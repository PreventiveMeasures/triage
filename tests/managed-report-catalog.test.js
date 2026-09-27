import assert from 'node:assert/strict'
import { test } from 'node:test'
import { managedReportViewChanged } from '../ui/view/managed-report-catalog.js'
import { ManagedAppState } from '../ui/managed/state.js'
import { MANAGED_PAGES } from '../common/managed/routes.js'

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
