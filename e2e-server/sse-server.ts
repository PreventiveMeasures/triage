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
//   POST /api/sync/sse
//       Request body:
//         { id?: string,                         — session continuation token
//           password?: string,                   — cached client password
//           frames?:   Array<protocol-frame>     — WS-style JSON frames
//         }
//       Response:
//         200 OK, content-type: text/event-stream
//         First frame on a *fresh* session is an SSE event named
//         `session` whose data is the raw continuation-token string
//         (22-char base64url, from `randomId()`). The per-session
//         challenge nonce is delivered separately on the next default-
//         named `data:` event as the standard protocol `challenge`
//         frame, so the SSE plane uses the SAME nonce-handshake the WS
//         plane does. Subsequent frames are default-named SSE messages
//         carrying the WS protocol's JSON envelopes.
//
// Continuation: each POST replaces the previous POST's response as the
// session's downstream channel. If the body's `id` matches a session
// this replica knows, the session continues (new outbound stream
// attached, old one end()ed). If the id is unknown (different replica
// picked up the POST, or session expired), a fresh session with a new
// id is created and announced via the first `session` event; the
// client uses the new id on all subsequent POSTs and re-sends its
// subscribe frames on the next POST (its `frames` carry the signed
// subscribes — they always do, see client/sync/sse-transport.ts).
//
// The id rides the JSON body, NOT the URL: the sid is a live bearer
// capability (whoever presents it attaches to the session's downstream
// and inherits its operator-auth flag), and a query-string token leaks
// into proxy / LB access logs — the same reason the objstore bearer
// tokens ride the Authorization header, never the URL. A legacy
// `?id=<sid>` query form is still ACCEPTED (older client bundles sent
// it; rejecting would churn them through a fresh session per POST),
// but current clients never emit it.
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

// Same prefix the WS upgrade lives under (e2e-server/http.ts WS_UPGRADE_PATH
// = '/api/sync'); subroute keeps the SSE plane sibling to the upgrade
// path so the same `location` block routes both.
export const SSE_OPEN_PATH = '/api/sync/sse'

// Cadence of the server-driven keepalive sweep: every tick we write a `:`
// comment to each open session's downstream so intermediary proxies don't
// idle-close it (nginx et al. default to a ~60s read timeout). This is the
// server's own liveness upkeep — the client no longer POSTs a periodic ping
// (which forced a stream takeover every tick).
//
// Reaping model (replaces the old POST-driven idle timer): a session is
// dropped on its downstream response `close` — clean disconnect, or a
// half-open socket the per-session TCP keepalive forces closed (see
// SseSession.SOCKET_KEEPALIVE_MS) — NOT by this sweep. We intentionally
// trust connection-level liveness. The one topology this can't see is a
// buffering / TLS-terminating proxy that holds the upstream open after the
// real client vanished (keepalive then probes the proxy hop, not the
// client); such a session lingers until `maxSessions`, the hard backstop.
// This is the same exposure the WS heartbeat already has (its ping only
// proves the proxy↔server hop too), not a new class of leak.
const KEEPALIVE_SWEEP_MS = 30_000

export type SseServerDeps = {
  // The WS dispatch is the cohesive unit; SSE just provides another
  // transport into it. Closure over the same handler / hub / objstore
  // / track / debug surface the WS path uses.
  peerDeps: PeerConnectionDeps
  // Shutdown gate. Mirror of the REST + WS branches in e2e-server/http.ts:
  // an SSE POST arriving on an existing keep-alive socket after
  // SIGTERM should be rejected, not dispatched against a draining DB.
  isShuttingDown: () => boolean
  // Max number of concurrent SSE sessions per process. Above this we
  // 503 the open request. Caps the SSE-side equivalent of `wss.clients`.
  maxSessions: number
  // Max body size for one POST. Matches the WS `maxPayload` in
  // e2e-server/index.ts so the SSE plane can't accept frames the WS plane
  // would reject. The POST body envelope can hold multiple frames so
  // the per-frame budget is the same as the WS plane after the
  // dispatcher splits them.
  maxBodyBytes: number
  debug: boolean
}

export type SseServer = {
  // Returns true if the request matched an SSE route (caller should
  // not fall through to other handlers). false otherwise.
  handle: (req: HttpRequest, res: ServerResponse) => boolean
  // Iterates active sessions. Lifecycle's graceful-shutdown loop
  // reads this to close SSE sessions alongside WS clients.
  sessions: () => Iterable<SseSession>
  // The keepalive-sweep timer. Lifecycle clears it on shutdown (parity
  // with the WS heartbeat timer) so a tick can't fire mid-teardown.
  keepaliveTimer: ReturnType<typeof setInterval>
}

// Inbound POST body. Every field optional — an empty-body POST is a
// valid "wake the session" probe (the response stream rides on every
// POST), and a body that carries only `password` or only `frames` is
// a normal partial update. `id` is the session continuation token
// (see the header's "Continuation" note for why it rides the body).
type SseBody = {
  id?: unknown
  password?: unknown
  frames?: unknown
}

export function installSseServer(deps: SseServerDeps): SseServer {
  const { peerDeps, isShuttingDown, maxSessions, maxBodyBytes, debug } = deps

  // Active SSE sessions, keyed by the random session id `createSession`
  // mints on the first POST that carries no continuation id (or whose
  // id this replica doesn't recognise) and that subsequent POSTs echo
  // back (body `id` field) to continue the session. Bounded by
  // `maxSessions` — over the cap, new POSTs get a 503. POSTs against an
  // unknown id are NOT 404'd — they mint a fresh session instead, so a
  // multi-replica deployment doesn't require sticky LB routing to
  // recover.
  const sessions = new Map<string, SseSession>()

  function dropSession(sid: string): void {
    sessions.delete(sid)
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

  function createSession(res: ServerResponse, req: HttpRequest): SseSession | null {
    if (sessions.size >= maxSessions) {
      if (debug) console.warn(`sse: refused open — sessions ${sessions.size} >= ${maxSessions}`)
      return null
    }
    writeSseHeaders(res)
    const sid = randomId()
    const session = new SseSession(res)
    sessions.set(sid, session)
    session.on('close', () => { dropSession(sid) })
    // Announce the continuation token BEFORE the dispatcher emits its
    // `challenge` frame so the client latches the id first and the
    // protocol-level challenge lands on a stream the client is already
    // tracking. Both ride the same response — order is a wire-shape
    // nicety, not a correctness requirement (events are independent).
    session.writeEvent('session', sid)
    // Hand the session to the shared WS connection setup so it joins
    // the same Peer / dispatcher / hub lifecycle as a real WebSocket.
    // `setupPeerConnection`'s first action is the protocol `challenge`
    // frame, on the default-named SSE channel.
    setupPeerConnection(session as unknown as WebSocket, req, peerDeps)
    return session
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
      // Resolve the continuation token: the JSON body's `id` is the
      // canonical carrier; the `?id=` query form is the legacy
      // fallback for older client bundles (see the header note — a
      // query sid leaks into access logs). Body wins when both are
      // present (current clients only ever send one).
      const sid = parseSid(body.id) ?? sidFromUrl
      // Look up the session by id (if the client sent one). If found
      // and alive, attach the new response and dispatch. If not (or
      // session is closed), mint a fresh one — the response stream
      // carries the new id as the first `session` event so the client
      // switches over on the next POST.
      //
      // Attach-then-write ordering: attachResponse runs FIRST and only
      // on success do we writeSseHeaders. If attachResponse returns
      // false (today only when the session transitions out of OPEN
      // between the lookup and the attach — a future backpressure /
      // takeover-rate path could surface that legitimately) we fall
      // through to createSession with `res` still header-virgin, so
      // the new session can writeSseHeaders without ERR_HTTP_HEADERS_SENT.
      let session: SseSession | null = null
      if (sid) {
        const existing = sessions.get(sid)
        if (existing && existing.readyState === existing.OPEN && existing.attachResponse(res)) {
          writeSseHeaders(res)
          session = existing
        }
      }
      if (!session) {
        session = createSession(res, req)
        if (!session) {
          // Cap exceeded; createSession already logged. Response
          // headers not yet written by writeSseHeaders, so send a
          // 503 JSON instead.
          res.writeHead(503, { 'content-type': 'application/json', 'connection': 'close' })
          res.end(JSON.stringify({ error: 'too-many-sessions' }))
          return
        }
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

  // Server-driven keepalive sweep. Writes a `:` comment to every open
  // session's downstream so proxies don't idle-close it. `unref` so it can't
  // by itself hold the event loop open (parity with the WS heartbeat timer);
  // skipped during shutdown so a tick can't write to a session the close
  // loop is tearing down. Dead-session reaping is the response `close` event
  // (see SseSession.wireResponse + the per-session TCP keepalive), NOT this
  // sweep — so a half-open client is dropped without ever POSTing.
  const keepaliveTimer = setInterval(() => {
    if (isShuttingDown()) return
    for (const session of sessions.values()) {
      try { session.ping() } catch {}
    }
  }, KEEPALIVE_SWEEP_MS)
  keepaliveTimer.unref?.()

  return { handle, sessions: () => sessions.values(), keepaliveTimer }
}

// Shape gate for a continuation token from either carrier (body `id`
// field or the legacy `?id=` query). The {1,64} bound is a
// deliberately lenient sanity gate: anything outside the base64url
// alphabet is rejected; an unrecognised sid just gets a fresh session
// from createSession (no failure mode), and the wide length window
// keeps a future randomId-length change from silently breaking old
// clients that round-trip a longer/shorter token. Returns null on
// missing / non-string / malformed.
function parseSid(v: unknown): string | null {
  if (typeof v !== 'string') return null
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(v)) return null
  return v
}

// Bare-bones query parse for the LEGACY `id=<base64url>` carrier
// (older client bundles; current clients send the sid in the POST
// body — see the header's "Continuation" note). Avoids URLSearchParams
// (which decodes percent-escapes) — `randomId()` mints a 22-char
// base64url string echoed back unchanged, so no escapes are possible
// on the legitimate path.
function parseSidQuery(query: string | undefined): string | null {
  if (typeof query !== 'string') return null
  for (const part of query.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq) !== 'id') continue
    return parseSid(part.slice(eq + 1))
  }
  return null
}
