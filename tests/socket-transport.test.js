// Unit tests for `client/socket-transport.ts`. Mocks the global
// `WebSocket` constructor so the transport's behaviour is observable
// frame-by-frame without spinning up a real server. Covers:
//   - Refcounted acquire/release lifecycle + reopen-after-release
//   - setServerUrl swap semantics (same URL / empty / different)
//   - Reconnect-backoff after server-initiated close
//   - Heartbeat: ping cadence, pong cancels timeout, missed pong tears down
//   - Auth flow: cached-replay once per socket, resolver loop,
//     concurrent-caller coalescing, startSocket pin (bail on socket swap)
//   - resetCachedReplayGuard re-arms the cached-replay attempt
//   - Dispatch routing: pong / challenge / unauthorized.auth-failed
//     are transport-internal; authenticated passes through; consumers
//     fire in registration order
//   - setHeartbeatTimings runtime swap restarts the heartbeat

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

await import('./_polyfills.js')

const { createSocketTransport } = await import('../client/sync/socket-transport.ts')
const { setCachedSyncPassword } = await import('../client/sync/sync-auth-cache.ts')

// ─────────── fake WebSocket ───────────
//
// Constructor records the URL; tests grab the instance via
// `FakeWebSocket.last`. Calls to `send` queue into `frames`.
// Tests drive readyState + dispatch events via `simulate*`.
// Standard readyState constants on the class match the spec so the
// transport's `socket.readyState !== WebSocket.OPEN` comparisons
// agree with both globalThis.WebSocket.OPEN and an instance's
// inherited constant.

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  // Per-instance constants too — real `WebSocket` instances expose
  // these (HTML spec), and the production transport now reads
  // `socket.OPEN` (instance) rather than the bare global so the SSE
  // adapter (which doesn't share a global WebSocket constructor) can
  // be type-equivalent. Without instance constants the readyState
  // strict-compare drops every readyState check to a `1 !== undefined`
  // truthy and the transport thinks the socket is never open.
  CONNECTING = 0
  OPEN = 1
  CLOSING = 2
  CLOSED = 3
  static instances = []
  static get last() { return FakeWebSocket.instances.at(-1) }
  static reset() { FakeWebSocket.instances.length = 0 }

  constructor(url) {
    this.url = url
    this.readyState = FakeWebSocket.CONNECTING
    this.frames = []
    this.listeners = { open: [], message: [], close: [], error: [] }
    this.closed = false
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('fake-ws: send on non-open socket')
    this.frames.push(data)
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
    // Spec-faithful: the close event fires asynchronously after
    // `close()`. Use queueMicrotask so it lands in the same turn
    // for deterministic test ordering.
    queueMicrotask(() => this.simulateClose())
  }

  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN
    for (const fn of this.listeners.open) fn()
  }
  simulateMessage(obj) {
    const data = typeof obj === 'string' ? obj : JSON.stringify(obj)
    for (const fn of this.listeners.message) fn({ data })
  }
  simulateClose() {
    this.readyState = FakeWebSocket.CLOSED
    for (const fn of this.listeners.close) fn()
  }
  simulateError() {
    for (const fn of this.listeners.error) fn()
  }
  // Convenience: drive through to "ready to send / consumers
  // notified" with a single call. Returns the nonce used.
  handshake(nonce = 'test-nonce') {
    this.simulateOpen()
    this.simulateMessage({ type: 'challenge', nonce })
    return nonce
  }
}

let originalWebSocket
beforeEach(async () => {
  originalWebSocket = globalThis.WebSocket
  globalThis.WebSocket = FakeWebSocket
  FakeWebSocket.reset()
  // Clear the shared password cache so auth-flow tests start clean.
  await setCachedSyncPassword(null)
})
afterEach(() => { globalThis.WebSocket = originalWebSocket })

// Construct a transport with heartbeat disabled by default (most
// tests don't exercise it; the heartbeat tests opt in).
function makeTransport(opts = {}) {
  return createSocketTransport({
    serverUrl: opts.serverUrl ?? 'ws://test.invalid/api/sync',
    pingIntervalMs: opts.pingIntervalMs ?? 0,
    pongTimeoutMs: opts.pongTimeoutMs ?? 30,
    ...(opts.authResolver === undefined ? {} : { authResolver: opts.authResolver }),
  })
}

// Helper to capture consumer callbacks into arrays the test can
// assert against.
function recordingConsumer() {
  const messages = []
  const connected = []
  const disconnected = []
  return {
    messages, connected, disconnected,
    onMessage: (m) => { messages.push(m) },
    onConnected: (n) => { connected.push(n) },
    onDisconnected: (r) => { disconnected.push(r) },
  }
}

// ─────────── lifecycle ───────────

describe('socket-transport: lifecycle', () => {
  it('first acquire opens a socket; release closes it', async () => {
    const t = makeTransport()
    assert.equal(FakeWebSocket.last, undefined, 'no socket before acquire')
    const h = t.acquire()
    assert.equal(FakeWebSocket.instances.length, 1)
    assert.equal(FakeWebSocket.last.url, 'ws://test.invalid/api/sync')
    h.release()
    // Release tears down via teardownCurrentSocket → close().
    await delay(0)
    assert.equal(FakeWebSocket.last.closed, true)
    t.close()
  })

  it('refcount: 2 acquires + 1 release keeps the socket open', async () => {
    const t = makeTransport()
    const h1 = t.acquire()
    const h2 = t.acquire()
    assert.equal(FakeWebSocket.instances.length, 1, 'second acquire reuses socket')
    h1.release()
    await delay(0)
    assert.equal(FakeWebSocket.last.closed, false, 'still acquired by h2')
    h2.release()
    await delay(0)
    assert.equal(FakeWebSocket.last.closed, true)
    t.close()
  })

  it('release after another release is a no-op (no negative refcount)', async () => {
    const t = makeTransport()
    const h1 = t.acquire()
    const h2 = t.acquire()
    h1.release()
    h1.release()  // double-release on h1
    assert.equal(FakeWebSocket.last.closed, false, 'h2 still holds it')
    h2.release()
    await delay(0)
    assert.equal(FakeWebSocket.last.closed, true)
    t.close()
  })

  it('re-acquire after last release opens a fresh socket', async () => {
    const t = makeTransport()
    const h1 = t.acquire()
    h1.release()
    await delay(0)
    const h2 = t.acquire()
    assert.equal(FakeWebSocket.instances.length, 2, 'new socket on re-acquire')
    h2.release()
    t.close()
  })

  it('transport.close() tears the socket down even with outstanding acquires', async () => {
    const t = makeTransport()
    t.acquire()
    t.acquire()
    t.close()
    await delay(0)
    assert.equal(FakeWebSocket.last.closed, true)
  })

  it('acquire after close is a no-op (returns silent-release handle)', () => {
    const t = makeTransport()
    t.close()
    const h = t.acquire()
    assert.equal(FakeWebSocket.instances.length, 0, 'no socket opened post-close')
    h.release()  // does not throw
  })
})

describe('socket-transport: setServerUrl', () => {
  it('same-URL setServerUrl is a no-op', () => {
    const t = makeTransport()
    t.acquire()
    const ws = FakeWebSocket.last
    t.setServerUrl('ws://test.invalid/api/sync')
    assert.equal(FakeWebSocket.last, ws, 'no rebuild')
    t.close()
  })

  it('different-URL setServerUrl tears down + reopens when acquired', async () => {
    const t = makeTransport()
    t.acquire()
    const wsA = FakeWebSocket.last
    t.setServerUrl('ws://other.invalid/api/sync')
    await delay(0)
    assert.equal(wsA.closed, true, 'old socket closed')
    assert.equal(FakeWebSocket.instances.length, 2)
    assert.equal(FakeWebSocket.last.url, 'ws://other.invalid/api/sync')
    t.close()
  })

  it('different-URL setServerUrl while unacquired does NOT open', () => {
    const t = makeTransport()
    // Never acquire. Just swap URL.
    t.setServerUrl('ws://other.invalid/api/sync')
    assert.equal(FakeWebSocket.instances.length, 0)
    t.close()
  })

  it('setServerUrl("") tears down without reopen', async () => {
    const t = makeTransport()
    t.acquire()
    const ws = FakeWebSocket.last
    t.setServerUrl('')
    await delay(0)
    assert.equal(ws.closed, true)
    assert.equal(FakeWebSocket.instances.length, 1, 'no reopen')
    t.close()
  })

  it('setServerUrl from "" to a URL opens (if acquired) on the second call', () => {
    const t = makeTransport({ serverUrl: '' })
    t.acquire()
    assert.equal(FakeWebSocket.instances.length, 0, 'empty URL never opens')
    t.setServerUrl('ws://test.invalid/api/sync')
    assert.equal(FakeWebSocket.instances.length, 1)
    t.close()
  })
})

// ─────────── consumer dispatch ───────────

describe('socket-transport: dispatch routing', () => {
  it('pong is consumed by the transport (does NOT reach consumers)', () => {
    const t = makeTransport()
    const c = recordingConsumer()
    t.addConsumer(c)
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    FakeWebSocket.last.simulateMessage({ type: 'pong' })
    assert.equal(c.messages.length, 0, 'pong not dispatched')
    t.close()
  })

  it('challenge populates nonce + fires onConnected (does NOT reach onMessage)', () => {
    const t = makeTransport()
    const c = recordingConsumer()
    t.addConsumer(c)
    t.acquire()
    FakeWebSocket.last.simulateOpen()
    assert.equal(t.getNonce(), null, 'no nonce until challenge')
    assert.deepEqual(c.connected, [], 'no onConnected pre-challenge')
    FakeWebSocket.last.simulateMessage({ type: 'challenge', nonce: 'abc' })
    assert.equal(t.getNonce(), 'abc')
    assert.deepEqual(c.connected, ['abc'])
    assert.equal(c.messages.length, 0, 'challenge not dispatched as message')
    t.close()
  })

  it('unauthorized.auth-failed is consumed by the transport (does NOT reach consumers)', () => {
    const t = makeTransport()
    const c = recordingConsumer()
    t.addConsumer(c)
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    FakeWebSocket.last.simulateMessage({ type: 'unauthorized', kind: 'auth-failed' })
    assert.equal(c.messages.length, 0, 'auth-failed not dispatched')
    t.close()
  })

  it('authenticated DOES pass through to consumers', () => {
    const t = makeTransport()
    const c = recordingConsumer()
    t.addConsumer(c)
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    FakeWebSocket.last.simulateMessage({ type: 'authenticated' })
    assert.equal(c.messages.length, 1, 'authenticated passes through')
    assert.equal(c.messages[0].type, 'authenticated')
    t.close()
  })

  it('unauthorized.gated passes through to consumers (the gated-action signal)', () => {
    const t = makeTransport()
    const c = recordingConsumer()
    t.addConsumer(c)
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    FakeWebSocket.last.simulateMessage({ type: 'unauthorized', kind: 'gated', workspaceTag: 'tag-x' })
    assert.equal(c.messages.length, 1)
    assert.equal(c.messages[0].kind, 'gated')
    t.close()
  })

  it('consumers fire in registration order', () => {
    const t = makeTransport()
    const order = []
    t.addConsumer({
      onMessage: () => order.push('A'),
      onConnected: () => order.push('A-conn'),
      onDisconnected: () => order.push('A-disc'),
    })
    t.addConsumer({
      onMessage: () => order.push('B'),
      onConnected: () => order.push('B-conn'),
      onDisconnected: () => order.push('B-disc'),
    })
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    FakeWebSocket.last.simulateMessage({ type: 'workspace-state', workspaceTag: 't' })
    assert.deepEqual(order, ['A-conn', 'B-conn', 'A', 'B'])
    t.close()
  })

  it('a consumer that throws in onMessage does NOT break later consumers', () => {
    const t = makeTransport()
    const bReached = []
    t.addConsumer({
      onMessage: () => { throw new Error('A always throws') },
      onConnected: () => {},
      onDisconnected: () => {},
    })
    t.addConsumer({
      onMessage: (m) => bReached.push(m),
      onConnected: () => {},
      onDisconnected: () => {},
    })
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    FakeWebSocket.last.simulateMessage({ type: 'workspace-state', workspaceTag: 't' })
    assert.equal(bReached.length, 1, 'B still received the message')
    t.close()
  })

  it('socket close triggers onDisconnected for every consumer (post-handshake)', async () => {
    const t = makeTransport()
    const c = recordingConsumer()
    t.addConsumer(c)
    const h = t.acquire()
    FakeWebSocket.last.handshake('n0')
    h.release()
    await delay(0)
    assert.equal(c.disconnected.length, 1)
  })
})

// ─────────── reconnect ───────────

describe('socket-transport: reconnect', () => {
  it('server-initiated close while acquired triggers reconnect after the initial delay', async () => {
    const t = makeTransport()
    t.acquire()
    const wsA = FakeWebSocket.last
    wsA.handshake('n0')
    // Server drops the connection.
    wsA.simulateClose()
    assert.equal(FakeWebSocket.instances.length, 1, 'no immediate reconnect')
    // INITIAL_RECONNECT_DELAY is 1000ms in the transport. Wait long
    // enough for the timer to fire + a turn for the new constructor.
    await delay(1100)
    assert.equal(FakeWebSocket.instances.length, 2, 'reconnect fired')
    t.close()
  })
})

// ─────────── heartbeat ───────────

describe('socket-transport: heartbeat', () => {
  // Auto-respond to every newly-observed ping frame on the current
  // socket with a `pong` so the heartbeat loop keeps cycling. Without
  // this, the `if (pongTimeoutId) return` re-entry guard in
  // startHeartbeat means only the first ping ever fires before the
  // pong-timeout closes the socket.
  function autoRespondPongs(getWs) {
    let lastSeen = 0
    const id = setInterval(() => {
      const ws = getWs()
      if (!ws || ws.closed) return
      while (lastSeen < ws.frames.length) {
        const frame = ws.frames[lastSeen++]
        let parsed
        try { parsed = JSON.parse(frame) } catch { continue }
        if (parsed?.type === 'ping') ws.simulateMessage({ type: 'pong' })
      }
    }, 5)
    return () => clearInterval(id)
  }

  it('sends ping at the configured interval while open (with auto-pong)', async () => {
    const t = makeTransport({ pingIntervalMs: 30, pongTimeoutMs: 100 })
    t.acquire()
    const wsA = FakeWebSocket.last
    wsA.handshake('n0')
    const stop = autoRespondPongs(() => wsA)
    try {
      await delay(120)
      const pings = wsA.frames.map(JSON.parse).filter((m) => m.type === 'ping')
      assert.ok(pings.length >= 2, `expected ≥2 pings, got ${pings.length}`)
    } finally {
      stop()
      t.close()
    }
  })

  it('pong arrival cancels the pong-timeout', async () => {
    // Long pong-timeout (1s) so we can prove the cancellation
    // observationally: after a pong lands, the next ping should fire
    // (proving the first pong-timeout was cleared, otherwise the
    // `if (pongTimeoutId) return` re-entry guard would skip it).
    const t = makeTransport({ pingIntervalMs: 30, pongTimeoutMs: 1_000 })
    t.acquire()
    const ws = FakeWebSocket.last
    ws.handshake('n0')
    try {
      await delay(50)  // first ping fires at t=30, pong-timeout armed (fires at t=1030)
      const pingCount = ws.frames.map(JSON.parse).filter((m) => m.type === 'ping').length
      assert.equal(pingCount, 1, 'one ping fired')
      ws.simulateMessage({ type: 'pong' })  // pong-timeout cancelled
      await delay(80)  // well past the next ping interval; if pong cancelled, more pings fire
      const after = ws.frames.map(JSON.parse).filter((m) => m.type === 'ping').length
      assert.ok(after > pingCount, `pong cancelled timeout → next ping fired (was ${pingCount}, now ${after})`)
      assert.equal(ws.closed, false, 'socket still alive')
    } finally {
      t.close()
    }
  })

  it('missed pong tears the socket down', async () => {
    const t = makeTransport({ pingIntervalMs: 30, pongTimeoutMs: 20 })
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    try {
      // Wait long enough for ping + pong-timeout to fire (no pong sent).
      await delay(80)
      assert.equal(FakeWebSocket.last.closed, true)
    } finally {
      t.close()
    }
  })

  it('setHeartbeatTimings(0) disables pings AND clears any in-flight pong-timeout', async () => {
    // Pong-timeout shorter than the assertion wait so a regression
    // that fails to clear it would actually close the socket within
    // the test window — without this, the original 1s timeout was
    // never going to fire inside the 80ms wait anyway and the
    // assertion was a green-only signal.
    const t = makeTransport({ pingIntervalMs: 30, pongTimeoutMs: 40 })
    t.acquire()
    const wsA = FakeWebSocket.last
    wsA.handshake('n0')
    try {
      await delay(35)  // first ping at t=30 → pong-timeout armed (fires at t=70)
      const beforeCount = wsA.frames.length
      t.setHeartbeatTimings({ pingMs: 0 })
      // Internally `startHeartbeat()` runs (because pingIntervalId
      // was set), which calls `stopHeartbeat()` first — that clears
      // BOTH the interval and the in-flight pong-timeout — then
      // early-returns on `pingIntervalMs <= 0`. The wait below
      // outlives the original pong-timeout, so a regression that
      // failed to clear pongTimeoutId would close the socket.
      await delay(80)
      assert.equal(wsA.frames.length, beforeCount, 'no new pings sent after disable')
      assert.equal(wsA.closed, false, 'in-flight pong-timeout was cleared (socket still alive past original deadline)')
    } finally {
      t.close()
    }
  })
})

// ─────────── coverage gaps from the re-audit ───────────

describe('socket-transport: misc invariants', () => {
  it('addConsumer().remove() drops the consumer from dispatch', () => {
    const t = makeTransport()
    const c = recordingConsumer()
    const h = t.addConsumer(c)
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    FakeWebSocket.last.simulateMessage({ type: 'workspace-state', workspaceTag: 't' })
    assert.equal(c.messages.length, 1)
    h.remove()
    FakeWebSocket.last.simulateMessage({ type: 'workspace-state', workspaceTag: 't' })
    assert.equal(c.messages.length, 1, 'removed consumer received no further messages')
    t.close()
  })

  it('consumer throwing in onConnected does not break later consumers', () => {
    const t = makeTransport()
    const bConnected = []
    t.addConsumer({
      onMessage: () => {},
      onConnected: () => { throw new Error('A boom on connected') },
      onDisconnected: () => {},
    })
    t.addConsumer({
      onMessage: () => {},
      onConnected: (n) => bConnected.push(n),
      onDisconnected: () => {},
    })
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    assert.deepEqual(bConnected, ['n0'], 'B still received onConnected')
    t.close()
  })

  it('consumer throwing in onDisconnected does not break later consumers', async () => {
    const t = makeTransport()
    const bDisc = []
    t.addConsumer({
      onMessage: () => {},
      onConnected: () => {},
      onDisconnected: () => { throw new Error('A boom on disconnected') },
    })
    t.addConsumer({
      onMessage: () => {},
      onConnected: () => {},
      onDisconnected: (r) => bDisc.push(r),
    })
    const h = t.acquire()
    FakeWebSocket.last.handshake('n0')
    h.release()
    await delay(0)
    assert.equal(bDisc.length, 1, 'B still received onDisconnected')
    t.close()
  })

  it('malformed (non-JSON) inbound frame does not crash the transport', () => {
    const t = makeTransport()
    const c = recordingConsumer()
    t.addConsumer(c)
    t.acquire()
    FakeWebSocket.last.simulateOpen()
    // Synthesize a raw event with non-JSON data.
    for (const fn of FakeWebSocket.last.listeners.message) fn({ data: 'not-json-{[}' })
    // Socket is still alive; a subsequent legit message is dispatched.
    FakeWebSocket.last.simulateMessage({ type: 'challenge', nonce: 'n0' })
    FakeWebSocket.last.simulateMessage({ type: 'workspace-state', workspaceTag: 't' })
    assert.equal(c.messages.length, 1, 'transport recovered after malformed frame')
    t.close()
  })

  it('WebSocket constructor throwing schedules a reconnect', async () => {
    const calls = []
    let shouldThrow = true
    // Wrap the FakeWebSocket as a function that throws on the first
    // call, then delegates to the fake afterwards. Avoids declaring a
    // second class in this file (eslint max-classes-per-file=1).
    const ThrowingWS = function (url) {
      calls.push(url)
      if (shouldThrow) {
        shouldThrow = false
        throw new Error('ctor failure')
      }
      return Reflect.construct(FakeWebSocket, [url])
    }
    ThrowingWS.CONNECTING = FakeWebSocket.CONNECTING
    ThrowingWS.OPEN = FakeWebSocket.OPEN
    ThrowingWS.CLOSING = FakeWebSocket.CLOSING
    ThrowingWS.CLOSED = FakeWebSocket.CLOSED
    globalThis.WebSocket = ThrowingWS
    const t = makeTransport()
    t.acquire()
    assert.equal(calls.length, 1, 'first constructor attempt threw')
    // Reconnect fires after INITIAL_RECONNECT_DELAY (~1s).
    await delay(1100)
    assert.equal(calls.length, 2, 'reconnect attempted')
    t.close()
  })

  it('reentrancy: consumer releasing its own acquire from onDisconnected does not crash', async () => {
    const t = makeTransport()
    let handle
    const c = {
      onMessage: () => {},
      onConnected: () => {},
      onDisconnected: () => { handle.release() },
    }
    t.addConsumer(c)
    handle = t.acquire()
    FakeWebSocket.last.handshake('n0')
    // Trigger teardown via setServerUrl swap — fires onDisconnected
    // for all consumers, then attempts reopen if still acquired.
    t.setServerUrl('ws://other.invalid/api/sync')
    await delay(0)
    // The consumer released during onDisconnected → acquireCount → 0
    // → setServerUrl's reopen check (acquireCount > 0) bails → no
    // new socket opened.
    assert.equal(FakeWebSocket.instances.length, 1, 'no reopen — consumer released during disconnect')
    t.close()
  })
})

// ─────────── SSE fallback ───────────
//
// The `SseTransport` adapter (client/sync/sse-transport.ts) issues
// `fetch` POSTs and reads the streaming `text/event-stream` response
// bodies. These tests intercept `fetch` and feed a synthetic
// `ReadableStream` so each test can drive frames at SSE granularity
// without a real server.

// Build a manually-controllable ReadableStream<Uint8Array>. `push` adds
// SSE-encoded bytes for the reader; `close` ends the stream (the
// adapter sees done=true, equivalent to the server end()ing the
// response on takeover).
function makeStream() {
  let controller
  const stream = new ReadableStream({
    start(c) { controller = c },
  })
  const encoder = new TextEncoder()
  return {
    stream,
    push(text) { controller.enqueue(encoder.encode(text)) },
    pushEvent(event, data) {
      const lines = data.split('\n').map((l) => `data: ${l}`).join('\n')
      controller.enqueue(encoder.encode(`event: ${event}\n${lines}\n\n`))
    },
    pushMessage(obj) {
      const data = typeof obj === 'string' ? obj : JSON.stringify(obj)
      const lines = data.split('\n').map((l) => `data: ${l}`).join('\n')
      controller.enqueue(encoder.encode(`${lines}\n\n`))
    },
    close() { try { controller.close() } catch {} },
    error(err) { try { controller.error(err) } catch {} },
  }
}

describe('socket-transport: SSE fallback', () => {
  let originalFetch
  let fetchCalls
  let nextResponse  // queued response factories: () => { streamCtl, response }

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchCalls = []
    nextResponse = []
    globalThis.fetch = (url, opts) => {
      fetchCalls.push({ url, opts })
      const factory = nextResponse.shift() ?? (() => {
        const s = makeStream()
        return { streamCtl: s, response: { ok: true, status: 200, statusText: 'OK', body: s.stream } }
      })
      const made = factory()
      // Capture the latest stream controller so the test can drive it.
      globalThis.__sseStreams = (globalThis.__sseStreams ?? [])
      globalThis.__sseStreams.push(made.streamCtl)
      return Promise.resolve(made.response)
    }
    globalThis.__sseStreams = []
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    delete globalThis.__sseStreams
  })

  function lastStream() {
    return globalThis.__sseStreams.at(-1)
  }
  // Wait for at least N fetch calls (the SSE transport debounces
  // outbound frames into a 100ms batched POST; tests need to wait for
  // the timer to fire).
  async function awaitFetch(n, timeoutMs = 1_000) {
    const start = Date.now()
    while (fetchCalls.length < n && Date.now() - start < timeoutMs) {
      await delay(10)
    }
    return fetchCalls.length >= n
  }

  it('WS close-before-open triggers an SSE POST', async () => {
    const t = makeTransport()
    t.acquire()
    assert.equal(FakeWebSocket.instances.length, 1, 'WS attempted first')
    assert.equal(fetchCalls.length, 0, 'no SSE POST yet')
    FakeWebSocket.last.simulateClose()
    // The constructor schedules an immediate flush (0ms) — wait one tick.
    assert.ok(await awaitFetch(1), 'SSE POST issued')
    assert.equal(fetchCalls[0].url, 'http://test.invalid/api/sync/sse')
    assert.equal(fetchCalls[0].opts.method, 'POST')
    t.close()
  })

  it('SSE session+challenge drive the same onConnected/onMessage path as WS', async () => {
    const t = makeTransport()
    const c = recordingConsumer()
    t.addConsumer(c)
    t.acquire()
    FakeWebSocket.last.simulateClose()
    assert.ok(await awaitFetch(1))
    // Server pushes session id event, then challenge, then a state.
    lastStream().pushEvent('session', 'sid-abc')
    await delay(10)
    lastStream().pushMessage({ type: 'challenge', nonce: 'sse-nonce' })
    await delay(10)
    assert.deepEqual(c.connected, ['sse-nonce'])
    assert.equal(t.getNonce(), 'sse-nonce')
    lastStream().pushMessage({ type: 'workspace-state', workspaceTag: 't' })
    await delay(10)
    assert.equal(c.messages.length, 1)
    assert.equal(c.messages[0].type, 'workspace-state')
    t.close()
  })

  it('cached authenticate password rides as body.password on every POST', async () => {
    const t = makeTransport()
    t.acquire()
    FakeWebSocket.last.simulateClose()
    assert.ok(await awaitFetch(1))
    lastStream().pushEvent('session', 'sid-xyz')
    lastStream().pushMessage({ type: 'challenge', nonce: 'n0' })
    await delay(10)
    await setCachedSyncPassword('p1')
    const p = t.runAuthFlow()
    // The 100ms debounce window means the password POST takes ~100ms.
    assert.ok(await awaitFetch(2, 500))
    assert.equal(fetchCalls[1].url, 'http://test.invalid/api/sync/sse?id=sid-xyz')
    const body = JSON.parse(fetchCalls[1].opts.body)
    assert.equal(body.password, 'p1', 'password rides on the body')
    // The authenticate frame itself is intercepted (not sent on the
    // wire) — only password + frames go out. No `frames` field.
    assert.equal(body.frames, undefined, 'no synthetic frames')
    lastStream().pushMessage({ type: 'authenticated' })
    await delay(10)
    assert.equal(await p, true)
    t.close()
  })

  it('a fresh session event replaces the id and re-fires onConnected with the new nonce', async () => {
    const t = makeTransport()
    const c = recordingConsumer()
    t.addConsumer(c)
    t.acquire()
    FakeWebSocket.last.simulateClose()
    assert.ok(await awaitFetch(1))
    // First session.
    lastStream().pushEvent('session', 'sid-A')
    lastStream().pushMessage({ type: 'challenge', nonce: 'nonce-A' })
    await delay(10)
    // Trigger an outbound send so the test can observe the next POST's URL.
    t.send({ type: 'ping' })
    assert.ok(await awaitFetch(2, 500))
    assert.equal(fetchCalls[1].url, 'http://test.invalid/api/sync/sse?id=sid-A',
      'continuation POST echoes the latched sid')
    // Simulate a different replica picking up the session — server
    // emits a fresh `session` event with a NEW id + a new challenge.
    lastStream().pushEvent('session', 'sid-B')
    lastStream().pushMessage({ type: 'challenge', nonce: 'nonce-B' })
    await delay(10)
    assert.deepEqual(c.connected, ['nonce-A', 'nonce-B'])
    assert.equal(t.getNonce(), 'nonce-B')
    // Next POST should carry the new id.
    t.send({ type: 'ping' })
    assert.ok(await awaitFetch(3, 500))
    assert.equal(fetchCalls[2].url, 'http://test.invalid/api/sync/sse?id=sid-B',
      'next POST switches to the new sid')
    t.close()
  })

  it('outbound frames coalesce within the 100ms debounce window', async () => {
    const t = makeTransport()
    t.acquire()
    FakeWebSocket.last.simulateClose()
    assert.ok(await awaitFetch(1))
    lastStream().pushEvent('session', 'sid-x')
    lastStream().pushMessage({ type: 'challenge', nonce: 'n' })
    await delay(10)
    // Fire 3 sends within the debounce window — should produce ONE POST.
    t.send({ type: 'ping' })
    t.send({ type: 'ping' })
    t.send({ type: 'ping' })
    assert.ok(await awaitFetch(2, 500))
    const body = JSON.parse(fetchCalls[1].opts.body)
    assert.equal(body.frames.length, 3, 'three frames batched into one POST')
    t.close()
  })

  it('SSE fallback does NOT engage on a successful WS open', () => {
    const t = makeTransport()
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    assert.equal(fetchCalls.length, 0, 'no SSE POST issued')
    FakeWebSocket.last.simulateClose()
    t.close()
  })

  it('server-initiated close event (graceful shutdown) tears the transport down', async () => {
    const t = makeTransport()
    const c = recordingConsumer()
    t.addConsumer(c)
    t.acquire()
    FakeWebSocket.last.simulateClose()
    assert.ok(await awaitFetch(1))
    lastStream().pushEvent('session', 'sid-x')
    lastStream().pushMessage({ type: 'challenge', nonce: 'n' })
    await delay(10)
    // Server emits the structured close event (1001).
    lastStream().pushEvent('close', JSON.stringify({ code: 1001, reason: 'Server shutting down' }))
    await delay(10)
    assert.equal(c.disconnected.length, 1)
    t.close()
  })

  it('mid-life session change fires onDisconnected before onConnected (re-subscribe path)', async () => {
    // Mirrors the multi-replica recovery case: an in-flight POST
    // landed on a replica that didn't know the latched session id, so
    // the server minted a fresh session with a new id + new challenge.
    // The outer transport must fire `onDisconnected` so triage-sync
    // resets its subscribed-state before `onConnected` re-runs the
    // subscribe loop against the new nonce. Without this, the new
    // server session has no subscribers and broadcasts never reach
    // this client.
    const t = makeTransport()
    const events = []
    t.addConsumer({
      onMessage: () => { events.push('M') },
      onConnected: (n) => { events.push(`C:${n}`) },
      onDisconnected: (r) => { events.push(`D:${r}`) },
    })
    t.acquire()
    FakeWebSocket.last.simulateClose()
    assert.ok(await awaitFetch(1))
    // First session.
    lastStream().pushEvent('session', 'sid-A')
    lastStream().pushMessage({ type: 'challenge', nonce: 'nonce-A' })
    await delay(10)
    assert.deepEqual(events, ['C:nonce-A'])
    // Replica takeover — new session id, new challenge.
    lastStream().pushEvent('session', 'sid-B')
    lastStream().pushMessage({ type: 'challenge', nonce: 'nonce-B' })
    await delay(10)
    // Order matters: disconnect THEN connect — that's the signal
    // triage-sync needs to clear session.subscribed before
    // re-subscribing.
    assert.deepEqual(events, ['C:nonce-A', 'D:session restarted', 'C:nonce-B'])
    t.close()
  })

  it('1001 close code resets reconnect backoff to INITIAL', async () => {
    const t = makeTransport()
    t.acquire()
    FakeWebSocket.last.simulateClose()
    assert.ok(await awaitFetch(1))
    lastStream().pushEvent('session', 'sid-x')
    lastStream().pushMessage({ type: 'challenge', nonce: 'n' })
    await delay(10)
    // Drive the reconnect-backoff up: trigger a server-initiated 1001
    // close, then check that the reconnect attempt fires at the
    // INITIAL delay (~1s) rather than a bumped value. Observable via
    // the timing of the next fetch.
    lastStream().pushEvent('close', JSON.stringify({ code: 1001, reason: 'shutting down' }))
    await delay(10)
    const beforeReconnect = fetchCalls.length
    // Reconnect cycle: the close listener resets reconnectDelayMs to
    // INITIAL (1000ms) on 1001, so the next attempt should land
    // within ~1100ms (with margin). A regression that didn't reset
    // would still attempt within that window since this is the FIRST
    // reconnect — but the assertion holds for any future regression
    // that accidentally bumped the delay before resetting.
    await delay(1100)
    // Reconnect tries WS first (FakeWebSocket constructor); if WS
    // succeeds the SSE plane stays untouched. Either way, the WS
    // ctor fires another instance.
    assert.ok(FakeWebSocket.instances.length >= 2, 'reconnect attempted')
    assert.ok(fetchCalls.length >= beforeReconnect, 'reconnect fired')
    t.close()
  })
})

// ─────────── auth flow ───────────

describe('socket-transport: auth flow', () => {
  it('returns false synchronously when socket is not open', async () => {
    const t = makeTransport()
    const r = await t.runAuthFlow()
    assert.equal(r, false)
    t.close()
  })

  it('cached-password silent replay: succeeds → no resolver call, returns true', async () => {
    await setCachedSyncPassword('cached-pw')
    const resolverCalls = []
    const t = makeTransport({ authResolver: (ctx) => {
      resolverCalls.push(ctx)
      return Promise.resolve(null)
    } })
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    const p = t.runAuthFlow()
    await delay(0)  // let the IIFE send authenticate
    const sent = FakeWebSocket.last.frames.map(JSON.parse).find((m) => m.type === 'authenticate')
    assert.equal(sent.password, 'cached-pw')
    FakeWebSocket.last.simulateMessage({ type: 'authenticated' })
    assert.equal(await p, true)
    assert.equal(resolverCalls.length, 0, 'resolver not invoked on cached-replay success')
    t.close()
  })

  it('cached-password fails → falls through to resolver with retry=false on first prompt', async () => {
    await setCachedSyncPassword('wrong-pw')
    const resolverCalls = []
    const t = makeTransport({ authResolver: (ctx) => {
      resolverCalls.push(ctx)
      return Promise.resolve(null)  // cancel
    } })
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    const p = t.runAuthFlow()
    await delay(0)
    FakeWebSocket.last.simulateMessage({ type: 'unauthorized', kind: 'auth-failed' })
    const r = await p
    assert.equal(r, false, 'resolver returned null → flow returns false')
    assert.equal(resolverCalls.length, 1, 'resolver invoked once')
    assert.equal(resolverCalls[0].retry, false, 'first prompt is not a retry')
    t.close()
  })

  it('cached-replay is once-per-socket: second runAuthFlow without reset goes straight to resolver', async () => {
    await setCachedSyncPassword('cached-pw')
    let resolverCount = 0
    const t = makeTransport({ authResolver: () => {
      resolverCount += 1
      return Promise.resolve(null)
    } })
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    // First flow: cached replay fires + fails.
    const p1 = t.runAuthFlow()
    await delay(0)
    FakeWebSocket.last.simulateMessage({ type: 'unauthorized', kind: 'auth-failed' })
    await p1
    assert.equal(resolverCount, 1)
    // Second flow on the same socket: cache is now null (we wiped on
    // first failure), so it goes straight to resolver. The replay
    // guard is the secondary mechanism — even if the cache were
    // re-populated, the guard would skip replay until reset.
    await setCachedSyncPassword('re-cached')
    const p2 = t.runAuthFlow()
    await p2
    assert.equal(resolverCount, 2, 'second runAuthFlow skipped cached replay (guard burnt)')
    t.close()
  })

  it('runAuthFlow with no resolver does not wedge the in-flight singleton', async () => {
    // Synchronous-return path: no cached password (cleared in
    // beforeEach) and no authResolver, so the IIFE runs straight to the
    // `!deps.authResolver` bail. The `await Promise.resolve()` at the
    // top of the IIFE ensures `authFlowInFlight = promise` lands BEFORE
    // the finally nulls it — otherwise the finally ran first and the
    // outer assignment resurrected the settled-`false` promise into the
    // slot, wedging every subsequent runAuthFlow (and the documented
    // resetCachedReplayGuard boot-after-unlock recovery) on it.
    const t = makeTransport() // no authResolver
    t.acquire()
    FakeWebSocket.last.handshake('n0') // socket OPEN + challenge nonce
    const p1 = t.runAuthFlow()
    assert.equal(await p1, false, 'no resolver → false')
    const p2 = t.runAuthFlow()
    assert.notEqual(p2, p1, 'a fresh flow is created, not the wedged settled promise')
    assert.equal(await p2, false)
    t.close()
  })

  it('resetCachedReplayGuard re-arms the cached replay on the current socket', async () => {
    await setCachedSyncPassword('cached-pw')
    const t = makeTransport({ authResolver: () => Promise.resolve(null) })
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    // First replay: succeeds via cached path.
    const p1 = t.runAuthFlow()
    await delay(0)
    FakeWebSocket.last.simulateMessage({ type: 'authenticated' })
    await p1
    const framesAfterFirst = FakeWebSocket.last.frames.length
    // Re-arm + run again — should fire another cached-replay
    // authenticate frame.
    t.resetCachedReplayGuard()
    const p2 = t.runAuthFlow()
    await delay(0)
    assert.ok(FakeWebSocket.last.frames.length > framesAfterFirst, 'second cached-replay fired')
    FakeWebSocket.last.simulateMessage({ type: 'authenticated' })
    await p2
    t.close()
  })

  it('concurrent runAuthFlow callers coalesce on the in-flight promise', async () => {
    await setCachedSyncPassword('cached-pw')
    let resolverCount = 0
    const t = makeTransport({ authResolver: () => {
      resolverCount += 1
      return Promise.resolve(null)
    } })
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    const p1 = t.runAuthFlow()
    const p2 = t.runAuthFlow()
    const p3 = t.runAuthFlow()
    assert.equal(p1, p2, 'second caller gets the same promise')
    assert.equal(p1, p3, 'third caller gets the same promise')
    await delay(0)
    FakeWebSocket.last.simulateMessage({ type: 'authenticated' })
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    assert.deepEqual([r1, r2, r3], [true, true, true])
    assert.equal(resolverCount, 0, 'cached replay succeeded; resolver not called')
    t.close()
  })

  it('socket swap mid-flow bails false (startSocket pin)', async () => {
    await setCachedSyncPassword('cached-pw')
    let resolverEntered = false
    let resolverResolve
    const t = makeTransport({ authResolver: () => {
      resolverEntered = true
      return new Promise((resolve) => { resolverResolve = resolve })
    } })
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    // Burn the cached replay first so the flow advances to the
    // resolver and waits.
    const p = t.runAuthFlow()
    await delay(0)
    FakeWebSocket.last.simulateMessage({ type: 'unauthorized', kind: 'auth-failed' })
    // Now the flow is awaiting the resolver. Swap the socket out
    // by tearing down + reconnecting.
    await delay(0)
    assert.equal(resolverEntered, true, 'resolver was invoked')
    FakeWebSocket.last.simulateClose()
    // After socket swap, resolve the resolver with a password — the
    // flow should bail false because startSocket no longer matches.
    resolverResolve('would-have-worked')
    const r = await p
    assert.equal(r, false, 'flow bails on socket swap')
    t.close()
  })

  it('new socket resets the cached-replay guard (so each socket gets one cached attempt)', async () => {
    await setCachedSyncPassword('cached-pw')
    const t = makeTransport({ authResolver: () => Promise.resolve(null) })
    t.acquire()
    FakeWebSocket.last.handshake('n0')
    // Burn the replay on socket A.
    const pA = t.runAuthFlow()
    await delay(0)
    FakeWebSocket.last.simulateMessage({ type: 'unauthorized', kind: 'auth-failed' })
    await pA
    // Tear down socket A and let reconnect open socket B.
    FakeWebSocket.last.simulateClose()
    await delay(1100)
    assert.equal(FakeWebSocket.instances.length, 2)
    const wsB = FakeWebSocket.last
    wsB.handshake('n1')
    await setCachedSyncPassword('cached-pw-2')
    const pB = t.runAuthFlow()
    await delay(0)
    const sent = wsB.frames.map(JSON.parse).find((m) => m.type === 'authenticate')
    assert.equal(sent?.password, 'cached-pw-2', 'fresh socket replays the (new) cached password')
    wsB.simulateMessage({ type: 'authenticated' })
    await pB
    t.close()
  })
})
