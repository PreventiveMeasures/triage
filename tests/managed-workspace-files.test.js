import assert from 'node:assert/strict'
import { test } from 'node:test'
import { store } from '@rray/frontend/state-management'
import { ManagedAppState } from '../ui/managed/state.js'
import { refreshManagedWorkspaceFiles } from '../ui/view/managed-workspace-files.js'
import { filesButtonTemplate } from '../ui/view/workspace-content.js'

function fixture(view = 'workspace-reports') {
  const state = store({ currentView: view, currentManagedTeam: 'team', managedSession: { id: 'user', role: 'manage' },
    managedTeams: [{ id: 'team', reports: [] }], workspaceContentFileCount: 0 })
  const controller = new AbortController()
  const cache = new ManagedAppState()
  let current = true, reads = 0, renders = 0
  const fetchReports = (id, options) => {
    const key = `reports:content:team:${id}`
    return cache.read(key) ?? cache.load(key, 'workspace', () => {
      reads++
      return Promise.resolve(state.managedTeams.find(team => team.id === id).reports
        .filter(report => report.visible !== false).map(report => ({ id: report.id, data: report.data })))
    }, options)
  }
  const refresh = (overrides = {}) => refreshManagedWorkspaceFiles(state, {
    fetchReports, signal: controller.signal, isCurrent: () => current, render: () => { renders++ }, ...overrides,
  })
  const catalog = reports => {
    const teams = [{ id: 'team', reports }]
    cache.setReportCatalog(teams)
    state.managedTeams = teams
  }
  return { state, refresh, catalog, controller, reads: () => reads, renders: () => renders, stop: () => { current = false } }
}

const report = (id, files, cacheKey = id, visible = true) => ({ id, cacheKey, visible,
  data: { tree: Object.fromEntries(files.map(file => [file, {}])) } })

for (const view of ['workspace-reports', 'workspace-bundles']) {
  test(`${view} updates Files after uploads, replacements, publication, hiding and removal`, async () => {
    const f = fixture(view)
    const a = report('a', ['a.js', 'shared.js'])
    const b = report('b', ['b.js', 'shared.js'])
    const snapshots = [
      [[], 0],
      [[a], 2],
      [[a, b], 3],
      [[report('a', ['new.js', 'extra.js'], 'a-v2'), b], 4],
      [[{ ...a, visible: false }, b], 2],
      [[a, b], 3],
      [[{ ...a, visible: false }, { ...b, visible: false }], 0],
      [[a], 2],
      [[], 0],
    ]
    for (const [reports, count] of snapshots) {
      f.catalog(reports)
      assert.equal(await f.refresh(), true)
      assert.equal(f.state.workspaceContentFileCount, count)
      assert.equal(typeof filesButtonTemplate(count, view) === 'symbol', count <= 1, 'button availability follows the refreshed count')
      assert.equal(f.state.currentView, view, 'refresh does not navigate or replace the list')
    }
    const reads = f.reads()
    f.catalog([])
    assert.equal(await f.refresh(), true)
    assert.equal(f.reads(), reads, 'unchanged catalog snapshots reuse the team report cache')
  })
}

test('an initial count read cannot overwrite a newer catalog refresh', async () => {
  const f = fixture(), pending = Promise.withResolvers()
  f.catalog([report('a', ['old.js'])])
  const initial = f.refresh({ fetchReports: () => pending.promise })
  f.catalog([report('b', ['b.js', 'c.js'])])
  assert.equal(await f.refresh(), true)
  pending.resolve([{ data: { tree: { 'old.js': {} } } }])
  assert.equal(await initial, true)
  assert.equal(f.state.workspaceContentFileCount, 2)
  assert.equal(f.renders(), 1)
})

test('failed count reads invalidate stale buttons and can retry without a catalog change', async () => {
  for (const fetchReports of [() => Promise.resolve(null), () => Promise.reject(new Error('Network error'))]) {
    const f = fixture()
    f.catalog([report('a', ['a.js', 'b.js'])])
    f.state.workspaceContentFileCount = 99
    assert.equal(await f.refresh({ fetchReports }), false, 'tell the feed to retry')
    assert.equal(f.state.workspaceContentFileCount, 0)
    assert.equal(await f.refresh(), true)
    assert.equal(f.state.workspaceContentFileCount, 2)
  }
})

test('late count responses cannot update a different view, account, team or canceled request', async () => {
  const changes = [
    f => { f.state.currentView = 'findings' },
    f => { f.state.currentView = 'workspace-bundles' },
    f => { f.state.currentManagedTeam = 'other' },
    f => { f.state.managedSession = { id: 'other', role: 'manage' } },
    f => { f.state.managedTeams = [] },
    f => f.controller.abort(),
    f => f.stop(),
  ]
  for (const change of changes) {
    const f = fixture(), pending = Promise.withResolvers()
    const refresh = f.refresh({ fetchReports: (id, { signal }) => {
      assert.equal(id, 'team')
      assert.equal(signal, f.controller.signal)
      return pending.promise
    } })
    change(f)
    f.state.workspaceContentFileCount = 7
    pending.resolve([{ data: { tree: { 'old.js': {} } } }])
    assert.equal(await refresh, true, 'stale work does not restart a stopped feed')
    assert.equal(f.state.workspaceContentFileCount, 7)
    assert.equal(f.renders(), 0)
  }
})

test('inactive lists do not load report data', async () => {
  for (const view of ['findings', 'files', 'bundles', 'home', 'manage-reports']) {
    const f = fixture(view)
    assert.equal(await f.refresh(), true)
    assert.equal(f.reads(), 0)
  }
  const f = fixture()
  f.controller.abort()
  assert.equal(await f.refresh(), true)
  assert.equal(f.reads(), 0)
})

test('feed cancellation stops waiting even when a shared report request remains pending', async () => {
  const f = fixture(), pending = Promise.withResolvers()
  const refreshing = f.refresh({ fetchReports: () => pending.promise })
  await Promise.resolve()
  f.controller.abort()
  assert.equal(await refreshing, true)
  assert.equal(f.renders(), 0)
  pending.resolve([{ data: { tree: { late: {} } } }])
  assert.equal(f.state.workspaceContentFileCount, 0)
})
