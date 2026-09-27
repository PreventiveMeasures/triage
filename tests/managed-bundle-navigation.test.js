import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BUNDLE_TABS } from '../common/bundle-tabs.js'
import { managedRouteForIds, managedRoutePath, parseManagedRoute, resolveManagedRoute } from '../common/managed/routes.js'
import { managedBundleEntry, managedBundleRoute, managedTeamBundleEntries } from '../ui/view/managed-bundle-navigation.js'
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
  }
  assert.equal(resolveManagedRoute({ view: 'bundles', teamSlug: 'first', bundleSlug: a.id }, teams), null, 'UUIDs are not slug aliases')
  assert.equal(resolveManagedRoute({ view: 'bundles', teamSlug: 'other', bundleSlug: a.slug }, teams), null, 'bundle must be in the clicked team')
  assert.equal(resolveManagedRoute({ view: 'bundles', teamSlug: 'missing', bundleSlug: a.slug }, teams), null)
  assert.equal(resolveManagedRoute({ view: 'bundles', teamSlug: 'first', bundleSlug: a.slug },
    [...teams, { id: 'ambiguous', slug: 'ambiguous', bundles: [{ id: 'different', slug: a.slug }] }]), null)
  assert.equal(resolveManagedRoute({ view: 'bundles', teamSlug: null, bundleSlug: a.slug }, teams), null, 'Manage requires its own authorized catalogue')
  for (const path of ['/team/first/bundle/a/invalid', '/team/first/bundle/%2F/code', '/team/first/bundle/a/code/extra', '/bundle/uuid-a']) {
    assert.equal(parseManagedRoute(new URL(path, 'https://triage.test')), null)
  }
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
