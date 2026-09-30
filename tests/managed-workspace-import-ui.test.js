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

function triageDeps(readTriageBlob) {
  return {
    isEncryptionEnabled: () => false, isUnlocked: () => true,
    onVaultStateChange: () => () => {}, readTriageBlob,
  }
}

test('Import triage reads only local triage, needs no catalog/workspace, and reports an empty import', async t => {
  const p = page()
  p._catalog = null
  p.localDeps = triageDeps(() => ({ ignored: { ignoredReports: ['report.json'] } }))
  t.mock.method(globalThis, 'fetch', () => assert.fail('empty import must not contact the server'))
  await p._importLocalTriage()
  assert.equal(p._error, '')
  assert.equal(p._message, 'No local triage matches findings in managed reports.')
})

test('Import triage unlocks local data, imports without reading files, and preserves a pending workspace plan', async t => {
  const p = page()
  const plan = p._plan = { name: 'Prepared workspace' }
  let notifications = 0, unlocked = false, writes = 0
  p.localDeps = { ...triageDeps(() => ({ f: { flagged: false, comment: 'Local comment' } })),
    isEncryptionEnabled: () => true, isUnlocked: () => unlocked,
    unlockEncryption: () => { p._localChanged(); p._blur(); unlocked = true; return true },
  }
  p.dispatchEvent = event => { assert.equal(event.type, 'managed-import-complete'); notifications++ }
  t.mock.method(globalThis, 'fetch', (path, options) => {
    if (path === '/api/admin/reports/finding-ids') {
      assert.equal(options.body, undefined)
      return Response.json({ reports: [{ id: 'report', findingIds: ['f'] }] })
    }
    assert.equal(path, '/api/admin/reports/report/import-triage')
    assert.equal(options.headers['x-csrf-token'], 'csrf')
    const body = JSON.parse(options.body)
    if (body.findingIds) return Response.json({ snapshots: { f: { entry: null, comments: [], version: '0'.repeat(64) } } })
    writes++
    assert.deepEqual(body.entries, { f: { flagged: false, comment: 'Local comment' } })
    return Response.json({ ok: true })
  })
  await p._importLocalTriage()
  assert.equal(p._error, '')
  assert.equal(p._message, 'Imported triage for 1 finding.')
  assert.equal(p._plan, plan)
  assert.equal(writes, 1)
  assert.equal(notifications, 1)
})

test('cancelled unlock and invalid matching local triage never send imports', async t => {
  let reads = 0
  t.mock.method(globalThis, 'fetch', (path, options) => {
    assert.equal(path, '/api/admin/reports/finding-ids')
    assert.equal(options.body, undefined)
    reads++
    return Response.json({ reports: [{ id: 'report', findingIds: ['valid', 'invalid'] }] })
  })
  const p = page()
  p.localDeps = { ...triageDeps(() => assert.fail('must not read locked data')),
    isEncryptionEnabled: () => true, isUnlocked: () => false, unlockEncryption: () => false,
  }
  await p._importLocalTriage()
  assert.equal(p._error, '')
  assert.equal(reads, 0)
  p.localDeps = triageDeps(() => ({ valid: { color: 'red' }, invalid: { comment: 'x'.repeat(10001) } }))
  await p._importLocalTriage()
  assert.match(p._error, /exceeds the managed server limits/u)
  assert.equal(reads, 1)
})

test('vault changes during reads and local/session changes during conflicts cancel triage writes', async t => {
  for (const change of ['read', 'storage', 'session']) {
    const p = page()
    let notifyVault
    p.localDeps = triageDeps(() => {
      if (change === 'read') notifyVault()
      return { f: { color: 'red' } }
    })
    p.localDeps.onVaultStateChange = callback => { notifyVault = callback; return () => { notifyVault = null } }
    const fetch = t.mock.method(globalThis, 'fetch', (path, options) => {
      if (path === '/api/admin/reports/finding-ids') return Response.json({ reports: [{ id: 'report', findingIds: ['f'] }] })
      assert.ok(JSON.parse(options.body).findingIds, 'no write after cancellation')
      return Response.json({ snapshots: { f: { entry: { color: 'blue' }, comments: [], version: '0'.repeat(64) } } })
    })
    p.resolveConflicts = () => {
      if (change === 'session') p.appState.setSession({ id: 'other-admin', role: 'admin' })
      else p._localChanged()
      return { 'f:color': 'imported' }
    }
    await p._importLocalTriage()
    assert.equal(p._message, '')
    assert.equal(p._busy, false)
    assert.equal(notifyVault, null, 'vault listener is released after the read')
    assert.equal(fetch.mock.callCount(), change === 'read' ? 0 : 2)
    fetch.mock.restore()
  }
})
