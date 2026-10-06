import './_polyfills.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
  p.confirmTriageImport = () => ({ confirmed: true })
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

test('Import triage previews an empty local store without reading files or contacting the server', async t => {
  const p = page()
  p._catalog = null
  p.localDeps = triageDeps(() => ({ ignored: { ignoredReports: ['report.json'] } }))
  p.confirmTriageImport = ({ matched, available }) => {
    assert.deepEqual({ matched, available }, { matched: 0, available: 0 })
    return { confirmed: false }
  }
  t.mock.method(globalThis, 'fetch', () => assert.fail('empty import must not contact the server'))
  await p._importLocalTriage()
  assert.equal(p._error, '')
  assert.equal(p._message, '')
})

test('triage confirmation counts unique matches across all pages and sends no annotations before approval', async t => {
  for (const confirmed of [false, true]) {
    const p = page()
    p.localDeps = triageDeps(() => ({ f: { color: 'red' }, shared: { comment: 'Local comment' }, unknown: { comment: 'Keep local' },
      ignored: { ignoredReports: ['report.json'] }, empty: {} }))
    const decision = Promise.withResolvers(), shown = Promise.withResolvers()
    const paths = [], written = []
    let approved = false
    p.confirmTriageImport = ({ matched, available, signal }) => {
      assert.deepEqual({ matched, available }, { matched: 2, available: 3 })
      assert.equal(signal.aborted, false)
      shown.resolve()
      return decision.promise
    }
    const fetch = t.mock.method(globalThis, 'fetch', (path, options) => {
      paths.push(path)
      if (path.startsWith('/api/admin/reports/finding-ids')) {
        assert.equal(options.body, undefined)
        return Response.json({ reports: [{ id: paths.length === 1 ? 'first' : 'second', findingIds: ['f', 'shared', 'other'] }],
          nextCursor: paths.length === 1 ? 'next' : null })
      }
      assert.ok(approved, 'even conflict snapshots must wait for approval')
      assert.equal(path, '/api/admin/reports/first/import-triage', 'shared IDs are imported once')
      const body = JSON.parse(options.body)
      assert.doesNotMatch(options.body, /unknown|Keep local|ignored/u)
      if (body.findingIds) {
        assert.deepEqual(body.findingIds, ['f', 'shared'])
        return Response.json({ snapshots: Object.fromEntries(body.findingIds.map(id => [id, { entry: null, comments: [], version: '0'.repeat(64) }])) })
      }
      written.push(...Object.keys(body.entries))
      return Response.json({ ok: true })
    })
    const importing = p._importLocalTriage()
    await shown.promise
    assert.deepEqual(paths, ['/api/admin/reports/finding-ids', '/api/admin/reports/finding-ids?after=next'])
    assert.equal(p._busy, true)
    approved = confirmed
    decision.resolve({ confirmed })
    await importing
    assert.equal(p._error, '')
    assert.equal(p._busy, false)
    assert.equal(p._message, confirmed ? 'Imported triage for 2 findings.' : '')
    assert.deepEqual(written, confirmed ? ['f', 'shared'] : [])
    fetch.mock.restore()
  }
})

test('nonmatching local triage shows zero eligible entries without sending local IDs', async t => {
  const p = page()
  p.localDeps = triageDeps(() => ({ unknown: { comment: 'Keep local' } }))
  let previews = 0
  p.confirmTriageImport = ({ matched, available }) => {
    previews++
    assert.deepEqual({ matched, available }, { matched: 0, available: 1 })
    return { confirmed: false }
  }
  t.mock.method(globalThis, 'fetch', (path, options) => {
    assert.equal(path, '/api/admin/reports/finding-ids')
    assert.equal(options.body, undefined)
    return Response.json({ reports: [{ id: 'report', findingIds: ['other'] }] })
  })
  await p._importLocalTriage()
  assert.equal(previews, 1)
  assert.equal(p._error, '')
  assert.equal(p._message, '')
})

test('local or session changes while confirmation is pending prevent imports even after approval', async t => {
  for (const change of ['storage', 'session']) {
    const p = page()
    p.localDeps = triageDeps(() => ({ f: { color: 'red' } }))
    const decision = Promise.withResolvers(), shown = Promise.withResolvers()
    p.confirmTriageImport = ({ signal }) => { shown.resolve(signal); return decision.promise }
    const fetch = t.mock.method(globalThis, 'fetch', (path, options) => {
      assert.equal(path, '/api/admin/reports/finding-ids', 'no annotations may be sent')
      assert.equal(options.body, undefined)
      return Response.json({ reports: [{ id: 'report', findingIds: ['f'] }] })
    })
    const importing = p._importLocalTriage()
    const signal = await shown.promise
    if (change === 'session') p.appState.setSession({ id: 'other-admin', role: 'admin' })
    else p._localChanged()
    assert.equal(signal.aborted, true)
    decision.resolve({ confirmed: true })
    await importing
    assert.equal(p._message, '')
    assert.equal(p._busy, false)
    assert.equal(fetch.mock.callCount(), 1)
    fetch.mock.restore()
  }
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

function contentSource(p, kind) {
  const content = kind === 'report' ? '{"repo":{"github":"org/repo","directory":"src"},"findings":[]}' : 'bundle bytes'
  const value = kind === 'report' ? 'report.json' : `sha512-${createHash('sha512').update(content).digest('base64')}`
  const file = new File([content], kind === 'report' ? value : 'source.bundle')
  const listeners = new Set()
  p.localImportSource = {
    locked: false, subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback) },
    list: () => [{ value, label: file.name }], importItem: (_kind, _value, use) => use(file),
  }
  p.localDeps = {
    hydrateKey: key => {
      assert.equal(key, 'deepview.workspaces')
      return JSON.stringify([{ id: 'local', name: 'Local workspace', [`${kind}s`]: [value], privateKey: 'never-send' }])
    },
    reportSyncHash: () => 'raw-bytes-hash',
    localContentSyncStatus: () => ({ synced: true, cached: true }),
  }
  return { content, value, listeners }
}

test('bare imports wait for selection, use normal upload defaults, and preserve a workspace import plan', async t => {
  for (const kind of ['bundle', 'report']) {
    const p = page(), workspacePlan = { name: 'Pending workspace' }
    p._plan = workspacePlan
    const { content, value, listeners } = contentSource(p, kind)
    const decision = Promise.withResolvers(), shown = Promise.withResolvers()
    p.confirmContentImport = ({ plan, signal }) => { shown.resolve({ plan, signal }); return decision.promise }
    let uploads = 0
    p.dispatchEvent = event => { assert.equal(event.type, 'managed-import-complete') }
    const fetch = t.mock.method(globalThis, 'fetch', async (path, options) => {
      assert.equal(path, `/api/admin/${kind}s`)
      if (!options.body) return Response.json({ [`${kind}s`]: [] })
      uploads++
      assert.ok(options.body instanceof File)
      assert.equal(await options.body.text(), content)
      assert.deepEqual(options.headers, { 'x-csrf-token': 'csrf', [`x-${kind}-filename`]: encodeURIComponent(options.body.name) })
      return Response.json({ id: 'stored', repoId: kind === 'report' ? 1 : null })
    })
    const importing = p._importLocalContent(kind)
    const { plan, signal } = await shown.promise
    assert.equal(uploads, 0)
    assert.equal(signal.aborted, false)
    assert.equal(plan.groups[0].name, 'Local workspace')
    decision.resolve({ confirmed: true, selected: [value] })
    await importing
    assert.equal(p._error, '')
    assert.equal(p._message, `Imported 1 ${kind}.`)
    assert.equal(uploads, 1)
    assert.equal(p._plan, workspacePlan)
    assert.equal(listeners.size, 0)
    fetch.mock.restore()
  }
})

test('cancelled content selections and local/session changes cannot start uploads', async t => {
  for (const change of ['cancel', 'storage', 'session', 'mutation']) {
    const p = page(), { value, listeners } = contentSource(p, 'bundle')
    const decision = Promise.withResolvers(), shown = Promise.withResolvers()
    p.confirmContentImport = ({ signal }) => { shown.resolve(signal); return decision.promise }
    const fetch = t.mock.method(globalThis, 'fetch', (path, options) => {
      assert.equal(path, '/api/admin/bundles')
      assert.equal(options.body, undefined, 'no files may be sent')
      return Response.json({ bundles: [] })
    })
    const importing = p._importLocalContent('bundle')
    const signal = await shown.promise
    if (change === 'storage') p._localChanged()
    if (change === 'session') p.appState.setSession({ id: 'other-admin', role: 'admin' })
    if (change === 'mutation') for (const notify of listeners) notify()
    assert.equal(signal.aborted, change !== 'cancel')
    decision.resolve({ confirmed: change !== 'cancel', selected: [value] })
    await importing
    assert.equal(p._message, '')
    assert.equal(p._busy, false)
    assert.equal(listeners.size, 0)
    fetch.mock.restore()
  }
})
