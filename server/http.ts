// HTTP plane: the REST byte-transfer routing (`/api/objstore/...`), the
// static UI bundle, and the WebSocket upgrade gate. Built once at boot
// with the WS server plus the lifecycle hooks it needs (`track` to
// drain in-flight requests on shutdown, `isShuttingDown` to gate new
// ones). The WS *connection* handler is wired on `wss` separately in
// index.ts; this module only owns the upgrade handshake.

import { type IncomingMessage as HttpRequest, type Server, type ServerResponse, createServer } from 'node:http'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import type { WebSocketServer } from 'ws'
import { type ObjstoreRestDeps, handleRest, matchRoute } from './objstore/rest.ts'
import { loadStatic } from './static.ts'
import { errStack } from './util.ts'

// `/api/*` is reserved for backend traffic so a fronting nginx (or
// similar) can route `/api/*` → this process and `/*` → the static UI
// bundle with a single location block.
export const WS_UPGRADE_PATH = '/api/sync'
function isUpgradePath(url: string | undefined): boolean {
  if (typeof url !== 'string') return false
  // Strip `?…` so clients can carry build / debug tags. Exact match
  // otherwise — `/api/sync/` (trailing slash) doesn't pass.
  return url.split('?', 1)[0] === WS_UPGRADE_PATH
}

const NOT_FOUND_BODY = JSON.stringify({ error: 'not-found' })

type HasHeaders = { headers: HttpRequest['headers'] }

export type HttpServerDeps = {
  wss: WebSocketServer
  restDeps: ObjstoreRestDeps
  isOriginAllowed: (req: HasHeaders) => boolean
  isShuttingDown: () => boolean
  track: (promise: Promise<unknown>) => void
  restPutIdleTimeoutMs: number
  debug: boolean
}

export function createHttpServer(deps: HttpServerDeps): Server {
  const { wss, restDeps, isOriginAllowed, isShuttingDown, track, restPutIdleTimeoutMs, debug } = deps
  // Static-file plane (see ./static.ts). The directory is the
  // `build.js build` output sibling to this file; the loader handles
  // enumeration, pre-compression, and ETag derivation. Plugged in after
  // the `/api/objstore/...` REST branch.
  const handleStatic = loadStatic(fileURLToPath(new URL('../out', import.meta.url)))

  const httpServer = createServer((req: HttpRequest, res: ServerResponse) => {
    if (matchRoute(req.url) != null) {
      // Shutdown gate. The WS plane gates new messages on `shuttingDown`;
      // REST handlers go through a separate path and must mirror it.
      // Without this, a REST PUT arriving on an existing keep-alive
      // socket AFTER SIGTERM but BEFORE `httpServer.close()` finishes
      // draining could land in `withCommitLock`, acquire a lease, and
      // finish its `finally { release() }` AFTER the shutdown's
      // `heldLeaseCount` snapshot — leaving an orphan lock row that pins
      // the key until TTL expiry. The 503 + `shutting-down` reason tells
      // the client to retry against a different replica. Transport
      // audit + multi-replica shutdown ordering review.
      if (isShuttingDown()) {
        res.writeHead(503, { 'content-type': 'application/json', 'connection': 'close' })
        res.end(JSON.stringify({ error: 'shutting-down' }))
        return
      }
      // Same-origin gate. Token IS the auth on REST, but a hostile origin
      // that holds a valid token (e.g. via XSS that read a freshly-minted
      // one) would PUT with its own Origin header — caught here.
      // Same-origin XHR/fetch may omit Origin; that path is allowed (see
      // `isOriginAllowed`). Transport audit `server/objstore/rest.ts:103`.
      if (!isOriginAllowed(req)) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'origin-denied' }))
        return
      }
      // PUT idle-body timeout — a slow-loris client trickling bytes
      // within the declared Content-Length holds the staging fd + an
      // inFlightSids slot indefinitely. `req.setTimeout` fires on
      // inactivity; we destroy the request, aborting the body pipeline.
      // Transport audit `server/objstore/rest.ts:218`.
      if (req.method === 'PUT') {
        req.setTimeout(restPutIdleTimeoutMs, () => {
          if (debug) console.warn(`REST PUT idle ${restPutIdleTimeoutMs}ms → abort`)
          try { req.destroy(new Error('idle-timeout')) } catch {}
        })
      }
      // Track so SIGTERM mid-upload/download awaits handleRest before the
      // DB close. The outer `.catch` is the unhandled-rejection guard for
      // a stray throw OUTSIDE handleRest's internal try/catch blocks —
      // Node 20+ defaults `--unhandled-rejections=throw`, which would
      // crash the server. Logs and terminates the response so the TCP
      // socket doesn't dangle.
      const p = handleRest(restDeps, req, res).catch((err) => {
        console.warn('REST handler error:', errStack(err))
        if (res.headersSent) { try { res.destroy() } catch {} }
        else { try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'internal' })) } catch {} }
      })
      track(p)
      return
    }
    if (handleStatic(req, res)) return
    // `Connection: close` so an HTTP/1.1 keep-alive client doesn't hold
    // the socket open expecting more requests on a server that only
    // serves a small REST surface.
    res.writeHead(404, { 'content-type': 'application/json', 'connection': 'close' })
    res.end(NOT_FOUND_BODY)
  })

  httpServer.on('upgrade', (req, socket, head) => {
    // RFC 6455: the WS upgrade IS an HTTP request; reject with a normal
    // HTTP response so a misconfigured client sees the JSON body instead
    // of ECONNRESET. `socket.end(body)` flushes before sending FIN.
    if (!isUpgradePath(req.url)) {
      socket.end(
        'HTTP/1.1 404 Not Found\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(NOT_FOUND_BODY)}\r\n` +
        'Connection: close\r\n\r\n' +
        NOT_FOUND_BODY,
      )
      return
    }
    // Same-origin gate. The WS upgrade IS a cross-origin-reachable
    // surface in the browser; without this any tab can open a session to
    // a 127.0.0.1 relay and probe handler shape / burn verify CPU.
    // Browser WS handshakes always carry Origin (RFC 6455); non-browser
    // clients omit it and are allowed (network is their trust boundary).
    if (!isOriginAllowed(req)) {
      socket.end(
        'HTTP/1.1 403 Forbidden\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Length: 26\r\n' +
        'Connection: close\r\n\r\n' +
        '{"error":"origin-denied"}\n',
      )
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req) })
  })

  return httpServer
}
