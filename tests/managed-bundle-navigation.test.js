import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BUNDLE_TABS } from '../common/bundle-tabs.js'
import { managedRouteForIds, managedRoutePath, parseManagedRoute, resolveManagedRoute } from '../common/managed/routes.js'
import { managedBundleEntry, managedBundleRoute, managedCodeLocation, managedCompareLocation, managedTabLocation, managedTeamBundleEntries, shownManagedBundleId } from '../ui/view/managed-bundle-navigation.js'
import { bundleComparisonCandidates } from '../ui/view/bundle-comparison-candidates.js'
import { createManagedHistory } from '../ui/view/managed-history.js'
import { browserAt } from './_managed-browser.js'

const bundle = (id, repoId) => ({ id: `uuid-${id}`, slug: id, integrity: `hash-${id}`, filename: `${id}.map`, byteSize: 20, repoId })
const a = bundle('a', 1), b = bundle('b', 1), c = bundle('c', 2), detached = bundle('detached', null)
const teams = [
  { id: 'uuid-first', slug: 'first', bundles: [a, b, c] },
  { id: 'uuid-second', slug: 'second', bundles: [a, b] },
  { id: 'uuid-other', slug: 'other', bundles: [c] },
]

for (const kind of ['reports', 'bundles']) {
  test(`team ${kind} lists round-trip their route and require an unambiguous current team`, () => {
    const view = `workspace-${kind}`
    const route = managedRouteForIds({ view, teamId: 'uuid-first' }, teams)
    assert.equal(managedRoutePath(route), `/team/first/${kind}`)
    const parsed = parseManagedRoute(new URL(`/team/first/${kind}`, 'https://triage.test'))
    assert.deepEqual(resolveManagedRoute(parsed, teams), { view, teamId: 'uuid-first' })
    assert.equal(resolveManagedRoute(parsed, []), null)
    assert.equal(resolveManagedRoute(parsed, [...teams, { id: 'duplicate', slug: 'first' }]), null)
    assert.equal(managedRouteForIds({ view, teamId: 'missing' }, teams), null)
    assert.equal(managedRoutePath({ view, teamSlug: '../bad' }), null)
  })
}

test('cold managed catalogue offers every same-repository bundle, deduplicated across teams', () => {
  const entries = managedTeamBundleEntries(teams)
  assert.equal(entries.length, 3)
  assert.deepEqual(bundleComparisonCandidates(entries, a.integrity).map(entry => entry.managedId), [b.id])
  assert.deepEqual(bundleComparisonCandidates(entries, c.integrity), [])
  const all = [...entries, managedBundleEntry(detached), managedBundleEntry(bundle('unattached', null)), { integrity: 'local', name: 'local.map' }]
  assert.deepEqual(bundleComparisonCandidates(all, a.integrity).map(entry => entry.managedId), [b.id])
  assert.deepEqual(bundleComparisonCandidates(all, detached.integrity), [])
  assert.deepEqual(bundleComparisonCandidates([{ integrity: 'x' }, { integrity: 'y' }], 'x'), [{ integrity: 'y' }])
})

test('all bundle tabs round-trip exact slugs and the clicked team, including Manage without a team', () => {
  for (const team of [...teams.slice(0, 2), null]) {
    for (const tab of BUNDLE_TABS) {
      const route = managedBundleRoute(teams, managedBundleEntry(a), team?.id, tab)
      const path = managedRoutePath(route)
      assert.equal(path, `${team ? `/team/${team.slug}` : '/manage'}/bundle/a${tab === 'overview' ? '' : `/${tab}`}`)
      assert.deepEqual(resolveManagedRoute(parseManagedRoute(new URL(path, 'https://triage.test')), teams, [a]),
        { view: 'bundles', bundleTab: tab, teamId: team?.id ?? null, bundleId: a.id })
    }
    // Code numbers its open file from 1, never naming its path.
    const route = managedBundleRoute(teams, managedBundleEntry(a), team?.id, 'code', { file: 4, line: 42, endLine: 69 })
    const path = managedRoutePath(route)
    assert.equal(path, `${team ? `/team/${team.slug}` : '/manage'}/bundle/a/code/4#L42-L69`)
    assert.deepEqual(resolveManagedRoute(parseManagedRoute(new URL(path, 'https://triage.test')), teams, [a]),
      { view: 'bundles', bundleTab: 'code', file: 4, line: 42, endLine: 69, teamId: team?.id ?? null, bundleId: a.id })
  }
  assert.equal(resolveManagedRoute({ view: 'bundles', teamSlug: 'first', bundleSlug: a.id }, teams), null, 'UUIDs are not slug aliases')
  assert.equal(resolveManagedRoute({ view: 'bundles', teamSlug: 'other', bundleSlug: a.slug }, teams), null, 'bundle must be in the clicked team')
  assert.equal(resolveManagedRoute({ view: 'bundles', teamSlug: 'missing', bundleSlug: a.slug }, teams), null)
  assert.equal(resolveManagedRoute({ view: 'bundles', teamSlug: 'first', bundleSlug: a.slug },
    [...teams, { id: 'ambiguous', slug: 'ambiguous', bundles: [{ id: 'different', slug: a.slug }] }]), null)
  assert.equal(resolveManagedRoute({ view: 'bundles', teamSlug: null, bundleSlug: a.slug }, teams), null, 'Manage requires its own authorized catalogue')
  for (const path of ['/team/first/bundle/a/invalid', '/team/first/bundle/%2F/code', '/team/first/bundle/a/code/extra', '/bundle/uuid-a',
    '/team/first/bundle/a/code/04', '/team/first/bundle/a/code/4/code', '/team/first/bundle/a/graph/b', '/team/first/bundle/a/compare/b/split']) {
    assert.equal(parseManagedRoute(new URL(path, 'https://triage.test')), null)
  }
})

test('Manage bundle refreshes retain their route and tab after a team discovers the bundle, and recheck access', async () => {
  const { browser } = browserAt()
  const entry = managedBundleEntry(a)
  let catalog = [a], refreshed = [], shown
  const nav = createManagedHistory(browser)
  await nav.start(route => {
    if (route.view === 'home') { shown = null; return true }
    const resolved = resolveManagedRoute(route, refreshed, catalog)
    if (!resolved) return false
    shown = resolved
    return managedRouteForIds(resolved, refreshed, catalog)
  })
  assert.equal(await nav.navigate(managedBundleRoute(refreshed, entry, null)), true)
  assert.equal(browser.location.pathname, '/manage/bundle/a')
  refreshed = teams
  for (const tab of BUNDLE_TABS) {
    assert.equal(await nav.navigate(managedBundleRoute(refreshed, entry, null, tab), { replace: true }), true)
    assert.deepEqual(shown, { view: 'bundles', bundleTab: tab, teamId: null, bundleId: a.id })
    assert.equal(browser.location.pathname, `/manage/bundle/a${tab === 'overview' ? '' : `/${tab}`}`)
  }
  assert.equal(managedBundleRoute([], entry, 'uuid-first'), null, 'lost team access must not fall back to Manage')
  catalog = []
  assert.equal(await nav.navigate(managedBundleRoute(refreshed, entry, null), { replace: true }), false)
  assert.equal(browser.location.pathname, '/', 'the current Manage catalogue must still authorize the bundle')
  assert.equal(shown, null)
})

test('tab links survive reload, bundle switches, Compare swaps and Back/Forward without losing the clicked team', async () => {
  const hash = `#public=link0001.${'A'.repeat(43)}`
  const { browser } = browserAt(`/team/second/bundle/a/code${hash}`)
  let shown
  const restore = route => {
    const resolved = resolveManagedRoute(route, teams)
    if (!resolved) return false
    shown = resolved
    return managedRouteForIds(resolved, teams)
  }
  let nav = createManagedHistory(browser)
  await nav.start(restore)
  assert.equal(shown.bundleTab, 'code')
  assert.equal(shown.teamId, 'uuid-second')
  nav.replaceRoute(managedBundleRoute(teams, managedBundleEntry(a), shown.teamId, 'graph'))
  nav = createManagedHistory(browser)
  await nav.start(restore)
  assert.equal(shown.bundleTab, 'graph')
  await nav.navigate(managedBundleRoute(teams, managedBundleEntry(b), shown.teamId, shown.bundleTab))
  assert.equal(browser.location.pathname, '/team/second/bundle/b/graph')
  nav.replaceRoute(managedBundleRoute(teams, managedBundleEntry(b), shown.teamId, 'compare'))
  await nav.navigate(managedBundleRoute(teams, managedBundleEntry(a), shown.teamId, 'compare'))
  assert.equal(browser.location.pathname, '/team/second/bundle/a/compare')
  await browser.move(-1)
  assert.equal(shown.bundleId, b.id)
  assert.equal(shown.bundleTab, 'compare')
  await browser.move(1)
  assert.equal(shown.bundleId, a.id)
  assert.equal(shown.teamId, 'uuid-second')
  assert.equal(browser.location.hash, hash)
})

test('route rewrites locate the Code tab\'s file shown and its marked lines, or what a link asked for while its sources load', () => {
  const details = { kind: 'stasis', integrity: 'sha512-a', bundle: { sources: new Map([['src/z.js', 'z'], ['lib/a.js', 'a'], ['src/b.js', 'b']]) } }
  const state = { bundleDetailsTab: 'code', selectedBundle: 'sha512-a', bundleDetails: details, bundleSourceFile: 'src/z.js', bundleCodeFileRequest: null, bundleSourceTargetLine: null }
  assert.deepEqual(managedCodeLocation(state), { file: 3 }, 'numbered from 1 in path order')
  assert.deepEqual(managedCodeLocation({ ...state, bundleSourceFile: 'lib/a.js' }), { file: 1 })
  assert.equal(managedCodeLocation(state, 'graph'), null, 'only Code names a file')
  assert.equal(managedCodeLocation({ ...state, bundleSourceFile: null }), null)
  assert.equal(managedCodeLocation({ ...state, bundleSourceFile: 'gone.js' }), null)
  assert.equal(managedCodeLocation({ ...state, selectedBundle: 'sha512-b' }), null, 'never from another bundle\'s sources')
  const marked = { bundle: 'sha512-a', path: 'src/z.js', line: 4 }
  assert.deepEqual(managedCodeLocation({ ...state, bundleSourceTargetLine: marked }), { file: 3, line: 4 })
  assert.deepEqual(managedCodeLocation({ ...state, bundleSourceTargetLine: { ...marked, end: 9, anchor: 9 } }), { file: 3, line: 4, endLine: 9 })
  assert.deepEqual(managedCodeLocation({ ...state, bundleSourceTargetLine: { ...marked, path: 'src/b.js' } }), { file: 3 }, 'lines marked in another file')
  assert.deepEqual(managedCodeLocation({ ...state, bundleSourceTargetLine: { ...marked, bundle: 'sha512-b' } }), { file: 3 })
  const request = { bundle: 'sha512-a', file: 7, line: 2, endLine: 5 }
  assert.deepEqual(managedCodeLocation({ ...state, bundleSourceFile: null, bundleDetails: { ...details, metadataOnly: true }, bundleCodeFileRequest: request }), { file: 7, line: 2, endLine: 5 })
  assert.deepEqual(managedCodeLocation({ ...state, bundleCodeFileRequest: { ...request, bundle: 'sha512-b' } }), { file: 3 })
  assert.equal(managedCodeLocation({ ...state, bundleSourceFile: null, bundleDetails: { ...details, metadataOnly: true }, bundleCodeFileRequest: { bundle: 'sha512-a', path: 'src/z.js' } }), null,
    'a file asked for by path has no number while sources load, and its path never goes in a route')
})

test('Compare links name the bundle compared with by slug, then /code or /diff while it reviews the changes', () => {
  const entries = [managedBundleEntry(a), managedBundleEntry(b)]
  for (const team of [teams[0], null]) {
    const prefix = team ? `/team/${team.slug}` : '/manage'
    const route = mode => managedBundleRoute(teams, entries[0], team?.id, 'compare', { compareId: b.id, ...mode }, entries)
    assert.equal(managedRoutePath(route()), `${prefix}/bundle/a/compare/b`)
    assert.equal(managedRoutePath(route({ compareMode: 'code' })), `${prefix}/bundle/a/compare/b/code`)
    assert.deepEqual(resolveManagedRoute(parseManagedRoute(new URL(`${prefix}/bundle/a/compare/b/code`, 'https://triage.test')), teams, [a, b]),
      { view: 'bundles', bundleTab: 'compare', teamId: team?.id ?? null, bundleId: a.id, compareId: b.id, compareMode: 'code' })
    assert.equal(managedRoutePath(route({ compareMode: 'diff' })), `${prefix}/bundle/a/compare/b/diff`)
    assert.deepEqual(resolveManagedRoute(parseManagedRoute(new URL(`${prefix}/bundle/a/compare/b/diff`, 'https://triage.test')), teams, [a, b]),
      { view: 'bundles', bundleTab: 'compare', teamId: team?.id ?? null, bundleId: a.id, compareId: b.id, compareMode: 'diff' })
    assert.equal(managedRoutePath(route({ compareMode: 'split' })), `${prefix}/bundle/a/compare/b`, 'no mode it does not know')
  }
  assert.equal(managedRoutePath(managedBundleRoute(teams, entries[0], 'uuid-first', 'graph', { compareId: b.id }, entries)), '/team/first/bundle/a/graph',
    'only Compare names one')
  // One no longer listed, or a slug that names more than one, leaves the
  // bundle's Compare to pick again.
  assert.deepEqual(resolveManagedRoute(parseManagedRoute(new URL('/team/first/bundle/a/compare/gone/code', 'https://triage.test')), teams),
    { view: 'bundles', bundleTab: 'compare', teamId: 'uuid-first', bundleId: a.id })
  const ambiguous = [...teams, { id: 'uuid-ambiguous', slug: 'ambiguous', bundles: [{ id: 'different', slug: b.slug }] }]
  assert.deepEqual(resolveManagedRoute(parseManagedRoute(new URL('/team/first/bundle/a/compare/b', 'https://triage.test')), ambiguous),
    { view: 'bundles', bundleTab: 'compare', teamId: 'uuid-first', bundleId: a.id })
  assert.equal(managedRoutePath(managedBundleRoute(ambiguous, entries[0], 'uuid-first', 'compare', { compareId: b.id }, entries)), '/team/first/bundle/a/compare')
  assert.equal(managedRoutePath(managedBundleRoute(teams, entries[0], null, 'compare', { compareId: b.id })), '/manage/bundle/a/compare',
    'Manage names only bundles it was given')
  assert.equal(managedRoutePath({ view: 'bundles', bundleSlug: 'a', bundleTab: 'compare', compareSlug: '../b' }), null)
})

test('route rewrites locate Compare\'s bundle and mode for the open bundle only', () => {
  const entries = [managedBundleEntry(a), managedBundleEntry(b)]
  const state = { bundleDetailsTab: 'compare', selectedBundle: a.integrity, bundles: entries,
    bundleCompare: { bundle: a.integrity, target: b.integrity, mode: 'overview' } }
  assert.deepEqual(managedCompareLocation(state), { compareId: b.id })
  assert.deepEqual(managedCompareLocation({ ...state, bundleCompare: { ...state.bundleCompare, mode: 'code' } }), { compareId: b.id, compareMode: 'code' })
  assert.deepEqual(managedCompareLocation({ ...state, bundleCompare: { ...state.bundleCompare, mode: 'diff' } }), { compareId: b.id, compareMode: 'diff' })
  assert.deepEqual(managedTabLocation(state), { compareId: b.id })
  assert.equal(managedCompareLocation(state, 'code'), null, 'only Compare names one')
  assert.equal(managedCompareLocation({ ...state, selectedBundle: b.integrity }), null, 'never another bundle\'s')
  assert.equal(managedCompareLocation({ ...state, bundles: entries.slice(0, 1) }), null)
  assert.equal(managedCompareLocation({ ...state, bundles: [entries[0], { ...entries[1], repoId: 2 }] }), null,
    'nor one a refreshed catalogue moved to another repository, which Compare no longer offers')
  assert.equal(managedCompareLocation({ ...state, bundleCompare: null }), null)
})

test('a Compare link reloads to its bundle and mode, and Compare\'s own changes replace it', async () => {
  const { browser } = browserAt('/team/first/bundle/a/compare/b/code')
  let shown
  const nav = createManagedHistory(browser)
  await nav.start(route => {
    const resolved = resolveManagedRoute(route, teams)
    if (!resolved) return false
    shown = resolved
    return managedRouteForIds(resolved, teams)
  })
  assert.deepEqual(shown, { view: 'bundles', bundleTab: 'compare', teamId: 'uuid-first', bundleId: a.id, compareId: b.id, compareMode: 'code' })
  assert.equal(browser.location.pathname, '/team/first/bundle/a/compare/b/code')
  nav.replaceRoute(managedBundleRoute(teams, managedBundleEntry(a), 'uuid-first', 'compare', { compareId: b.id }))
  assert.equal(browser.location.pathname, '/team/first/bundle/a/compare/b')
  nav.replaceRoute(managedBundleRoute(teams, managedBundleEntry(a), 'uuid-first', 'compare'))
  assert.equal(browser.location.pathname, '/team/first/bundle/a/compare')
})

test('the shown managed bundle comes from its details, or its catalogue entry while they load', () => {
  const entry = { managedId: 'managed', integrity: 'sha512-managed' }, local = { integrity: 'sha512-local', name: 'local.map' }
  const shown = overrides => shownManagedBundleId({ currentView: 'bundles', selectedBundle: entry.integrity, bundles: [local, entry], bundleDetails: null, ...overrides })
  assert.equal(shown(), 'managed', 'before its metadata arrives')
  assert.equal(shown({ bundleDetails: { managedId: 'managed', integrity: entry.integrity } }), 'managed')
  assert.equal(shown({ bundleDetails: { integrity: local.integrity }, selectedBundle: local.integrity }), null, 'a local bundle')
  assert.equal(shown({ selectedBundle: local.integrity }), null)
  assert.equal(shown({ currentView: 'findings' }), null)
})
