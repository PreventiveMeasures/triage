import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { PullRequestCache } from '../client/managed/pull-request-cache.js'
import { fetchPullRequests } from '../client/managed/session.js'
import { setPreviewRole } from '../client/managed/request.js'

const link = n => `https://github.com/Org/Repo/pull/${n}`
const settle = async () => { for (let i = 0; i < 4; i++) await setImmediate() }

function fixture(t, fetchBatch) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let changes = 0, context = { key: 'alice', csrfToken: 'csrf', teams: [] }, time = 0
  const calls = []
  const cache = new PullRequestCache({
    context: () => context, now: () => time, changed: () => { changes++ },
    fetchBatch: (...args) => {
      calls.push(args)
      return fetchBatch ? fetchBatch(...args) : args[0].map(url => ({ url, title: `PR ${url}`, status: 'merged' }))
    },
  })
  t.after(() => cache.reset())
  return { cache, calls, get changes() { return changes }, context: value => { context = value }, time: value => { time = value },
    async flush() { t.mock.timers.tick(1); await settle() } }
}

test('visible links coalesce into bounded batches and case/anchor duplicates share a result', async t => {
  const f = fixture(t)
  for (let n = 1; n <= 53; n++) assert.equal(f.cache.read(link(n)), null)
  assert.equal(f.cache.read('https://github.com/oRG/rEPO/pull/01/files#diff-a'), null)
  f.cache.read('https://elsewhere.test/o/r/pull/1')
  f.cache.read('fix pending')
  assert.equal(f.calls.length, 0, 'rendering queues the batch instead of firing one request per card')
  await f.flush()
  assert.deepEqual(f.calls.map(([urls]) => urls.length), [50, 3])
  assert.equal(f.calls[0][1], 'csrf')
  assert.equal(f.cache.read(link(1)).status, 'merged')
  assert.equal(f.cache.read('https://github.com/oRG/rEPO/pull/01/files#diff-a').status, 'merged')
  assert.equal(f.changes, 2)
  f.cache.read(link(1))
  await f.flush()
  assert.equal(f.calls.length, 2)
})

test('metadata and failed lookups expire, and mismatched/malformed results cannot label another link', async t => {
  const f = fixture(t, urls => [{ url: urls[0], error: 'unavailable' }, { url: link(999), title: 'Wrong PR', status: 'open' },
    { url: urls[1], title: 'Unknown state', status: 'invalid' }])
  f.cache.read(link(1)); f.cache.read(link(2))
  await f.flush()
  assert.equal(f.cache.read(link(1)), null)
  assert.equal(f.cache.read(link(2)), null)
  await f.flush()
  assert.equal(f.calls.length, 1, 'negative results do not retry on every render')
  f.time(60_001)
  f.cache.read(link(1))
  await f.flush()
  assert.equal(f.calls.length, 2)
})

test('account, team, and mode changes discard cached values and late in-flight responses', async t => {
  const delayed = Promise.withResolvers()
  let first = true
  const f = fixture(t, urls => {
    if (first) { first = false; return delayed.promise }
    return urls.map(url => ({ url, title: 'Current account', status: 'open' }))
  })
  f.cache.read(link(1))
  await f.flush()
  const oldSignal = f.calls[0][2]
  f.context(null)
  assert.equal(f.cache.read(link(1)), null)
  assert.ok(oldSignal.aborted)
  delayed.resolve([{ url: link(1), title: 'Private old account', status: 'merged' }])
  await settle()
  assert.equal(f.changes, 0)
  await f.flush()
  assert.equal(f.calls.length, 1, 'E2E and signed-out contexts make no requests')
  f.context({ key: 'bob', csrfToken: 'new-csrf', teams: [] })
  f.cache.read(link(1))
  await f.flush()
  assert.equal(f.cache.read(link(1)).title, 'Current account')
  assert.equal(f.calls[1][1], 'new-csrf')
  f.context({ key: 'bob', csrfToken: 'new-csrf', teams: [] })
  assert.equal(f.cache.read(link(1)), null, 'a refreshed team catalogue revalidates access')
  await f.flush()
  assert.equal(f.calls.length, 3)
  f.cache.reset()
  assert.equal(f.cache.read(link(1)), null)
})

test('client sends one authenticated uncached batch and preview mode never sends it to the real server', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push([url, options])
    return Response.json({ pullRequests: [{ url: link(1), title: 'Fix', status: 'closed' }] })
  })
  const controller = new AbortController()
  const result = await fetchPullRequests([link(1), link(2)], 'csrf', controller.signal)
  assert.equal(result[0].status, 'closed')
  const [url, options] = calls[0]
  assert.equal(url, '/api/github/pull-requests')
  assert.equal(options.method, 'POST')
  assert.equal(options.credentials, 'same-origin')
  assert.equal(options.cache, 'no-store')
  assert.equal(options.headers['x-csrf-token'], 'csrf')
  assert.deepEqual(JSON.parse(options.body), { urls: [link(1), link(2)] })
  assert.equal(options.signal, controller.signal)
  setPreviewRole('admin')
  t.after(() => setPreviewRole(null))
  assert.equal(await fetchPullRequests([link(1)], null), null)
  assert.equal(calls.length, 1)
})
