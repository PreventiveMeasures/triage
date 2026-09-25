import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { MANAGED_PAGES, managedRoutePath, parseManagedRoute } from '../common/managed/routes.js'
import { createManagedHistory } from '../ui/view/managed-history.js'

function browserAt(path = '/') {
  const entries = [{ url: new URL(path, 'https://triage.test'), state: null }]
  let index = 0, sequence = 0
  const listeners = new Map()
  const writes = []
  const saved = new Map()
  const browser = {
    get location() { return entries[index].url },
    crypto: { randomUUID: () => `generation-${++sequence}` },
    addEventListener: (event, listener) => listeners.set(event, listener),
    launchQueue: { setConsumer(consumer) { this.consume = consumer } },
    sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    history: {
      get state() { return entries[index].state },
      replaceState(state, _, url) { entries[index] = { state, url: new URL(url, browser.location) }; writes.push('replace') },
      pushState(state, _, url) { entries.splice(index + 1); entries.push({ state, url: new URL(url, browser.location) }); index++; writes.push('push') },
    },
    async move(delta) { index += delta; listeners.get('popstate')?.({ state: entries[index].state }); await setImmediate() },
    async hash(value) {
      entries[index].url.hash = value
      listeners.get('popstate')?.({ state: entries[index].state })
      listeners.get('hashchange')?.()
      await setImmediate()
    },
  }
  return { browser, entries, writes }
}

test('all managed pages and team/report Files routes round-trip', () => {
  const routes = [{ view: 'home' }, ...Object.keys(MANAGED_PAGES).map(view => ({ view })),
    { view: 'manage-history', actor: 'user name & repo' }]
  for (const view of ['findings', 'files']) for (const reportId of [null, 'report-id']) routes.push({ view, teamId: 'team-id', reportId })
  for (const route of routes) assert.deepEqual(parseManagedRoute(new URL(managedRoutePath(route), 'https://triage.test')), route)
  for (const path of ['/api/config', '/api/admin/users', '/manage/missing', '/teams/a/reports', '/teams/%2f', '/teams/%00', '/teams/%ff']) {
    assert.equal(parseManagedRoute(new URL(path, 'https://triage.test')), null, path)
  }
  assert.equal(managedRoutePath({ view: 'files', teamId: '../api' }), null)
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

test('deep-link boot replaces; user navigation pushes; Back/Forward and reload restore pages', async () => {
  const { browser, entries, writes } = browserAt('/manage/reports')
  let shown
  const restore = route => { shown = route; return true }
  let nav = createManagedHistory(browser)
  await nav.start(restore)
  assert.equal(shown.view, 'manage-reports')
  assert.deepEqual(writes, ['replace'])
  await nav.navigate({ view: 'manage-scans' })
  await nav.navigate({ view: 'manage-scans' })
  assert.equal(entries.length, 2, 'the same destination is not duplicated')
  await nav.navigate({ view: 'findings', teamId: 'a', reportId: 'b' })
  await browser.move(-1)
  assert.equal(shown.view, 'manage-scans')
  await browser.move(1)
  assert.equal(shown.reportId, 'b')
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
  const { browser } = browserAt('/teams/missing')
  const nav = createManagedHistory(browser)
  const pending = Promise.withResolvers()
  let shown
  await nav.start(async (route, current) => {
    if (route.teamId === 'missing') return false
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
  await nav.navigate({ view: 'findings', teamId: 'missing' })
  assert.equal(shown, 'home', 'a failed report click also leaves the URL and view consistent')
  assert.equal(browser.location.pathname, '/')
})

test('a Files fallback records the actual findings page', async () => {
  const { browser } = browserAt('/teams/a/files')
  const nav = createManagedHistory(browser)
  await nav.start(route => ({ ...route, view: 'findings' }))
  assert.equal(browser.location.pathname, '/teams/a')
})

test('managed finding links and E2E hints survive boot and resolve to the actual report route', async () => {
  for (const path of ['/teams/a/reports/b#finding=issue-id', '/#finding=issue-id&v=abcdefgh']) {
    const { browser } = browserAt(path)
    const nav = createManagedHistory(browser)
    let restored
    await nav.start(route => { restored = route; return { view: 'findings', teamId: 'a', reportId: 'b' } })
    assert.equal(restored.finding.id, 'issue-id')
    if (path.startsWith('/#')) assert.deepEqual(restored.finding, { id: 'issue-id', report: 'abcd', workspace: 'efgh' })
    else assert.equal(restored.reportId, 'b')
    assert.equal(browser.location.href, 'https://triage.test/teams/a/reports/b')
  }
})

test('finding hash navigation is handled once, supports repeat clicks, and preserves managed history', async () => {
  const { browser } = browserAt('/teams/a')
  const nav = createManagedHistory(browser)
  const findings = []
  await nav.start(route => { if (route.finding) findings.push(route.finding.id); return { view: 'findings', teamId: 'a', reportId: null } })
  await browser.hash('#finding=issue-id')
  await browser.hash('#finding=issue-id')
  assert.deepEqual(findings, ['issue-id', 'issue-id'])
  assert.ok(browser.history.state.deepviewManagedNavigation)
  assert.equal(browser.location.hash, '')
})

test('a finding destination survives the OAuth round trip and is consumed once', async () => {
  const { browser } = browserAt('/teams/a/reports/b#finding=issue-id')
  createManagedHistory(browser).rememberFinding()
  browser.history.replaceState(null, '', '/')
  const navigation = createManagedHistory(browser)
  navigation.reset({ force: false }) // initial managed-mode discovery
  let restored
  await navigation.start(route => { restored = route; return true })
  assert.equal(restored.finding.id, 'issue-id')
  assert.equal(restored.reportId, 'b')
  browser.history.replaceState(null, '', '/')
  await createManagedHistory(browser).start(route => { restored = route; return true })
  assert.deepEqual(restored, { view: 'home' })
})

test('PWA launches navigate only to same-origin managed pages', async () => {
  const { browser } = browserAt('/')
  let shown
  const nav = createManagedHistory(browser)
  await nav.start(route => { shown = route.view; return true })
  browser.launchQueue.consume({ targetURL: 'https://triage.test/manage/bundles' })
  await setImmediate()
  assert.equal(shown, 'manage-bundles')
  browser.launchQueue.consume({ targetURL: 'https://elsewhere.test/manage/users' })
  browser.launchQueue.consume({ targetURL: 'https://triage.test/api/admin/users' })
  await setImmediate()
  assert.equal(shown, 'manage-bundles')
})
