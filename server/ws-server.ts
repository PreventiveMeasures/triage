// WebSocket runtime: the per-connection handler (Peer setup, message
// dispatch, close/error) and the server-driven heartbeat sweep. Wired
// once at boot onto the shared `wss` with the protocol handlers +
// lifecycle hooks it dispatches to. Kept out of index.ts so the WS
// message loop — the most concurrency-sensitive surface — is one unit.

import type { WebSocket, WebSocketServer } from 'ws'
import { Buffer } from 'node:buffer'
import { decodeUtf8 } from '../common/utf8.js'
import type { SaveErrorReason } from '../common/save-error-reason.ts'
import { Peer, type PeerRegistry } from './peer.ts'
import { errMsg, errStack, randomId } from './util.ts'
import type { SaveMsg, SubscribeMsg } from './sign.ts'
import type { AuthenticateMsg } from './auth.ts'
import type { ObjstoreHandlers } from './objstore/handlers.ts'
import type { ObjstoreDeleteMsg, ObjstoreFetchMsg, ObjstoreListMsg, ObjstorePutBeginMsg } from './objstore/sign.ts'

// Wire-message envelope as it lands post-`JSON.parse`. Every field is
// `unknown` until a handler narrows it; the type just documents the
// dispatch surface so call sites can pattern-match on `msg.type`.
type IncomingMessage = {
  type?: unknown
  [k: string]: unknown
}

export type WsServerDeps = {
  wss: WebSocketServer
  peers: PeerRegistry
  send: (socket: WebSocket, msg: object) => void
  unsubscribeAll: (socket: WebSocket) => void
  handleSave: (socket: WebSocket, msg: SaveMsg) => Promise<void>
  handleSubscribe: (socket: WebSocket, msg: SubscribeMsg) => Promise<void>
  handleAuthenticate: (socket: WebSocket, msg: AuthenticateMsg) => void
  sendSaveError: (socket: WebSocket, workspaceTag: string, base: string | null, reason: SaveErrorReason) => void
  objstore: ObjstoreHandlers
  track: (promise: Promise<unknown>) => void
  isShuttingDown: () => boolean
  maxInflightPerSocket: number
  heartbeatIntervalMs: number
  debug: boolean
}

// Wires `wss.on('connection')` + starts the heartbeat. Returns the
// timer so shutdown can clear it.
export function installWsServer(deps: WsServerDeps): { heartbeatTimer: ReturnType<typeof setInterval> } {
  const {
    wss, peers, send, unsubscribeAll, handleSave, handleSubscribe, handleAuthenticate,
    sendSaveError, objstore, track, isShuttingDown, maxInflightPerSocket, heartbeatIntervalMs, debug,
  } = deps

  wss.on('connection', (socket: WebSocket, req) => {
    if (debug) console.log(`connect from ${req.socket.remoteAddress}`)
    // One Peer holds this connection's state (challenge / authorized /
    // alive / inflight / tags). Created before any client frame can
    // arrive (`socket.on('message')` is wired below). The heartbeat
    // sweep flips `alive` false after each `ping()`; the `pong` listener
    // flips it back, and a socket still false on the next sweep is
    // terminated — the only thing closing FDs for an idle peer.
    const peer = new Peer(randomId())
    peers.set(socket, peer)
    socket.on('pong', () => { peer.alive = true })
    // Issue the per-connection challenge nonce BEFORE the client can
    // send anything that needs it. The client signs it into every
    // `workspace-subscribe` (see canonicalSubscribe in server/sign.ts);
    // a captured subscribe frame can't be replayed from a different
    // connection because that connection's nonce differs and the
    // signature won't verify against the new canonical bytes. Round-9 H2.
    send(socket, { type: 'challenge', nonce: peer.challenge })
    // Per-socket handlers are DELIBERATELY NOT serialized (vs the
    // client-side `messageQueue = messageQueue.then(...)` Promise
    // chain inside `client/triage-sync.ts:onTransportMessage`).
    // Each inbound frame spawns its own tracked async IIFE; two
    // frames from the same socket can interleave across `await`
    // boundaries inside the handlers. Per-resource correctness needs
    // no in-process lock: `commitRevision` resolves concurrent saves
    // via its single gated INSERT (one snapshot + the
    // `UNIQUE(workspace_tag, seq)` PK — see `server/db.ts`), and the
    // objstore handlers (`commitPut` / `beginPut` / `deleteObject`)
    // via the version compare-and-set + content-addressing (see
    // `server/objstore/store.ts`), backed by post-await
    // `readyState === OPEN` rechecks in every objstore handler. The
    // unbounded fan-out is capped by `maxInflightPerSocket` (see
    // also the `'busy'` NACK at the cap below). Concurrent dispatch
    // is intentional: it lets multi-workspace clients multiplex
    // saves + subscribes over one socket without HOL blocking.
    // Audit follow-up to round-15 concurrency review.
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      // Drop new work once shutdown started — `wss.close()` stops new
      // CONNECTIONS but already-open sockets can still send messages.
      // Without this gate a message arriving between `wss.close()`
      // resolving and the `inFlight` snapshot would spawn a handler
      // that's NOT in the snapshot, then resume against the just-
      // closed DB and throw inside the commit's gated INSERT. Audit
      // round-9.
      if (isShuttingDown()) return
      // Wire protocol is JSON over text frames. A binary frame is
      // either a buggy client or someone probing — drop without
      // attempting to interpret it as text.
      if (isBinary) return
      let msg: IncomingMessage | null = null
      try {
        // `decodeUtf8` is fatal on invalid UTF-8 (vs `Buffer.toString`
        // which silently substitutes U+FFFD). The substitution path
        // would let mangled bytes pass JSON.parse only to fail
        // signature verification deeper in the handler — wasted work
        // and noisier logs. Fail at the gate.
        msg = JSON.parse(decodeUtf8(data)) as IncomingMessage
      } catch { return }
      if (!msg || typeof msg !== 'object') return
      const parsed: IncomingMessage = msg
      // Per-socket inflight cap. Each tracked handler keeps the socket
      // alive in `inFlight`, and a peer who keeps firing valid frames
      // can spawn unbounded handlers — growing SIGTERM drain time and
      // memory. Drop new work above the cap. Heartbeat ping is the
      // exception: it's stateless, synchronous, and we want to KEEP
      // responding so the peer doesn't drop the socket while we're
      // shedding load. Pings go through a fast inline `send(pong)`
      // path BELOW that doesn't bump the per-socket inflight counter,
      // so a ping-spam at the cap can't outrun the gate. Transport
      // audit `server/index.ts:590` + post-#58 audit follow-up.
      if (parsed.type === 'ping') {
        send(socket, { type: 'pong' })
        return
      }
      // `authenticate` runs synchronously (constant-time bytes compare
      // — no DB, no I/O), so it shares the same fast-inline path as
      // `ping` and bypasses the per-socket inflight counter. Keeping
      // it out of the IIFE pool means an unauthenticated client can
      // still complete the handshake when the socket is otherwise
      // saturated (matching the philosophy of the `busy` NACK path
      // for `workspace-save`: don't strand a recoverable handshake
      // behind the cap).
      if (parsed.type === 'authenticate') {
        handleAuthenticate(socket, parsed as AuthenticateMsg)
        return
      }
      if (peer.inflight >= maxInflightPerSocket) {
        if (debug) console.warn(`drop message: socket inflight ${peer.inflight} >= ${maxInflightPerSocket}`)
        // For workspace-save specifically, send a typed NACK so the
        // client's `pending` slot clears IMMEDIATELY instead of
        // hanging until the next heartbeat (~15–30s). Reason `busy`
        // is server-side overload; safe to retry. Same wire envelope
        // as the existing `too-large` save-error path.
        //
        // Wire-order interaction with `'stale-base'`: the cap-path
        // send is SYNCHRONOUS in this message callback and lands on
        // the wire BEFORE any handler IIFE's `await`-completed reply.
        // If an earlier in-flight `workspace-save` (frame F1) ends up
        // emitting a catch-up `workspace-state` + `'stale-base'` while
        // a later frame F2 hits the cap, the order is `'busy'`(F2) →
        // `workspace-state`(F1) → `'stale-base'`(F1). The client's
        // `handleSaveError` correlates on `base`, and the wire-order
        // trick documented in `common/save-error-reason.ts` (catch-up
        // clears `pending` before the stale-base frame's
        // `handleSaveError` runs) still holds.
        const rawBase = (parsed as SaveMsg).base
        const baseField: string | null = typeof rawBase === 'string' ? rawBase : null
        const rawTag = (parsed as SaveMsg).workspaceTag
        const tagField = typeof rawTag === 'string' ? rawTag : null
        if (parsed.type === 'workspace-save' && tagField != null) {
          // `sendSaveError` runs its taxonomy-guard before the wire
          // send and throws on an unknown reason. Every OTHER emit
          // site lives inside the `handler` IIFE's try/catch — this
          // cap path is the only one outside it. Mirror the same
          // forensic envelope so a future bad reason here surfaces
          // as `Handler error (type=workspace-save): …` rather than
          // escaping to ws's emitter as an uncaught.
          try {
            sendSaveError(socket, tagField, baseField, 'busy')
          } catch (err) {
            console.warn('Handler error (type=workspace-save):', errStack(err))
          }
        }
        return
      }
      peer.inflight += 1
      const handler = (async () => {
        try {
          if (parsed.type === 'workspace-save') await handleSave(socket, parsed as SaveMsg)
          else if (parsed.type === 'workspace-subscribe') await handleSubscribe(socket, parsed as SubscribeMsg)
          // Objstore control plane — bytes ride the REST plane via
          // tokens these handlers mint. The Objstore*Msg types are
          // weak shapes (every field `unknown`); the handlers narrow
          // each field through their own validators on entry.
          else if (parsed.type === 'objstore-put-begin') await objstore.handlePutBegin(socket, parsed as ObjstorePutBeginMsg)
          else if (parsed.type === 'objstore-delete') await objstore.handleDelete(socket, parsed as ObjstoreDeleteMsg)
          else if (parsed.type === 'objstore-list') await objstore.handleList(socket, parsed as ObjstoreListMsg)
          else if (parsed.type === 'objstore-fetch') await objstore.handleFetch(socket, parsed as ObjstoreFetchMsg)
        } catch (err) {
          // Forensic logging for unexpected throws — the handlers all
          // have internal narrow catches (e.g. signature reject paths);
          // anything reaching here is unexpected. Include the wire
          // `type` so an operator can correlate to a specific code
          // path, and prefer `.stack` over `.message` so the post-
          // mortem has the throw site.
          const typeStr = typeof parsed.type === 'string' ? parsed.type : '<unknown>'
          console.warn(`Handler error (type=${typeStr}):`, errStack(err))
        } finally {
          peer.inflight -= 1
        }
      })()
      track(handler)
    })
    socket.on('close', () => {
      // `unsubscribeAll` reads `peer.tags` (peer still registered), then
      // we drop the Peer. The Peer's state would GC once the socket is
      // unreachable, but `wss.clients` / `ws` internals hold the socket
      // strongly well past `close`, so the explicit delete frees it
      // immediately. Audit round-10 + round-13.
      unsubscribeAll(socket)
      peers.delete(socket)
    })
    // Surface socket-level errors instead of swallowing — these are
    // the signals operators want under abuse / network flakiness
    // (TLS handshake failures, frame-decode errors, ws-protocol
    // violations). The previous `() => {}` left every per-connection
    // failure invisible. `close` fires after `error` and runs the
    // unsubscribe cleanup, so logging here doesn't risk leaking.
    socket.on('error', (err: Error) => { console.warn('Socket error:', errMsg(err)) })
  })

  // Periodic heartbeat sweep. Two-tick liveness window: a socket that
  // doesn't `pong` within `heartbeatIntervalMs` of our `ping` sees its
  // tracker flip to `false`; on the NEXT tick we terminate. `try/catch`
  // shrugs at any peer that races us into CLOSING / CLOSED (`ws.ping` /
  // `ws.terminate` throw in that state) — the close event handles
  // cleanup either way.
  //
  // `unref` so the timer alone doesn't keep the event loop alive
  // (parity with `terminateTimer` in shutdown). Cleared in shutdown so
  // a graceful SIGTERM doesn't fire one last ping race after wss.close.
  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      const peer = peers.get(ws)
      if (peer?.alive === false) {
        try { ws.terminate() } catch {}
        continue
      }
      if (peer) peer.alive = false
      try { ws.ping() } catch {}
    }
  }, heartbeatIntervalMs)
  heartbeatTimer.unref?.()

  return { heartbeatTimer }
}
