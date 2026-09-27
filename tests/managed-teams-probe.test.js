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

test('live catalog callers share a request while cancelled callers discard its result', async t => {
  const { calls, read } = fixture(t)
  const caller = new AbortController(), owner = new AbortController()
  const first = read(owner.signal), second = read(caller.signal)
  assert.equal(calls.length, 1)
  caller.abort()
  assert.equal(calls[0].signal.aborted, false, 'the original owner is still active')
  calls[0].resolve(Response.json({ teams }))
  assert.deepEqual(await first, teams)
  assert.equal(await second, null)
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
