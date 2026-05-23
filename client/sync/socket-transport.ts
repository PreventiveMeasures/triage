// Shared transport for the v1 triage-sync relay's two client-side
// consumers (`client/triage-sync.ts` and `client/objstore.ts`). Owns
// the socket lifecycle, reconnect backoff, per-connection challenge
// nonce, application-level heartbeat, and the operator-side
// `authenticate` flow. The wire is preferentially a WebSocket; when
// `new WebSocket(…)` errors before `open` (corporate proxies that
// strip the Upgrade header, hostile network middleboxes, browser
// extensions blocking the upgrade), the transport falls back to an
// SSE+POST pair that exposes the same WebSocket-shaped surface (see
// ./sse-transport.ts). The fallback is per-open-attempt: each
// reconnect tries WS first and falls back to SSE again on failure.
//
// Lifecycle (refcount): each consumer that wants the socket open
// holds a `transport.acquire()` handle. The socket opens on the
// first acquire and closes on the last release; reconnect is
// scheduled only while `acquireCount > 0`.
//
// Dispatch: `pong`, `challenge`, and `unauthorized.auth-failed`
// are transport-internal. `authenticated` passes through (triage-
// sync uses it as a "kick deferred sends" signal). Everything
// else fans to consumers in registration order. `handleMessage`
// MUST stay synchronous — consumers with async handlers chain
// them inside their own `onMessage` (the triage-sync pattern).
//
// Auth flow: `runAuthFlow()` is singleton per-socket; concurrent
// callers coalesce. Pinned to `startSocket` at entry — a mid-flow
// disconnect bails false rather than landing the authenticate on
// a fresh socket whose gate state has been reset.

import { getCachedSyncPassword, setCachedSyncPassword } from './sync-auth-cache.ts'
import { SseTransport, type WebSocketLike } from './sse-transport.ts'

export type AuthResolver = (context: { retry: boolean }) => Promise<string | null | undefined>

export type SocketTransportDeps = {
  // Empty string is allowed — `setServerUrl(url)` populates later.
  serverUrl: string
  // Optional. Shared between consumers since the server's
  // `socketAuthorized` flag is per-WebSocket.
  authResolver?: AuthResolver
  // Heartbeat cadence in ms. 0 disables (test seam). Defaults:
  // 15 s ping, 5 s pong timeout.
  pingIntervalMs?: number
  pongTimeoutMs?: number
}

// Wire-shape envelope every server frame lands as post-JSON.parse.
type WireMessage = { type?: unknown; [k: string]: unknown }

export type TransportConsumer = {
  // MUST return synchronously (see file-header dispatch invariant).
  onMessage(msg: WireMessage): void
  // Fires after the server's `challenge` frame lands; `nonce` is
  // bound into every subsequent signed frame.
  onConnected(nonce: string): void
  // Fires on socket close / transport-close / release. `reason` is
  // a human-readable tag, not a stable identifier.
  onDisconnected(reason: string): void
}

export type AcquireHandle = { release(): void }
export type ConsumerHandle = { remove(): void }

export type SocketTransport = {
  // Refcount the "want it open" signal. Socket opens on first
  // acquire, closes on last release. Double-release is a no-op.
  acquire(): AcquireHandle
  // Swap the server URL. Tears down + re-opens (if still acquired).
  // Same-URL is no-op; empty-string tears down without re-opening.
  setServerUrl(url: string): void
  // Consumers fire in registration order (`Set` iterates insertion-
  // ordered per ECMA-262).
  addConsumer(consumer: TransportConsumer): ConsumerHandle
  // Returns false (no throw) when the socket isn't OPEN — caller
  // decides whether to throw, queue, or drop.
  send(msg: object): boolean
  // Null before `challenge` lands / after disconnect. Async signers
  // must capture into a local + re-check before sending.
  getNonce(): string | null
  // Stale-check primitive: `getSocket() !== captured` means the
  // socket has swapped since the capture. The concrete type is either
  // the real `WebSocket` or the `SseTransport` adapter; consumers
  // only compare identity, so the union surface is enough.
  getSocket(): WebSocketLike | null
  // Singleton per-socket; concurrent callers coalesce. Returns
  // false on cancel / no resolver / socket-swap-mid-flow.
  runAuthFlow(): Promise<boolean>
  // Force teardown. Idempotent. Acquisitions held after `close()`
  // are stale handles whose `release()` is a no-op.
  close(): void
  // Test seam. Pass `0` to `pingMs` to disable.
  setHeartbeatTimings(opts: { pingMs?: number; pongMs?: number }): void
  // Re-arm "silent cached-password replay" so the NEXT
  // `runAuthFlow` against the current socket tries the cache
  // again. Boot-after-unlock path: a fresh cache landing after the
  // auth flow already gave up should get one more silent attempt
  // without forcing a reconnect.
  resetCachedReplayGuard(): void
}

const INITIAL_RECONNECT_DELAY = 1_000
const MAX_RECONNECT_DELAY = 30_000

export function createSocketTransport(deps: SocketTransportDeps): SocketTransport {
  let serverUrl = deps.serverUrl
  let pingIntervalMs = deps.pingIntervalMs ?? 15_000
  let pongTimeoutMs = deps.pongTimeoutMs ?? 5_000

  // `socket` carries either a real WebSocket (preferred path) or an
  // `SseTransport` adapter (fallback path); both implement the same
  // `WebSocketLike` surface — readyState constants, `send`, `close`,
  // and the `open` / `message` / `close` / `error` event types. The
  // outer transport branches on neither: `handleMessage`,
  // `runAuthFlow`, `setHeartbeatTimings`, etc. just call the subset
  // both expose.
  let socket: WebSocketLike | null = null
  let connectionNonce: string | null = null
  let acquireCount = 0
  let transportClosed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY
  let pingIntervalId: ReturnType<typeof setInterval> | null = null
  let pongTimeoutId: ReturnType<typeof setTimeout> | null = null

  // Per-socket auth state. `cachedPasswordTriedOnThisSocket`
  // enforces "silent replay once per socket" so a wrong cached
  // password doesn't ping-pong `unauthorized` ↔ `authenticate`.
  let authFlowInFlight: Promise<boolean> | null = null
  let cachedPasswordTriedOnThisSocket = false
  let authResponseResolver: ((ok: boolean) => void) | null = null

  const consumers = new Set<TransportConsumer>()

  function clearReconnect(): void {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  }

  function scheduleReconnect(): void {
    clearReconnect()
    if (transportClosed) return
    if (acquireCount === 0) return
    if (!serverUrl) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      openSocket()
    }, reconnectDelayMs)
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY)
  }

  function startHeartbeat(): void {
    stopHeartbeat()
    if (pingIntervalMs <= 0) return
    pingIntervalId = setInterval(() => {
      // `socket.OPEN` (instance constant) rather than the bare global
      // `WebSocket.OPEN` — when the SSE fallback engaged because there
      // is NO global `WebSocket` constructor at all (Node SSR, hostile
      // browser env), the global form throws ReferenceError on every
      // tick and silently disables dead-socket detection. Instance
      // constants exist on both real `WebSocket` and the SSE adapter.
      if (!socket || socket.readyState !== socket.OPEN) return
      // Don't double-arm — the existing pongTimeout will close if its pong doesn't land.
      if (pongTimeoutId) return
      send({ type: 'ping' })
      pongTimeoutId = setTimeout(() => {
        pongTimeoutId = null
        console.warn('socket-transport: heartbeat timeout; closing socket')
        try { socket?.close() } catch {}
      }, pongTimeoutMs)
    }, pingIntervalMs)
  }

  function stopHeartbeat(): void {
    if (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = null }
    if (pongTimeoutId) { clearTimeout(pongTimeoutId); pongTimeoutId = null }
  }

  function notifyDisconnected(reason: string): void {
    for (const c of consumers) {
      try { c.onDisconnected(reason) }
      catch (err) { console.warn('socket-transport: consumer.onDisconnected threw:', err) }
    }
  }

  function notifyConnected(nonce: string): void {
    for (const c of consumers) {
      try { c.onConnected(nonce) }
      catch (err) { console.warn('socket-transport: consumer.onConnected threw:', err) }
    }
  }

  function dispatchMessage(msg: WireMessage): void {
    for (const c of consumers) {
      try { c.onMessage(msg) }
      catch (err) { console.warn('socket-transport: consumer.onMessage threw:', err) }
    }
  }

  // MUST REMAIN SYNCHRONOUS — see file-header dispatch invariant.
  function handleMessage(event: MessageEvent): void {
    let msg: WireMessage
    try {
      const text = typeof event.data === 'string'
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer)
      msg = JSON.parse(text) as WireMessage
    } catch (err) {
      console.warn('socket-transport: dropping malformed wire frame:', err)
      return
    }
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'pong') {
      if (pongTimeoutId) { clearTimeout(pongTimeoutId); pongTimeoutId = null }
      return
    }
    if (msg.type === 'challenge') {
      if (typeof msg['nonce'] !== 'string') return
      // Detect a session restart: a second challenge with a different
      // nonce arrives mid-life when the SSE plane's continuation token
      // landed on a replica that didn't know it, so the server minted
      // a fresh session (new id + new challenge). Fire a synthetic
      // disconnect FIRST so consumers reset their subscribed-state
      // (triage-sync clears session.subscribed in onDisconnected),
      // then notifyConnected runs the normal re-subscribe path against
      // the new nonce. Without this, the new nonce is silently latched
      // but consumers never re-sign / re-send subscribes, and the new
      // server-side session has no subscribers — broadcasts never
      // reach this client until the next full reconnect.
      if (connectionNonce != null && connectionNonce !== msg['nonce']) {
        notifyDisconnected('session restarted')
      }
      connectionNonce = msg['nonce']
      notifyConnected(connectionNonce)
      return
    }
    // `authenticated` also passes through; triage-sync uses it as a
    // "kick deferred sends" signal. `unauthorized.auth-failed` is
    // purely an auth-flow signal — no consumer claims it.
    if (msg.type === 'authenticated') {
      settleAuthResponse(true)
      dispatchMessage(msg)
      return
    }
    if (msg.type === 'unauthorized' && msg['kind'] === 'auth-failed') {
      settleAuthResponse(false)
      return
    }

    dispatchMessage(msg)
  }

  // Resolve a pending `attemptAuthenticate` promise exactly once and
  // clear the slot. No-op if nothing is waiting.
  function settleAuthResponse(ok: boolean): void {
    if (!authResponseResolver) return
    const r = authResponseResolver
    authResponseResolver = null
    r(ok)
  }

  function send(msg: object): boolean {
    if (!socket || socket.readyState !== socket.OPEN) return false
    try {
      socket.send(JSON.stringify(msg))
      return true
    } catch (err) {
      console.warn('socket-transport: send failed:', err)
      return false
    }
  }

  function attemptAuthenticate(password: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      authResponseResolver = resolve
      if (!send({ type: 'authenticate', password })) {
        // Socket transitioned to CLOSING / CLOSED between the gating
        // reply and our auth attempt; resolve false so the flow
        // doesn't hang.
        authResponseResolver = null
        resolve(false)
      }
    })
  }

  function runAuthFlow(): Promise<boolean> {
    if (authFlowInFlight) return authFlowInFlight
    if (!socket || socket.readyState !== socket.OPEN) return Promise.resolve(false)
    // Pin the socket. A mid-flow swap (NAT-induced reconnect during
    // resolver dialog, etc.) bails false; the caller's gated send,
    // re-armed by `onDisconnected`, re-enters on the fresh socket.
    const startSocket = socket
    const promise = (async (): Promise<boolean> => {
      try {
        // Silent cached-replay, once per socket.
        const cached = getCachedSyncPassword()
        if (cached != null && !cachedPasswordTriedOnThisSocket) {
          cachedPasswordTriedOnThisSocket = true
          const ok = await attemptAuthenticate(cached)
          if (socket !== startSocket) return false
          if (ok) return true
          // Wrong cache — wipe so the next flow doesn't loop on it.
          try { await setCachedSyncPassword(null) }
          catch (err) { console.warn('socket-transport: failed to clear cached auth password:', err) }
        }
        // `retry=true` after the first attempt surfaces "wrong password" in the UI.
        let firstAttempt = true
        while (true) {
          if (socket !== startSocket || !socket || socket.readyState !== socket.OPEN) return false
          if (!deps.authResolver) return false
          let password: string | null | undefined
          try { password = await deps.authResolver({ retry: !firstAttempt }) }
          catch (err) {
            console.warn('socket-transport: authentication resolver threw:', err)
            return false
          }
          if (socket !== startSocket) return false
          firstAttempt = false
          if (password == null || password === '') return false
          const ok = await attemptAuthenticate(password)
          if (socket !== startSocket) return false
          if (ok) {
            try { await setCachedSyncPassword(password) }
            catch (err) { console.warn('socket-transport: failed to cache auth password:', err) }
            return true
          }
        }
      } finally {
        authFlowInFlight = null
      }
    })()
    authFlowInFlight = promise
    return promise
  }

  function teardownCurrentSocket(reason: string): void {
    if (!socket) return
    const stale = socket
    socket = null
    connectionNonce = null
    cachedPasswordTriedOnThisSocket = false
    settleAuthResponse(false)
    stopHeartbeat()
    notifyDisconnected(reason)
    try { stale.close() } catch {}
  }

  function openSocket(): void {
    if (transportClosed) return
    if (socket) return
    if (acquireCount === 0) return
    if (!serverUrl) return
    tryOpen(/* sse= */ false)
  }

  // One open attempt against one wire. When `sse=false` we try the
  // WebSocket; on close-before-open (server refused upgrade, proxy
  // stripped the Upgrade header, constructor threw) we re-enter with
  // `sse=true` and try the SSE+POST adapter against the same URL.
  // Successive reconnects after a fully-opened socket dropped restart
  // at `sse=false` — the WS plane is the preferred path; SSE is the
  // last-resort fallback, re-tested every connection cycle so a
  // transient WS-blocking middlebox doesn't permanently downgrade.
  function tryOpen(sse: boolean): void {
    // Re-check the gates each time tryOpen is invoked — the WS-ctor
    // catch and the close-fallback path call back into us, and a
    // close() racing those re-entries would otherwise construct an
    // orphan SseTransport that immediately fires a POST to the server.
    if (transportClosed) return
    if (acquireCount === 0) return
    if (!serverUrl) return
    let next: WebSocketLike
    try { next = sse ? new SseTransport(serverUrl) : new WebSocket(serverUrl) }
    catch (err) {
      // Constructor failure path. For WS this is e.g. an invalid URL
      // shape that `new WebSocket(…)` rejects synchronously; for SSE
      // it's the wsUrlToSseUrl scheme check. Fall back to SSE if we
      // were trying WS; otherwise schedule a normal reconnect.
      if (!sse) {
        console.warn('socket-transport: WebSocket constructor failed; trying SSE fallback:', err)
        tryOpen(true)
        return
      }
      console.warn('socket-transport: SSE constructor failed:', err)
      scheduleReconnect()
      return
    }
    socket = next
    connectionNonce = null
    cachedPasswordTriedOnThisSocket = false
    // Track whether THIS attempt ever reached `open`. The WS plane
    // fires `close` immediately on a failed upgrade (without a prior
    // `open`); we use that signal to fall back to SSE. After a
    // legitimately-opened connection drops, this path is not taken —
    // the next reconnect cycle restarts at WS through `openSocket`.
    let hasOpened = false

    next.addEventListener('open', () => {
      if (socket !== next) return  // stale: fresh socket replaced this one
      hasOpened = true
      reconnectDelayMs = INITIAL_RECONNECT_DELAY
      startHeartbeat()
      // Consumers fire on `challenge`, not `open` — nonce arrives later.
    })

    // The message listener is wrapped so a stale frame on the prior
    // transport (in-flight between teardownCurrentSocket setting
    // socket=null and stale.close() draining its receive buffer; acute
    // for SSE per the older-readers issue in sse-transport.ts) doesn't
    // re-fire `notifyConnected` / settle a stale auth resolver / push
    // a phantom frame to consumers that just received `onDisconnected`.
    next.addEventListener('message', (ev) => {
      if (socket !== next) return
      handleMessage(ev as MessageEvent)
    })

    next.addEventListener('close', (ev) => {
      if (socket !== next) return  // stale: don't clobber the replacement's state
      socket = null
      connectionNonce = null
      cachedPasswordTriedOnThisSocket = false
      settleAuthResponse(false)
      stopHeartbeat()
      // WS close-before-open is the "this transport doesn't work
      // against this server" signal. Try SSE before notifying
      // consumers (the SSE attempt is a continuation of the same
      // open cycle; from the consumer's perspective the transport
      // hasn't disconnected because it never connected). If SSE was
      // already the one that failed, fall through to the normal
      // reconnect-notify path.
      if (!hasOpened && !sse && !transportClosed && acquireCount > 0) {
        if (typeof fetch === 'undefined') {
          // No fetch available (Node test env without polyfill);
          // can't fall back. Fall through to the normal reconnect path
          // so the WS retry loop keeps trying.
          notifyDisconnected('socket closed')
          scheduleReconnect()
          return
        }
        console.warn('socket-transport: WebSocket failed to open; falling back to SSE')
        tryOpen(true)
        return
      }
      // Read the close code if the transport surfaced one (WebSocket
      // CloseEvent has it natively, SseTransport attaches it as a
      // plain-Event property). 1001 (server going away) is the
      // graceful-shutdown signal — reset the backoff so the immediate
      // reconnect attempt fires at INITIAL_RECONNECT_DELAY instead of
      // whatever bumped value the previous reconnect cycle left. The
      // optional chain handles legacy listeners that may not pass an
      // event argument (test fakes, some embedded WS shims).
      const closeCode = (ev as (Event & { code?: number }) | undefined)?.code
      if (closeCode === 1001) reconnectDelayMs = INITIAL_RECONNECT_DELAY
      notifyDisconnected('socket closed')
      if (!transportClosed && acquireCount > 0) scheduleReconnect()
    })

    next.addEventListener('error', () => {
      // `close` fires right after — let it own reconnect scheduling.
    })
  }

  function acquire(): AcquireHandle {
    // Stale-handle: post-close acquires return a no-op release.
    if (transportClosed) return { release() {} }
    acquireCount += 1
    if (acquireCount === 1 && !socket) openSocket()
    let released = false
    return {
      release() {
        if (released) return
        released = true
        // `close()` zeroed `acquireCount`; further decrements would
        // drift negative and mis-interpret a future `> 0` read.
        if (transportClosed) return
        acquireCount -= 1
        if (acquireCount === 0) {
          clearReconnect()
          reconnectDelayMs = INITIAL_RECONNECT_DELAY
          teardownCurrentSocket('released')
        }
      },
    }
  }

  function setServerUrl(url: string): void {
    if (url === serverUrl) return
    serverUrl = url
    if (socket) teardownCurrentSocket('serverUrl changed')
    // Reopen iff still wanted — symmetric with the close-event
    // reconnect gate. "No consumer wants it" means don't reopen.
    if (acquireCount > 0 && serverUrl) openSocket()
  }

  function addConsumer(consumer: TransportConsumer): ConsumerHandle {
    consumers.add(consumer)
    let removed = false
    return {
      remove() {
        if (removed) return
        removed = true
        consumers.delete(consumer)
      },
    }
  }

  function close(): void {
    if (transportClosed) return
    transportClosed = true
    clearReconnect()
    teardownCurrentSocket('transport closed')
    consumers.clear()
    acquireCount = 0
  }

  function setHeartbeatTimings(opts: { pingMs?: number; pongMs?: number }): void {
    const { pingMs, pongMs } = opts
    if (typeof pingMs === 'number' && pingMs >= 0) pingIntervalMs = pingMs
    if (typeof pongMs === 'number' && pongMs > 0) pongTimeoutMs = pongMs
    // Restart in place so the new interval takes effect immediately.
    if (pingIntervalId) startHeartbeat()
  }

  function resetCachedReplayGuard(): void {
    cachedPasswordTriedOnThisSocket = false
  }

  return {
    acquire,
    setServerUrl,
    addConsumer,
    send,
    getNonce: () => connectionNonce,
    getSocket: () => socket,
    runAuthFlow,
    close,
    setHeartbeatTimings,
    resetCachedReplayGuard,
  }
}
