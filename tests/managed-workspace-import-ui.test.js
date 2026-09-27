import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/client-managed.js'
import { registerWorkspaceImport } from '../ui/client-managed-import.js'
import { ManagedPage } from '../ui/managed/page.js'
import { ManagedAppState } from '../ui/managed/state.js'
import { adminNavigation } from '../ui/managed/navigation.js'
import { managedRoutePath, parseManagedRoute } from '../common/managed/routes.js'

assert.equal(customElements.get('managed-admin-import'), undefined, 'loading normal managed pages does not register the import page')
registerWorkspaceImport(ManagedPage, (...args) => globalThis.fetch(...args))
const Import = customElements.get('managed-admin-import')
function page() {
  const p = new Import()
  p.appState = new ManagedAppState()
  p.session = { id: 'admin', role: 'admin', csrfToken: 'csrf' }
  p.appState.setSession(p.session)
  p._catalog = { repos: [{ repoId: 1, fullName: 'org/repo' }], teams: [{ name: 'Local workspace' }] }
  return p
}
const exported = triage => ({ version: 1, workspace: { id: 'local', name: 'Local workspace', privateKey: '' }, reports: [{ name: 'report.json', content: '{"findings":[{"id":"f","file":"a.js"}]}' }], triage })
const controller = () => new AbortController()

test('admin-only Import navigation sits immediately before Links and has a restorable route', () => {
  const admin = adminNavigation('manage-import', 'admin', true).values[0].map(template => template.values.at(-1))
  const manager = adminNavigation('manage', 'manage', true).values[0].map(template => template.values.at(-1))
  assert.equal(admin[admin.indexOf('Import') + 1], 'Links')
  assert.equal(manager.includes('Import'), false)
  assert.equal(managedRoutePath({ view: 'manage-import' }), '/manage/import')
  assert.deepEqual(parseManagedRoute(new URL('https://example.test/manage/import')), { view: 'manage-import' })
})

test('preview proposes a unique workspace name and requires an explicit triage choice', async () => {
  const p = page()
  await p._prepare(exported({ f: { color: 'red' } }), controller().signal)
  assert.equal(p._plan.name, 'Local workspace (2)')
  assert.equal(p._triage, '')
  await p._import()
  assert.equal(p._plan.team, null)
  await p._prepare(exported({}), controller().signal)
  assert.equal(p._triage, 'skip')
})

test('local passkey unlock survives vault notifications and blur before the guarded read', async () => {
  const p = page()
  let unlocked = false
  p._local = true
  p.localDeps = {
    isEncryptionEnabled: () => true, isUnlocked: () => unlocked,
    unlockEncryption: ({ signal }) => {
      p._localChanged(); p._blur(); unlocked = true
      assert.equal(signal.aborted, false)
      return true
    },
    hydrateKey: () => JSON.stringify({ workspaces: [{ id: 'local', name: 'Local workspace' }] }),
    onVaultStateChange: () => () => {}, onFileMutated: () => () => {}, onBundleMutated: () => () => {},
  }
  await p._chooseLocal()
  assert.equal(p._error, '')
  assert.deepEqual(p._workspaces, [{ id: 'local', name: 'Local workspace' }])
  p._plan = {}
  p._localChanged()
  assert.equal(p._plan, null)
})

test('changing accounts while a conflict dialog is pending discards its import plan', () => {
  const p = page()
  p._plan = {}
  p._operation = controller()
  p.updated(new Map([['session', { id: 'other-admin', role: 'admin' }]]))
  assert.equal(p._operation.signal.aborted, true)
  assert.equal(p._plan, null)
})

test('non-admin callers cannot start import actions even after the page code has loaded', async () => {
  const p = page()
  p.session = { id: 'manager', role: 'manage' }
  await p._action(() => assert.fail('must not execute'))
  assert.equal(p._busy, false)
})
