import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { FixCache } from '../client/managed/pull-request-cache.js'
import { fetchFixes } from '../client/managed/session.js'
import { setPreviewRole } from '../client/managed/request.js'

const link = n => `https://github.com/Org/Repo/pull/${n}`
const result = n => ({ url: link(n), title: `PR ${n}`, status: 'merged' })
const settle = async () => { for (let i = 0; i < 4; i++) await setImmediate() }
const team = (id = 'team') => ({ id, name: id, cacheKey: 'access-v1', reports: [
  { id: 'report', cacheKey: 'report-v1' }, { id: 'links', cacheKey: 'links-v1' },
] })

function fixture(t, fetchWorkspace = () => Array.from({ length: 64 }, (_, i) => result(i + 1))) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let changes = 0, context = { key: 'alice', teamId: 'team', teams: [team()] }, time = 0
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

test('navigation and feed catalog refreshes keep one in-flight request and resolved links for unchanged access', async t => {
  const delayed = Promise.withResolvers()
  const f = fixture(t, () => delayed.promise)
  f.cache.read(link(1))
  await f.flush()
  const signal = f.calls[0][1]
  const refreshed = () => ({ key: 'alice', teamId: 'team', teams: [
    { ...team('other'), cacheKey: 'other-team-changed' },
    { ...team(), name: 'Renamed team', reports: team().reports.toReversed() },
  ] })
  f.context(refreshed())
  assert.equal(f.cache.read(link(1)), null)
  await f.flush()
  assert.equal(f.calls.length, 1, 'unchanged access must not duplicate the initial /fixes request')
  assert.equal(signal.aborted, false)
  delayed.resolve([result(1)])
  await settle()
  assert.equal(f.cache.read(link(1)).status, 'merged')
  for (let i = 0; i < 3; i++) {
    f.context(refreshed())
    assert.equal(f.cache.read(link(1)).status, 'merged', 'resolved links must not flash back to unavailable')
    await f.flush()
  }
  assert.equal(f.calls.length, 1)
  assert.equal(f.changes, 1)
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
  assert.equal(f.cache.read(link(1)).status, 'merged', 'refreshing metadata keeps the known status visible')
  await f.flush()
  assert.equal(f.calls.length, 2)
})

test('expired metadata stays visible until one refresh replaces it, including removed links', async t => {
  const delayed = Promise.withResolvers()
  let first = true
  const f = fixture(t, () => { if (first) { first = false; return [result(1), result(2)] }; return delayed.promise })
  f.cache.read(link(1))
  await f.flush()
  f.time(60_001)
  for (let i = 0; i < 3; i++) {
    assert.equal(f.cache.read(link(1)).status, 'merged')
    await f.flush()
  }
  assert.equal(f.calls.length, 2)
  delayed.resolve([{ ...result(1), status: 'open' }])
  await settle()
  assert.equal(f.cache.read(link(1)).status, 'open')
  assert.equal(f.cache.read(link(2)), null, 'a completed response replaces the old authorized URL set')
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
  const teams = [team(), team('second')]
  f.context({ key: 'bob', teamId: 'team', teams })
  f.cache.read(link(1))
  await f.flush()
  assert.equal(f.cache.read(link(1)).title, 'PR 1')
  f.context({ key: 'bob', teamId: 'second', teams })
  assert.equal(f.cache.read(link(1)), null, 'same account and catalogue cannot reuse another workspace response')
  await f.flush()
  assert.equal(f.calls.at(-1)[0], 'second')
  f.context({ key: 'bob', teamId: 'second', teams: [team(), { ...team('second'), cacheKey: 'access-v2' }] })
  assert.equal(f.cache.read(link(1)), null, 'changed team permissions revalidate access')
  await f.flush()
  assert.equal(f.calls.length, 4)
  f.cache.reset()
  assert.equal(f.cache.read(link(1)), null)
})

for (const [name, change] of [
  ['grants', current => ({ ...current, cacheKey: 'access-v2' })],
  ['report versions', current => ({ ...current, reports: current.reports.map(report => ({ ...report, cacheKey: 'changed' })) })],
  ['removed links', current => ({ ...current, reports: current.reports.filter(report => report.id !== 'links') })],
  ['added links', current => ({ ...current, reports: [...current.reports, { id: 'new-links', cacheKey: 'new' }] })],
]) {
  test(`changed ${name} clear cached metadata and reject late replies`, async t => {
    const delayed = Promise.withResolvers()
    let first = true
    const f = fixture(t, () => { if (first) { first = false; return [result(1)] }; return delayed.promise })
    f.cache.read(link(1))
    await f.flush()
    f.time(60_001)
    f.cache.read(link(1))
    await f.flush()
    const signal = f.calls.at(-1)[1]
    f.context({ key: 'alice', teamId: 'team', teams: [change(team())] })
    assert.equal(f.cache.read(link(1)), null)
    assert.equal(signal.aborted, true)
    delayed.resolve([result(1)])
    await settle()
    assert.equal(f.cache.read(link(1)), null)
  })
}

test('losing team membership clears metadata without querying the removed team', async t => {
  const f = fixture(t)
  f.cache.read(link(1))
  await f.flush()
  f.context({ key: 'alice', teamId: 'team', teams: [team('other')] })
  assert.equal(f.cache.read(link(1)), null)
  await f.flush()
  assert.equal(f.calls.length, 1)
})

test('a catalog without access versions revalidates on refresh', async t => {
  const f = fixture(t)
  const context = () => ({ key: 'alice', teamId: 'team', teams: [{ ...team(), cacheKey: undefined }] })
  f.context(context())
  f.cache.read(link(1))
  await f.flush()
  f.context(context())
  assert.equal(f.cache.read(link(1)), null)
  await f.flush()
  assert.equal(f.calls.length, 2)
})

test('a failed refresh clears previously loaded metadata because access could have been revoked', async t => {
  let first = true
  const f = fixture(t, () => { if (first) { first = false; return [result(1)] }; return null })
  f.cache.read(link(1))
  await f.flush()
  f.time(60_001)
  f.cache.read(link(1))
  await f.flush()
  assert.equal(f.cache.read(link(1)), null)
  await f.flush()
  assert.equal(f.calls.length, 2)
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
  assert.deepEqual(f.cache.read(url), { title: 'Issue title', description: 'Issue description', status: 'closed', stateReason: 'unknown' })
  assert.equal(f.cache.read(link(1)).description, 'PR description')
  assert.equal(f.calls.length, 1)
})

test('workspace cache preserves closed issue reasons and ignores them for open issues and PRs', async t => {
  const reasons = ['completed', 'not_planned', 'duplicate', null, 'unexpected']
  const rows = reasons.map((stateReason, i) => ({ url: `https://github.com/Org/Repo/issues/${i + 1}`, title: 'Issue', status: 'closed', stateReason }))
  const open = { ...rows[0], url: 'https://github.com/Org/Repo/issues/99', status: 'open' }
  const f = fixture(t, () => [...rows, open, { ...result(1), stateReason: 'completed' }])
  f.cache.read(rows[0].url)
  await f.flush()
  assert.deepEqual(rows.map(row => f.cache.read(row.url).stateReason), ['completed', 'not_planned', 'duplicate', 'unknown', 'unknown'])
  assert.equal(f.cache.read(open.url).stateReason, null)
  assert.equal(f.cache.read(link(1)).stateReason, null)
})
