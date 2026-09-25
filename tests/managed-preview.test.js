import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { fetchReport } from '../client/managed/session.js'

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
  assert.equal(impact.triageCount, 0)
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
