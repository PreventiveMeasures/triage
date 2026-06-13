// In-process tests for the npm advisories proxy. Drives
// `dispatchNpmAdvisories` against a real `http.Server` so the
// gate / method / body-size / JSON-assertion paths exercise the
// production request-handling pipeline; `globalThis.fetch` is
// replaced with a controllable mock so we don't depend on the
// live npm registry (and so the JSON-assertion branches can be
// tested without producing pathological upstream responses).
//
// The dispatcher's same-origin gate IS reachable in this setup:
// the test passes both `isOriginAllowed` and `isShuttingDown`
// closures explicitly, so each test can switch the answer.

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { createServer } from 'node:http'
import { dispatchNpmAdvisories, matchNpmAdvisoriesRoute } from '../e2e-server/npm-proxy.ts'

const UPSTREAM_PREFIX = 'https://registry.npmjs.org/'

describe('matchNpmAdvisoriesRoute', () => {
  it('matches the canonical path', () => {
    assert.equal(matchNpmAdvisoriesRoute('/api/npm-advisories'), true)
  })
  it('matches with a trailing query string', () => {
    assert.equal(matchNpmAdvisoriesRoute('/api/npm-advisories?cache=0'), true)
  })
  it('rejects a trailing slash', () => {
    assert.equal(matchNpmAdvisoriesRoute('/api/npm-advisories/'), false)
  })
  it('rejects unrelated paths', () => {
    assert.equal(matchNpmAdvisoriesRoute('/api/objstore/foo/bar'), false)
    assert.equal(matchNpmAdvisoriesRoute('/api/sync'), false)
    assert.equal(matchNpmAdvisoriesRoute(undefined), false)
  })
})

describe('npm-proxy: dispatcher gates + handler', () => {
  let server
  let baseUrl
  let originAllowed = true
  let shuttingDown = false
  let upstreamResponder = null  // (init) => Response | Promise<Response>
  let originalFetch

  before(async () => {
    originalFetch = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const u = typeof input === 'string' ? input : input.url
      if (u.startsWith(UPSTREAM_PREFIX)) {
        if (upstreamResponder == null) throw new Error('test forgot to set upstreamResponder')
        return Promise.resolve(upstreamResponder(init))
      }
      return originalFetch(input, init)
    }
    server = createServer((req, res) => {
      const p = dispatchNpmAdvisories(req, res, {
        isOriginAllowed: () => originAllowed,
        isShuttingDown: () => shuttingDown,
        debug: false,
      })
      if (!p) { res.writeHead(404); res.end() }
    })
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const { port } = server.address()
    baseUrl = `http://127.0.0.1:${port}/api/npm-advisories`
  })

  after(async () => {
    globalThis.fetch = originalFetch
    await new Promise((resolve) => { server.close(resolve) })
  })

  beforeEach(() => {
    originAllowed = true
    shuttingDown = false
    upstreamResponder = null
  })

  // Reusable POST helper that defaults to a minimal valid body.
  function post(body = JSON.stringify({ semver: ['7.3.7'] }), opts = {}) {
    return originalFetch(baseUrl, {
      method: opts.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: opts.method === 'GET' ? undefined : body,
    })
  }

  it('rejects GET with 405', async () => {
    const r = await post(undefined, { method: 'GET' })
    assert.equal(r.status, 405)
    const j = await r.json()
    assert.equal(j.error, 'method-not-allowed')
  })

  it('rejects shutdown state with 503', async () => {
    shuttingDown = true
    const r = await post()
    assert.equal(r.status, 503)
    const j = await r.json()
    assert.equal(j.error, 'shutting-down')
  })

  it('rejects denied origin with 403', async () => {
    originAllowed = false
    const r = await post()
    assert.equal(r.status, 403)
    const j = await r.json()
    assert.equal(j.error, 'origin-denied')
  })

  it('caps request body at 1 MiB and returns 413', async () => {
    // 1 MiB + 1 = oversize. Stringified twice (JSON.stringify of the
    // string adds quotes + escapes), so over the cap regardless.
    const big = 'a'.repeat(1024 * 1024 + 1)
    const r = await post(JSON.stringify({ big }))
    assert.equal(r.status, 413)
    const j = await r.json()
    assert.equal(j.error, 'payload-too-large')
  })

  it('forwards a JSON upstream response with its status', async () => {
    upstreamResponder = () => new Response(
      '{"semver":[{"id":1,"severity":"high","title":"x"}]}',
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const r = await post()
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'application/json')
    const j = await r.json()
    assert.deepEqual(j, { semver: [{ id: 1, severity: 'high', title: 'x' }] })
  })

  it('treats a JSON-shaped body with NO content-type as JSON (Cloudflare-stripped header)', async () => {
    upstreamResponder = () => new Response('{"ok":true}', { status: 200 })
    const r = await post()
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'application/json')
    assert.deepEqual(await r.json(), { ok: true })
  })

  it('preserves the upstream status on a non-2xx JSON response', async () => {
    upstreamResponder = () => new Response(
      '{"error":"too-many-requests"}',
      { status: 429, headers: { 'content-type': 'application/json' } },
    )
    const r = await post()
    assert.equal(r.status, 429)
    assert.deepEqual(await r.json(), { error: 'too-many-requests' })
  })

  it('collapses an HTML upstream body to a 502 JSON envelope', async () => {
    upstreamResponder = () => new Response(
      '<!DOCTYPE html><html>503 Service Unavailable</html>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
    )
    const r = await post()
    assert.equal(r.status, 502)
    assert.equal(r.headers.get('content-type'), 'application/json')
    const j = await r.json()
    assert.equal(j.error, 'upstream-not-json')
    assert.equal(j.upstreamStatus, 503)
    assert.equal(j.upstreamContentType, 'text/html; charset=utf-8')
  })

  it('collapses a truncated-JSON upstream body to a 502 JSON envelope', async () => {
    upstreamResponder = () => new Response(
      '{"truncated":',
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const r = await post()
    assert.equal(r.status, 502)
    const j = await r.json()
    assert.equal(j.error, 'upstream-not-json')
    assert.equal(j.upstreamStatus, 200)
  })

  it('collapses an oversize upstream body to a 502 JSON envelope', async () => {
    // 4 MiB cap + a hair; loop emits chunks so the cap-check trips
    // before the whole body buffers.
    const big = 'b'.repeat(4 * 1024 * 1024 + 1)
    upstreamResponder = () => new Response(
      big,
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const r = await post()
    assert.equal(r.status, 502)
    const j = await r.json()
    assert.equal(j.error, 'upstream-too-large')
    assert.equal(j.upstreamStatus, 200)
  })

  it('returns 502 upstream-unreachable on fetch throw', async () => {
    upstreamResponder = () => { throw new Error('connect ECONNREFUSED') }
    const r = await post()
    assert.equal(r.status, 502)
    const j = await r.json()
    assert.equal(j.error, 'upstream-unreachable')
  })

  it('drops client-supplied headers on the upstream call', async () => {
    let observed = null
    upstreamResponder = (init) => {
      observed = init
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    await post(JSON.stringify({ semver: ['1.0.0'] }), {
      headers: {
        // These all should be stripped — only content-type + accept
        // ride along on the upstream call.
        'authorization': 'Bearer secret',
        'cookie': 'sid=hijacked',
        'user-agent': 'evil-bot',
        'x-forwarded-for': '1.2.3.4',
      },
    })
    assert.ok(observed, 'upstream observed init')
    const headers = new Headers(observed.headers)
    assert.equal(headers.get('content-type'), 'application/json')
    assert.equal(headers.get('accept'), 'application/json')
    assert.equal(headers.get('authorization'), null, 'authorization stripped')
    assert.equal(headers.get('cookie'), null, 'cookie stripped')
    assert.equal(headers.get('user-agent'), null, 'user-agent stripped')
    assert.equal(headers.get('x-forwarded-for'), null, 'x-forwarded-for stripped')
  })

  it('silently bails when the client disconnects mid-upload (no unhandled error)', async () => {
    // Stream a body slowly, then abort. The server's
    // `for await (chunk of req)` should throw on the disconnect;
    // we just want to confirm the server doesn't crash and serves
    // the next request fine.
    const ctrl = new AbortController()
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"semv'))
        // Give the server a tick to start consuming, then abort
        // mid-body.
        setTimeout(() => ctrl.abort(), 30)
      },
    })
    try {
      await originalFetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
        signal: ctrl.signal,
        duplex: 'half',
      })
    } catch (err) {
      assert.equal(err?.name, 'AbortError', 'client sees AbortError')
    }
    // Sanity probe — server still alive after the mid-upload abort.
    upstreamResponder = () => new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } })
    const r = await post()
    assert.equal(r.status, 200)
  })

  it('aborts the upstream fetch when the client closes mid-request', async () => {
    let signalSeen = null
    // Resolve `abortPropagated` from inside the upstream signal's
    // abort listener — this is the cleanest way to drive a wait
    // without an eslint-tripping polling loop, and the resolve()
    // semantics also give us a clean reject-on-timeout race.
    let resolveAbort
    const abortPropagated = new Promise((resolve) => { resolveAbort = resolve })
    upstreamResponder = (init) => new Promise((_resolve, reject) => {
      signalSeen = init.signal
      init.signal.addEventListener('abort', () => {
        resolveAbort()
        reject(new DOMException('aborted', 'AbortError'))
      })
    })
    const ctrl = new AbortController()
    const inflight = originalFetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: ctrl.signal,
    })
    // Give the request a tick to reach the handler + start the
    // upstream fetch.
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    ctrl.abort()
    await assert.rejects(inflight, { name: 'AbortError' })
    assert.ok(signalSeen, 'upstream fetch received an AbortSignal')
    // 2 s ceiling — the propagation lands well under 100 ms in
    // practice but we don't want a flaky test under load. Throws
    // a clear AssertionError if the propagation never fires.
    await Promise.race([
      abortPropagated,
      new Promise((_resolve, reject) => { setTimeout(() => reject(new Error('AbortSignal did NOT fire on client disconnect within 2s')), 2_000) }),
    ])
  })

  it('stays responsive across a slow upstream and a fresh probe', async () => {
    // Slow but eventually successful upstream — ~150 ms — proves the
    // server can ride out a non-instant upstream call AND that a
    // probe immediately afterward still works (not deadlocked /
    // not stuck on the prior in-flight slot). Also: serves as the
    // sanity check after the abort-propagation test above, which
    // intentionally tears down a hung in-flight request — if that
    // teardown leaked, this follow-up probe would hang too.
    upstreamResponder = () => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(
        '{"slow":1}',
        { status: 200, headers: { 'content-type': 'application/json' } },
      )), 150)
    })
    const t0 = Date.now()
    const r1 = await post()
    const elapsed = Date.now() - t0
    assert.equal(r1.status, 200)
    assert.deepEqual(await r1.json(), { slow: 1 })
    assert.ok(elapsed >= 140, `slow upstream should have delayed the response (got ${elapsed}ms)`)
    // Fresh probe right after — confirms the slow call didn't pin
    // any resource that would block a subsequent request.
    upstreamResponder = () => new Response('{"fresh":1}', { status: 200, headers: { 'content-type': 'application/json' } })
    const r2 = await post()
    assert.equal(r2.status, 200)
    assert.deepEqual(await r2.json(), { fresh: 1 })
  })
})
