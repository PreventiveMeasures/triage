// SSE+POST fallback for clients that can't establish a WebSocket
// upgrade — corporate proxies that strip `Upgrade: websocket`, legacy
// HTTP/1.0 intermediaries, or environments where `new WebSocket(…)`
// errors before `open`. Wire protocol on the SSE downstream is
// identical to the WS plane (same JSON message taxonomy, same Ed25519-
// signed canonicals, same `challenge` / `pong` / `authenticate` flow);
// the upstream direction batches frames into HTTP POSTs.
//
// One route, POSTs only:
//
//   POST /api/sync/sse[?id=<sid>]
//       Request body:
//         { password?: string,                   — cached client password
//           frames?:   Array<protocol-frame>     — WS-style JSON frames
//         }
//       Response:
//         200 OK, content-type: text/event-stream
//         First frame on a *fresh* session is an SSE event named
//         `session` whose data is JSON `{ id, nonce }` — the
//         continuation token + per-session challenge nonce. Subsequent
//         frames are default-named SSE messages carrying the WS
//         protocol's JSON envelopes.
//
// Continuation: each POST replaces the previous POST's response as the
// session's downstream channel. If the `?id=<sid>` in the URL matches
// a session this replica knows, the session continues (new outbound
// stream attached, old one end()ed). If the id is unknown (different
// replica picked up the POST, or session expired), a fresh session
// with a new id is created and announced via the first `session`
// event; the client uses the new id on all subsequent POSTs and re-
// sends its subscribe frames on the next POST (its `frames` carry the
// signed subscribes — they always do, see client/sync/sse-transport.ts).
//
// Why POSTs only: a long-lived GET pins the client to one replica via
// TCP affinity, which would mean POSTs from the same client must be
// sticky-routed to the same replica. POSTs-only makes the protocol
// stateless across replicas — any replica can pick up the next POST
// from any client.

import type { IncomingMessage as HttpRequest, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'
import type { WebSocket } from 'ws'
import { type PeerConnectionDeps, setupPeerConnection } from './ws-server.ts'
import { SseSession } from './sse-session.ts'
import { errMsg, randomId } from './util.ts'

// Same prefix the WS upgrade lives under (server/http.ts WS_UPGRADE_PATH
// = '/api/sync'); subroute keeps the SSE plane sibling to the upgrade
// path so the same `location` block routes both.
export const SSE_OPEN_PATH = '/api/sync/sse'

export type SseServerDeps = {
  // The WS dispatch is the cohesive unit; SSE just provides another
  // transport into it. Closure over the same handler / hub / objstore
  // / track / debug surface the WS path uses.
  peerDeps: PeerConnectionDeps
  // Shutdown gate. Mirror of the REST + WS branches in server/http.ts:
  // an SSE POST arriving on an existing keep-alive socket after
  // SIGTERM should be rejected, not dispatched against a draining DB.
  isShuttingDown: () => boolean
  // Max number of concurrent SSE sessions per process. Above this we
  // 503 the open request. Caps the SSE-side equivalent of `wss.clients`.
  maxSessions: number
  // Max body size for one POST. Matches the WS `maxPayload` in
  // server/index.ts so the SSE plane can't accept frames the WS plane
  // would reject. The POST body envelope can hold multiple frames so
  // the per-frame budget is the same as the WS plane after the
  // dispatcher splits them.
  maxBodyBytes: number
  // Idle timeout for a session with no inbound POSTs. Detects the
  // wandered-off browser tab the WS heartbeat sweep handles via
  // ping/pong on real sockets. The client's JSON ping/pong heartbeat
  // (every 15s) is the steady-state liveness signal; this is the
  // hard ceiling.
  sessionIdleMs: number
  debug: boolean
}

export type SseServer = {
  // Returns true if the request matched an SSE route (caller should
  // not fall through to other handlers). false otherwise.
  handle: (req: HttpRequest, res: ServerResponse) => boolean
  // Iterates active sessions. Lifecycle's graceful-shutdown loop
  // reads this to close SSE sessions alongside WS clients.
  sessions: () => Iterable<SseSession>
}

// Inbound POST body. Every field optional — an empty-body POST is a
// valid "wake the session" probe (the response stream rides on every
// POST), and a body that carries only `password` or only `frames` is
// a normal partial update.
type SseBody = {
  password?: unknown
  frames?: unknown
}

export function installSseServer(deps: SseServerDeps): SseServer {
  const { peerDeps, isShuttingDown, maxSessions, maxBodyBytes, sessionIdleMs, debug } = deps

  // Active SSE sessions, keyed by the random session id the GET path
  // mints and the POST path looks up. Bounded by `maxSessions` — over
  // the cap, new POSTs get a 503. POSTs against an unknown id are not
  // 404'd — they mint a fresh session instead (multi-replica recovery).
  const sessions = new Map<string, SseSession>()
  // Per-session idle timer handle. Reset on every inbound POST; fires
  // after `sessionIdleMs` of silence to close a stranded session.
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function armIdleTimer(sid: string, session: SseSession): void {
    clearTimeout(idleTimers.get(sid))
    if (sessionIdleMs <= 0) return
    const t = setTimeout(() => {
      if (debug) console.warn(`sse: session ${sid.slice(0, 8)}… idle ${sessionIdleMs}ms → close`)
      try { session.terminate() } catch {}
    }, sessionIdleMs)
    t.unref?.()
    idleTimers.set(sid, t)
  }

  function dropSession(sid: string): void {
    sessions.delete(sid)
    const t = idleTimers.get(sid)
    if (t) clearTimeout(t)
    idleTimers.delete(sid)
  }

  function writeSseHeaders(res: ServerResponse): void {
    // `no-store` keeps stale event copies out of intermediate caches;
    // `x-accel-buffering: no` is the nginx-specific opt-out from
    // response buffering (without it nginx queues up to its
    // `proxy_buffer_size` of events before flushing, breaking the
    // realtime contract).
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // Retry hint for any auto-reconnect machinery on the client side.
    // The production client (client/sync/sse-transport.ts) does its own
    // reconnect via the outer socket-transport loop, so this is just
    // defence in depth.
    res.write('retry: 1000\n\n')
  }

  function createSession(res: ServerResponse, req: HttpRequest): { sid: string; session: SseSession } | null {
    if (sessions.size >= maxSessions) {
      if (debug) console.warn(`sse: refused open — sessions ${sessions.size} >= ${maxSessions}`)
      return null
    }
    writeSseHeaders(res)
    const sid = randomId()
    const session = new SseSession(res)
    sessions.set(sid, session)
    armIdleTimer(sid, session)
    session.on('close', () => { dropSession(sid) })
    // Announce the continuation token BEFORE the dispatcher emits its
    // `challenge` frame so the client latches the id first and the
    // protocol-level challenge lands on a stream the client is already
    // tracking. Both ride the same response — order is a wire-shape
    // nicety, not a correctness requirement (events are independent).
    session.writeEvent('session', sid)
    // Hand the session to the shared WS connection setup so it joins
    // the same Peer / dispatcher / hub lifecycle as a real WebSocket.
    // `setupPeerConnection` sends the protocol `challenge` frame as
    // its first action; that re-uses the normal default-named SSE
    // message channel.
    setupPeerConnection(session as unknown as WebSocket, req, peerDeps)
    return { sid, session }
  }

  // Drives a POST body's `password` and `frames` through the shared
  // dispatcher. The dispatcher's `ping` / `authenticate` fast paths
  // handle the trivial cases inline; everything else spawns a tracked
  // handler. We synthesise one synthetic frame per inbound bit so the
  // dispatcher reads identically whether it's reading WS frames or
  // SSE POST batches.
  function dispatchBody(session: SseSession, body: SseBody): void {
    // Password → synthetic `authenticate` frame so the shared
    // dispatcher's existing fast path runs unchanged. Client caches
    // the password and re-sends on every POST, so the first POST
    // after a session takeover re-authenticates silently on the new
    // replica without an extra round-trip.
    if (typeof body.password === 'string' && body.password.length > 0) {
      const buf = Buffer.from(JSON.stringify({ type: 'authenticate', password: body.password }), 'utf8')
      session.receiveMessage(buf)
    }
    if (Array.isArray(body.frames)) {
      for (const frame of body.frames) {
        if (!frame || typeof frame !== 'object') continue
        const buf = Buffer.from(JSON.stringify(frame), 'utf8')
        session.receiveMessage(buf)
      }
    }
  }

  function handlePost(req: HttpRequest, res: ServerResponse, sidFromUrl: string | null): void {
    if (isShuttingDown()) {
      res.writeHead(503, { 'content-type': 'application/json', 'connection': 'close' })
      res.end(JSON.stringify({ error: 'shutting-down' }))
      return
    }
    // Bound the body the same way `WebSocketServer({ maxPayload })`
    // bounds a WS frame. Slurp into a single buffer rather than
    // streaming — every protocol frame fits comfortably under
    // `maxBodyBytes` (4 MiB) and the dispatcher takes one buffer at a
    // time anyway. `content-length` may be missing on chunked-encoded
    // requests; rely on the accumulating size check.
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      total += chunk.length
      if (total > maxBodyBytes) {
        aborted = true
        if (debug) console.warn(`sse: POST body too large (${total} > ${maxBodyBytes})`)
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'too-large' }))
        try { req.destroy() } catch {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      // Re-check shutdown: the entry gate at handlePost runs at request
      // arrival, but the body read is async — a slow upload that
      // started pre-SIGTERM can fire 'end' AFTER the lifecycle's
      // sseSessions() close-loop has already iterated, and createSession
      // would otherwise add a NEW session post-iteration that only
      // gets force-killed by the terminate-grace timer (no graceful
      // event:close frame). Bail with 503 so the client distinguishes
      // shutdown from a transport error and short-circuits backoff.
      if (isShuttingDown()) {
        res.writeHead(503, { 'content-type': 'application/json', 'connection': 'close' })
        res.end(JSON.stringify({ error: 'shutting-down' }))
        return
      }
      let body: SseBody = {}
      if (chunks.length > 0) {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
          if (parsed && typeof parsed === 'object') body = parsed as SseBody
        } catch (err) {
          if (debug) console.warn('sse: malformed POST body:', errMsg(err))
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'bad-json' }))
          return
        }
      }
      // Look up the session by id (if the client sent one). If found
      // and alive, attach the new response and dispatch. If not (or
      // session is closed), mint a fresh one — the response stream
      // carries the new id as the first `session` event so the client
      // switches over on the next POST.
      let session: SseSession | null = null
      let sid: string | null = null
      if (sidFromUrl) {
        const existing = sessions.get(sidFromUrl)
        if (existing && existing.readyState === existing.OPEN) {
          writeSseHeaders(res)
          if (existing.attachResponse(res)) {
            session = existing
            sid = sidFromUrl
            armIdleTimer(sid, session)
          }
        }
      }
      if (!session) {
        const created = createSession(res, req)
        if (!created) {
          // Cap exceeded; createSession already logged. Response
          // headers not yet written by writeSseHeaders, so send a
          // 503 JSON instead.
          res.writeHead(503, { 'content-type': 'application/json', 'connection': 'close' })
          res.end(JSON.stringify({ error: 'too-many-sessions' }))
          return
        }
        session = created.session
        sid = created.sid
      }
      dispatchBody(session, body)
      // Do NOT res.end() — the response stays open as the session's
      // downstream channel until the next POST takes over (or the
      // client disconnects).
    })
    req.on('error', (err) => {
      if (debug) console.warn('sse: POST stream error:', errMsg(err))
      if (res.headersSent) {
        try { res.destroy() } catch {}
      } else {
        try { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad-request' })) } catch {}
      }
    })
  }

  function handle(req: HttpRequest, res: ServerResponse): boolean {
    if (typeof req.url !== 'string') return false
    const [path, query] = req.url.split('?', 2)
    if (path !== SSE_OPEN_PATH) return false
    if (req.method !== 'POST') {
      // `connection: close` so a probing client (e.g. accidental GET)
      // can't pipeline N more 405s on the same keep-alive socket.
      // Sibling 503 paths set this for the same reason.
      res.writeHead(405, { 'content-type': 'application/json', 'allow': 'POST', 'connection': 'close' })
      res.end(JSON.stringify({ error: 'method-not-allowed' }))
      return true
    }
    const sid = parseSidQuery(query)
    handlePost(req, res, sid)
    return true
  }

  return { handle, sessions: () => sessions.values() }
}

// Bare-bones query parse for `id=<base64url>`. Avoids URLSearchParams
// (which decodes percent-escapes) — the session id is always a 22-char
// base64url string from `randomId()`, no escapes possible. Returns
// null on missing / malformed.
function parseSidQuery(query: string | undefined): string | null {
  if (typeof query !== 'string') return null
  for (const part of query.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq) !== 'id') continue
    const v = part.slice(eq + 1)
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(v)) return null
    return v
  }
  return null
}
