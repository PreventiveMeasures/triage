// SSE+POST adapter for the v1 triage-sync relay's fallback transport.
// Exposes the subset of the `WebSocket` API that `socket-transport.ts`
// uses (`readyState` + `OPEN` / `CLOSED` constants, `send` / `close`,
// the `open` / `message` / `close` / `error` event types) so the
// surrounding transport (refcount, reconnect backoff, heartbeat, auth
// flow) doesn't have to branch on the wire underneath.
//
// Wire (server side in server/sse-server.ts) — POSTs only:
//
//   POST <httpUrl>[?id=<sid>]
//     body: { password?: string, frames?: object[] }
//     response: text/event-stream
//
// Each POST opens a fresh `text/event-stream` response that becomes the
// session's downstream channel; the previous POST's response is closed
// server-side when the new one takes over. Outbound frames are batched
// in a ~100 ms window so a UI burst (subscribe + save + ping) coalesces
// into one POST. The session id is a server-minted continuation token:
// on the first POST the client sends none, and the server's first
// `session` event carries the assigned id; on subsequent POSTs the
// client echoes it in `?id=`. If a POST lands on a replica that
// doesn't recognise the id (LB routed elsewhere, session expired), the
// replica mints a fresh id, returns it in the new response's `session`
// event, and the client switches over. Subscriptions ride re-sendable
// signed frames on the next POST; auth state rides the cached password
// on every POST.
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
// same path as the WS upgrade — see server/http.ts `WS_UPGRADE_PATH`
// and `server/sse-server.ts SSE_OPEN_PATH` which is
// `${WS_UPGRADE_PATH}/sse`.
export function wsUrlToSseUrl(wsUrl: string): string {
  let httpScheme: string
  let rest: string
  if (wsUrl.startsWith('wss://')) { httpScheme = 'https://'; rest = wsUrl.slice(6) }
  else if (wsUrl.startsWith('ws://')) { httpScheme = 'http://'; rest = wsUrl.slice(5) }
  else if (wsUrl.startsWith('https://')) { httpScheme = 'https://'; rest = wsUrl.slice(8) }
  else if (wsUrl.startsWith('http://')) { httpScheme = 'http://'; rest = wsUrl.slice(7) }
  else throw new Error(`sse-transport: unsupported URL scheme: ${wsUrl}`)
  // Strip any `?…` the caller may have appended (build / debug tags
  // on the WS upgrade URL); the SSE endpoint doesn't need them.
  const queryIx = rest.indexOf('?')
  if (queryIx >= 0) rest = rest.slice(0, queryIx)
  return `${httpScheme}${rest}/sse`
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
  // `session` event lands. Echoed in `?id=` on every subsequent POST.
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
  // AbortController for the currently-reading response stream so we
  // can tear it down on `close()` without leaving a stranded fetch.
  private currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  // EventTarget surface for the outer transport's
  // `addEventListener('open' / 'message' / 'close' / 'error', …)`.
  // The first `session` event flips us from CONNECTING → OPEN.

  constructor(wsUrl: string) {
    super()
    this.baseUrl = wsUrlToSseUrl(wsUrl)
    // Kick off the first POST immediately so the session opens before
    // any consumer frames arrive. An empty-body POST is a valid "open
    // me" probe — the server mints a session, writes the `session`
    // event + `challenge` frame, and keeps the response stream open.
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

  // One POST cycle: serialise the outbound buffer, await any in-flight
  // POST (so we don't open two concurrent streams), then issue the
  // POST and drive its response body through the SSE parser. If a new
  // flush is scheduled while we're still reading the response, that's
  // fine — the OLD reader keeps draining until the server end()s the
  // stream on takeover, while the new flush opens its own POST.
  private async flush(): Promise<void> {
    if (this.readyState === SseTransport.CLOSED) return
    // Wait for the previous POST to send its headers + body, but cap
    // the wait so a stalled server doesn't pin us forever. The server
    // closes the previous response when the next POST arrives, so a
    // long-tail response read is OK to leave behind — the post-send
    // path keeps reading it for any in-flight frames.
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
    const body: { password?: string; frames?: PendingFrame[] } = {}
    if (this.cachedPassword != null) body.password = this.cachedPassword
    if (frames.length > 0) body.frames = frames
    const url = this.sessionId == null
      ? this.baseUrl
      : `${this.baseUrl}?id=${encodeURIComponent(this.sessionId)}`
    const post = (async (): Promise<void> => {
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
        })
      } catch (err) {
        // Network failure → tear the channel down. Outer transport's
        // reconnect loop will retry (with WS first).
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
      void this.consumeStream(stream)
    })()
    this.inFlightPost = post
    post.finally(() => { if (this.inFlightPost === post) this.inFlightPost = null })
  }

  // Reads one POST's response body, parses SSE events, dispatches them.
  // Multiple consumeStream invocations may be running in parallel (the
  // previous POST's reader still draining while the new one starts) —
  // each owns its own parser + reader, no shared state.
  private async consumeStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    // Track only the latest reader for the close() teardown — letting
    // the older one drain naturally is fine (server end()s it).
    this.currentReader = reader
    const parser = new SseParser()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const events = parser.parse(decoder.decode(value, { stream: true }))
        for (const ev of events) this.dispatchEvent_(ev)
      }
    } catch (err) {
      if (this.readyState !== SseTransport.CLOSED) {
        console.warn('sse-transport: stream read failed:', err)
        this.shutdown()
      }
    } finally {
      if (this.currentReader === reader) this.currentReader = null
      try { reader.releaseLock() } catch {}
    }
  }

  // Routes a single SSE event. `session` updates the continuation
  // token (and on the first one, flips us OPEN + fires `open`). `close`
  // is the server-initiated graceful-shutdown signal. Default-named
  // `message` events are forwarded to the outer transport.
  private dispatchEvent_(ev: { event: string; data: string }): void {
    if (ev.event === 'session') {
      this.sessionId = ev.data
      if (this.readyState === SseTransport.CONNECTING) {
        this.readyState = SseTransport.OPEN
        this.dispatchEvent(new Event('open'))
      }
      return
    }
    if (ev.event === 'close') {
      // Server-initiated close (graceful shutdown). Tear down without
      // resending the close on the outer transport — `shutdown` fires
      // it once.
      this.shutdown()
      return
    }
    if (ev.event === '' || ev.event === 'message') {
      this.dispatchEvent(new MessageEvent('message', { data: ev.data }))
    }
  }

  private shutdown(): void {
    if (this.readyState === SseTransport.CLOSED) return
    this.readyState = SseTransport.CLOSING
    if (this.flushTimer != null) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (this.currentReader) {
      try { this.currentReader.cancel().catch(() => {}) } catch {}
      this.currentReader = null
    }
    this.readyState = SseTransport.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}
