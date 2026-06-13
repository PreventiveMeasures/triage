// Cross-instance pub/sub round-trip (`server-e2e/pubsub.ts`). Exercises the
// LISTEN+NOTIFY loop against PGlite — single-connection by design, so
// this confirms parse / dispatch / self-filter on ONE process; the
// genuine multi-replica fan-out (instance A → instance B) is out of
// reach of PGlite (mirrors the same caveat the Neon DB tests carry —
// see `_neon-pglite.js` and `tryCommitNeon`'s docstring).
//
// The Neon `Client` API the pubsub expects (`connect` / `query` /
// `end` / `on('notification', cb)` / optional `once('error', cb)`)
// doesn't match PGlite's callback-style `listen(channel, cb)`. The
// adapter below maps PGlite's API into the Client shape so the
// production pubsub code path runs unmodified under test.

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

import { CHANNEL, createNeonPubSub, createNoopPubSub } from '../server-e2e/pubsub.ts'

// One PGlite instance per file — same rationale as `_neon-pglite.js`
// (WASM init cost). Each test holds its own Client adapter, so two
// tests don't clobber each other's listeners.
let sharedPg = null
function sharedInstance() {
  if (!sharedPg) sharedPg = new PGlite()
  return sharedPg
}

after(async () => {
  if (sharedPg) { await sharedPg.close(); sharedPg = null }
})

// Adapter: PGlite-backed shim of the `@neondatabase/serverless` Client
// surface the pubsub touches. Returns a *factory* matching
// `NeonPubSubDeps.newClient` — one PGlite-backed Client per call so
// every connect+listen builds its own subscription.
//
// Options:
//   `failConnects`     — first N connects throw before any succeed
//                        (exercises the reconnect backoff).
//   `hangConnect`      — connect Promise never resolves until `end()`
//                        is called (simulates a Neon WS blackhole; the
//                        connect Promise rejects via the abort path).
function makeFakeClientFactory({ failConnects = 0, onConnect = null, hangConnect = false } = {}) {
  let connectsLeft = failConnects
  return () => {
    const pg = sharedInstance()
    let notifListener = null
    let errListener = null
    let unsub = null
    // The hung-connect path: stash the in-flight connect's reject so
    // a subsequent `end()` can abort it. Mirrors what a real Client
    // does internally when the underlying WS is torn down mid-handshake.
    let abortConnect = null
    return {
      connect: async () => {
        if (connectsLeft > 0) {
          connectsLeft -= 1
          throw new Error(`fake connect failure #${connectsLeft + 1}`)
        }
        if (hangConnect) {
          await new Promise((_resolve, reject) => { abortConnect = reject })
          return  // unreachable in practice
        }
        if (onConnect) await onConnect()
      },
      query: async (text, params = []) => {
        // The pubsub fires `LISTEN <channel>` once at start. Route it
        // through PGlite's callback-style `listen()` so notifications
        // arrive via our `notification`-event listener installed above.
        // The Client's `query()` is fire-and-forget here — we only care
        // about the side effect.
        const m = /^LISTEN\s+(\w+)/iu.exec(text)
        if (m) {
          unsub = await pg.listen(m[1], (payload) => {
            const fn = notifListener
            if (fn) fn({ channel: m[1], payload })
          })
          return { rows: [] }
        }
        return await pg.query(text, params)
      },
      end: async () => {
        // Abort a hung connect (if any) — real Client's `end()` rejects
        // in-flight queries; mirror that here so `stop()`'s cancel path
        // is exercised by the test.
        if (abortConnect) { abortConnect(new Error('client end()')); abortConnect = null }
        if (unsub) { try { await unsub() } catch {} }
        notifListener = null
        errListener = null
      },
      on: (event, listener) => {
        if (event === 'notification') notifListener = listener
      },
      once: (event, listener) => {
        if (event === 'error') errListener = listener
      },
      // Test-only helper: simulate a transport error so the pubsub
      // exercises its reconnect path.
      _fireError(err) { errListener?.(err) },
    }
  }
}

// Drives the test event loop until `cond()` returns truthy or the
// `timeoutMs` budget elapses (then throws). PGlite notification
// dispatch is async — a publish that arrived inside `await` may not
// have fired its handler yet by the next line.
async function waitFor(cond, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  // eslint-disable-next-line no-await-in-loop
  while (Date.now() < deadline) {
    const v = await cond()
    if (v) return v
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
}

describe('createNoopPubSub', () => {
  it('start / publish / stop are all no-ops that resolve immediately', async () => {
    const ps = createNoopPubSub()
    const seen = []
    await ps.start((msg) => { seen.push(msg); return Promise.resolve() })
    ps.publish({ kind: 'rev', tag: 'tag-A', id: 'id-1' })
    ps.publish({ kind: 'objput', tag: 'tag-A', res: 'res-1' })
    ps.publish({ kind: 'objdel', tag: 'tag-A', res: 'res-1', ver: 7 })
    // Give the loop a turn so any (errant) handler invocation would
    // land. The noop publishes go nowhere by design.
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    assert.deepEqual(seen, [])
    await ps.stop()
  })
})

describe('createNeonPubSub — LISTEN/NOTIFY round-trip on PGlite', () => {
  it('routes a publish through pg_notify and into the handler', async () => {
    const ps = createNeonPubSub({
      newClient: makeFakeClientFactory(),
      debug: false,
    })
    const seen = []
    await ps.start((msg) => { seen.push(msg); return Promise.resolve() })
    try {
      ps.publish({ kind: 'rev', tag: 'tag-A', id: 'id-1' })
      // The Client's notification dispatch is async — wait for the
      // round-trip. The publish carries our own sender id, so it
      // would be FILTERED here; but PGlite delivers via its own
      // listener path that doesn't share state with the publishing
      // pubsub's sender — wait, it DOES share state because we hand
      // back the SAME notification listener the pubsub registered.
      // The self-filter therefore fires and `seen` stays empty.
      // This case is covered by the dedicated self-filter test below.
      // Here we instead inject a foreign-sender envelope to confirm
      // the dispatch path itself works.
      const pg = sharedInstance()
      await pg.query(
        `SELECT pg_notify($1, $2)`,
        [CHANNEL, JSON.stringify({ sender: 'foreign', kind: 'rev', tag: 'tag-A', id: 'id-1' })],
      )
      await waitFor(() => seen.length === 1)
      assert.deepEqual(seen, [{ kind: 'rev', tag: 'tag-A', id: 'id-1' }])
    } finally { await ps.stop() }
  })

  it("skips notifications carrying our own sender id (Postgres delivers NOTIFY back to publishers)", async () => {
    const ps = createNeonPubSub({
      newClient: makeFakeClientFactory(),
      debug: false,
    })
    const seen = []
    await ps.start((msg) => { seen.push(msg); return Promise.resolve() })
    try {
      // The pubsub's own publish stamps its sender id, so the
      // round-trip lands on our own LISTENing client and is filtered.
      ps.publish({ kind: 'rev', tag: 'tag-A', id: 'self-1' })
      ps.publish({ kind: 'objput', tag: 'tag-A', res: 'self-res' })
      // Allow the loop several ticks so a (regressed) self-delivery
      // would have time to land. None should.
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      assert.deepEqual(seen, [])
    } finally { await ps.stop() }
  })

  it('parses all three message kinds; drops malformed payloads', async () => {
    const ps = createNeonPubSub({
      newClient: makeFakeClientFactory(),
      debug: false,
    })
    const seen = []
    await ps.start((msg) => { seen.push(msg); return Promise.resolve() })
    try {
      const pg = sharedInstance()
      const send = (envelope) => pg.query(`SELECT pg_notify($1, $2)`, [CHANNEL, JSON.stringify(envelope)])
      // Valid: one of each kind, foreign sender so they pass the filter.
      await send({ sender: 'fA', kind: 'rev', tag: 't', id: 'r1' })
      await send({ sender: 'fA', kind: 'objput', tag: 't', res: 'p1' })
      await send({ sender: 'fA', kind: 'objdel', tag: 't', res: 'p1', ver: 3 })
      // Malformed: missing required field / wrong types / unknown kind.
      // None of these should reach `seen`.
      await send({ sender: 'fA', kind: 'rev', tag: 't' })            // no id
      await send({ sender: 'fA', kind: 'rev', tag: 't', id: 7 })      // non-string id
      await send({ sender: 'fA', kind: 'rev', id: 'r' })              // no tag
      await send({ sender: 'fA', kind: 'objput', tag: 't' })          // no res
      await send({ sender: 'fA', kind: 'objdel', tag: 't', res: 'r' })// no ver
      await send({ sender: 'fA', kind: 'objdel', tag: 't', res: 'r', ver: 1.5 }) // non-int
      await send({ sender: 'fA', kind: 'unknown', tag: 't' })         // unknown kind
      // Also send a non-JSON payload (parseBusMessage guards via try/catch).
      await pg.query(`SELECT pg_notify($1, $2)`, [CHANNEL, 'not-json'])
      await waitFor(() => seen.length === 3)
      // Give the loop a few more ticks so any spurious dispatch would surface.
      await new Promise((resolve) => { setTimeout(resolve, 30) })
      assert.equal(seen.length, 3, `unexpected extra dispatches: ${JSON.stringify(seen)}`)
      assert.deepEqual(seen.find((m) => m.kind === 'rev'), { kind: 'rev', tag: 't', id: 'r1' })
      assert.deepEqual(seen.find((m) => m.kind === 'objput'), { kind: 'objput', tag: 't', res: 'p1' })
      assert.deepEqual(seen.find((m) => m.kind === 'objdel'), { kind: 'objdel', tag: 't', res: 'p1', ver: 3 })
    } finally { await ps.stop() }
  })

  it("retries `connect` with backoff on transient failure", async () => {
    const ps = createNeonPubSub({
      newClient: makeFakeClientFactory({ failConnects: 2 }),
      debug: false,
      reconnectBaseMs: 5,
      reconnectCapMs: 20,
    })
    const seen = []
    await ps.start((msg) => { seen.push(msg); return Promise.resolve() })
    try {
      // After 2 failed attempts the third connect succeeds and LISTEN
      // registers; a publish round-trip now works as in the parse test.
      const pg = sharedInstance()
      await pg.query(
        `SELECT pg_notify($1, $2)`,
        [CHANNEL, JSON.stringify({ sender: 'remote', kind: 'rev', tag: 't', id: 'after-retry' })],
      )
      await waitFor(() => seen.length === 1)
      assert.deepEqual(seen[0], { kind: 'rev', tag: 't', id: 'after-retry' })
    } finally { await ps.stop() }
  })

  it('publish dropped silently when client is disconnected (start hasn\'t resolved yet)', () => {
    // Publishing BEFORE start (or during a reconnect window) drops on
    // the floor. Verified by constructing the pubsub but never calling
    // start — `publish` must not throw, must not enqueue, must not
    // leak state.
    const ps = createNeonPubSub({
      newClient: makeFakeClientFactory(),
      debug: false,
    })
    assert.doesNotThrow(() => {
      ps.publish({ kind: 'rev', tag: 't', id: 'x' })
      ps.publish({ kind: 'objdel', tag: 't', res: 'r', ver: 1 })
    })
  })

  it("stop is safe to call even when start hasn't resolved", async () => {
    // SIGTERM during the initial connect attempt: stop must not block
    // on the in-flight connect, and must close cleanly so the process
    // exits. The fake's `connect()` resolves promptly here; the
    // hung-connect case is pinned by the next test.
    const ps = createNeonPubSub({
      newClient: makeFakeClientFactory(),
      debug: false,
    })
    // Don't await start — schedule it and stop in parallel.
    const startPromise = ps.start(() => Promise.resolve()).catch(() => {})
    await ps.stop()
    await startPromise
  })

  it('stop unblocks a hung `c.connect()` by ending the in-flight client', async () => {
    // Neon WS blackhole during handshake: `c.connect()` never
    // resolves. Without `tryConnect`'s eager `state.client = c`
    // assignment + `stop()`'s `c.end()` call, `stop()` would await
    // `state.connectAttempt` forever and SIGTERM would hang. Stage
    // a hung connect, then assert `stop()` returns promptly (the
    // fake `end()` rejects the connect Promise, the catch path
    // unwinds, connectAttempt resolves).
    const ps = createNeonPubSub({
      newClient: makeFakeClientFactory({ hangConnect: true }),
      debug: false,
    })
    const startPromise = ps.start(() => Promise.resolve()).catch(() => {})
    // Let the connect Promise be created + state.client assigned.
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    const t0 = Date.now()
    await ps.stop()
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 500, `stop should not hang on a stuck connect; took ${elapsed}ms`)
    await startPromise
  })

  it('stop drains in-flight handler promises before returning', async () => {
    // `onBusMessage` hits the DB (`handle.revisionById.get` /
    // `getLive`); the lifecycle teardown runs `pubsub.stop()` and THEN
    // `handle.close()` (see closeDb in server-e2e/index.ts). Without the
    // pendingHandlers drain, a handler mid-DB-query would race the
    // close and throw. Stage a slow handler and assert `stop()` waits
    // for it.
    const ps = createNeonPubSub({
      newClient: makeFakeClientFactory(),
      debug: false,
    })
    let handlerCompleted = false
    await ps.start(() => new Promise((resolve) => {
      setTimeout(() => { handlerCompleted = true; resolve() }, 100)
    }))
    try {
      // Foreign-sender publish so the dispatch fires (own-sender
      // would be self-filtered).
      const pg = sharedInstance()
      await pg.query(
        `SELECT pg_notify($1, $2)`,
        [CHANNEL, JSON.stringify({ sender: 'remote', kind: 'rev', tag: 't', id: 'slow' })],
      )
      // Wait for the dispatch to fire and the handler to start. PGlite
      // notification dispatch is async — give it a tick. Once the
      // pendingHandlers set has an entry, the handler is in flight.
      await new Promise((resolve) => { setTimeout(resolve, 30) })
      assert.equal(handlerCompleted, false, 'handler must still be in flight')
    } finally {
      await ps.stop()
      assert.equal(handlerCompleted, true, 'stop() must await in-flight handlers')
    }
  })

  it('stop kicks the reconnect-backoff sleep out promptly (no `capMs` stall on SIGTERM)', async () => {
    // The reconnect loop parks in `cancellableSleep(state, delay)`
    // between failed connects. Without the cancel hook a SIGTERM
    // mid-backoff would stall shutdown for up to `capMs` (30 s default)
    // waiting on the timer. Stage 5 connect failures with a 10-second
    // floor and assert stop returns in well under the floor.
    const ps = createNeonPubSub({
      newClient: makeFakeClientFactory({ failConnects: 5 }),
      debug: false,
      reconnectBaseMs: 10_000,    // first delay = 10s, well above the
      reconnectCapMs: 10_000,     // ~1s budget below
    })
    const startPromise = ps.start(() => Promise.resolve()).catch(() => {})
    // Wait for the loop to enter its first sleep (one failed connect
    // attempt → sleeping for ~10s). 50ms is plenty for the awaits
    // around `c.connect()` + `c.end()` to settle.
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    const t0 = Date.now()
    await ps.stop()
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 1_000, `stop should not stall on the backoff sleep; took ${elapsed}ms`)
    await startPromise
  })
})
