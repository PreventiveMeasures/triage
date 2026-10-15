import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

mock.module('../client/index.js', { exports: { state: {} } })
for (const module of ['managed-history', 'finding-history', 'managed-issues', 'managed-pull-requests']) {
  mock.module(`../ui/view/${module}.js`, { exports: { managedHistory: null, canViewFindingHistory: () => false, applyManagedIssues() {}, invalidateManagedFixes() {} } })
}
const { resetManagedAppState, setManagedAppSession } = await import('../ui/view/client-managed.js')
const { appUser, knowGithubUsers } = await import('../ui/view/github-users.js')

test('the GitHub users kept for a session are forgotten when another user\'s, or another role\'s, comes, or managed mode ends', () => {
  const know = () => knowGithubUsers({ items: [{ author: 'mona' }], users: { mona: { id: 'mona-id', login: 'mona', name: 'Mona' } } })
  setManagedAppSession({ id: 'alice', role: 'view' })
  know()
  setManagedAppSession({ id: 'alice', role: 'view', name: 'Renamed' })
  assert.equal(appUser('mona')?.id, 'mona-id', 'the same session, renamed, keeps them')
  setManagedAppSession({ id: 'alice', role: 'admin' })
  assert.equal(appUser('mona'), null, 'another role')
  know()
  setManagedAppSession({ id: 'bob', role: 'admin' })
  assert.equal(appUser('mona'), null, 'another user')
  know()
  resetManagedAppState()
  assert.equal(appUser('mona'), null, 'managed mode ended')
})
