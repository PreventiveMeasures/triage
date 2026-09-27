import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { FixCache } from '../client/managed/pull-request-cache.js'
import { fetchFixes } from '../client/managed/session.js'
import { setPreviewRole } from '../client/managed/request.js'

const link = n => `https://github.com/Org/Repo/pull/${n}`
const result = n => ({ url: link(n), title: `PR ${n}`, status: 'merged' })
const settle = async () => { for (let i = 0; i < 4; i++) await setImmediate() }

function fixture(t, fetchWorkspace = () => Array.from({ length: 64 }, (_, i) => result(i + 1))) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let changes = 0, context = { key: 'alice', teamId: 'team', teams: [] }, time = 0
  const calls = []
  const cache = new FixCache({
    context: () => context, now: () => time, changed: () => { changes++ },
    fetchWorkspace: (...args) => { calls.push(args); return fetchWorkspace(...args) },
  })
  t.after(() => cache.reset())
  return { cache, calls, get changes() { return changes }, context: value => { context = value }, time: value => { time = value },
    async flush() { t.mock.timers.tick(1); await settle() } }
}

test('visible links coalesce into one workspace read; all returned metadata is available without more requests', async t => {
  const f = fixture(t)
  for (let n = 1; n <= 53; n++) assert.equal(f.cache.read(link(n)), null)
  assert.equal(f.cache.read('https://github.com/oRG/rEPO/pull/01/files#diff-a'), null)
  f.cache.read('https://elsewhere.test/o/r/pull/1')
  f.cache.read('fix pending')
  assert.equal(f.calls.length, 0)
  await f.flush()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0][0], 'team')
  assert.ok(f.calls[0][1] instanceof AbortSignal)
  assert.equal(f.cache.read(link(1)).status, 'merged')
  assert.equal(f.cache.read('https://github.com/oRG/rEPO/pull/01/files#diff-a').status, 'merged')
  assert.equal(f.cache.read(link(64)).title, 'PR 64', 'a card first rendered later is already cached')
  assert.equal(f.cache.read(link(999)), null, 'a URL absent from the server response cannot trigger its own lookup')
  assert.equal(f.changes, 1)
  await f.flush()
  assert.equal(f.calls.length, 1)
})

test('workspace metadata expires, and malformed or unavailable entries do not label a link', async t => {
  const f = fixture(t, () => [result(1), { url: link(2), error: 'unavailable' },
    { url: link(3), title: 'Unknown state', status: 'invalid' }, { url: link(4), status: 'open' },
    { url: 'https://elsewhere.test/o/r/pull/1', title: 'Invalid URL', status: 'open' }, null])
  f.cache.read(link(1))
  await f.flush()
  assert.equal(f.cache.read(link(1)).status, 'merged')
  for (const n of [2, 3, 4]) assert.equal(f.cache.read(link(n)), null)
  await f.flush()
  assert.equal(f.calls.length, 1, 'missing results do not retry on every render')
  f.time(60_001)
  assert.equal(f.cache.read(link(1)), null)
  await f.flush()
  assert.equal(f.calls.length, 2)
})

for (const failure of ['empty', 'null', 'throw']) {
  test(`${failure} workspace responses have a TTL instead of retrying on every card render`, async t => {
    const f = fixture(t, () => { if (failure === 'throw') throw new Error('offline'); return failure === 'empty' ? [] : null })
    f.cache.read(link(1))
    await f.flush()
    f.cache.read(link(2))
    await f.flush()
    assert.equal(f.calls.length, 1)
    f.time(60_001)
    f.cache.read(link(1))
    await f.flush()
    assert.equal(f.calls.length, 2)
  })
}

test('account, workspace, catalogue and mode changes discard metadata and abort late responses', async t => {
  const delayed = Promise.withResolvers()
  let first = true
  const f = fixture(t, () => {
    if (first) { first = false; return delayed.promise }
    return [result(1)]
  })
  f.cache.read(link(1))
  await f.flush()
  const oldSignal = f.calls[0][1]
  f.context(null)
  assert.equal(f.cache.read(link(1)), null)
  assert.ok(oldSignal.aborted)
  delayed.resolve([{ url: link(1), title: 'Private old account', status: 'merged' }])
  await settle()
  assert.equal(f.changes, 0)
  await f.flush()
  assert.equal(f.calls.length, 1, 'E2E and signed-out contexts make no requests')
  const teams = []
  f.context({ key: 'bob', teamId: 'team', teams })
  f.cache.read(link(1))
  await f.flush()
  assert.equal(f.cache.read(link(1)).title, 'PR 1')
  f.context({ key: 'bob', teamId: 'second', teams })
  assert.equal(f.cache.read(link(1)), null, 'same account and catalogue cannot reuse another workspace response')
  await f.flush()
  assert.equal(f.calls.at(-1)[0], 'second')
  f.context({ key: 'bob', teamId: 'second', teams: [] })
  assert.equal(f.cache.read(link(1)), null, 'a refreshed team catalogue revalidates access')
  await f.flush()
  assert.equal(f.calls.length, 4)
  f.cache.reset()
  assert.equal(f.cache.read(link(1)), null)
})

test('resetting after a saved Fix discards an in-flight response and reads the new workspace result', async t => {
  const delayed = Promise.withResolvers()
  let first = true
  const f = fixture(t, () => { if (first) { first = false; return delayed.promise }; return [result(2)] })
  f.cache.read(link(1))
  await f.flush()
  f.cache.reset()
  f.cache.read(link(2))
  await f.flush()
  delayed.resolve([result(1)])
  await settle()
  assert.equal(f.cache.read(link(1)), null)
  assert.equal(f.cache.read(link(2)).title, 'PR 2')
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls[0][1].aborted)
})

test('client sends an authenticated uncached GET with only the workspace ID, and preview never reaches the real server', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push([url, options])
    return Response.json({ fixes: [result(1)] })
  })
  const controller = new AbortController()
  assert.equal((await fetchFixes('team/name', controller.signal))[0].status, 'merged')
  const [url, options] = calls[0]
  assert.equal(url, '/api/teams/team%2Fname/fixes')
  assert.equal(options.method ?? 'GET', 'GET')
  assert.equal(options.credentials, 'same-origin')
  assert.equal(options.cache, 'no-store')
  assert.equal(new Headers(options.headers).has('x-csrf-token'), false)
  assert.equal(options.body, undefined)
  assert.equal(options.signal, controller.signal)
  setPreviewRole('admin')
  t.after(() => setPreviewRole(null))
  assert.equal(await fetchFixes('team'), null)
  assert.equal(calls.length, 1)
})

test('workspace results include ordinary issue metadata and descriptions under separate keys', async t => {
  const url = 'https://github.com/Org/Repo/issues/1'
  const f = fixture(t, () => [{ ...result(1), description: 'PR description' }, { url, title: 'Issue title', description: 'Issue description', status: 'closed' }])
  f.cache.read(url)
  await f.flush()
  assert.deepEqual(f.cache.read(url), { title: 'Issue title', description: 'Issue description', status: 'closed' })
  assert.equal(f.cache.read(link(1)).description, 'PR description')
  assert.equal(f.calls.length, 1)
})
