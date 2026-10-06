import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'

const state = { serverMode: 'managed', currentManagedTeam: 'team', managedSession: { id: 'user', role: 'view', csrfToken: 'token' },
  managedTeams: [{ id: 'team', cacheKey: 'v1', reports: [] }], managedIssues: new Map() }
const issue = 'https://github.com/o/r/issues/1', pr = 'https://github.com/o/r/pull/2'
const calls = []
mock.module('../client/index.js', { namedExports: { state, isManagedUiMode: () => true } })
mock.module('../ui/view/client-managed.js', { namedExports: { fetchFixes: teamId => {
  calls.push(teamId)
  return [{ url: issue, title: 'Issue', status: 'open' }, { url: pr, title: 'Fix', status: 'open' }]
} } })
const { managedFixes, refreshManagedIssueMetadata } = await import('../ui/view/managed-pull-requests.js')

test('issue discovery warms metadata in kanban and derived updates reuse that batch without a second fetch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => managedFixes.reset())
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
