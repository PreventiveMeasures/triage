import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { MANAGED_PAGES, managedRoutePath, parseManagedRoute } from '../common/managed/routes.js'
import { createManagedHistory } from '../ui/view/managed-history.js'
import { browserAt } from './_managed-browser.js'

for (const id of ['link0001', 'legacy-team-id']) {
  test(`public capability ${id} stays in the fragment across navigation, history and reload`, async () => {
    const hash = `#public=${id}.${'A'.repeat(43)}`
    const { browser, entries } = browserAt(`/team/team${hash}`)
    let nav = createManagedHistory(browser)
    await nav.start(() => true)
    await nav.navigate({ view: 'files', teamSlug: 'team' })
    await nav.navigate({ view: 'files', teamSlug: 'team' })
    assert.equal(entries.length, 2)
    assert.equal(browser.location.hash, hash)
    assert.equal(browser.location.search, '')
    await browser.move(-1)
    assert.equal(browser.location.hash, hash)
    nav = createManagedHistory(browser)
    await nav.start(() => true)
    await nav.navigate({ view: 'bundles', teamSlug: 'team', bundleSlug: 'bundle', bundleTab: 'code' })
    assert.equal(browser.location.hash, hash)
    assert.equal(browser.location.pathname, '/team/team/bundle/bundle/code')
  })
}

test('pasting a new public fragment cannot restore the previous credential before reload', async () => {
  for (const initial of ['', `#public=legacy-team.${'A'.repeat(43)}`]) {
    const { browser, writes } = browserAt(`/team/team${initial}`)
    const nav = createManagedHistory(browser), pending = Promise.withResolvers()
    let restores = 0
    await nav.start(route => { restores++; return route.view === 'files' ? pending.promise : true })
    const load = nav.navigate({ view: 'files', teamSlug: 'team' })
    const hash = `#public=link0002.${'B'.repeat(43)}`
    const count = writes.length
    await browser.hash(hash)
    pending.resolve(true)
    assert.equal(await load, false)
    assert.equal(restores, 2, 'popstate must not restore the old workspace')
    assert.equal(browser.location.hash, hash)
    assert.equal(writes.length, count)
    assert.equal(await nav.navigate({ view: 'home' }), false)
    await browser.hash('#public=malformed')
    nav.reset()
    assert.equal(browser.location.hash, '#public=malformed', 'invalid links also reload and fail closed')
  }
})

test('all managed pages and team/report Files routes round-trip', () => {
  const routes = [{ view: 'bundles', teamSlug: 'team', bundleSlug: 'bundle-id', bundleTab: 'overview' }, { view: 'home' }, ...Object.keys(MANAGED_PAGES).map(view => ({ view })),
    { view: 'manage-history', actor: 'user name & repo' }, { view: 'manage-scans', bundleId: 'bundle-id' }]
  for (const view of ['findings', 'files']) for (const reportSlug of [null, 'report-id']) routes.push({ view, teamSlug: 'team-id', reportSlug })
  for (const route of routes) assert.deepEqual(parseManagedRoute(new URL(managedRoutePath(route), 'https://triage.test')), route)
  for (const path of ['/bundles', '/bundles/%2f', '/bundles/../api/config', '/api/config', '/api/admin/users', '/manage/missing', '/teams/a/reports', '/teams/%2f', '/teams/%00', '/teams/%ff']) {
    assert.equal(parseManagedRoute(new URL(path, 'https://triage.test')), null, path)
  }
  assert.equal(managedRoutePath({ view: 'files', teamSlug: '../api' }), null)
})

test('E2E creates no history entries or navigation listeners', async () => {
  const { browser, writes } = browserAt('/?e2e=1#workspace-secret')
  const nav = createManagedHistory(browser)
  assert.equal(await nav.navigate({ view: 'manage' }), false)
  nav.reset()
  assert.equal(browser.location.href, 'https://triage.test/?e2e=1#workspace-secret')
  assert.deepEqual(writes, [])
  assert.equal(browser.launchQueue.consume, undefined)
})

test('finding paths round-trip encoded IDs only under a team or report', () => {
  for (const reportSlug of [null, 'report']) {
    for (const id of ['issue-id', 'https://example.test/finding/a?x=1&y=two#detail', 'issue /%?# é', '界'.repeat(512)]) {
      const route = { view: 'findings', teamSlug: 'team', reportSlug, finding: { id } }
      const path = managedRoutePath(route)
      assert.equal(path, `/team/team${reportSlug ? '/report/report' : ''}/finding/${encodeURIComponent(id)}`)
      assert.deepEqual(parseManagedRoute(new URL(path, 'https://triage.test')), route)
    }
  }
  for (const suffix of ['', '42', '%00issue', '%ff', '%', 'a/b', encodeURIComponent('x'.repeat(513))]) {
    assert.equal(parseManagedRoute(new URL(`/team/t/finding/${suffix}`, 'https://triage.test')), null, suffix)
  }
  for (const id of ['', '42', '.', '..', '\nissue', 'x'.repeat(513), '\uD800']) {
    assert.equal(managedRoutePath({ view: 'findings', teamSlug: 't', finding: { id } }), null)
  }
  for (const path of ['/finding/issue', '/report/r/finding/issue', '/team/t/files/finding/issue', '/team/t/bundle/b/finding/issue', '/manage/finding/issue']) {
    assert.equal(parseManagedRoute(new URL(path, 'https://triage.test')), null, path)
  }
})

test('obsolete managed URLs use the same home fallback as unknown pages', async () => {
  for (const path of ['/teams/a', '/teams/a/reports/b#finding=issue-id', '/teams/a/bundles/c/code', '/team/a/reports/b', '/team/a/bundles/c', '/manage/teams', '/manage/reports', '/manage/bundles/c', '/unknown']) {
    const { browser } = browserAt(path)
    let restored
    const nav = createManagedHistory(browser)
    await nav.start(route => { restored = route; return true })
    assert.deepEqual(restored, { view: 'home' }, path)
    assert.equal(browser.location.href, 'https://triage.test/')
    assert.equal(await browser.click(path), false, 'unknown comment links are not intercepted')
  }
})

test('public finding navigation preserves the capability fragment on boot, clicks and reload', async () => {
  const hash = `#public=link0001.${'A'.repeat(43)}`
  const { browser } = browserAt(`/team/a/finding/issue-id${hash}`)
  let restored
  let nav = createManagedHistory(browser)
  const restore = route => { restored = route; return true }
  await nav.start(restore)
  assert.equal(restored.finding.id, 'issue-id')
  assert.equal(browser.location.hash, hash)
  await browser.click('/team/a/report/b/finding/another-id')
  assert.equal(restored.finding.id, 'another-id')
  assert.equal(browser.location.hash, hash)
  nav = createManagedHistory(browser)
  await nav.start(restore)
  assert.equal(restored.reportSlug, 'b')
  assert.equal(restored.finding.id, 'another-id')
  assert.equal(browser.location.hash, hash)
})

test('E2E hints survive OAuth before resolving to a managed destination', async () => {
  const { browser } = browserAt('/#finding=issue-id&v=abcdefgh')
  createManagedHistory(browser).rememberFinding()
  browser.history.replaceState(null, '', '/')
  let restored
  await createManagedHistory(browser).start(route => { restored = route; return true })
  assert.deepEqual(restored, { view: 'home', finding: { id: 'issue-id', report: 'abcd', workspace: 'efgh' } })
})

test('deep-link boot replaces; user navigation pushes; Back/Forward and reload restore pages', async () => {
  const { browser, entries, writes } = browserAt('/manage/report')
  let shown
  const restore = route => { shown = route; return true }
  let nav = createManagedHistory(browser)
  await nav.start(restore)
  assert.equal(shown.view, 'manage-reports')
  assert.deepEqual(writes, ['replace'])
  await nav.navigate({ view: 'manage-scans' })
  await nav.navigate({ view: 'manage-scans' })
  assert.equal(entries.length, 2, 'the same destination is not duplicated')
  await nav.navigate({ view: 'findings', teamSlug: 'a', reportSlug: 'b' })
  await browser.move(-1)
  assert.equal(shown.view, 'manage-scans')
  await browser.move(1)
  assert.equal(shown.reportSlug, 'b')
  assert.equal(entries.length, 3, 'popstate never pushes')
  nav = createManagedHistory(browser) // new document, same browser history
  await nav.start(restore)
  await browser.move(-1)
  assert.equal(shown.view, 'manage-scans', 'earlier entries work after reload')
})

test('mode reset invalidates old entries and prevents stale page loads or PWA launches', async () => {
  const { browser, entries } = browserAt('/')
  const nav = createManagedHistory(browser)
  let shown = 'e2e'
  const pending = Promise.withResolvers()
  const restore = async (route, current) => {
    if (route.view === 'manage-scans') await pending.promise
    if (current()) shown = route.view
    return true
  }
  await nav.start(restore)
  await nav.navigate({ view: 'manage-reports' })
  const load = nav.navigate({ view: 'manage-scans' })
  nav.reset()
  shown = 'e2e'
  pending.resolve()
  await load
  assert.equal(shown, 'e2e')
  assert.equal(browser.location.pathname, '/')
  browser.launchQueue.consume({ targetURL: 'https://triage.test/manage/users' })
  await browser.move(-1)
  assert.equal(shown, 'e2e')
  assert.equal(browser.location.pathname, '/')
  await nav.start(restore)
  await browser.move(1)
  assert.equal(shown, 'home', 'old managed entries cannot reactivate their pages')
  assert.equal(entries.length, 2)
})

test('latest navigation wins; inaccessible deep links fall back to Home', async () => {
  const { browser } = browserAt('/team/missing')
  const nav = createManagedHistory(browser)
  const pending = Promise.withResolvers()
  let shown
  await nav.start(async (route, current) => {
    if (route.teamSlug === 'missing') return false
    if (route.view === 'manage-reports') await pending.promise
    if (current()) shown = route.view
    return true
  })
  assert.equal(shown, 'home')
  assert.equal(browser.location.pathname, '/')
  const slow = nav.navigate({ view: 'manage-reports' })
  await nav.navigate({ view: 'manage' })
  pending.resolve()
  await slow
  assert.equal(shown, 'manage')
  assert.equal(browser.location.pathname, '/manage')
  await nav.navigate({ view: 'findings', teamSlug: 'missing' })
  assert.equal(shown, 'home', 'a failed report click also leaves the URL and view consistent')
  assert.equal(browser.location.pathname, '/')
})

test('a Files fallback records the actual findings page', async () => {
  const { browser } = browserAt('/team/a/files')
  const nav = createManagedHistory(browser)
  await nav.start(route => ({ ...route, view: 'findings' }))
  assert.equal(browser.location.pathname, '/team/a')
})

test('managed finding links and E2E hints survive boot and resolve to the actual report route', async () => {
  for (const path of ['/team/a/report/b/finding/issue-id', '/#finding=issue-id&v=abcdefgh']) {
    const { browser } = browserAt(path)
    const nav = createManagedHistory(browser)
    let restored
    await nav.start(route => { restored = route; return { view: 'findings', teamSlug: 'a', reportSlug: 'b', finding: { id: route.finding.id } } })
    assert.equal(restored.finding.id, 'issue-id')
    if (path.startsWith('/#')) assert.deepEqual(restored.finding, { id: 'issue-id', report: 'abcd', workspace: 'efgh' })
    else assert.equal(restored.reportSlug, 'b')
    assert.equal(browser.location.href, 'https://triage.test/team/a/report/b/finding/issue-id')
  }
})

test('E2E finding hash navigation is handled once and repeat comment clicks still reveal it', async () => {
  const { browser } = browserAt('/')
  const nav = createManagedHistory(browser)
  const findings = []
  await nav.start(route => {
    if (!route.finding) return true
    findings.push(route.finding.id)
    return { view: 'findings', teamSlug: 'a', reportSlug: null, finding: { id: route.finding.id } }
  })
  await browser.hash('#finding=issue-id')
  assert.equal(await browser.click('/#finding=issue-id'), true)
  assert.deepEqual(findings, ['issue-id', 'issue-id'])
  assert.ok(browser.history.state.deepviewManagedNavigation)
  assert.equal(browser.location.hash, '')
})

test('comment finding links navigate in the same document and retain Back/Forward history', async () => {
  const { browser, entries, writes } = browserAt('/team/a/report/first')
  const nav = createManagedHistory(browser)
  let restored
  await nav.start(route => { restored = route; return true })
  const href = '/team/b/report/second/finding/issue-id'
  assert.equal(await browser.click(href), true, 'cancel native document navigation')
  assert.deepEqual(restored, { view: 'findings', teamSlug: 'b', reportSlug: 'second', finding: { id: 'issue-id' } })
  assert.equal(browser.location.pathname, '/team/b/report/second/finding/issue-id')
  assert.equal(browser.location.hash, '')
  assert.deepEqual(writes, ['replace', 'push'])
  assert.equal(await browser.click(href), true)
  assert.equal(entries.length, 2, 'repeat clicks reveal the finding without duplicating history')
  await browser.move(-1)
  assert.equal(restored.reportSlug, 'first')
  await browser.move(1)
  assert.equal(restored.reportSlug, 'second')
  assert.equal(restored.finding.id, 'issue-id')
  await createManagedHistory(browser).start(route => { restored = route; return true })
  assert.equal(restored.finding.id, 'issue-id', 'reload reveals the same finding')
})

test('comment routing preserves native link actions and stops intercepting in E2E mode', async () => {
  const { browser, writes } = browserAt('/team/a')
  const nav = createManagedHistory(browser)
  let restores = 0
  await nav.start(() => { restores++; return true })
  const href = '/team/b/finding/issue-id'
  for (const options of [{ button: 1 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { target: '_blank' }, { download: true }, { self: false }]) {
    assert.equal(await browser.click(href, options), false)
  }
  await browser.click(href, { defaultPrevented: true })
  assert.equal(await browser.click('https://elsewhere.test/team/b/finding/issue-id'), false)
  assert.equal(await browser.click('/team/b'), false)
  assert.equal(restores, 1)
  assert.deepEqual(writes, ['replace'])
  nav.reset()
  assert.equal(await browser.click(href), false)
  assert.equal(restores, 1)
})

test('a finding destination survives the OAuth round trip and is consumed once', async () => {
  const { browser } = browserAt('/team/a/report/b/finding/issue-id')
  createManagedHistory(browser).rememberFinding()
  browser.history.replaceState(null, '', '/')
  const navigation = createManagedHistory(browser)
  navigation.reset({ force: false }) // initial managed-mode discovery
  let restored
  await navigation.start(route => { restored = route; return true })
  assert.equal(restored.finding.id, 'issue-id')
  assert.equal(restored.reportSlug, 'b')
  browser.history.replaceState(null, '', '/')
  await createManagedHistory(browser).start(route => { restored = route; return true })
  assert.deepEqual(restored, { view: 'home' })
})

test('PWA launches navigate only to same-origin managed pages', async () => {
  const { browser } = browserAt('/')
  let shown
  const nav = createManagedHistory(browser)
  await nav.start(route => { shown = route.view; return true })
  browser.launchQueue.consume({ targetURL: 'https://triage.test/manage/bundle' })
  await setImmediate()
  assert.equal(shown, 'manage-bundles')
  browser.launchQueue.consume({ targetURL: 'https://elsewhere.test/manage/users' })
  browser.launchQueue.consume({ targetURL: 'https://triage.test/api/admin/users' })
  await setImmediate()
  assert.equal(shown, 'manage-bundles')
})
