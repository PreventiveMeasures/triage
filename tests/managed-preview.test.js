import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'

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
