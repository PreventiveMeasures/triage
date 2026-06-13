// HTTP plane: the REST byte-transfer routing (`/api/objstore/...`), the
// static UI bundle, the SSE+POST fallback transport for the sync
// protocol, and the WebSocket upgrade gate. Built once at boot with
// the WS server plus the lifecycle hooks it needs (`track` to drain
// in-flight requests on shutdown, `isShuttingDown` to gate new ones).
// The WS *connection* handler is wired on `wss` separately in
// index.ts; this module only owns the upgrade handshake.

import { type IncomingMessage as HttpRequest, type Server, type ServerResponse, createServer } from 'node:http'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import type { WebSocketServer } from 'ws'
import { CONFIG_PATH, type ServerInfo } from '../common/server-info.ts'
import { type ObjstoreRestDeps, handleRest, matchRoute } from './objstore/rest.ts'
import { SSE_OPEN_PATH, type SseServer } from './sse-server.ts'
import { dispatchNpmAdvisories } from './npm-proxy.ts'
import { loadStatic } from './static.ts'
import { errStack } from './util.ts'

// `/api/*` is reserved for backend traffic so a fronting nginx (or
// similar) can route `/api/*` → this process and `/*` → the static UI
// bundle with a single location block.
export const WS_UPGRADE_PATH = '/api/sync'
// Session-independent triage-sync save plane: `POST /api/sync/save`. The
// SSE-mode alternative to the in-band `workspace-save` frame — a save POSTed
// here commits + broadcasts WITHOUT taking over the client's SSE event-stream
// (each in-band POST forces a stream takeover; see sse-server.ts). Sibling of
// the WS upgrade path so one nginx `/api/*` block routes both.
export const SAVE_REST_PATH = '/api/sync/save'
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
  // This server's `server-info` (mode advertisement), served as JSON at
  // GET /api/config so a client can detect the protocol without a sync
  // connection (the WS connect frame stays the source of truth).
  serverInfo: ServerInfo
  // SSE+POST fallback. Owns its own session map + lifecycle; we just
  // give it first crack at requests that match `SSE_OPEN_PATH`. Same
  // same-origin / shutdown gates run BEFORE the dispatch so the SSE
  // plane inherits them.
  sseServer: SseServer
  isOriginAllowed: (req: HasHeaders) => boolean
  isShuttingDown: () => boolean
  track: (promise: Promise<unknown>) => void
  // Handler for `POST /api/sync/save` (see SAVE_REST_PATH). Owns body parse +
  // the save pipeline + JSON response; this module owns the gates (method,
  // same-origin, shutdown, idle-timeout) and the graceful-drain tracking.
  handleSaveRest: (req: HttpRequest, res: ServerResponse) => Promise<void>
  restPutIdleTimeoutMs: number
  debug: boolean
}

// `POST /api/sync/save` dispatch. Returns the in-flight handler promise when
// the request matched the route (the caller `track`s it for graceful drain),
// or null when it's for a different route. The gate ladder — method →
// shutdown → same-origin → idle-timeout — mirrors the objstore REST branch; a
// gate rejection writes its own response and returns an already-settled
// promise. Kept out of `createHttpServer` so that dispatcher stays compact.
function dispatchSaveRest(
  req: HttpRequest, res: ServerResponse,
  deps: {
    handleSaveRest: (req: HttpRequest, res: ServerResponse) => Promise<void>
    isOriginAllowed: (req: HasHeaders) => boolean
    isShuttingDown: () => boolean
    restPutIdleTimeoutMs: number
    debug: boolean
  },
): Promise<void> | null {
  if (typeof req.url !== 'string' || req.url.split('?', 1)[0] !== SAVE_REST_PATH) return null
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', 'allow': 'POST', 'connection': 'close' })
    res.end(JSON.stringify({ error: 'method-not-allowed' }))
    return Promise.resolve()
  }
  // Shutdown gate — parity with the objstore REST branch (a POST on an
  // existing keep-alive socket after SIGTERM but before close() drains).
  if (deps.isShuttingDown()) {
    res.writeHead(503, { 'content-type': 'application/json', 'connection': 'close' })
    res.end(JSON.stringify({ error: 'shutting-down' }))
    return Promise.resolve()
  }
  // Same-origin gate — a hostile cross-origin page would carry an Origin
  // header (browser-set on fetch); same-origin XHR may omit it (allowed).
  if (!deps.isOriginAllowed(req)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'origin-denied' }))
    return Promise.resolve()
  }
  // Idle-body timeout — a slow-loris trickling the JSON body would otherwise
  // hold the connection indefinitely.
  req.setTimeout(deps.restPutIdleTimeoutMs, () => {
    if (deps.debug) console.warn(`sync-save REST idle ${deps.restPutIdleTimeoutMs}ms → abort`)
    try { req.destroy(new Error('idle-timeout')) } catch {}
  })
  // Outer catch is the unhandled-rejection guard for a throw OUTSIDE the
  // handler's own try/catch — logs and terminates the response so the TCP
  // socket doesn't dangle (same policy as the objstore handleRest wrapper).
  return deps.handleSaveRest(req, res).catch((err) => {
    console.warn('sync-save REST handler error:', errStack(err))
    if (res.headersSent) { try { res.destroy() } catch {} }
    else { try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'internal' })) } catch {} }
  })
}

export function createHttpServer(deps: HttpServerDeps): Server {
  const { wss, restDeps, sseServer, serverInfo, isOriginAllowed, isShuttingDown, track, handleSaveRest, restPutIdleTimeoutMs, debug } = deps
  // Static-file plane (see ./static.ts). The directory is the
  // `build.js build` output sibling to this file; the loader handles
  // enumeration, pre-compression, and ETag derivation. Plugged in after
  // the `/api/objstore/...` REST branch.
  const handleStatic = loadStatic(fileURLToPath(new URL('../out', import.meta.url)))

  const httpServer = createServer((req: HttpRequest, res: ServerResponse) => {
    // Static mode probe: GET /api/config → this server's `server-info` as JSON.
    // A client uses it to detect the protocol up front; the WS connect frame
    // stays the source of truth and catches a later mode change. Public, no body.
    if (typeof req.url === 'string' && req.url.split('?', 1)[0] === CONFIG_PATH) {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' })
        res.end(JSON.stringify({ error: 'method-not-allowed' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(serverInfo))
      return
    }
    // SSE+POST fallback plane. Same-origin gate first (Origin header
    // is set by the browser on cross-origin EventSource + fetch, so
    // a hostile origin would surface here just like it does on the
    // WS upgrade and REST plane). The sseServer.handle() function
    // returns true iff it matched and consumed the request; on false
    // we fall through to the REST / static / 404 ladder below.
    if (typeof req.url === 'string' && req.url.split('?', 1)[0] === SSE_OPEN_PATH) {
      if (!isOriginAllowed(req)) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'origin-denied' }))
        return
      }
      // sseServer.handle owns its own shutdown / cap / 503 ladder.
      // Each POST's response stays open as the session's downstream
      // channel until the next POST takes over — the response is
      // long-lived even though the request is one-shot — and the
      // shutdown gate inside sseServer prevents accepting new POSTs
      // once shuttingDown latches, so outstanding sessions drain via
      // the lifecycle's sseSessions() close loop.
      if (sseServer.handle(req, res)) return
    }
    // Triage-sync save REST plane (see SAVE_REST_PATH) — session-independent
    // `POST /api/sync/save` so an SSE-mode save doesn't take over the
    // event-stream. The dispatch helper owns the gate ladder; we `track` the
    // returned in-flight promise so SIGTERM drains it (mirrors npm-advisories).
    const saveP = dispatchSaveRest(req, res, { handleSaveRest, isOriginAllowed, isShuttingDown, restPutIdleTimeoutMs, debug })
    if (saveP) { track(saveP); return }
    // npm advisories proxy — same-origin + shutdown gates live in the
    // helper so this dispatcher stays compact. `dispatchNpmAdvisories`
    // returns the in-flight promise (or null when the route didn't
    // match); the lifecycle's `track` awaits it so SIGTERM drains
    // outstanding upstream fetches.
    const npmP = dispatchNpmAdvisories(req, res, { isOriginAllowed, isShuttingDown, debug })
    if (npmP) { track(npmP); return }
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
      // `isOriginAllowed`). Transport audit `server-e2e/objstore/rest.ts:103`.
      if (!isOriginAllowed(req)) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'origin-denied' }))
        return
      }
      // Idle-body timeout for the body-bearing REST methods — a slow-loris
      // client trickling bytes holds the connection (and, for PUT, the
      // staging fd + inFlightSids slot) indefinitely. PUT carries the raw
      // blob within its declared Content-Length; POST carries the small
      // fetch-mint JSON body. `req.setTimeout` fires on inactivity; we
      // destroy the request, aborting the body pipeline.
      // Transport audit `server-e2e/objstore/rest.ts:218`.
      if (req.method === 'PUT' || req.method === 'POST') {
        req.setTimeout(restPutIdleTimeoutMs, () => {
          if (debug) console.warn(`REST ${req.method} idle ${restPutIdleTimeoutMs}ms → abort`)
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
