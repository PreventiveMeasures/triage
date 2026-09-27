import assert from 'node:assert/strict'
import { test } from 'node:test'
import { probeTeams } from '../client/managed/session.js'
import { createManagedTeamsProbe } from '../ui/view/managed-teams-probe.js'

const session = { id: 'user', role: 'view' }
const teams = [{ id: 'team', name: 'Team', slug: 'team', reports: [], bundles: [] }]
function fixture(t) {
  const calls = []
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
    const response = Promise.withResolvers()
    calls.push({ signal, ...response })
    // Deliberately settle independently of cancellation to exercise the window
    // before a stopped fetch has unwound, and reject late successful responses.
    return response.promise
  })
  const probe = createManagedTeamsProbe(probeTeams)
  const read = (signal, context = {}) => probe({ generation: 1, session, signal, ...context })
  return { calls, read }
}

test('navigation replaces a stalled feed catalog read before the old request settles', async t => {
  const { calls, read } = fixture(t)
  const destination = new AbortController(), feed = new AbortController()
  const stopped = read(feed.signal)
  feed.abort()
  assert.equal(calls[0].signal.aborted, true)
  const navigating = read(destination.signal)
  assert.equal(calls.length, 2, 'the destination starts a fresh request immediately')
  calls[0].resolve(Response.json({ teams: [{ ...teams[0], name: 'Stale' }] }))
  assert.equal(await stopped, null, 'a late success cannot restore the old catalog')
  const joining = read(destination.signal)
  assert.equal(calls.length, 2, 'the old cleanup cannot discard the destination request')
  calls[1].resolve(Response.json({ teams }))
  assert.deepEqual(await navigating, teams)
  assert.deepEqual(await joining, teams)
})

test('fetch cancellation finishes a stopped probe and permits the next feed refresh', async t => {
  const { calls, read } = fixture(t)
  const feed = new AbortController()
  const stopped = read(feed.signal)
  calls[0].signal.addEventListener('abort', () => calls[0].reject(calls[0].signal.reason), { once: true })
  feed.abort()
  assert.equal(await stopped, null)
  assert.equal(await read(feed.signal), null, 'an already stopped feed cannot start another request')
  assert.equal(calls.length, 1)
  const next = read(new AbortController().signal)
  calls[1].resolve(Response.json({ teams }))
  assert.deepEqual(await next, teams)
})

test('a joining feed watchdog cancels a stalled view-owned read and permits a fresh request', async t => {
  const { calls, read } = fixture(t)
  const caller = new AbortController(), owner = new AbortController()
  const first = read(owner.signal), second = read(caller.signal)
  assert.equal(calls.length, 1)
  calls[0].signal.addEventListener('abort', () => calls[0].reject(calls[0].signal.reason), { once: true })
  caller.abort()
  assert.equal(calls[0].signal.aborted, true, 'the watchdog reaches a shared request started by another caller')
  assert.equal(owner.signal.aborted, false, 'the view remains active')
  assert.equal(await first, null)
  assert.equal(await second, null)
  const next = read(owner.signal)
  assert.equal(calls.length, 2)
  calls[1].resolve(Response.json({ teams }))
  assert.deepEqual(await next, teams)
})

for (const context of [{ generation: 2 }, { session: { id: 'other', role: 'view' } }, { session: { id: 'user', role: 'none' } }]) {
  test(`replacing catalog context ${JSON.stringify(context)} cancels the old request`, async t => {
    const { calls, read } = fixture(t)
    const signal = new AbortController().signal
    const old = read(signal)
    const current = read(signal, context)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].signal.aborted, true)
    calls[1].resolve(Response.json({ teams: [] }))
    assert.deepEqual(await current, [])
    calls[0].resolve(Response.json({ teams }))
    assert.equal(await old, null)
  })
}

test('startup, navigation and unchanged feed confirmations share one completed catalog in memory', async t => {
  const { calls, read } = fixture(t)
  const startup = new AbortController()
  const first = read(startup.signal)
  calls[0].resolve(Response.json({ teams, revision: 'v1' }))
  const catalog = await first
  startup.abort() // Restoring the initial URL starts a new view.
  const signal = new AbortController().signal
  assert.equal(await read(signal, { reuse: true }), catalog)
  assert.equal(await read(signal, { revision: 'v1' }), catalog)
  assert.equal(await read(new AbortController().signal, { reuse: true }), catalog)
  assert.equal(await read(new AbortController().signal, { revision: 'v1' }), catalog)
  assert.equal(calls.length, 1)
  const cancelled = new AbortController(); cancelled.abort()
  assert.equal(await read(cancelled.signal, { reuse: true }), null)
})

test('navigation eventually refreshes unknown summaries without losing normal catalog reuse', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 })
  const { calls, read } = fixture(t), signal = new AbortController().signal
  const pendingTeams = [{ ...teams[0], bundles: [{ id: 'bundle', filename: 'app.map', kind: 'sourcemap', summary: null }] }]
  const first = read(signal)
  calls[0].resolve(Response.json({ teams: pendingTeams, revision: 'v1' }))
  const old = await first
  assert.equal(await read(signal, { reuse: true }), old)
  t.mock.timers.tick(5_000)
  const next = read(signal, { reuse: true })
  assert.equal(calls.length, 2)
  calls[1].resolve(Response.json({ teams: [{ ...pendingTeams[0], bundles: [{ ...pendingTeams[0].bundles[0], summary: { files: 1, codeFiles: 1, lines: 3 } }] }], revision: 'v1' }))
  const complete = await next
  assert.equal(complete[0].bundles[0].summary.lines, 3)
  t.mock.timers.tick(60_000)
  assert.equal(await read(signal, { revision: 'v1' }), complete)
  assert.equal(calls.length, 2)
})

test('changed feed revisions refresh once and navigation joins the fresh catalog read', async t => {
  const { calls, read } = fixture(t)
  const signal = new AbortController().signal
  const first = read(signal)
  calls[0].resolve(Response.json({ teams, revision: 'v1' }))
  await first
  const changed = read(signal, { revision: 'v2' })
  const joining = read(signal, { reuse: true })
  const duplicate = read(signal, { revision: 'v2' })
  assert.equal(calls.length, 2)
  calls[1].resolve(Response.json({ teams: [], revision: 'v2' }))
  assert.deepEqual(await changed, [])
  assert.equal(await joining, await duplicate)
  assert.deepEqual(await read(signal, { revision: 'v2' }), [])
  assert.equal(calls.length, 2)
})

test('a revision received during an older read starts a new request rather than losing the invalidation', async t => {
  const { calls, read } = fixture(t)
  const signal = new AbortController().signal
  const older = read(signal)
  const changed = read(signal, { revision: 'v2' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].signal.aborted, true)
  calls[1].resolve(Response.json({ teams: [], revision: 'v2' }))
  assert.deepEqual(await changed, [])
  calls[0].resolve(Response.json({ teams, revision: 'v1' }))
  assert.equal(await older, null)
  assert.deepEqual(await read(signal, { reuse: true }), [])
  assert.equal(calls.length, 2)
})

test('failed invalidations cannot reuse the old catalog; a retry can clear revoked access', async t => {
  const { calls, read } = fixture(t)
  const signal = new AbortController().signal
  const first = read(signal)
  calls[0].resolve(Response.json({ teams, revision: 'v1' }))
  await first
  const failed = read(signal, { revision: 'v2' })
  calls[1].resolve(new Response('', { status: 503 }))
  assert.equal(await failed, null)
  const retry = read(signal, { reuse: true })
  assert.equal(calls.length, 3)
  calls[2].resolve(new Response('', { status: 403 }))
  assert.deepEqual(await retry, [])
  assert.deepEqual(await read(signal, { reuse: true }), [])
})

test('session revalidation and legacy unversioned feed events still request current state', async t => {
  const { calls, read } = fixture(t)
  const signal = new AbortController().signal
  for (let i = 0; i < 3; i++) {
    const refreshing = read(signal, i === 1 ? { revision: null } : {})
    assert.equal(calls.length, i + 1)
    calls[i].resolve(Response.json({ teams }))
    assert.deepEqual(await refreshing, teams)
    assert.deepEqual(await read(signal, { reuse: true }), teams)
  }
  assert.equal(calls.length, 3)
})

const changedContexts = [{ generation: 2 }, { session: { id: 'other', role: 'view' } },
  { session: { id: 'user', role: 'triage' } }, { session: { ...session, csrfToken: 'rotated' } }]
changedContexts.forEach(context => {
  test(`completed catalog is discarded when context changes: ${JSON.stringify(context)}`, async t => {
    const { calls, read } = fixture(t)
    const signal = new AbortController().signal
    const first = read(signal)
    calls[0].resolve(Response.json({ teams, revision: 'v1' }))
    await first
    const changed = read(signal, { ...context, reuse: true, revision: 'v1' })
    assert.equal(calls.length, 2)
    calls[1].resolve(Response.json({ teams: [], revision: 'v2' }))
    assert.deepEqual(await changed, [])
  })
})
