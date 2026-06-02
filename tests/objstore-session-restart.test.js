// Unit tests for `_rawPut`'s transient-session-restart retry in
// `client/sync/objstore.ts`. Drives the production objstore client over a
// hand-rolled fake transport (no server, no socket) so a session restart
// can be injected with exact timing relative to the put-token `recv`.
//
// Background: on the SSE plane a continuation token can land on a replica
// that doesn't know the session, so the server re-challenges with a fresh
// nonce. `socket-transport.ts` turns that into a synthetic disconnect with
// reason 'session restarted', and the objstore client's
// `failPendingWaiters` rejects every in-flight request with `objstore:
// session restarted`. The mass re-upload flow issues many sequential puts,
// so each hop used to surface as a per-object "re-upload … failed" row.
// `_rawPut` now replays the begin→put-token handshake across such a
// restart (re-signing against the new nonce) instead of failing.

import './_polyfills.js'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { Buffer } from 'node:buffer'

import { __test__, createObjstoreClient, deriveObjstoreKeys } from '../client/sync/objstore.ts'
import { computeContentHash } from '../client/sync/objstore-crypto.ts'
// Use the production reason constant (not a hardcoded copy) so this test
// stays coupled to the same string the objstore put-retry guard matches —
// a reword of the reason can't leave the test green while the real retry
// silently stops firing.
import { SESSION_RESTART_REASON } from '../client/sync/socket-transport.ts'

const HTTP_ORIGIN = 'https://relay.test'

// Minimal SocketTransport stand-in. Captures the objstore client's
// consumer + every sent frame, and exposes test controls to drive
// connect / disconnect / message delivery and to simulate a session
// restart (synchronous disconnect+reconnect with a new nonce — the same
// ordering `socket-transport.ts` produces on a re-challenge).
function makeFakeTransport(initialNonce = 'nonce-1', { sse = false } = {}) {
  let consumer = null
  let nonce = initialNonce
  const sent = []
  // Optional per-frame hook the bounded-retry test uses to auto-restart
  // on every put-begin.
  let onSend = null
  return {
    sent,
    setOnSend(fn) { onSend = fn },
    // --- test controls ---
    deliver(msg) { consumer?.onMessage(msg) },
    connect(n) { nonce = n; consumer?.onConnected(n) },
    restart(newNonce) {
      // Mirror socket-transport's re-challenge ordering: a synthetic
      // disconnect (which fails in-flight waiters) FIRST, then reconnect
      // with the fresh nonce.
      consumer?.onDisconnected(SESSION_RESTART_REASON)
      nonce = newNonce
      consumer?.onConnected(newNonce)
    },
    count(type) { return sent.filter((m) => m.type === type).length },
    last(type) { return sent.findLast((m) => m.type === type) },
    beginCount() { return sent.filter((m) => m.type === 'objstore-put-begin').length },
    lastBegin() { return sent.findLast((m) => m.type === 'objstore-put-begin') },
    // --- SocketTransport surface the objstore client uses ---
    addConsumer(c) { consumer = c; return { remove() { consumer = null } } },
    acquire() { return { release() {} } },
    getNonce() { return nonce },
    getSocket() { return {} },
    isSse() { return sse },
    send(msg) {
      sent.push(msg)
      try { onSend?.(msg) } catch {}
      return true
    },
    runAuthFlow() { return Promise.resolve(true) },
    close() {},
  }
}

// Poll `pred` on the macrotask queue until truthy or timeout. Used to
// await the client's async crypto (hash + sign) reaching the next
// `send`, without coupling to an exact microtask count.
async function waitFor(pred, label, timeoutMs = 2_000) {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${label}`)
    await new Promise((r) => { setTimeout(r, 5) })
  }
}

async function openSession(transport) {
  const keys = await deriveObjstoreKeys(
    crypto.getRandomValues(new Uint8Array(32)).toBase64(),
    crypto.randomUUID(),
  )
  const client = createObjstoreClient({ serverUrl: '', httpOrigin: HTTP_ORIGIN, transport })
  // `getNonce()` is already truthy, so openWorkspace resolves the connect
  // gate immediately; the subscription's `resources` seeds an empty
  // inventory.
  const session = await client.openWorkspace(keys, {
    workspaceId: keys.workspaceTag,
    workspaceTag: keys.workspaceTag,
    resources: Promise.resolve([]),
  })
  return { client, session }
}

// Reply to a captured put-begin with a valid put-token addressed to the
// same workspaceTag + resourceTag the predicate in `_rawPutOnce` pins on.
function deliverPutToken(transport, begin) {
  transport.deliver({
    type: 'objstore-put-token',
    workspaceTag: begin.workspaceTag,
    resourceTag: begin.resourceTag,
    urlPath: '/api/objstore/blob/staging1',
    token: 'rest-token',
    expiresAt: Date.now() + 60_000,
    stagingId: 'staging1',
  })
}

describe('objstore _rawPut session-restart retry', () => {
  let realFetch
  beforeEach(() => {
    realFetch = globalThis.fetch
    // Mock the REST PUT: echo back a contentHash computed from the body so
    // the client's post-PUT ack validation (which pins contentHash +
    // contentLength against what it signed) always matches.
    globalThis.fetch = async (_url, opts) => {
      const body = opts.body
      const contentHash = await computeContentHash(body)
      const ack = { version: 1, incarnation: 'incarnation-test', contentHash, contentLength: body.byteLength }
      return {
        ok: true,
        status: 200,
        json() { return ack },
        text() { return '' },
      }
    }
  })
  afterEach(() => { globalThis.fetch = realFetch })

  it('replays the put-token handshake after a session restart and resolves ok', async () => {
    const transport = makeFakeTransport('nonce-1')
    const { client, session } = await openSession(transport)
    try {
      const putP = session.put({ fileName: 'rep-1.json', content: Buffer.from('{"findings":[]}'), prev: null })

      // First begin goes out, then we wait for its put-token `recv`.
      await waitFor(() => transport.beginCount() === 1, 'first put-begin')
      const firstBegin = transport.lastBegin()

      // SSE replica hop: re-challenge with a new nonce. This rejects the
      // in-flight `recv` with `objstore: session restarted`.
      transport.restart('nonce-2')

      // The retry must re-send a fresh begin (re-signed against nonce-2).
      await waitFor(() => transport.beginCount() === 2, 'retried put-begin after restart')
      const retriedBegin = transport.lastBegin()
      assert.equal(retriedBegin.resourceTag, firstBegin.resourceTag, 'same resource, replayed handshake')

      // Honour the retry → REST PUT (mocked) → ack → ok.
      deliverPutToken(transport, retriedBegin)
      const result = await putP
      assert.equal(result.ok, true, `put should succeed after the restart: ${JSON.stringify(result)}`)
      assert.equal(result.meta.version, 1)
    } finally { client.close() }
  })

  it('a put that never hits a restart sends exactly one begin (no spurious retry)', async () => {
    const transport = makeFakeTransport('nonce-1')
    const { client, session } = await openSession(transport)
    try {
      const putP = session.put({ fileName: 'rep-2.json', content: Buffer.from('{"findings":[]}'), prev: null })
      await waitFor(() => transport.beginCount() === 1, 'put-begin')
      deliverPutToken(transport, transport.lastBegin())
      const result = await putP
      assert.equal(result.ok, true)
      assert.equal(transport.beginCount(), 1, 'no restart → no replay')
    } finally { client.close() }
  })

  it('gives up after MAX_SESSION_RESTART_RETRIES consecutive restarts', async () => {
    const transport = makeFakeTransport('nonce-1')
    // Auto-restart on every begin so the put can never complete its
    // handshake — exercises the retry bound.
    let restarts = 0
    transport.setOnSend((msg) => {
      if (msg.type !== 'objstore-put-begin') return
      restarts += 1
      queueMicrotask(() => transport.restart(`nonce-restart-${restarts}`))
    })
    const { client, session } = await openSession(transport)
    try {
      await assert.rejects(
        session.put({ fileName: 'rep-3.json', content: Buffer.from('{"findings":[]}'), prev: null }),
        /session restarted/u,
        'a persistently flapping socket must surface the error, not spin forever',
      )
      // Initial attempt + MAX_SESSION_RESTART_RETRIES replays.
      assert.equal(
        transport.beginCount(), __test__.MAX_SESSION_RESTART_RETRIES + 1,
        'bounded at MAX_SESSION_RESTART_RETRIES replays',
      )
    } finally { client.close() }
  })

  // --- fetch side: the same retry now covers the verification download ---

  it('replays the fetch handshake after a session restart', async () => {
    // The recovery dialog verifies each object with a fetch; a session
    // restart rejects the in-flight fetch-token `recv` exactly like a put.
    // The fetch must replay against the new nonce rather than throwing
    // `objstore: session restarted` (which the recovery flow would have
    // mis-read as "bytes missing"). Use the not-found reply so the test
    // needs no REST GET / decryption — it only pins the handshake replay.
    const transport = makeFakeTransport('nonce-1')
    const { client, session } = await openSession(transport)
    try {
      const fetchP = session.fetchByTag('resource-tag-abc')
      await waitFor(() => transport.count('objstore-fetch') === 1, 'first fetch frame')
      transport.restart('nonce-2')
      await waitFor(() => transport.count('objstore-fetch') === 2, 'fetch replayed after restart')
      const retried = transport.last('objstore-fetch')
      transport.deliver({ type: 'objstore-fetch-not-found', workspaceTag: retried.workspaceTag, resourceTag: retried.resourceTag })
      const got = await fetchP
      assert.equal(got, null, 'fetch resolves (not-found) after replaying past the restart')
    } finally { client.close() }
  })

  it('a fetch that never hits a restart sends exactly one fetch frame', async () => {
    const transport = makeFakeTransport('nonce-1')
    const { client, session } = await openSession(transport)
    try {
      const fetchP = session.fetchByTag('resource-tag-xyz')
      await waitFor(() => transport.count('objstore-fetch') === 1, 'fetch frame')
      const f = transport.last('objstore-fetch')
      transport.deliver({ type: 'objstore-fetch-not-found', workspaceTag: f.workspaceTag, resourceTag: f.resourceTag })
      assert.equal(await fetchP, null)
      assert.equal(transport.count('objstore-fetch'), 1, 'no restart → no replay')
    } finally { client.close() }
  })
})

// SSE-mode routing: in SSE mode the client mints fetch/put tokens over the
// REST endpoint (session-independent) instead of the in-band WS frame, then
// drives the unchanged GET/PUT. Driven over the fake transport (isSse:true)
// with a mocked `globalThis.fetch` for the mint POST + the byte transfer.
describe('objstore SSE-mode REST mint routing', () => {
  // Minimal fetch Response stand-in.
  function jsonResponse(status, obj) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json() { return Promise.resolve(obj) },
      text() { return Promise.resolve(JSON.stringify(obj)) },
    }
  }

  it('fetchByTag mints over REST (POST op=fetch), not a WS frame', async () => {
    const transport = makeFakeTransport('nonce-1', { sse: true })
    const real = globalThis.fetch
    const posts = []
    globalThis.fetch = (url, opts) => {
      if (opts.method === 'POST') { posts.push({ url: String(url), body: JSON.parse(opts.body) }); return Promise.resolve(jsonResponse(404, { error: 'not-found' })) }
      throw new Error(`unexpected ${opts.method}`)
    }
    const { client, session } = await openSession(transport)
    try {
      const got = await session.fetchByTag('resource-tag-abc')
      assert.equal(got, null, 'a 404 fetch-mint resolves to null')
      assert.equal(posts.length, 1, 'exactly one mint POST')
      assert.equal(posts[0].body.op, 'fetch')
      assert.ok(posts[0].url.includes('/api/objstore/') && posts[0].url.endsWith('/resource-tag-abc'), posts[0].url)
      assert.equal(transport.count('objstore-fetch'), 0, 'no in-band WS fetch frame in SSE mode')
    } finally { globalThis.fetch = real; client.close() }
  })

  it('put mints over REST (POST op=put) and commits via the PUT, no WS frame', async () => {
    const transport = makeFakeTransport('nonce-1', { sse: true })
    const real = globalThis.fetch
    const posts = []
    globalThis.fetch = async (url, opts) => {
      if (opts.method === 'POST') {
        posts.push(JSON.parse(opts.body))
        return jsonResponse(200, { stagingId: 's1', urlPath: '/api/objstore/x/y', token: 'tok', expiresAt: Date.now() + 60_000 })
      }
      if (opts.method === 'PUT') {
        const contentHash = await computeContentHash(opts.body)
        return jsonResponse(200, { version: 1, incarnation: 'inc-1', contentHash, contentLength: opts.body.byteLength })
      }
      throw new Error(`unexpected ${opts.method}`)
    }
    const { client, session } = await openSession(transport)
    try {
      const r = await session.put({ fileName: 'f.json', content: Buffer.from('hello-sse'), prev: null })
      assert.equal(r.ok, true, `put should succeed: ${JSON.stringify(r)}`)
      assert.equal(posts.length, 1, 'exactly one mint POST')
      assert.equal(posts[0].op, 'put')
      assert.equal(transport.count('objstore-put-begin'), 0, 'no in-band WS put-begin in SSE mode')
    } finally { globalThis.fetch = real; client.close() }
  })

  it('put falls back to the WS put-begin when the REST mint returns 401 (new-workspace gate)', async () => {
    const transport = makeFakeTransport('nonce-1', { sse: true })
    const real = globalThis.fetch
    globalThis.fetch = async (url, opts) => {
      if (opts.method === 'POST') return jsonResponse(401, { error: 'unauthorized' })
      if (opts.method === 'PUT') {
        const contentHash = await computeContentHash(opts.body)
        return jsonResponse(200, { version: 1, incarnation: 'inc-1', contentHash, contentLength: opts.body.byteLength })
      }
      throw new Error(`unexpected ${opts.method}`)
    }
    const { client, session } = await openSession(transport)
    try {
      const putP = session.put({ fileName: 'f.json', content: Buffer.from('hello-fallback'), prev: null })
      // The 401 mint routes to the in-band WS put-begin; deliver its token so
      // the put completes through the (mocked) REST PUT.
      await waitFor(() => transport.count('objstore-put-begin') === 1, 'WS put-begin fallback after mint 401')
      const begin = transport.last('objstore-put-begin')
      transport.deliver({ type: 'objstore-put-token', workspaceTag: begin.workspaceTag, resourceTag: begin.resourceTag, urlPath: '/api/objstore/x/y', token: 'tok', expiresAt: Date.now() + 60_000, stagingId: 's1' })
      const r = await putP
      assert.equal(r.ok, true, 'put completes via the WS fallback')
    } finally { globalThis.fetch = real; client.close() }
  })

  it('put surfaces a REST 409 as a conflict result (rebase path), no WS frame', async () => {
    const transport = makeFakeTransport('nonce-1', { sse: true })
    const real = globalThis.fetch
    globalThis.fetch = (url, opts) => {
      if (opts.method === 'POST') return Promise.resolve(jsonResponse(409, { error: 'conflict', currentVersion: 7, currentIncarnation: 'inc-x' }))
      throw new Error(`unexpected ${opts.method}`)
    }
    const { client, session } = await openSession(transport)
    try {
      const r = await session.put({ fileName: 'f.json', content: Buffer.from('x'), prev: null })
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'conflict')
      assert.equal(r.current?.version, 7, 'currentVersion parsed from the REST 409 envelope')
      assert.equal(r.current?.incarnation, 'inc-x')
      assert.equal(transport.count('objstore-put-begin'), 0, 'conflict came from the REST mint, no WS frame')
    } finally { globalThis.fetch = real; client.close() }
  })

  it('fetch falls back to the WS fetch-token when the REST mint returns 401', async () => {
    const transport = makeFakeTransport('nonce-1', { sse: true })
    const real = globalThis.fetch
    globalThis.fetch = (url, opts) => {
      if (opts.method === 'POST') return Promise.resolve(jsonResponse(401, { error: 'unauthorized' }))
      throw new Error(`unexpected ${opts.method}`)
    }
    const { client, session } = await openSession(transport)
    try {
      const fetchP = session.fetchByTag('resource-tag-xyz')
      await waitFor(() => transport.count('objstore-fetch') === 1, 'WS fetch-token fallback after mint 401')
      const f = transport.last('objstore-fetch')
      transport.deliver({ type: 'objstore-fetch-not-found', workspaceTag: f.workspaceTag, resourceTag: f.resourceTag })
      assert.equal(await fetchP, null, 'fetch resolves via the WS fallback')
    } finally { globalThis.fetch = real; client.close() }
  })
})
