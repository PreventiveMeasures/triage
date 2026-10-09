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
  const routes = [{ view: 'bundles', teamSlug: 'team', bundleSlug: 'bundle-id', bundleTab: 'overview' }, { view: 'home' },
    { view: 'bundles', teamSlug: 'team', bundleSlug: 'bundle-id', bundleTab: 'code', file: 7 }, { view: 'bundles', teamSlug: null, bundleSlug: 'bundle-id', bundleTab: 'code', file: 1 },
    { view: 'bundles', teamSlug: 'team', bundleSlug: 'bundle-id', bundleTab: 'code', file: 7, line: 42 }, { view: 'bundles', teamSlug: null, bundleSlug: 'bundle-id', bundleTab: 'code', file: 1, line: 42, endLine: 69 }, ...Object.keys(MANAGED_PAGES).map(view => ({ view })),
    { view: 'manage-history', actor: 'user name & repo' }, { view: 'manage-scans', bundleId: 'bundle-id' }, { view: 'manage-scans', bundleId: 'bundle-id', scanMode: 'dependencies' }, { view: 'manage-scans', scanMode: 'link' }, { view: 'manage-bundles', createRepoId: 106 }]
  for (const view of ['findings', 'files']) for (const reportSlug of [null, 'report-id']) routes.push({ view, teamSlug: 'team-id', reportSlug })
  for (const route of routes) assert.deepEqual(parseManagedRoute(new URL(managedRoutePath(route), 'https://triage.test')), route)
  for (const path of ['/bundles', '/bundles/%2f', '/bundles/../api/config', '/api/config', '/api/admin/users', '/manage/missing', '/teams/a/reports', '/teams/%2f', '/teams/%00', '/teams/%ff',
    '/team/a/bundle/b/graph/3', '/team/a/bundle/b/code/0', '/team/a/bundle/b/code/03', '/team/a/bundle/b/code/9007199254740992', '/team/a/bundle/b/code/src', '/team/a/bundle/b/code/src%2Findex.js', '/manage/bundle/b/code/1/2']) {
    assert.equal(parseManagedRoute(new URL(path, 'https://triage.test')), null, path)
  }
  assert.equal(managedRoutePath({ view: 'files', teamSlug: '../api' }), null)
  assert.equal(managedRoutePath({ view: 'bundles', teamSlug: 't', bundleSlug: 'b', bundleTab: 'graph', file: 3 }), '/team/t/bundle/b/graph', 'only Code names a file')
  assert.equal(managedRoutePath({ view: 'bundles', teamSlug: 't', bundleSlug: 'b', bundleTab: 'code', file: 0 }), '/team/t/bundle/b/code')
  // Lines go in the fragment, only with a file: reversed ranges read in order,
  // and a fragment that is not a line link marks none.
  const code = path => parseManagedRoute(new URL(path, 'https://triage.test'))
  assert.deepEqual(code('/team/t/bundle/b/code/3#L69-L42'), { view: 'bundles', teamSlug: 't', bundleSlug: 'b', bundleTab: 'code', file: 3, line: 42, endLine: 69 })
  assert.deepEqual(code('/team/t/bundle/b/code/3#L7-L7'), { view: 'bundles', teamSlug: 't', bundleSlug: 'b', bundleTab: 'code', file: 3, line: 7 })
  for (const hash of ['#L0', '#L4-', '#L-4', '#l4', '#L4-L0', '#L9007199254740992', '#finding=x', '#L4&L5']) {
    assert.deepEqual(code(`/team/t/bundle/b/code/3${hash}`), { view: 'bundles', teamSlug: 't', bundleSlug: 'b', bundleTab: 'code', file: 3 }, hash)
  }
  assert.deepEqual(code('/team/t/bundle/b/code#L4'), { view: 'bundles', teamSlug: 't', bundleSlug: 'b', bundleTab: 'code' }, 'lines need a file')
  assert.equal(managedRoutePath({ view: 'bundles', teamSlug: 't', bundleSlug: 'b', bundleTab: 'code', line: 4 }), '/team/t/bundle/b/code')
})

test('managed deduplication details round-trip through history', () => {
  const route = { view: 'manage-deduplication', linkId: 'a-link-report' }
  assert.deepEqual(parseManagedRoute(new URL(managedRoutePath(route), 'https://triage.test')), route)
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

test('finding selection replaces the current entry through open, navigation and close', async () => {
  for (const reportSlug of [null, 'report']) {
    const base = { view: 'findings', teamSlug: 'team', reportSlug }
    const path = managedRoutePath(base)
    const hash = `#public=link0001.${'A'.repeat(43)}`
    const { browser, entries, writes } = browserAt(path + hash)
    const nav = createManagedHistory(browser)
    let restores = 0
    await nav.start(() => { restores++; return true })
    for (const id of ['first-id', 'another /?# é']) {
      const selected = { ...base, finding: { id } }
      nav.replaceFindingRoute(selected)
      assert.equal(browser.location.pathname, managedRoutePath(selected))
      assert.equal(browser.location.hash, hash)
      const count = writes.length
      nav.replaceFindingRoute(selected)
      assert.equal(writes.length, count, 'repainting the same selection does not write history')
    }
    nav.replaceFindingRoute(base)
    assert.equal(browser.location.pathname, path, 'closing details or entering a list clears the suffix')
    assert.equal(browser.location.hash, hash)
    assert.equal(restores, 1, 'selection must not reload the report')
    assert.equal(entries.length, 1, 'individual selections do not fill Back history')
    nav.replaceFindingRoute({ ...base, teamSlug: 'other', finding: { id: 'stale-id' } })
    assert.equal(browser.location.pathname, path, 'late paints cannot switch teams')
    nav.reset()
    const count = writes.length
    nav.replaceFindingRoute({ ...base, finding: { id: 'stale-id' } })
    assert.equal(writes.length, count, 'E2E/local mode ignores managed selection')
  }
})

test('rendered selections wait for navigation to commit and retain the departing finding on Back', async () => {
  const first = { view: 'findings', teamSlug: 'team', reportSlug: 'first', finding: { id: 'first-id' } }
  const second = { ...first, reportSlug: 'second', finding: { id: 'second-id' } }
  const { browser, entries } = browserAt(managedRoutePath(first))
  const nav = createManagedHistory(browser)
  const pending = Promise.withResolvers()
  let loading = false
  await nav.start(async route => {
    if (loading) {
      nav.replaceFindingRoute(second)
      assert.equal(browser.location.pathname, managedRoutePath(first), 'incoming paint cannot overwrite departing history')
      await pending.promise
    } else nav.replaceFindingRoute(route)
    return true
  })
  loading = true
  const navigation = nav.navigate({ ...second, finding: undefined })
  pending.resolve()
  await navigation
  assert.equal(browser.location.pathname, managedRoutePath(second), 'Focus default is committed with its report')
  assert.equal(entries.length, 2)
  loading = false
  await browser.move(-1)
  assert.equal(browser.location.pathname, managedRoutePath(first))
  await browser.move(1)
  assert.equal(browser.location.pathname, managedRoutePath(second))
})

test('deep-link restoration keeps the final revealed selection, including E2E hash resolution', async () => {
  for (const path of ['/team/team/report/report/finding/linked-id', '/#finding=linked-id']) {
    const { browser } = browserAt(path)
    const nav = createManagedHistory(browser)
    const canonical = { view: 'findings', teamSlug: 'team', reportSlug: 'report', finding: { id: 'linked-id' } }
    await nav.start(() => {
      nav.replaceFindingRoute({ ...canonical, finding: { id: 'default-id' } })
      nav.replaceFindingRoute(canonical)
      return canonical
    })
    assert.equal(browser.location.pathname, managedRoutePath(canonical))
  }
})

test('failed or superseded navigation cannot publish a pending finding selection', async () => {
  const { browser } = browserAt('/team/team')
  const nav = createManagedHistory(browser)
  const pending = Promise.withResolvers()
  await nav.start(async route => {
    if (route.reportSlug) {
      nav.replaceFindingRoute({ ...route, finding: { id: 'pending-id' } })
      if (route.reportSlug === 'slow') await pending.promise
      return route.reportSlug !== 'missing'
    }
    return true
  })
  await nav.navigate({ view: 'findings', teamSlug: 'team', reportSlug: 'missing' })
  assert.equal(browser.location.pathname, '/')
  const slow = nav.navigate({ view: 'findings', teamSlug: 'team', reportSlug: 'slow' })
  await nav.navigate({ view: 'manage' })
  pending.resolve()
  assert.equal(await slow, false)
  assert.equal(browser.location.pathname, '/manage')
})

test('the Code tab replaces its file in place, so Back leaves the bundle rather than stepping through files', async () => {
  const report = { view: 'findings', teamSlug: 'team', reportSlug: 'report' }
  const code = { view: 'bundles', teamSlug: 'team', bundleSlug: 'bundle', bundleTab: 'code' }
  const { browser, entries } = browserAt(managedRoutePath(report))
  const nav = createManagedHistory(browser)
  await nav.start(() => true)
  await nav.navigate(code)
  for (const file of [3, 5, 1]) {
    nav.replaceCodeRoute({ ...code, file })
    assert.equal(browser.location.pathname, `/team/team/bundle/bundle/code/${file}`)
  }
  assert.equal(entries.length, 2, 'files do not fill Back history')
  nav.replaceCodeRoute({ ...code, bundleSlug: 'other', file: 9 })
  nav.replaceCodeRoute({ ...code, teamSlug: null, file: 9 })
  assert.equal(browser.location.pathname, '/team/team/bundle/bundle/code/1', 'late paints cannot switch bundles')
  nav.replaceRoute({ ...code, bundleTab: 'graph' })
  nav.replaceCodeRoute({ ...code, file: 9 })
  assert.equal(browser.location.pathname, '/team/team/bundle/bundle/graph', 'or bring back a tab that was left')
  await browser.move(-1)
  assert.equal(browser.location.pathname, managedRoutePath(report))
})

test('a Code link commits the file the tab shows once it opens, without touching the page it leaves', async () => {
  const report = { view: 'findings', teamSlug: 'team', reportSlug: 'report' }
  const code = { view: 'bundles', teamSlug: null, bundleSlug: 'bundle', bundleTab: 'code' }
  const { browser, entries } = browserAt(managedRoutePath(report))
  const nav = createManagedHistory(browser)
  let opening = false
  await nav.start(route => {
    if (!opening) return true
    // A number past the last file falls back to the tab's own pick.
    nav.replaceCodeRoute({ ...code, file: 2 })
    assert.equal(browser.location.pathname, managedRoutePath(report), 'the departing entry stays as it was')
    return route
  })
  opening = true
  await nav.navigate({ ...code, file: 99 })
  assert.equal(browser.location.pathname, '/manage/bundle/bundle/code/2')
  assert.equal(entries.length, 2)
})

test('a public share keeps the capability as the only fragment, dropping line links', async () => {
  const hash = `#public=link0001.${'A'.repeat(43)}`
  const { browser } = browserAt(`/team/team/bundle/bundle/code/2${hash}`)
  const nav = createManagedHistory(browser)
  await nav.start(() => true)
  nav.replaceCodeRoute({ view: 'bundles', teamSlug: 'team', bundleSlug: 'bundle', bundleTab: 'code', file: 2, line: 5 })
  assert.equal(browser.location.pathname, '/team/team/bundle/bundle/code/2')
  assert.equal(browser.location.hash, hash)
})

test('marked lines replace the entry, and a pasted line link to the open file keeps the page', async () => {
  const report = { view: 'findings', teamSlug: 'team', reportSlug: 'report' }
  const code = { view: 'bundles', teamSlug: 'team', bundleSlug: 'bundle', bundleTab: 'code', file: 3 }
  const { browser, entries } = browserAt(managedRoutePath(report))
  const nav = createManagedHistory(browser)
  let restores = 0
  await nav.start(() => { restores++; return true })
  await nav.navigate(code)
  for (const lines of [{ line: 4 }, { line: 4, endLine: 9 }, {}]) {
    nav.replaceCodeRoute({ ...code, ...lines })
    assert.equal(browser.location.pathname + browser.location.hash, managedRoutePath({ ...code, ...lines }))
  }
  assert.equal(entries.length, 2, 'marking lines adds no Back entries')
  await browser.fragment('#L12-L20')
  assert.equal(restores, 2, 'the bundle is not reopened')
  assert.equal(browser.location.pathname + browser.location.hash, `${managedRoutePath(code)}#L12-L20`)
  assert.ok(browser.history.state, 'the entry is adopted')
  await browser.fragment('#something-else')
  assert.equal(restores, 2, 'any fragment over the open file keeps the page')
  assert.equal(browser.location.pathname + browser.location.hash, managedRoutePath(code), 'and marks no lines')
})
