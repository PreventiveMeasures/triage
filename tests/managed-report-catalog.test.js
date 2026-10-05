import assert from 'node:assert/strict'
import { test } from 'node:test'
import { managedBundleViewChanged, managedReportViewChanged } from '../ui/view/managed-report-catalog.js'
import { ManagedAppState } from '../ui/managed/state.js'
import { MANAGED_PAGES } from '../common/managed/routes.js'
import { managedBundleEntry } from '../ui/view/managed-bundle-navigation.js'

const report = id => ({ id, cacheKey: `${id}-v1` })
const teams = (...ids) => [{ id: 'team', reports: ids.map(report) }]
const aggregate = { currentView: 'findings', currentManagedTeam: 'team', currentManagedReport: null, managedReports: [report('a')] }

test('an open aggregate view reloads newly visible reports even though no loaded report changed', () => {
  const cache = new ManagedAppState()
  cache.setReportCatalog(teams('a'))
  const refreshed = teams('a', 'b')
  const changed = cache.setReportCatalog(refreshed)
  assert.deepEqual([...changed], ['team:team', 'b'])
  assert.equal(managedReportViewChanged(aggregate, refreshed, changed), true)
})

test('aggregate membership changes are detected even if report content remains cached through other teams', () => {
  const unchanged = new Set()
  assert.equal(managedReportViewChanged(aggregate, teams('a', 'b'), unchanged), true)
  assert.equal(managedReportViewChanged(aggregate, teams('b'), unchanged), true)
  assert.equal(managedReportViewChanged(aggregate, teams(), unchanged), true)
  const loaded = { ...aggregate, managedReports: [report('a'), report('b')] }
  assert.equal(managedReportViewChanged(loaded, teams('b', 'a'), unchanged), false)
})

test('individual views ignore additions but reload changed or removed content and lost teams', () => {
  const individual = { ...aggregate, currentManagedReport: 'a' }
  assert.equal(managedReportViewChanged(individual, teams('a', 'b'), new Set(['b'])), false)
  assert.equal(managedReportViewChanged(individual, teams('a'), new Set(['a'])), true)
  assert.equal(managedReportViewChanged(individual, teams('b'), new Set()), true)
  assert.equal(managedReportViewChanged(individual, [], new Set()), true)
  assert.equal(managedReportViewChanged({ ...individual, currentManagedTeam: null }, [], new Set(['a'])), false)
})

test('catalog changes evict report views only while Findings or Files is displayed', () => {
  const changes = [
    { catalog: teams('a'), changed: new Set(['a']) },
    { catalog: teams('a', 'b'), changed: new Set(['b']) },
    { catalog: teams(), changed: new Set(['a']) },
    { catalog: [], changed: new Set(['a']) },
  ]
  for (const currentView of ['findings', 'files', ...Object.keys(MANAGED_PAGES), 'bundles', 'home']) {
    // Management navigation retains the previously loaded report in state.
    const state = { ...aggregate, currentView }
    for (const { catalog, changed } of changes) {
      assert.equal(managedReportViewChanged(state, catalog, changed), ['findings', 'files'].includes(currentView), currentView)
    }
  }
})

test('refreshing a catalog on a management page still invalidates cached report content', async () => {
  const cache = new ManagedAppState()
  cache.setReportCatalog(teams('a'))
  await cache.load('reports:content:a', 'report', () => Promise.resolve({ data: { findings: [] } }))
  const refreshed = [{ id: 'team', reports: [{ id: 'a', cacheKey: 'a-v2' }] }]
  const changed = cache.setReportCatalog(refreshed)
  assert.deepEqual([...changed], ['team:team', 'a'])
  assert.equal(cache.read('reports:content:a'), undefined)
  assert.equal(managedReportViewChanged({ ...aggregate, currentView: 'manage-reports' }, refreshed, changed), false)
})

test('empty-team grant changes invalidate the workspace and its bundle metadata', async () => {
  const cache = new ManagedAppState()
  const catalog = key => [{ id: 'team', cacheKey: key, reports: [], bundles: [{ id: 'bundle', filename: 'b.stasis', repoFullName: 'org/repo' }] }]
  cache.setReportCatalog(catalog('grant-v1'))
  await cache.load('reports:content:team:team', 'workspace', () => Promise.resolve([]))
  await cache.load('bundle-metadata:bundle', 'bundle', () => Promise.resolve({ files: [] }))
  assert.equal(cache.setReportCatalog(catalog('grant-v1')).size, 0)
  assert.deepEqual([...cache.setReportCatalog(catalog('grant-v2'))], ['team:team', 'bundle:bundle'])
  assert.equal(cache.read('reports:content:team:team'), undefined)
  assert.equal(cache.read('bundle-metadata:bundle'), undefined)
  assert.deepEqual([...cache.setReportCatalog([])], ['team:team', 'bundle:bundle'])
})

test('bundle assignment changes reload affected team reports and leave other teams alone', () => {
  const cache = new ManagedAppState()
  const bundle = { id: 'bundle', filename: 'source.stasis', repoFullName: 'org/repo' }
  const catalog = owner => ['one', 'two', 'other'].map(id => ({ id, reports: [report(id)], bundles: id === owner ? [bundle] : [] }))
  cache.setReportCatalog(catalog('one'))
  const moved = catalog('two')
  const changed = cache.setReportCatalog(moved)
  for (const id of ['one', 'two', 'other']) {
    const view = { ...aggregate, currentManagedTeam: id, managedReports: [report(id)] }
    assert.equal(managedReportViewChanged(view, moved, changed), id !== 'other')
    assert.equal(managedReportViewChanged({ ...view, currentManagedReport: id }, moved, changed), id !== 'other')
  }
  assert.equal(cache.setReportCatalog(catalog('two')).size, 0)
})


test('moving a bundle within the same team refreshes its location and source caches', async () => {
  const cache = new ManagedAppState()
  const catalog = directory => [{ id: 'team', reports: [report('report')], bundles: [{ id: 'bundle', filename: 'b.map', repoFullName: 'org/repo', repoDirectory: directory }] }]
  cache.setReportCatalog(catalog('foo'))
  await cache.load('bundle-metadata:bundle', 'bundle', () => Promise.resolve({ files: [] }))
  const changed = cache.setReportCatalog(catalog('foo/sub'))
  assert.deepEqual([...changed], ['team:team', 'bundle:bundle'])
  assert.equal(cache.read('bundle-metadata:bundle'), undefined)
})

test('the first team refresh after creation keeps the matching Manage bundle view open', async () => {
  const cache = new ManagedAppState()
  const bundle = { id: 'created', slug: 'created', integrity: 'sha512-created', filename: 'created.stasis', repoId: 7, repoFullName: 'org/repo', repoDirectory: '' }
  const previous = [{ id: 'team', reports: [], bundles: [] }]
  const refreshed = [{ ...previous[0], bundles: [bundle] }]
  const view = { currentView: 'bundles', currentManagedTeam: null, bundleDetails: { managedId: bundle.id }, bundles: [managedBundleEntry(bundle)] }
  cache.setReportCatalog(previous)
  await cache.load('bundle-metadata:created', 'bundle', () => Promise.resolve({ files: [] }))
  const changed = cache.setReportCatalog(refreshed)
  assert.ok(changed.has('bundle:created'), 'a new team assignment still invalidates shared caches')
  assert.equal(cache.read('bundle-metadata:created'), undefined)
  assert.equal(managedBundleViewChanged(view, previous, refreshed, changed), false, 'a newly discovered team assignment must not clear the displayed bundle')
})

test('newly discovered bundle changes and known grant revocations still clear stale bundle views', () => {
  const bundle = { id: 'bundle', slug: 'bundle', integrity: 'sha512-bundle', filename: 'bundle.map', repoId: 7, repoFullName: 'org/repo', repoDirectory: '' }
  const empty = [{ id: 'team', reports: [], bundles: [] }]
  const known = [{ ...empty[0], cacheKey: 'grant-v1', bundles: [bundle] }]
  const view = { currentView: 'bundles', currentManagedTeam: null, bundleDetails: { managedId: bundle.id }, bundles: [managedBundleEntry(bundle)] }
  const changed = new Set(['bundle:bundle'])
  for (const update of [{ filename: 'renamed.map' }, { repoId: 8 }, { repoFullName: 'other/repo' }, { repoDirectory: 'sub' }, { integrity: 'sha512-other' }]) {
    const refreshed = [{ ...known[0], bundles: [{ ...bundle, ...update }] }]
    assert.equal(managedBundleViewChanged(view, empty, refreshed, changed), true)
  }
  assert.equal(managedBundleViewChanged(view, known, [{ ...known[0], cacheKey: 'grant-v2' }], changed), true)
  assert.equal(managedBundleViewChanged(view, known, empty, changed), true)
  assert.equal(managedBundleViewChanged({ ...view, currentManagedTeam: 'team' }, empty, known, changed), true)
  assert.equal(managedBundleViewChanged({ ...view, bundles: [] }, empty, known, changed), true)
  assert.equal(managedBundleViewChanged(view, known, known, new Set()), false)
  assert.equal(managedBundleViewChanged({ ...view, currentView: 'manage-bundles' }, known, empty, changed), false)
})
