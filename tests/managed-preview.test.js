import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { fetchReport, probeTeams } from '../client/managed/session.js'
import { managedRouteForIds, managedRoutePath, resolveManagedRoute } from '../common/managed/routes.js'
import { createManagedHistory } from '../ui/view/managed-history.js'
import { browserAt } from './_managed-browser.js'

test('managed preview triage persists in memory and stays scoped to the requested report', async (t) => {
  const previousPort = process.env.MANAGED_TEST_PORT
  const previousRole = process.env.MANAGED_TEST_ROLE
  process.env.MANAGED_TEST_PORT = '0'
  process.env.MANAGED_TEST_ROLE = 'admin'
  let start
  try {
    ;({ start } = await import('../server-managed/test-server.ts'))
  } finally {
    if (previousPort === undefined) delete process.env.MANAGED_TEST_PORT
    else process.env.MANAGED_TEST_PORT = previousPort
    if (previousRole === undefined) delete process.env.MANAGED_TEST_ROLE
    else process.env.MANAGED_TEST_ROLE = previousRole
  }
  const server = start()
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/api/reports`
  const results = await (await fetch(new URL('/api/admin/scan-results', base))).json()
  const exported = await (await fetch(new URL('/api/admin/reports', base))).json()
  assert.equal(results.bundles.length, 2)
  assert.equal(results.results.length, 5)
  assert.equal(results.results.every(result => results.bundles.some(bundle => bundle.id === result.bundleId)), true)
  assert.equal(results.results.some(result => exported.reports.some(report => report.id === result.id)), false)
  await t.test('preview history filters repositories and reports before pagination', async () => {
    const get = async params => (await fetch(new URL(`/api/admin/history?${params}`, base))).json()
    const first = await get('repo=example%2Fmanaged-fixtures&limit=1&page=2')
    assert.equal(first.total, 3)
    assert.equal(first.page, 2)
    assert.equal(first.history.length, 1)
    assert.equal(first.filters.repos.length, 2)
    assert.equal(first.filters.reports.length, 3)
    assert.equal(first.filters.reports.some(report => report.filename.endsWith('.stasis')), false)
    const report = await get('repo=example%2Fmanaged-fixtures&reportId=fixture-report-1&kind=triage')
    assert.equal(report.total, 1)
    assert.equal(report.history[0].reportId, 'fixture-report-1')
    assert.equal((await get('reportId=fixture-report-1&repo=example%2Fworker-service')).total, 0)
    assert.equal((await get('reportId=unknown')).total, 0)
  })
  await t.test('fixture slugs support managed team and report navigation', async fixtureTest => {
    const networkFetch = globalThis.fetch
    fixtureTest.mock.method(globalThis, 'fetch', (url, options) => networkFetch(new URL(url, base), options))
    const teams = await probeTeams()
    const admin = await (await fetch('/api/admin/teams')).json()
    assert.ok(teams.length > 0)
    const { browser } = browserAt('/')
    const nav = createManagedHistory(browser)
    let shown
    await nav.start(route => {
      shown = resolveManagedRoute(route, teams)
      return shown != null
    })
    for (const team of teams) {
      assert.ok(team.slug, team.id)
      assert.equal(team.slug, admin.teams.find(entry => entry.id === team.id).slug)
      for (const report of [null, ...team.reports]) {
        const internal = { view: 'findings', teamId: team.id, reportId: report?.id ?? null }
        const route = managedRouteForIds(internal, teams)
        assert.ok(route, report?.id ?? team.id)
        assert.equal(await nav.navigate(route), true)
        assert.equal(browser.location.pathname, managedRoutePath(route))
        assert.deepEqual(shown, internal)
        if (report) {
          assert.equal(report.slug, exported.reports.find(entry => entry.id === report.id).slug)
          assert.ok(await fetchReport(shown.reportId), 'navigation keeps the report API ID')
        }
      }
    }
  })
  await t.test('fixture reports support the real managed client and raw downloads', async (fixtureTest) => {
    const networkFetch = globalThis.fetch
    fixtureTest.mock.method(globalThis, 'fetch', (url, options) => networkFetch(new URL(url, base), options))
    for (const report of exported.reports) {
      const loaded = await fetchReport(report.id)
      assert.ok(loaded, report.filename)
      assert.deepEqual(loaded.repo, { github: report.repoFullName, directory: report.repoDirectory })
      assert.ok(JSON.parse(loaded.content).findings.length > 0)
      const raw = await fetch(`${base}/${report.id}`)
      assert.equal(raw.headers.get('content-type'), 'text/plain; charset=utf-8')
      assert.equal(raw.headers.get('vary'), 'Accept')
      assert.equal(await raw.text(), loaded.content)
      for (const accept of ['application/json, */*', 'application/json; q=1']) {
        const response = await fetch(`${base}/${report.id}`, { headers: { accept } })
        assert.equal(response.headers.get('cache-control'), 'no-store')
        assert.equal(response.headers.get('vary'), 'Accept')
        assert.deepEqual(await response.json(), loaded, accept)
      }
    }
    assert.equal(await fetchReport('unknown'), null)
  })
  const first = `${base}/fixture-report-1/triage`
  const second = `${base}/fixture-report-2/triage`
  const impactUrl = new URL('/api/admin/repositories/impact?repoId=101', base)
  const impact = await (await fetch(impactUrl)).json()
  assert.equal(impact.repoId, 101)
  assert.equal(impact.reports.length, 2)
  assert.equal(impact.bundles.length, 2)
  assert.equal(impact.triageCount, 1, 'the unattributed fixture comment is part of repository annotations')
  assert.equal((await fetch(new URL('/api/admin/repositories/impact?repoId=999', base))).status, 404)
  const post = (url, entries, token = 'fixture-csrf-token') => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify({ entries }),
  })
  assert.deepEqual(await (await fetch(first)).json(), { entries: {} })
  assert.equal((await post(first, { 'managed-fixture-1': { triage: 'fixed' } }, 'bad-token')).status, 403)
  assert.equal((await post(first, { 'managed-fixture-1': { triage: 'fixed' } })).status, 200)
  assert.equal((await (await fetch(impactUrl)).json()).triageCount, 1)
  assert.deepEqual(await (await fetch(first)).json(), { entries: { 'managed-fixture-1': { triage: 'fixed' } } })
  assert.deepEqual(await (await fetch(second)).json(), { entries: {} })
  assert.equal((await post(first, { 'managed-fixture-1': { color: 'red' }, foreign: null })).status, 404)
  assert.deepEqual(await (await fetch(first)).json(), { entries: { 'managed-fixture-1': { triage: 'fixed' } } }, 'a rejected batch changes nothing')
  assert.equal((await post(first, { 'managed-fixture-1': { triage: 'not-a-bucket' } })).status, 400)
  assert.equal((await post(first, { 'managed-fixture-1': null })).status, 200)
  assert.deepEqual(await (await fetch(first)).json(), { entries: { 'managed-fixture-1': null } })
  assert.equal((await fetch(`${base}/unknown/triage`)).status, 404)
})
