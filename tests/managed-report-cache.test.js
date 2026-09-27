import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { fetchReport, fetchReports, fetchTeamReports } from '../ui/managed/report-data.js'
import { managedAppState, resetManagedAppState, setManagedAppSession, setManagedReportCatalog } from '../ui/managed/state.js'

const content = id => ({ data: { findings: [{ id }] }, repo: { github: 'org/repo', directory: '' } })
const session = { id: 'viewer', role: 'view' }
beforeEach(t => {
  resetManagedAppState()
  setManagedAppSession(session)
  t.mock.method(managedAppState, 'notify', () => {})
})

function network(t) {
  return t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(options.credentials, 'same-origin')
    if (url === '/api/reports/query') {
      assert.equal(options.method, 'POST')
      return Promise.resolve(Response.json({ reports: JSON.parse(options.body).ids.map(id => ({ id, ...content(id) })) }))
    }
    return Promise.resolve(Response.json(content(decodeURIComponent(url.slice('/api/reports/'.length)))))
  })
}

test('identical individual report queries reuse completed content without persisting it', async t => {
  const calls = network(t)
  assert.deepEqual(await fetchReport('a'), content('a'))
  assert.deepEqual(await fetchReport('a'), content('a'))
  assert.equal(calls.mock.callCount(), 1)
  assert.equal(calls.mock.calls[0].arguments[0], '/api/reports/a')
  setManagedAppSession({ ...session, csrfToken: 'rotated' })
  await fetchReport('a')
  assert.equal(calls.mock.callCount(), 1, 'token rotation keeps the same account cache')
})

test('workspace queries batch all missing reports and share results with individual navigation', async t => {
  const calls = network(t)
  assert.deepEqual(await fetchReports(['b', 'a', 'b']), [content('b'), content('a'), content('b')])
  assert.equal(calls.mock.callCount(), 1)
  assert.deepEqual(JSON.parse(calls.mock.calls[0].arguments[1].body).ids, ['a', 'b'])
  await fetchReport('a')
  await fetchReports(['a', 'b'])
  assert.equal(calls.mock.callCount(), 1)
  await fetchReports(['a', 'b', 'c', 'd'])
  assert.equal(calls.mock.callCount(), 2)
  assert.deepEqual(JSON.parse(calls.mock.calls[1].arguments[1].body).ids, ['c', 'd'])
  assert.deepEqual(await fetchReports([]), [])
  assert.equal(calls.mock.callCount(), 2)
})

test('overlapping workspace and report clicks share in-flight requests', async t => {
  let resolve
  const calls = t.mock.method(globalThis, 'fetch', () => new Promise(done => { resolve = done }))
  const workspace = fetchReports(['a', 'b'])
  const repeated = fetchReports(['b', 'a'])
  const report = fetchReport('b')
  assert.equal(calls.mock.callCount(), 1)
  resolve(Response.json({ reports: ['a', 'b'].map(id => ({ id, ...content(id) })) }))
  assert.deepEqual(await workspace, [content('a'), content('b')])
  assert.deepEqual(await repeated, [content('b'), content('a')])
  assert.deepEqual(await report, content('b'))
})

test('a pending individual read is excluded from a concurrent workspace batch', async t => {
  let resolve
  const calls = t.mock.method(globalThis, 'fetch', (url, options) => url === '/api/reports/a'
    ? new Promise(done => { resolve = done })
    : Promise.resolve(Response.json({ reports: JSON.parse(options.body).ids.map(id => ({ id, ...content(id) })) })))
  const report = fetchReport('a')
  const workspace = fetchReports(['a', 'b'])
  assert.deepEqual(JSON.parse(calls.mock.calls[1].arguments[1].body).ids, ['b'])
  resolve(Response.json(content('a')))
  await report
  assert.deepEqual(await workspace, [content('a'), content('b')])
})

test('failed or incomplete responses are not cached and can be retried', async t => {
  let response = new Response(null, { status: 503 })
  const calls = t.mock.method(globalThis, 'fetch', () => Promise.resolve(response))
  assert.equal(await fetchReport('a'), null)
  response = Response.json(content('a'))
  assert.deepEqual(await fetchReport('a'), content('a'))
  response = Response.json({ reports: [{ id: 'b', ...content('b') }] })
  assert.equal(await fetchReports(['b', 'c']), null)
  response = Response.json({ reports: ['b', 'c'].map(id => ({ id, ...content(id) })) })
  assert.deepEqual(await fetchReports(['b', 'c']), [content('b'), content('c')])
  assert.equal(calls.mock.callCount(), 4)
})

test('role/account changes, logout, mode resets and report mutations discard cached content', async t => {
  const calls = network(t)
  for (const change of [
    () => setManagedAppSession({ ...session, role: 'triage' }),
    () => setManagedAppSession({ id: 'other', role: 'triage' }),
    () => setManagedAppSession(null),
    () => resetManagedAppState(),
    () => managedAppState.invalidate(['reports']),
  ]) {
    await fetchReport('a')
    const before = calls.mock.callCount()
    change()
    await fetchReport('a')
    assert.equal(calls.mock.callCount(), before + 1)
  }
})

test('late responses cannot restore content after session reset or report invalidation', async t => {
  for (const reset of [resetManagedAppState, () => managedAppState.invalidate(['reports'])]) {
    let resolve
    const calls = t.mock.method(globalThis, 'fetch', () => new Promise(done => { resolve = done }))
    const loading = fetchReports(['a', 'b'])
    reset()
    assert.equal(calls.mock.calls[0].arguments[1].signal.aborted, true)
    resolve(Response.json({ reports: ['a', 'b'].map(id => ({ id, ...content(id) })) }))
    assert.equal(await loading, null)
    assert.equal(managedAppState.resources.size, 0)
    calls.mock.restore()
  }
})

const catalog = (a = 'a-v1', b = 'b-v1') => [{ id: 'team', reports: [
  { id: 'a', cacheKey: a }, { id: 'b', cacheKey: b },
] }]

test('unchanged refreshed catalogs preserve content while changed access/assignment versions refetch only affected reports', async t => {
  const calls = network(t)
  setManagedReportCatalog(catalog())
  await fetchReports(['a', 'b'])
  assert.deepEqual([...setManagedReportCatalog(catalog())], [])
  await fetchReports(['b', 'a'])
  assert.equal(calls.mock.callCount(), 1)
  assert.deepEqual([...setManagedReportCatalog(catalog('a-new-grant'))], ['team:team', 'a'])
  await fetchReports(['a', 'b'])
  assert.equal(calls.mock.callCount(), 2)
  assert.deepEqual(JSON.parse(calls.mock.calls[1].arguments[1].body).ids, ['a'])
  setManagedReportCatalog(catalog('a-new-grant', 'b-new-repository'))
  await fetchReport('b')
  assert.equal(calls.mock.callCount(), 3)
  assert.deepEqual([...setManagedReportCatalog([])].toSorted(), ['a', 'b', 'team:team'])
  assert.equal(managedAppState.read('reports:content:a'), undefined)
  assert.equal(managedAppState.read('reports:content:b'), undefined)
})

test('catalog versions include every team membership independent of ordering', async t => {
  const calls = network(t)
  const teams = [...catalog(), { id: 'other-team', reports: [{ id: 'a', cacheKey: 'other-grant' }] }]
  setManagedReportCatalog(teams)
  await fetchReport('a')
  assert.deepEqual([...setManagedReportCatalog(teams.toReversed())], [])
  await fetchReport('a')
  assert.equal(calls.mock.callCount(), 1)
  assert.deepEqual([...setManagedReportCatalog(catalog())], ['team:other-team', 'a'], 'revoking one membership invalidates shared findings')
  await fetchReport('a')
  assert.equal(calls.mock.callCount(), 2)
})

test('a refreshed catalog cancels older in-flight report content before it can restore revoked findings', async t => {
  setManagedReportCatalog(catalog())
  let resolve
  const calls = t.mock.method(globalThis, 'fetch', () => new Promise(done => { resolve = done }))
  const loading = fetchReports(['a', 'b'])
  setManagedReportCatalog(catalog('a-revoked'))
  assert.equal(calls.mock.calls[0].arguments[1].signal.aborted, true)
  resolve(Response.json({ reports: ['a', 'b'].map(id => ({ id, ...content(id) })) }))
  assert.equal(await loading, null)
  assert.equal(managedAppState.read('reports:content:a'), undefined)
})

test('team workspaces share in-flight and completed requests only within the same team, and cache only in memory', async t => {
  const calls = t.mock.method(globalThis, 'fetch', url => {
    const team = url.split('/')[3]
    return Promise.resolve(Response.json({ reports: [{ id: 'shared', filename: 'shared.json', ...content(team) }] }))
  })
  setManagedReportCatalog([{ id: 'a', reports: [{ id: 'shared', cacheKey: 'restricted' }] }, { id: 'b', reports: [{ id: 'shared', cacheKey: 'full' }] }])
  const [first, again, other] = await Promise.all([fetchTeamReports('a'), fetchTeamReports('a'), fetchTeamReports('b')])
  assert.strictEqual(first, again)
  assert.equal(first[0].data.findings[0].id, 'a')
  assert.equal(other[0].data.findings[0].id, 'b')
  assert.equal(calls.mock.callCount(), 2)
  assert.strictEqual(await fetchTeamReports('a'), first)
  setManagedReportCatalog([{ id: 'a', reports: [{ id: 'shared', cacheKey: 'changed' }] }, { id: 'b', reports: [{ id: 'shared', cacheKey: 'full' }] }])
  assert.strictEqual(await fetchTeamReports('b'), other)
  assert.notStrictEqual(await fetchTeamReports('a'), first)
  assert.equal(calls.mock.callCount(), 3)
  setManagedAppSession({ id: 'different-user', role: 'view' })
  assert.notStrictEqual(await fetchTeamReports('b'), other)
})

test('a changed links report invalidates the whole team response and cancels its stale in-flight load', async t => {
  setManagedReportCatalog([{ id: 'a', reports: [{ id: 'links', cacheKey: 'v1' }] }])
  const pending = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', () => pending.promise)
  const loading = fetchTeamReports('a')
  setManagedReportCatalog([{ id: 'a', reports: [{ id: 'links', cacheKey: 'v2' }] }])
  pending.resolve(Response.json({ reports: [{ id: 'links', filename: 'links.json', data: { source: 'links', findings: [], links: [] }, repo: { github: null, directory: '' } }] }))
  assert.equal(await loading, null)
  assert.equal(managedAppState.read('reports:content:team:a'), undefined)
})
