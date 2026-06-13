// SSE+POST adapter for the v1 triage-sync relay's fallback transport.
// Exposes the subset of the `WebSocket` API that `socket-transport.ts`
// uses (`readyState` + `OPEN` / `CLOSED` constants, `send` / `close`,
// the `open` / `message` / `close` / `error` event types) so the
// surrounding transport (refcount, reconnect backoff, heartbeat, auth
// flow) doesn't have to branch on the wire underneath.
//
// Wire (server side in server-e2e/sse-server.ts) — POSTs only:
//
//   POST <httpUrl>
//     body: { id?: string, password?: string, frames?: object[] }
//     response: text/event-stream
//
// Each POST opens a fresh `text/event-stream` response that becomes the
// session's downstream channel; the previous POST's response is closed
// server-side when the new one takes over. Outbound frames are batched
// in a ~100 ms window so a UI burst (subscribe + save + ping) coalesces
// into one POST. The session id is a server-minted continuation token:
// on the first POST the client sends none, and the server's first
// `session` event carries the assigned id; on subsequent POSTs the
// client echoes it as the body's `id` field — NEVER in the URL, where
// it would leak into proxy / LB access logs (the sid is a live bearer
// capability for the session's downstream). If a POST lands on a
// replica that doesn't recognise the id (LB routed elsewhere, session
// expired), the replica mints a fresh id, returns it in the new
// response's `session` event, and the client switches over.
// Subscriptions ride re-sendable signed frames on the next POST; auth
// state rides the cached password on every POST.
//
// No EventSource: the SSE downstream is read via the streaming
// response body of each POST (fetch + ReadableStream). EventSource only
// supports GET requests and has its own reconnect/backoff loop we'd
// have to fight.

// Subset of `WebSocket` the outer transport consumes. Listed
// explicitly so a future change in `socket-transport.ts` that reaches
// for a different WS method surfaces here as a compile error.
export type WebSocketLike = {
  readonly CONNECTING: 0
  readonly OPEN: 1
  readonly CLOSING: 2
  readonly CLOSED: 3
  readyState: number
  send(data: string): void
  close(): void
  addEventListener(event: 'open' | 'message' | 'close' | 'error', listener: (ev: Event | MessageEvent) => void): void
}

// Translates `ws://host/path` → `http://host/path` so the adapter can
// derive the POST endpoint from the same URL the caller would have
// passed `new WebSocket(...)`. The server mounts the SSE plane at the
// same path as the WS upgrade — see server-e2e/http.ts `WS_UPGRADE_PATH`
// and `server-e2e/sse-server.ts SSE_OPEN_PATH` which is
// `${WS_UPGRADE_PATH}/sse`.
// Scheme-convert (ws→http / wss→https) and strip any `?…` build/debug tags,
// yielding the http(s) base at the WS upgrade path. The SSE (`/sse`) and
// REST-save (`/save`) planes are siblings of that path on the server.
function wsUrlToHttpBase(wsUrl: string): string {
  let httpScheme: string
  let rest: string
  if (wsUrl.startsWith('wss://')) { httpScheme = 'https://'; rest = wsUrl.slice(6) }
  else if (wsUrl.startsWith('ws://')) { httpScheme = 'http://'; rest = wsUrl.slice(5) }
  else if (wsUrl.startsWith('https://')) { httpScheme = 'https://'; rest = wsUrl.slice(8) }
  else if (wsUrl.startsWith('http://')) { httpScheme = 'http://'; rest = wsUrl.slice(7) }
  else throw new Error(`sse-transport: unsupported URL scheme: ${wsUrl}`)
  const queryIx = rest.indexOf('?')
  if (queryIx >= 0) rest = rest.slice(0, queryIx)
  return `${httpScheme}${rest}`
}

export function wsUrlToSseUrl(wsUrl: string): string {
  return `${wsUrlToHttpBase(wsUrl)}/sse`
}

// The session-independent REST save plane (server-e2e/http.ts SAVE_REST_PATH =
// `${WS_UPGRADE_PATH}/save`). triage-sync POSTs saves here in SSE mode so a
// save doesn't take over the event-stream.
export function wsUrlToSaveUrl(wsUrl: string): string {
  return `${wsUrlToHttpBase(wsUrl)}/save`
}

// 100ms outbound coalesce window. Saves + subscribes + pings produced
// by a tight UI burst land in one POST instead of N. Bounded small so
// the first frame of any burst still hits the wire promptly.
const FLUSH_DELAY_MS = 100

// Hard ceiling for waiting on a previous in-flight POST to settle.
// Steady-state a POST settles in one RTT; if it doesn't (slow network,
// blocked replica), the next POST goes out anyway — closing the prior
// response server-side is the takeover signal we want here.
const FLUSH_MAX_WAIT_MS = 5_000

// Client-side liveness ceiling for the live SSE downstream. The server
// writes a `:` keepalive comment to every open session's response every
// server-e2e/sse-server.ts KEEPALIVE_SWEEP_MS (30s), so a healthy live
// stream delivers SOME bytes at least that often even when idle. If
// NOTHING arrives within this window — no keepalive, no data, and no
// EOF (a wedged TLS-terminating proxy that holds the socket open but
// stops forwarding, a silently-dropped NAT mapping) — the downstream is
// dead in a way the bare-EOF path below can't observe, so we tear down
// and let the outer socket-transport reconnect. This is the SSE plane's
// analogue of the WS pong-timeout (socket-transport `startHeartbeat`):
// the SSE plane sends no client ping, so the server's keepalive is the
// only liveness beat we get. Generous (2.5× the sweep) to absorb a
// dropped keepalive + scheduling jitter without a false reconnect.
let downstreamTimeoutMs = 75_000

// Test-only knob: lower the downstream-inactivity window so a unit test
// can drive the watchdog without waiting the full production timeout
// (the peer of socket-transport's `setHeartbeatTimings`). Production
// constructs `SseTransport` with the default 75s.
export function setSseDownstreamTimeoutMs(ms: number): void {
  downstreamTimeoutMs = typeof ms === 'number' && ms > 0 ? ms : 75_000
}

// SSE frame parser. Splits a streaming chunk buffer on `\n\n` event
// terminators and yields each event with its name + concatenated data
// lines. Holds incomplete trailing bytes in `buf` for the next call.
// Server emits only `session` (continuation token), `close` (graceful
// shutdown), and default `message` events; we forward the latter and
// handle the others inline.
class SseParser {
  private buf = ''
  parse(chunk: string): Array<{ event: string; data: string }> {
    this.buf += chunk
    const events: Array<{ event: string; data: string }> = []
    let sep
    while ((sep = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, sep)
      this.buf = this.buf.slice(sep + 2)
      let event = ''
      const dataLines: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue  // SSE comment (server keepalive)
        if (line.startsWith('event:')) { event = line.slice(6).trim(); continue }
        if (line.startsWith('data:')) { dataLines.push(line.slice(5).replace(/^ /u, '')); continue }
        // `retry:` and other SSE directives — ignored. Client never
        // auto-reconnects; the outer socket-transport owns reconnect.
      }
      if (dataLines.length === 0) continue
      events.push({ event, data: dataLines.join('\n') })
    }
    return events
  }
}

type PendingFrame = { type: string; [k: string]: unknown }

export class SseTransport extends EventTarget implements WebSocketLike {
  static readonly CONNECTING = 0 as const
  static readonly OPEN = 1 as const
  static readonly CLOSING = 2 as const
  static readonly CLOSED = 3 as const
  readonly CONNECTING = SseTransport.CONNECTING
  readonly OPEN = SseTransport.OPEN
  readonly CLOSING = SseTransport.CLOSING
  readonly CLOSED = SseTransport.CLOSED

  readyState: number = SseTransport.CONNECTING

  private readonly baseUrl: string
  // Server-minted continuation token. Null until the first response's
  // `session` event lands. Echoed as the `id` body field on every
  // subsequent POST (never the URL — see the header note on log leak).
  // A new value mid-life means the previous session was lost (replica
  // takeover or timeout) and a fresh session was minted — the outer
  // transport observes a new `challenge` frame and re-subscribes.
  private sessionId: string | null = null
  // Cached password from the most recent `authenticate` frame the
  // outer transport pushed through `send`. Sent as a body field on
  // every POST so a session-takeover replica re-authenticates without
  // an extra round-trip.
  private cachedPassword: string | null = null
  // Frames queued for the next POST flush. `send` enqueues; the
  // flush timer drains.
  private outbound: PendingFrame[] = []
  // Flush timer handle; null when no flush is pending.
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  // The in-flight POST's `Promise<Response>` chain. Concurrent POSTs
  // are disallowed — a new flush waits for this to settle (up to
  // FLUSH_MAX_WAIT_MS) before opening its own POST. The previous
  // POST's response stream stays attached server-side until the new
  // POST arrives, so broadcasts flow on it during the wait.
  private inFlightPost: Promise<void> | null = null
  // Every reader currently draining a POST response. A new POST opens
  // its own reader; the *previous* reader keeps draining (the server
  // end()s its response on takeover, so it EOFs naturally). On
  // shutdown we cancel them ALL so a hung response can't keep firing
  // MessageEvents past CLOSED.
  private readonly activeReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>()
  // AbortController shared by every in-flight fetch — abort()'d on
  // shutdown so a hung POST (headers never arriving) tears down with
  // the rest of the transport instead of leaving a stranded socket.
  private readonly fetchAbort = new AbortController()
  // Monotonic id stamped on each POST as it's issued. `consumeStream`
  // captures its POST's value; on a bare response EOF it compares back
  // to `postSeq` to tell the LIVE downstream (still the latest → the
  // connection died, reconnect) from a SUPERSEDED reader (a newer POST
  // already took over → the normal takeover, stay quiet). Bumped at
  // issue time in `flush`, BEFORE the fetch, so a prior stream that EOFs
  // the instant its successor is issued already observes the higher
  // value and so stays silent.
  private postSeq = 0
  // Inactivity watchdog for the live downstream (see downstreamTimeoutMs).
  // (Re)armed when a POST is issued and on every byte the live stream
  // delivers; fires → shutdown. Null when disarmed (never armed / shut
  // down).
  private downstreamWatchdog: ReturnType<typeof setTimeout> | null = null

  constructor(wsUrl: string) {
    super()
    this.baseUrl = wsUrlToSseUrl(wsUrl)
    // First POST immediately so the session opens before any consumer
    // frames arrive. An empty-body POST is a valid "open me" probe — the
    // server mints a session, writes the `session` event + `challenge`
    // frame, and keeps the response stream open.
    this.scheduleFlush(/* now= */ true)
  }

  // Outer transport's `send`. The `authenticate` frame carries the
  // password and is intercepted here (extracted to the per-POST body
  // field); every other frame is enqueued for the next flush.
  send(data: string): void {
    if (this.readyState === SseTransport.CLOSED) {
      throw new Error('sse-transport: send on closed transport')
    }
    let frame: PendingFrame
    try { frame = JSON.parse(data) as PendingFrame }
    catch (err) { throw new Error(`sse-transport: send received non-JSON payload: ${(err as Error).message}`, { cause: err }) }
    if (frame.type === 'authenticate' && typeof frame['password'] === 'string') {
      // The shared dispatcher's WS path treats `authenticate` as a
      // synchronous fast-path inline send. For SSE we surface the
      // password as a per-POST body field so it rides on every POST —
      // a replica that didn't have the session re-authenticates the
      // moment it picks one up. The frame itself is not sent on the
      // wire (the server side re-synthesises it from `body.password`).
      this.cachedPassword = frame['password']
      this.scheduleFlush()
      return
    }
    this.outbound.push(frame)
    this.scheduleFlush()
  }

  close(): void { this.shutdown() }

  // Debounced flush. `now=true` skips the debounce (used by the
  // constructor's opening POST and by `authenticate` if needed).
  private scheduleFlush(now: boolean = false): void {
    if (this.readyState === SseTransport.CLOSED) return
    if (this.flushTimer != null) {
      if (now) {
        clearTimeout(this.flushTimer)
        this.flushTimer = null
      } else {
        return  // already scheduled within the window
      }
    }
    const delay = now ? 0 : FLUSH_DELAY_MS
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, delay)
  }

  // (Re)arm the downstream-inactivity watchdog. Called when a POST is
  // issued and on every byte the live stream delivers, so the timer only
  // fires after a full `downstreamTimeoutMs` with no sign of life on the
  // downstream — at which point the channel is presumed dead and we shut
  // down so the outer transport reconnects.
  private armDownstreamWatchdog(): void {
    if (this.readyState === SseTransport.CLOSED) return
    if (this.downstreamWatchdog != null) clearTimeout(this.downstreamWatchdog)
    this.downstreamWatchdog = setTimeout(() => {
      this.downstreamWatchdog = null
      if (this.readyState === SseTransport.CLOSED) return
      console.warn('sse-transport: no downstream activity within the liveness window; reconnecting')
      this.shutdown()
    }, downstreamTimeoutMs)
    // Don't let the watchdog by itself keep a Node event loop alive
    // (parity with the server keepalive timer); a browser timer id is a
    // number and ignores this.
    this.downstreamWatchdog.unref?.()
  }

  // One POST cycle: serialise the outbound buffer, await any in-flight
  // POST (so we don't open two concurrent streams), then issue the
  // POST and drive its response body through the SSE parser. If a new
  // flush is scheduled while we're still reading the response, that's
  // fine — the OLD reader keeps draining until the server end()s the
  // stream on takeover, while the new flush opens its own POST.
  private async flush(): Promise<void> {
    if (this.readyState === SseTransport.CLOSED) return
    // Wait for the previous POST's headers + body, capped so a stalled
    // server doesn't pin us forever. The server closes the previous
    // response when the next POST arrives, so leaving a long-tail read
    // behind is fine — its reader keeps draining its frames.
    if (this.inFlightPost) {
      const timer = new Promise<void>((resolve) => { setTimeout(resolve, FLUSH_MAX_WAIT_MS) })
      await Promise.race([this.inFlightPost.catch(() => {}), timer])
    }
    if (this.readyState === SseTransport.CLOSED) return
    // Snapshot the outbound buffer + password so concurrent `send`
    // calls during the await above don't accidentally clear what we're
    // about to ship.
    const frames = this.outbound
    this.outbound = []
    const body: { id?: string; password?: string; frames?: PendingFrame[] } = {}
    if (this.sessionId != null) body.id = this.sessionId
    if (this.cachedPassword != null) body.password = this.cachedPassword
    if (frames.length > 0) body.frames = frames
    const url = this.baseUrl
    // Stamp this POST and (re)arm the liveness watchdog up front:
    // issuing a POST is itself a sign of life and opens a fresh
    // downstream, so it refreshes the window even before the response's
    // first byte lands — covering the brief takeover gap while the new
    // fetch is in flight and the prior stream has stopped being live.
    const seq = ++this.postSeq
    this.armDownstreamWatchdog()
    const post = (async (): Promise<void> => {
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
          // signal so shutdown() can abort an in-flight fetch whose
          // headers never arrive — otherwise a hung server keeps the
          // socket pinned past close().
          signal: this.fetchAbort.signal,
        })
      } catch (err) {
        // Network failure (or shutdown aborted us) → tear the channel
        // down. Outer transport's reconnect loop will retry (with WS
        // first). Suppress the warn when we aborted ourselves — that
        // path is already noisy enough at the close-event site.
        if (this.readyState !== SseTransport.CLOSED) {
          console.warn('sse-transport: POST failed:', err)
        }
        this.shutdown()
        return
      }
      if (!res.ok) {
        if (this.readyState !== SseTransport.CLOSED) {
          console.warn(`sse-transport: POST ${res.status} ${res.statusText}; closing`)
        }
        this.shutdown()
        return
      }
      const stream = res.body
      if (!stream) {
        this.shutdown()
        return
      }
      // Drive the response body in the background so this POST's
      // Promise<void> resolves on headers (releasing the next flush to
      // proceed). Broadcasts and acks land on this reader until the
      // server closes the response on the next POST's takeover.
      void this.consumeStream(stream, seq)
    })()
    this.inFlightPost = post
    post.finally(() => { if (this.inFlightPost === post) this.inFlightPost = null })
  }

  // Reads one POST's response body, parses SSE events, dispatches them.
  // Multiple consumeStream invocations may be running in parallel (the
  // previous POST's reader still draining while the new one starts) —
  // each owns its own parser + reader, registered in `activeReaders`
  // so shutdown can cancel them all.
  private async consumeStream(stream: ReadableStream<Uint8Array>, seq: number): Promise<void> {
    const reader = stream.getReader()
    this.activeReaders.add(reader)
    const parser = new SseParser()
    const decoder = new TextDecoder()
    let reachedEof = false
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) { reachedEof = true; break }
        // Skip dispatch if the transport tore down while we awaited —
        // protects consumers from a post-shutdown phantom-connected
        // frame surfacing through their `onMessage` handler.
        if (this.readyState === SseTransport.CLOSED) return
        // Any byte on the LIVE downstream (data OR the server's `:`
        // keepalive comment, which the parser skips below but which
        // still proves the channel is alive) refreshes the watchdog. A
        // superseded reader (seq < postSeq) must NOT — its successor owns
        // liveness now, and letting a slow-draining old stream reset the
        // timer would mask a dead live downstream.
        if (seq === this.postSeq) this.armDownstreamWatchdog()
        const events = parser.parse(decoder.decode(value, { stream: true }))
        for (const ev of events) this.dispatchEvent_(ev)
      }
      // Flush any partial UTF-8 sequence buffered in the TextDecoder.
      // `decoder.decode()` with no args ends stream mode and emits
      // U+FFFD for incomplete tail bytes (rather than dropping them);
      // run it through the parser in case the tail completes a `data:`
      // line for an event whose `\n\n` terminator was the stream's last
      // bytes.
      if (this.readyState !== SseTransport.CLOSED) {
        const tail = decoder.decode()
        if (tail.length > 0) {
          for (const ev of parser.parse(tail)) this.dispatchEvent_(ev)
        }
      }
      // Bare EOF: the server closed this response with neither a `close`
      // event (dispatchEvent_ already shut us down on that path) nor a
      // newer POST superseding it. On the LIVE downstream (still the
      // latest issued, seq === postSeq) that's a silent death — a server
      // restart, an LB/idle-proxy drop, a reaped session — and because
      // the SSE plane runs no client heartbeat, nothing else would
      // notice; tear down so the outer socket-transport reconnects
      // (WS-first, SSE again on failure). A SUPERSEDED reader EOFing
      // (seq < postSeq) is the normal takeover signal — the server
      // end()s the prior response when the next POST attaches — so it
      // stays silent.
      if (reachedEof && this.readyState !== SseTransport.CLOSED && seq === this.postSeq) {
        console.warn('sse-transport: live downstream closed without a close frame; reconnecting')
        this.shutdown()
      }
    } catch (err) {
      // Same live-vs-superseded split as the bare-EOF path above: a read
      // error on the LIVE downstream (seq === postSeq) is a death →
      // reconnect. A SUPERSEDED reader (seq < postSeq) erroring is the
      // takeover tearing the old connection down — normally a clean
      // end() (the EOF path), but an RST surfaced by the OS / an
      // intermediary lands here instead. Its successor already owns
      // liveness, so drop it silently rather than shutting the healthy
      // stream down.
      if (this.readyState !== SseTransport.CLOSED && seq === this.postSeq) {
        console.warn('sse-transport: stream read failed:', err)
        this.shutdown()
      }
    } finally {
      this.activeReaders.delete(reader)
      try { reader.releaseLock() } catch {}
    }
  }

  // Routes a single SSE event. `session` updates the continuation
  // token (and on the first one, flips us OPEN + fires `open`). `close`
  // is the server-initiated graceful-shutdown signal carrying
  // `{code, reason}`. Default-named `message` events are forwarded to
  // the outer transport.
  private dispatchEvent_(ev: { event: string; data: string }): void {
    if (ev.event === 'session') {
      // Skip if no longer in a state that can use the token: a
      // post-shutdown 'session' from a stale reader has no caller for the
      // new id and could leak it through a future reuse of the instance.
      if (this.readyState === SseTransport.CLOSED) return
      this.sessionId = ev.data
      if (this.readyState === SseTransport.CONNECTING) {
        this.readyState = SseTransport.OPEN
        this.dispatchEvent(new Event('open'))
      }
      return
    }
    if (ev.event === 'close') {
      // Server-initiated graceful close — payload carries `{code,
      // reason}`. Forward both via the close Event so the outer
      // socket-transport can short-circuit reconnect backoff on 1001
      // (parity with the WS 1001 path).
      let code: number | undefined
      let reason: string | undefined
      try {
        const parsed = JSON.parse(ev.data) as { code?: unknown; reason?: unknown }
        if (typeof parsed.code === 'number') code = parsed.code
        if (typeof parsed.reason === 'string') reason = parsed.reason
      } catch {}
      this.shutdown(code, reason)
      return
    }
    if (ev.event === '' || ev.event === 'message') {
      if (this.readyState !== SseTransport.OPEN) return
      this.dispatchEvent(new MessageEvent('message', { data: ev.data }))
    }
  }

  // `code` / `reason` propagate onto the dispatched close event (parity
  // with WebSocket CloseEvent). Plain `Event` with fields attached
  // directly, not `CloseEvent` — the latter isn't available in some Node
  // test envs, and the outer's `ev.code` read works either way.
  private shutdown(code?: number, reason?: string): void {
    if (this.readyState === SseTransport.CLOSED) return
    this.readyState = SseTransport.CLOSING
    if (this.flushTimer != null) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (this.downstreamWatchdog != null) { clearTimeout(this.downstreamWatchdog); this.downstreamWatchdog = null }
    // Abort the in-flight fetch (if any), then cancel every active
    // reader so a stuck stream can't keep firing past CLOSED.
    try { this.fetchAbort.abort() } catch {}
    for (const reader of this.activeReaders) {
      try { reader.cancel().catch(() => {}) } catch {}
    }
    this.activeReaders.clear()
    this.readyState = SseTransport.CLOSED
    const event: Event & { code?: number; reason?: string } = new Event('close')
    if (code != null) event.code = code
    if (reason != null) event.reason = reason
    this.dispatchEvent(event)
  }
}
