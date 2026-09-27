import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createReapHandler, withReap } from '../server-common/reap.ts'

function response() {
  return { status: null, headers: {}, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = JSON.parse(body) },
  }
}
function request(method = 'GET', authorization = 'Bearer secret', url = '/api/reap') {
  return { method, url, headers: { authorization } }
}

test('shared cleanup gates auth, method and shutdown before invoking modes', async () => {
  let calls = 0
  const reapers = { e2e: () => { calls++; return Promise.resolve() } }
  for (const [options, req, expected] of [
    [{ secret: '' }, request(), 401],
    [{ secret: 'secret' }, request('GET', 'wrong'), 401],
    [{ secret: 'secret' }, request('POST'), 405],
    [{ secret: 'secret', isShuttingDown: () => true }, request(), 503],
  ]) {
    const res = response()
    await createReapHandler(reapers, options)(req, res)
    assert.equal(res.status, expected)
    assert.equal(res.headers['cache-control'], 'no-store')
    if (expected === 405) assert.equal(res.headers.allow, 'GET')
  }
  assert.equal(calls, 0)
})

test('top-level cleanup calls every enabled mode and only matches the exact route', async () => {
  for (const modes of [['e2e'], ['managed'], ['e2e', 'managed']]) {
    const calls = []
    const handler = withReap(() => { calls.push('next') }, Object.fromEntries(modes.map(mode => [mode, () => { calls.push(mode); return Promise.resolve() }])), { secret: 'secret' })
    const res = response()
    await handler(request('GET', 'Bearer secret', '/api/reap?cron=1'), res)
    assert.deepEqual(calls, modes)
    assert.deepEqual(res.body.reaped, modes)
    assert.equal(res.status, 200)
    await handler(request('GET', 'Bearer secret', '/api/reap/other'), response())
    assert.equal(calls.at(-1), 'next')
  }
})

test('a failed mode does not skip or outlive the other cleanup', async t => {
  t.mock.method(console, 'error', () => {})
  const pending = Promise.withResolvers(), started = Promise.withResolvers()
  const res = response()
  const work = createReapHandler({
    e2e: () => { throw new Error('cleanup failed') },
    managed: () => { started.resolve(); return pending.promise },
  }, { secret: 'secret' })(request(), res)
  await started.promise
  assert.equal(res.status, null)
  pending.resolve()
  await work
  assert.equal(res.status, 500)
})


test('explicit e2e cleanup coalesces, reports errors, and drains with automatic sweeps disabled', async t => {
  t.mock.method(console, 'warn', () => {})
  let calls = 0, pending = Promise.withResolvers()
  mock.module('../server-e2e/objstore/reaper.ts', { namedExports: { reapOrphans: () => { calls++; return pending.promise } } })
  const { initObjstore } = await import('../server-e2e/objstore/init.ts')
  const app = initObjstore({
    handle: {}, reapIntervalMs: 60_000, reapDisabled: true,
    send: () => {}, broadcast: () => {}, publishObjPut: () => {}, publishObjDeleted: () => {}, getNonce: () => undefined,
  })
  await app.startupReap
  assert.equal(calls, 0)
  const first = app.reap()
  assert.equal(app.reap(), first)
  let drained = false
  const stopping = app.stopReaper().then(() => { drained = true; return undefined })
  await Promise.resolve()
  assert.equal(drained, false)
  pending.resolve()
  await Promise.all([first, stopping])
  assert.equal(calls, 1)
  pending = Promise.withResolvers()
  const second = app.reap()
  const rejected = assert.rejects(second, /cleanup failure/u)
  pending.reject(new Error('cleanup failure'))
  await rejected
  await app.stopReaper()
  assert.equal(calls, 2)
})
