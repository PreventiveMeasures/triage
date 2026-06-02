// Per-connection state for the SSE+POST fallback. Each session pins to
// the *latest* POST's response stream — the previous POST's response
// is closed when a new POST takes over. This shape sidesteps sticky-
// routing in multi-replica deployments: a POST that lands on a
// replica that doesn't know the session id mints a fresh session with
// a new id (returned via the first `session` event); the client then
// continues against the new id with all subsequent POSTs. Subscriptions
// and auth state ride re-sendable signed frames + a client-cached
// password, so the new replica reconstructs locally.
//
// Mimics the subset of `ws.WebSocket` that `setupPeerConnection` (in
// ./ws-server.ts), the hub (./hub.ts) and the lifecycle shutdown loop
// (./lifecycle.ts) read: `readyState` + `OPEN`/`CLOSING` constants,
// `send` / `close` / `terminate` / `ping`, the `bufferedAmount`
// backpressure signal, and the `message` / `close` / `error` / `pong`
// EventEmitter surface. The per-connection dispatcher is single-
// sourced — it doesn't know whether it's talking to a real WebSocket
// or this adapter.
//
// Wire shape: each outbound frame becomes a single SSE `data:` field.
// The dispatcher emits JSON via `JSON.stringify` (no embedded newlines
// after that round-trip), so a single-line `data:` is enough; we still
// split-on-newline defensively for any future caller that hands raw
// multi-line text. Inbound frames are injected via `receiveMessage`
// after the POST plane reads the body.

import { EventEmitter } from 'node:events'
import type { Buffer } from 'node:buffer'
import type { ServerResponse } from 'node:http'

// TCP keepalive idle delay for the downstream socket. With the client no
// longer POSTing a periodic ping (see client/sync/socket-transport.ts), a
// QUIET session whose client vanished without a FIN (crash, NAT/idle drop)
// has no application-level liveness signal — so we lean on the kernel:
// after this much idle the kernel starts probing, and a dead half-open
// socket surfaces as a `close`/`error` here. Node's `setKeepAlive` sets
// only TCP_KEEPIDLE (the delay to the FIRST probe), not the probe
// interval/count — so full teardown is this delay PLUS the OS's
// TCP_KEEPINTVL × TCP_KEEPCNT (~minutes on Linux defaults), still bounded
// and far below the kernel's hours-long default-off behaviour. `maxSessions`
// is the hard backstop. Behind a TLS-terminating / buffering proxy this
// probes the proxy hop, not the client — see the reaping note in sse-server.ts.
const SOCKET_KEEPALIVE_MS = 30_000

export class SseSession extends EventEmitter {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  // Per-instance constants so `socket.OPEN` reads identically to the
  // `ws.WebSocket` shape the dispatcher and hub strict-compare against.
  readonly CONNECTING = SseSession.CONNECTING
  readonly OPEN = SseSession.OPEN
  readonly CLOSING = SseSession.CLOSING
  readonly CLOSED = SseSession.CLOSED

  readyState: number = SseSession.OPEN
  // The current downstream stream the session writes to. Each POST
  // replaces this; broadcasts and ack frames flow on the latest one.
  // Null between POSTs is *only* a transient state during swap — the
  // session is created with a response in hand and the swap is
  // synchronous from the dispatcher's perspective.
  private currentRes: ServerResponse | null

  constructor(res: ServerResponse) {
    super()
    this.currentRes = res
    this.wireResponse(res)
  }

  // Wire the close / error events on a freshly-attached response. The
  // close event only matters for the *current* response — a previous
  // response's close (after it was swapped out) is not a session-level
  // signal. Same guard applies to error: a TCP-level error during
  // res.end() flush on a swapped-out response would otherwise emit a
  // spurious session 'error' that operators read as a real transport
  // failure on a healthy session.
  private wireResponse(res: ServerResponse): void {
    // Probe half-open downstreams at the kernel level (see SOCKET_KEEPALIVE_MS).
    // A failed probe trips the `close`/`error` handlers below, which is how a
    // dead-but-quiet SSE client is reaped now that there's no client ping.
    try { res.socket?.setKeepAlive(true, SOCKET_KEEPALIVE_MS) } catch {}
    res.on('close', () => {
      if (res !== this.currentRes) return  // current-response guard (see above)
      if (this.readyState === SseSession.CLOSED) return
      this.readyState = SseSession.CLOSED
      this.currentRes = null
      this.emit('close')
    })
    res.on('error', (err: Error) => {
      if (res !== this.currentRes) return  // current-response guard (see above)
      this.emit('error', err)
    })
  }

  // Swap in a new response (the latest POST's body). The previous
  // response is end()ed cleanly so the client's reader sees EOF and
  // stops draining; the takeover-grace handling for in-flight buffered
  // bytes is on the client side (it keeps reading the old stream until
  // EOF before switching). Returns true when the session was alive and
  // the swap happened; false when the session is closed and the new
  // response should be ended by the caller.
  attachResponse(res: ServerResponse): boolean {
    if (this.readyState !== SseSession.OPEN) return false
    const prev = this.currentRes
    this.currentRes = res
    this.wireResponse(res)
    // End the previous stream AFTER the new one is wired so any
    // broadcast racing the swap lands on the new response, not on the
    // half-closed old one. `end()` flushes Node's send buffer before
    // sending FIN — frames already written drain to the client.
    if (prev) { try { prev.end() } catch {} }
    return true
  }

  // `hub.sendRaw` consults this before each send to decide whether to
  // terminate (slow / blackholed peer). `writableLength` is the count
  // of bytes queued in Node's HTTP stream that haven't drained to the
  // kernel yet — the SSE-channel equivalent of `ws`'s `bufferedAmount`.
  get bufferedAmount(): number {
    return this.currentRes?.writableLength ?? 0
  }

  // Encodes one JSON frame as a single SSE event. Splits on `\n` so a
  // multi-line payload still produces a well-formed event (each `data:`
  // line is concatenated with `\n` by the SSE parser on the client),
  // but `JSON.stringify` output won't trigger that branch.
  send(payload: string | Buffer): void {
    if (this.readyState !== SseSession.OPEN) return
    const res = this.currentRes
    if (!res) return
    const text = typeof payload === 'string' ? payload : payload.toString('utf8')
    const lines = text.split('\n')
    const wire = `${lines.map((l) => `data: ${l}`).join('\n')}\n\n`
    try { res.write(wire) } catch {}
  }

  // Writes a named SSE event (e.g. `session` for the continuation token
  // handshake). Used by sse-server.ts on session creation; not part of
  // the WebSocket-shaped surface and never called by the shared
  // dispatcher.
  writeEvent(event: string, data: string): void {
    if (this.readyState !== SseSession.OPEN) return
    const res = this.currentRes
    if (!res) return
    const lines = data.split('\n')
    const body = `${lines.map((l) => `data: ${l}`).join('\n')}`
    try { res.write(`event: ${event}\n${body}\n\n`) } catch {}
  }

  // Lifecycle's graceful-shutdown loop calls this with `(1001, '…')` to
  // signal a server-initiated close. SSE has no native close code, so
  // we emit a structured `close` event with the WS-style `{ code,
  // reason }` payload — the client's transport reads it and bypasses
  // its reconnect backoff (parity with the WS 1001 path).
  //
  // emit('close') is fired EXPLICITLY here, not via the res.on('close')
  // listener: that listener short-circuits on `readyState === CLOSED`
  // (so a later async res-close after we've flipped state doesn't
  // double-emit), which means without the explicit emit here neither
  // sse-server's dropSession cleanup nor setupPeerConnection's
  // unsubscribeAll/peers.delete would run on any server-initiated
  // teardown — the sessions map / hub.subscribers would leak per close.
  // The wireResponse guard then ensures the later async fire is a no-op.
  close(code?: number, reason?: string): void {
    if (this.readyState === SseSession.CLOSED) return
    const res = this.currentRes
    if (this.readyState === SseSession.OPEN && code != null && res) {
      try { res.write(`event: close\ndata: ${JSON.stringify({ code, reason: reason ?? '' })}\n\n`) } catch {}
    }
    this.readyState = SseSession.CLOSING
    if (res) { try { res.end() } catch {} }
    this.currentRes = null
    this.readyState = SseSession.CLOSED
    this.emit('close')
  }

  // Force-tear without flushing — mirrors `ws.terminate()`. Hub's
  // backpressure path and the lifecycle's terminate-grace timer call
  // this to drop unresponsive peers. Same explicit `emit('close')`
  // story as close() above — without it, the wireResponse guard would
  // swallow the later async res-close and the cleanup callbacks
  // (dropSession, peers.delete, unsubscribeAll) would never run.
  terminate(): void {
    if (this.readyState === SseSession.CLOSED) return
    this.readyState = SseSession.CLOSED
    const res = this.currentRes
    this.currentRes = null
    if (res) { try { res.destroy() } catch {} }
    this.emit('close')
  }

  // Server-driven keepalive, called on the SSE keepalive sweep in
  // sse-server.ts. SSE has no `pong` equivalent, so we write a `:` comment
  // line — ignored by the client parser — that keeps the downstream from
  // being idle-closed by intermediary proxies (nginx et al. default to a
  // ~60s read timeout). Dead-client detection is the response `close` event
  // (clean disconnect, or a half-open socket the TCP keepalive in
  // `wireResponse` forces closed), NOT this write: a `:`-comment write to a
  // half-open socket just buffers, it doesn't synchronously throw.
  ping(): void {
    if (this.readyState !== SseSession.OPEN) return
    const res = this.currentRes
    if (!res) return
    try { res.write(':\n\n') } catch {}
  }

  // Injects a client-to-server frame from the POST plane into the same
  // `message` event the dispatcher already listens for on real WSs.
  // `isBinary=false` because the SSE+POST plane is JSON-only by
  // contract — the binary-frame drop in the dispatcher reads this.
  receiveMessage(data: Buffer): void {
    if (this.readyState !== SseSession.OPEN) return
    this.emit('message', data, false)
  }
}
