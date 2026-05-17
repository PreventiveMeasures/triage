// Shared WebSocket transport for the v1 triage-sync relay's two
// client-side consumers (`client/triage-sync.ts` and
// `client/objstore.ts`). Owns the socket lifecycle, reconnect
// backoff, per-connection challenge nonce, application-level
// heartbeat, and the operator-side `authenticate` flow. Consumers
// register a `TransportConsumer` and use `send` / `getNonce` /
// `getSocket` / `runAuthFlow` to drive their own protocol on top.
//
// Lifecycle (refcount):
//   transport.acquire() → handle.release()
// Each consumer that wants the socket open holds an acquisition. The
// socket opens on the first acquire and closes on the last release;
// reconnect is scheduled only while `acquireCount > 0`. This matches
// the pre-unification "openSocket on first session, scheduleReconnect
// bails when sessions.size === 0" pattern from each consumer
// separately, but lets two consumers coordinate without one tearing
// the socket out from under the other.
//
// Dispatch model:
//   * `pong` resets the heartbeat timer (transport-internal — never
//     reaches consumers).
//   * `challenge { nonce }` populates `connectionNonce` and fans
//     `onConnected(nonce)` to every consumer. Consumers issue their
//     subscribes here (or in their addConsumer-time short-circuit
//     against a pre-existing nonce).
//   * `unauthorized { kind: 'auth-failed' }` resolves the in-flight
//     auth round-trip (transport-internal — never reaches consumers,
//     since no consumer's protocol cares about it).
//   * `authenticated` resolves the in-flight auth round-trip AND
//     passes through to consumers, since triage-sync uses it as a
//     "gate cleared — kick deferred sends" signal.
//   * Everything else dispatches to every consumer's `onMessage` in
//     registration order. Consumers narrow on `msg.type` /
//     `msg.workspaceTag` and drop frames they don't claim.
//
// Synchronous dispatch invariant: `handleMessage` never `await`s
// before fanning out to consumers, so per-consumer message order
// equals wire arrival order. Consumers whose handlers contain awaits
// (triage-sync) MUST chain those awaits inside `onMessage` (via a
// Promise queue) — `onMessage` itself must return synchronously.
// Compare to the parallel invariant in `client/objstore.ts`
// `handleMessage`.
//
// Auth flow:
//   `runAuthFlow()` is a singleton per-socket — concurrent callers
//   coalesce on the in-flight promise. The flow:
//     1. Silent replay of the cached password (once per socket).
//     2. Resolver prompt loop with `retry: true` on subsequent rounds.
//     3. On success, cache the password (so the same flow on a future
//        socket can silent-replay).
//   The flow pins `startSocket` at entry and bails false on every
//   step if the socket has swapped (mid-flow disconnect would
//   otherwise land an authenticate against a fresh socket whose
//   per-socket gate state has been reset).

import { getCachedSyncPassword, setCachedSyncPassword } from './sync-auth-cache.ts'

export type AuthResolver = (context: { retry: boolean }) => Promise<string | null | undefined>

export type SocketTransportDeps = {
  // WebSocket URL. May be the empty string to construct a transport
  // that won't open until `setServerUrl(url)` populates it.
  serverUrl: string
  // Optional operator-side password prompt. Shared between consumers
  // since the server's `socketAuthorized` flag is per-WebSocket; a
  // single password unlocks both subsystems' gated actions.
  authResolver?: AuthResolver
  // Heartbeat cadence. 0 disables (e.g. unit tests that drive the
  // socket directly). Defaults match the pre-unification triage-sync
  // values: ping every 15 s, fail the connection if pong doesn't
  // land within 5 s.
  pingIntervalMs?: number
  pongTimeoutMs?: number
}

// Wire-shape envelope every server frame lands as post-JSON.parse.
type WireMessage = { type?: unknown; [k: string]: unknown }

export type TransportConsumer = {
  // Fires synchronously for every inbound frame the transport doesn't
  // claim for itself. MUST return synchronously — see the "synchronous
  // dispatch invariant" comment at the top of the file.
  onMessage(msg: WireMessage): void
  // Fires when the socket has been opened AND the server's challenge
  // frame has landed. `nonce` is bound into every subsequent signed
  // frame. Consumers issue subscribes here.
  onConnected(nonce: string): void
  // Fires when the socket closes (clean or abnormal) or when the
  // transport is closed / released. Consumers drain pending waiters
  // and reset per-socket state. `reason` is a short human-readable
  // tag, not a stable identifier — don't switch on it.
  onDisconnected(reason: string): void
}

export type AcquireHandle = { release(): void }
export type ConsumerHandle = { remove(): void }

export type SocketTransport = {
  // Refcount the "want it open" signal. Each consumer that wants the
  // socket open holds at least one acquisition; the socket opens on
  // the first acquire and closes on the last release. Calling
  // `release` twice is a no-op.
  acquire(): AcquireHandle
  // Swap the server URL. If the socket is currently open, it's torn
  // down and re-opened against the new URL — provided some consumer
  // still holds an acquisition by the time teardown's
  // `onDisconnected` fan-out has completed. Setting to the same URL
  // is a no-op. Setting to empty string tears down without
  // re-opening — `acquire` will be the next trigger when a URL
  // exists again.
  setServerUrl(url: string): void
  // Register a consumer. Order matters for `onMessage` dispatch:
  // consumers fire in registration order, which is well-defined
  // because the internal `Set<TransportConsumer>` iterates
  // insertion-ordered per ECMA-262. Returns a handle whose
  // `remove()` unregisters.
  addConsumer(consumer: TransportConsumer): ConsumerHandle
  // Send a raw JSON frame. Returns `true` on send, `false` if the
  // socket isn't OPEN (caller decides whether to throw, queue, or
  // drop). Send-after-close throws are swallowed and surfaced as
  // `false`.
  send(msg: object): boolean
  // Current per-connection challenge nonce, or null before the
  // challenge frame lands / after disconnect. Consumers signing
  // outbound frames bind this nonce into their canonical bytes; an
  // async signer must capture into a local + re-check before sending.
  getNonce(): string | null
  // Current socket reference for stale-checks in consumers' async
  // IIFEs. `getSocket() !== captured` means the socket has swapped
  // (closed + reconnected) since the capture.
  getSocket(): WebSocket | null
  // Run the operator-side auth flow against the current socket.
  // Returns true on successful auth, false on cancel / no resolver /
  // socket-swap-mid-flow. Singleton per-socket: concurrent callers
  // coalesce on the in-flight promise.
  runAuthFlow(): Promise<boolean>
  // Force teardown. Releases all acquisitions, clears the consumer
  // list, closes the socket. Idempotent. Acquisitions held after
  // `close()` are stale handles whose `release()` is a no-op.
  close(): void
  // Test seam: swap the heartbeat windows at runtime. Restarts the
  // heartbeat against the new values if it's already running. No-op
  // for any field that isn't a positive number; pass `0` to disable.
  setHeartbeatTimings(opts: { pingMs?: number; pongMs?: number }): void
  // Re-arm the "silent cached-password replay" so the NEXT
  // `runAuthFlow()` against the current socket tries the cache
  // again, even if a prior flow on this same socket already burned
  // the replay attempt. Used by the boot-after-unlock path: a fresh
  // cache landing after the auth flow already gave up (no resolver
  // / cancelled) should get one more silent attempt without
  // requiring a reconnect.
  resetCachedReplayGuard(): void
}

const INITIAL_RECONNECT_DELAY = 1_000
const MAX_RECONNECT_DELAY = 30_000

export function createSocketTransport(deps: SocketTransportDeps): SocketTransport {
  let serverUrl = deps.serverUrl
  let pingIntervalMs = deps.pingIntervalMs ?? 15_000
  let pongTimeoutMs = deps.pongTimeoutMs ?? 5_000

  let socket: WebSocket | null = null
  let connectionNonce: string | null = null
  let acquireCount = 0
  let transportClosed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY
  let pingIntervalId: ReturnType<typeof setInterval> | null = null
  let pongTimeoutId: ReturnType<typeof setTimeout> | null = null

  // Per-socket auth state. `authFlowInFlight` coalesces concurrent
  // `runAuthFlow` callers onto one promise; `cachedPasswordTriedOnThisSocket`
  // enforces "silent replay once per socket so an `unauthorized` ↔
  // `authenticate` ping-pong doesn't happen if the cache is wrong";
  // `authResponseResolver` is the single-slot continuation the next
  // `authenticated` / `unauthorized.auth-failed` settles.
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
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      // Don't double-arm: a previous ping is still awaiting its pong.
      // The existing pongTimeout will close the socket if that one
      // doesn't land.
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

  // MUST REMAIN SYNCHRONOUS. See the "synchronous dispatch invariant"
  // comment at the top of the file — consumers whose handlers contain
  // awaits must chain those inside their own `onMessage`.
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

    // Heartbeat — transport-internal.
    if (msg.type === 'pong') {
      if (pongTimeoutId) { clearTimeout(pongTimeoutId); pongTimeoutId = null }
      return
    }
    // Challenge — populates nonce, fans `onConnected` to consumers so
    // they can kick subscribes. Transport-internal (doesn't pass through).
    if (msg.type === 'challenge') {
      if (typeof msg['nonce'] !== 'string') return
      connectionNonce = msg['nonce']
      notifyConnected(connectionNonce)
      return
    }
    // Auth resolution. `authenticated` ALSO passes through so consumers
    // can kick deferred sends (triage-sync uses it for trySendSubscribe /
    // trySendSave on every gated session). `unauthorized.auth-failed` is
    // purely an auth-flow signal — no consumer claims it.
    if (msg.type === 'authenticated') {
      if (authResponseResolver) {
        const r = authResponseResolver
        authResponseResolver = null
        r(true)
      }
      dispatchMessage(msg)
      return
    }
    if (msg.type === 'unauthorized' && msg['kind'] === 'auth-failed') {
      if (authResponseResolver) {
        const r = authResponseResolver
        authResponseResolver = null
        r(false)
      }
      return
    }

    dispatchMessage(msg)
  }

  function send(msg: object): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
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
        // Send-after-close: the socket transitioned to CLOSING /
        // CLOSED between the gating reply and our auth attempt.
        // Resolve false so the auth flow doesn't hang.
        authResponseResolver = null
        resolve(false)
      }
    })
  }

  function runAuthFlow(): Promise<boolean> {
    if (authFlowInFlight) return authFlowInFlight
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve(false)
    // Pin the socket this flow runs against. If the socket transitions
    // mid-flow (resolver dialog open during a NAT-induced reconnect,
    // e.g.), bail false so the caller's gated send — which has already
    // been re-armed by the consumer's `onDisconnected` — re-enters the
    // flow on the fresh socket where the cached-replay-once gate has
    // reset.
    const startSocket = socket
    const promise = (async (): Promise<boolean> => {
      try {
        // Silent replay of the shared cached password, once per socket.
        const cached = getCachedSyncPassword()
        if (cached != null && !cachedPasswordTriedOnThisSocket) {
          cachedPasswordTriedOnThisSocket = true
          const ok = await attemptAuthenticate(cached)
          if (socket !== startSocket) return false
          if (ok) return true
          // Cached password is wrong — clear it both in memory and on
          // disk so a future session doesn't repeat the loop. The
          // resolver below will prompt for a fresh one.
          try { await setCachedSyncPassword(null) }
          catch (err) { console.warn('socket-transport: failed to clear cached auth password:', err) }
        }
        // Prompt loop. `retry=true` after the first attempt so the UI
        // surfaces "wrong password" rather than re-prompting cold.
        let firstAttempt = true
        while (true) {
          if (socket !== startSocket || !socket || socket.readyState !== WebSocket.OPEN) return false
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
    if (authResponseResolver) {
      const r = authResponseResolver
      authResponseResolver = null
      r(false)
    }
    stopHeartbeat()
    notifyDisconnected(reason)
    try { stale.close() } catch {}
  }

  function openSocket(): void {
    if (transportClosed) return
    if (socket) return
    if (acquireCount === 0) return
    if (!serverUrl) return
    let next: WebSocket
    try { next = new WebSocket(serverUrl) }
    catch (err) {
      console.warn('socket-transport: WebSocket constructor failed:', err)
      scheduleReconnect()
      return
    }
    socket = next
    connectionNonce = null
    cachedPasswordTriedOnThisSocket = false

    next.addEventListener('open', () => {
      // Stale-open guard: a fresh socket may already have replaced
      // this one (setServerUrl mid-handshake, e.g.).
      if (socket !== next) return
      reconnectDelayMs = INITIAL_RECONNECT_DELAY
      startHeartbeat()
      // Consumers fire on `challenge`, not `open` — the nonce isn't
      // available yet here. See `notifyConnected` in handleMessage.
    })

    next.addEventListener('message', handleMessage)

    next.addEventListener('close', () => {
      // Stale-close guard: if a fresh socket has already replaced
      // this one (`socket !== next`), every clear below would step
      // on the new socket's state.
      if (socket !== next) return
      socket = null
      connectionNonce = null
      cachedPasswordTriedOnThisSocket = false
      if (authResponseResolver) {
        const r = authResponseResolver
        authResponseResolver = null
        r(false)
      }
      stopHeartbeat()
      notifyDisconnected('socket closed')
      if (!transportClosed && acquireCount > 0) scheduleReconnect()
    })

    next.addEventListener('error', () => {
      // `close` fires right after — let it own the reconnect schedule.
      // Errors that don't progress to `close` (rare; mostly mock-WS
      // test paths) are surfaced by the close-event handler when the
      // socket eventually settles.
    })
  }

  function acquire(): AcquireHandle {
    if (transportClosed) {
      // Stale handle. Return a no-op release so callers don't crash on
      // the cleanup path of a transport they don't realise is closed.
      return { release() {} }
    }
    acquireCount += 1
    if (acquireCount === 1 && !socket) openSocket()
    let released = false
    return {
      release() {
        if (released) return
        released = true
        // No-op if the transport was closed in the meantime — `close()`
        // already zeroed `acquireCount`. Decrementing further would
        // drift it negative (untidy + would mis-interpret a future
        // `> 0` read).
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
    // Reopen iff still wanted. Symmetric with the close-event
    // handler's reconnect gate: if every consumer's `onDisconnected`
    // released its acquisition (none does today, but the contract
    // doesn't forbid it), the socket stays closed per refcount
    // semantics — "no consumer wants it" means don't reopen.
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
    // If a heartbeat is already running (i.e. the socket is open),
    // restart it so the new interval takes effect immediately.
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
