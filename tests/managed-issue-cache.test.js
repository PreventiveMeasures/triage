import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'

const state = { serverMode: 'managed', currentManagedTeam: 'team', managedSession: { id: 'user', role: 'view', csrfToken: 'token' },
  managedTeams: [{ id: 'team', cacheKey: 'v1', reports: [] }], managedIssues: new Map() }
const issue = 'https://github.com/o/r/issues/1', pr = 'https://github.com/o/r/pull/2'
const calls = [], signals = []
const metadata = url => ({ url, title: url === issue ? 'Issue' : 'Fix', status: 'open' })
let response
mock.module('../client/index.js', { namedExports: { state, isManagedUiMode: () => true } })
mock.module('../ui/view/client-managed.js', { namedExports: { fetchFixes: (teamId, signal) => {
  calls.push(teamId); signals.push(signal)
  return response()
} } })
const { managedFixes, refreshManagedIssueMetadata } = await import('../ui/view/managed-pull-requests.js')

beforeEach(t => {
  managedFixes.reset()
  state.managedIssues.clear()
  calls.length = 0; signals.length = 0
  response = () => [metadata(issue), metadata(pr)]
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => managedFixes.reset())
})
const settle = async () => { for (let i = 0; i < 4; i++) await setImmediate() }
const flush = async t => { t.mock.timers.tick(1); await settle() }

test('issue discovery warms metadata in kanban and derived updates reuse that batch without a second fetch', async t => {
  state.managedIssues.set('finding', { url: issue, autoFix: null })
  refreshManagedIssueMetadata('team', ['finding'], new Map())
  t.mock.timers.tick(1)
  for (let i = 0; i < 4; i++) await setImmediate()
  assert.deepEqual(calls, ['team'])
  const previous = new Map(state.managedIssues)
  state.managedIssues.set('finding', { url: issue, autoFix: pr })
  refreshManagedIssueMetadata('team', ['finding'], previous)
  assert.equal(managedFixes.read(pr).title, 'Fix')
  t.mock.timers.tick(1)
  await setImmediate()
  assert.deepEqual(calls, ['team'], 'the annotation feed does not refetch the metadata that discovered the PR')
})


test('an automatic PR introduced by another client refreshes missing metadata before the cache TTL expires', async t => {
  state.managedIssues.set('finding', { url: issue, autoFix: pr })
  refreshManagedIssueMetadata('team', ['finding'], new Map())
  await flush(t)
  const next = 'https://github.com/o/r/pull/3', previous = new Map(state.managedIssues)
  state.managedIssues.set('finding', { url: issue, autoFix: next })
  response = () => [metadata(issue), metadata(next)]
  refreshManagedIssueMetadata('team', ['finding'], previous)
  assert.equal(managedFixes.read(pr).title, 'Fix', 'existing metadata remains available during refresh')
  await flush(t)
  assert.equal(managedFixes.read(next).title, 'Fix')
  assert.deepEqual(calls, ['team', 'team'])
  refreshManagedIssueMetadata('team', ['finding'], new Map(state.managedIssues))
  await flush(t)
  assert.equal(calls.length, 2, 'unchanged annotations do not repeatedly fetch')
})

const outcomes = ['included', 'missing', 'unavailable']
outcomes.forEach(outcome => {
  test(`an in-flight batch with the new PR ${outcome} handles the annotation without aborting or looping`, async t => {
    const next = 'https://github.com/o/r/pull/3', pending = Promise.withResolvers()
    response = () => pending.promise
    state.managedIssues.set('finding', { url: issue, autoFix: null })
    refreshManagedIssueMetadata('team', ['finding'], new Map())
    await flush(t)
    const previous = new Map(state.managedIssues)
    state.managedIssues.set('finding', { url: issue, autoFix: next })
    refreshManagedIssueMetadata('team', ['finding'], previous)
    await flush(t)
    assert.equal(calls.length, 1)
    assert.equal(signals[0].aborted, false)
    response = () => outcome === 'unavailable' ? [] : [metadata(issue), metadata(next)]
    pending.resolve(outcome === 'included' ? response() : [metadata(issue)])
    await settle()
    await flush(t)
    assert.equal(calls.length, outcome === 'included' ? 1 : 2)
    assert.equal(managedFixes.read(next)?.title ?? null, outcome === 'unavailable' ? null : 'Fix')
    refreshManagedIssueMetadata('team', ['finding'], new Map(state.managedIssues))
    await flush(t)
    assert.equal(calls.length, outcome === 'included' ? 1 : 2, 'a failed refresh retains its TTL rather than looping')
  })
})
