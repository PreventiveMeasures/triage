import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BUNDLE_TABS } from '../common/bundle-tabs.js'
import { managedRoutePath } from '../common/managed/routes.js'
import { ManagedAppState } from '../ui/managed/state.js'
import { managedBundleEntry, managedBundleRoute } from '../ui/view/managed-bundle-navigation.js'
import { refreshManagedBundleView } from '../ui/view/managed-bundle-refresh.js'
import { createManagedHistory } from '../ui/view/managed-history.js'
import { browserAt } from './_managed-browser.js'

const bundle = { id: 'bundle', slug: 'bundle', integrity: 'sha512-bundle', filename: 'bundle.stasis',
  repoId: 7, repoFullName: 'org/repo', repoDirectory: '' }
const team = (id, bundles = [bundle], key = 'grant-v1') => ({ id, slug: id, cacheKey: key, reports: [], bundles })

async function fixture({ teamId = null, role = 'manage', tab = 'code' } = {}) {
  const teams = [team('one'), team('two')]
  const state = { currentView: 'bundles', currentManagedTeam: teamId, managedSession: { id: 'user', role },
    selectedBundle: bundle.integrity, bundles: [managedBundleEntry(bundle)], bundleDetailsTab: tab,
    bundleDetails: { managedId: bundle.id, integrity: bundle.integrity, bundle: { sources: new Map([['index.js', 'source']]) } },
    bundleSourceFile: 'index.js', bundleCodeHistory: { files: ['lib.js', 'index.js'], at: 1 },
    bundleCodeSearchQuery: 'index', bundleCodeSearchMode: 'files', bundleSearchQuery: 'source',
    bundleSearchRegex: true, bundleSearchCase: true, bundleSearchContext: false }
  const before = { ...state }
  const { browser } = browserAt(managedRoutePath(managedBundleRoute(teams, state.bundles[0], teamId, tab)))
  const history = createManagedHistory(browser)
  let catalogue = [bundle], current = true, reads = 0, restorations = 0
  await history.start(() => { restorations++; return true })
  const refresh = (updatedTeams, render = () => {}) => refreshManagedBundleView(state, updatedTeams, {
    fetchCatalog: () => { reads++; return Promise.resolve(catalogue) }, isCurrent: () => current,
    render,
    replaceRoute: route => history.replaceRoute(route),
  })
  const preserved = () => {
    assert.deepEqual({ ...state, bundles: before.bundles, currentManagedTeam: before.currentManagedTeam }, before)
    assert.equal(state.bundleDetails, before.bundleDetails, 'retain the loaded source body')
    assert.equal(restorations, 1, 'refresh must not reopen the bundle through route restoration')
  }
  return { state, browser, refresh, preserved, reads: () => reads,
    setCatalog: value => { catalogue = value }, stop: () => { current = false } }
}

test('first and later Manage refreshes invalidate shared caches while preserving every active bundle tab', async () => {
  for (const tab of BUNDLE_TABS) {
    const f = await fixture({ tab })
    const cache = new ManagedAppState()
    cache.setReportCatalog([team('one', [])])
    for (const key of ['grant-v1', 'grant-v2', 'grant-v3']) {
      await cache.load('bundle-metadata:bundle', 'bundle', () => Promise.resolve({ files: [] }))
      const refreshed = [team('one', [bundle], key)]
      assert.ok(cache.setReportCatalog(refreshed).has('bundle:bundle'))
      assert.equal(cache.read('bundle-metadata:bundle'), undefined)
      assert.equal(await f.refresh(refreshed), true)
      f.preserved()
      assert.equal(f.browser.location.pathname, `/manage/bundle/bundle${tab === 'overview' ? '' : `/${tab}`}`)
    }
    assert.equal(f.reads(), 3, 'Manage always confirms access through its own current catalogue')
  }
})

test('an accessible team bundle refreshes its location and candidates without resetting its source view', async () => {
  const f = await fixture({ teamId: 'two', role: 'view' })
  const moved = { ...bundle, filename: 'renamed.stasis', repoFullName: 'other/repo', repoDirectory: 'sub' }
  const other = { ...moved, id: 'other', slug: 'other', integrity: 'sha512-other' }
  assert.equal(await f.refresh([team('one', [moved]), team('two', [moved, other], 'grant-v2')]), true)
  f.preserved()
  assert.deepEqual(f.state.bundles, [managedBundleEntry(moved), managedBundleEntry(other)])
  assert.equal(f.state.currentManagedTeam, 'two', 'keep the clicked team when several teams grant access')
  assert.equal(f.browser.location.pathname, '/team/two/bundle/bundle/code')
  assert.equal(f.reads(), 0, 'the fresh team catalogue already confirms access')
})

test('losing the original team keeps the bundle open through another authorized team', async () => {
  const f = await fixture({ teamId: 'one', role: 'view' })
  assert.equal(await f.refresh([team('two')]), true)
  f.preserved()
  assert.equal(f.state.currentManagedTeam, 'two')
  assert.equal(f.browser.location.pathname, '/team/two/bundle/bundle/code')
  assert.equal(f.reads(), 0)
})

test('a detached upload stays open in Manage when its uploader still has access', async () => {
  const f = await fixture({ teamId: 'one' })
  const detached = { ...bundle, repoId: null, repoFullName: null }
  f.setCatalog([detached])
  assert.equal(await f.refresh([]), true)
  f.preserved()
  assert.equal(f.state.currentManagedTeam, null)
  assert.deepEqual(f.state.bundles, [managedBundleEntry(detached)])
  assert.equal(f.browser.location.pathname, '/manage/bundle/bundle/code')
})

test('a bundle still loading its metadata is rehomed, or found gone, from its catalogue entry', async () => {
  const f = await fixture({ teamId: 'one', role: 'view', tab: 'overview' })
  f.state.bundleDetails = null
  assert.equal(await f.refresh([team('two')]), true)
  assert.equal(f.state.currentManagedTeam, 'two')
  assert.equal(f.browser.location.pathname, '/team/two/bundle/bundle')
  assert.equal(f.state.bundleDetails, null, 'the metadata it waits for still fills it in')
  assert.equal(await f.refresh([]), false)
})

test('history records the final rendered tab when Advisories loses access', async () => {
  const f = await fixture({ tab: 'advisories' })
  assert.equal(await f.refresh([], () => { f.state.bundleDetailsTab = 'overview' }), true)
  assert.equal(f.browser.location.pathname, '/manage/bundle/bundle')
  assert.equal(f.state.bundleDetails.managedId, bundle.id)
})

test('missing bundles and confirmed authorization failures are inaccessible, even outside all teams', async () => {
  const viewer = await fixture({ teamId: 'one', role: 'view' })
  assert.equal(await viewer.refresh([]), false)
  assert.equal(viewer.reads(), 0)
  for (const status of [null, 401, 403]) {
    const f = await fixture()
    f.setCatalog([])
    const fetchCatalog = () => {
      if (status !== null) throw Object.assign(new Error('Access denied'), { status })
      return Promise.resolve([])
    }
    assert.equal(await refreshManagedBundleView(f.state, [], {
      fetchCatalog, isCurrent: () => true, replaceRoute: () => assert.fail('do not retain a revoked route'),
    }), false)
    f.preserved()
  }
})

test('temporary catalogue failures preserve the bundle and allow the next refresh to retry', async () => {
  for (const error of [Object.assign(new Error('Unavailable'), { status: 503 }), new TypeError('Network error')]) {
    const f = await fixture()
    await assert.rejects(refreshManagedBundleView(f.state, [], {
      fetchCatalog: () => Promise.reject(error), isCurrent: () => true,
      replaceRoute: () => assert.fail('failed refresh must not rewrite history'),
    }), error)
    f.preserved()
    assert.equal(await f.refresh([]), true)
    f.preserved()
  }
})

test('late access responses cannot overwrite newer navigation, catalogues or sessions', async () => {
  for (const catalogue of [[{ ...bundle, filename: 'outdated.stasis' }], []]) {
    const f = await fixture()
    const pending = Promise.withResolvers()
    let current = true
    const loading = refreshManagedBundleView(f.state, [], {
      fetchCatalog: () => pending.promise, isCurrent: () => current,
      replaceRoute: () => assert.fail('stale refresh must not rewrite history'),
    })
    current = false
    const next = { ...f.state, bundles: [], currentView: 'manage-bundles', currentManagedTeam: null,
      bundleDetails: null, managedSession: { id: 'other', role: 'manage' } }
    Object.assign(f.state, next)
    pending.resolve(catalogue)
    assert.equal(await loading, true)
    assert.deepEqual(f.state, next)
  }
})

test('inactive bundle refreshes do not start catalogue reads or alter another page', async () => {
  const f = await fixture()
  f.stop()
  assert.equal(await f.refresh([]), true)
  f.preserved()
  f.state.currentView = 'manage-bundles'
  assert.equal(await f.refresh([]), true)
  assert.equal(f.reads(), 0)
})

test('a refresh keeps the number of the file the Code tab shows', async () => {
  const f = await fixture({ teamId: 'one' })
  Object.assign(f.state, { bundleSourceFile: 'lib.js', bundleCodeFileRequest: null,
    bundleSourceTargetLine: { bundle: bundle.integrity, path: 'lib.js', line: 3, end: 5 },
    bundleDetails: { ...f.state.bundleDetails, kind: 'stasis', bundle: { sources: new Map([['lib.js', 'lib'], ['index.js', 'source']]) } } })
  assert.equal(await f.refresh([team('one'), team('two')]), true)
  assert.equal(f.browser.location.pathname + f.browser.location.hash, '/team/one/bundle/bundle/code/2#L3-L5')
})
