import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession, readSession } from '../server-managed/session.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { MAX_REPORT_QUERY_BYTES, MAX_REPORT_QUERY_COUNT } from '../server-managed/report-query.ts'
import { managedCsv, managedCsvIds } from './_managed-csv.js'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 3_600_000 }

async function setup(t, createHandler = createManagedRequestHandler) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const now = Date.now(), users = {}
  for (const [index, role] of ['admin', 'view', 'none', 'manage', 'triage'].entries()) {
    users[role] = await createSession(config, db, { githubUserId: index + 1, login: role, name: null, avatarUrl: null }, now)
    await db.setUserRole(users[role].userId, role)
  }
  for (const repoId of [7, 9]) {
    await db.selectRepo({ repoId, fullName: `org/repo${repoId}`, private: true, installationId: null,
      defaultBranch: 'main', htmlUrl: 'https://example.test', addedBy: users.admin.userId }, now)
  }
  await db.createTeam('team', 'Workspace', now)
  await db.setTeamRepo('team', 7, 'packages/app')
  await db.setTeamMember('team', users.view.userId, { dependencies: false, security: false })
  const blobs = new Map(), reads = []
  const store = { async get(id) { reads.push(id); await store.afterRead?.(id); return blobs.get(id) ?? null } }
  for (const [id, repoId, repoDirectory, visible] of [
    ['a', 7, 'packages/app', true], ['b', 7, 'packages/app/sub', true],
    ['outside', 7, 'packages/other', true], ['foreign', 9, '', true], ['draft', 7, 'packages/app', false],
  ]) {
    const content = JSON.stringify({ repo: { github: 'wrong/embedded' }, findings: [
      { id: `${id}-own`, file: 'app.js' }, { id: `${id}-dep`, file: 'node_modules/dep.js' },
      { id: `${id}-security`, file: 'security.js', security: true },
    ] })
    blobs.set(id, Buffer.from(content))
    await db.insertReport({ id, filename: `${id}.json`, contentType: 'application/json', byteSize: content.length,
      sha256: id, uploadedBy: users.admin.userId, repoId, repoDirectory, visible, bundleId: null, bundleIntegrity: null }, now)
  }
  let pending
  const handler = createHandler({
    config, db, reportStore: store, originGate: { isOriginAllowed: () => true },
    isShuttingDown: () => false, track: promise => { pending = promise },
  })
  async function request(body, { role = 'view', method = 'POST', path = '/api/reports/query' } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: path, headers: { accept: 'application/json', cookie: users[role]?.setCookie.split(';')[0] } })
    const res = { statusCode: 0, headers: {}, body: '', headersSent: false,
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this },
      write(value) { this.body += value; this.headersSent = true; return true },
      end(value) { this.body += value ?? ''; this.headersSent = true; return this },
    }
    handler(req, res)
    await pending
    return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) }
  }
  return { db, users, blobs, reads, store, request }
}

async function addReports(h, count, sizes = []) {
  const original = await h.db.getReport('a')
  const ids = Array.from({ length: count }, (_, index) => `report-${index}`)
  for (const [index, id] of ids.entries()) {
    await h.db.insertReport({ ...original, id, sha256: id, byteSize: sizes[index] ?? original.byteSize }, Date.now())
    h.blobs.set(id, h.blobs.get('a'))
  }
  return ids
}

test('batch blob reads overlap within a small pool and preserve request order', async t => {
  const h = await setup(t)
  const ids = await addReports(h, 24)
  const first = Promise.withResolvers()
  let active = 0, peak = 0
  const completed = []
  h.store.afterRead = async id => {
    peak = Math.max(peak, ++active)
    // Keep the first read slow while the other workers consume the queue.
    if (id === ids[0]) await first.promise
    else await setImmediate()
    completed.push(id)
    active--
  }
  const response = h.request({ ids })
  try {
    for (let i = 0; i < 100 && completed.length < ids.length - 1; i++) await setImmediate()
    assert.ok(peak > 1 && peak <= 8, `expected 2–8 simultaneous reads, got ${peak}`)
    assert.equal(completed.length, ids.length - 1, 'one slow blob must not stall other workers')
  } finally {
    first.resolve()
    await response
  }
  const result = await response
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.reports.map(report => report.id), ids)
  assert.equal(active, 0)
  assert.equal(new Set(h.reads).size, ids.length)
  assert.equal(h.reads.length, ids.length)
})

test('blob concurrency respects a byte budget and admits large reports alone', async t => {
  const mib = 1024 * 1024
  for (const sizes of [Array.from({ length: 8 }, () => 100), [40, 24, 1, 32, 32, 80, 1, 3, 40]]) {
    const h = await setup(t)
    const ids = await addReports(h, sizes.length, sizes.map(size => size * mib))
    let active = 0, activeBytes = 0, peak = 0
    const admitted = []
    t.mock.method(h.store, 'get', async id => {
      const size = sizes[ids.indexOf(id)] * mib
      active++
      activeBytes += size
      peak = Math.max(peak, active)
      admitted.push({ active, bytes: activeBytes })
      await setImmediate()
      // Model large buffers without allocating hundreds of MiB in the test.
      // Keep their reservation visible until parsing starts, after get resolves.
      return { length: size, toString() {
        active--
        activeBytes -= size
        return h.blobs.get(id).toString('utf8')
      } }
    })
    const response = await h.request({ ids })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.reports.map(report => report.id), ids)
    assert.ok(admitted.every(read => read.bytes <= 64 * mib || read.active === 1), JSON.stringify(admitted))
    if (sizes[0] === 100) assert.equal(peak, 1)
    else assert.ok(peak > 1 && peak <= 8)
    assert.equal(active, 0)
    assert.equal(activeBytes, 0)
  }
})

test('failed batches wake byte-budget waiters and drain active reads before responding', async t => {
  for (const [kind, status, error] of [
    ['missing', 503, 'unavailable'], ['unreadable', 422, 'unreadable-report'],
    ['oversized', 413, 'batch-too-large'], ['throwing', 500, 'internal'],
  ]) {
    const h = await setup(t)
    const ids = await addReports(h, 24, Array.from({ length: 24 }, () => 32 * 1024 * 1024))
    const release = Promise.withResolvers()
    let active = 0, settled = false
    t.mock.method(h.store, 'get', async id => {
      h.reads.push(id)
      active++
      try {
        if (id !== ids[0]) {
          await release.promise
          if (kind === 'throwing') throw new Error('later blob read failed')
          return h.blobs.get(id)
        }
        await setImmediate()
        if (kind === 'missing') return null
        if (kind === 'unreadable') return Buffer.from('not a report')
        if (kind === 'oversized') return { length: MAX_REPORT_QUERY_BYTES + 1, toString() { assert.fail('oversized report parsed') } }
        throw new Error('blob read failed')
      } finally { active-- }
    })
    const response = h.request({ ids }).then(result => { settled = true; return result })
    try {
      for (let i = 0; i < 100 && h.reads.length === 0; i++) await setImmediate()
      for (let i = 0; i < 5; i++) await setImmediate()
      assert.equal(h.reads.length, 2, kind)
      assert.equal(settled, false, 'wait for already-started reads')
    } finally { release.resolve(); await response }
    const result = await response
    assert.equal(result.status, status, kind)
    assert.deepEqual(result.body, { error }, kind)
    assert.equal(h.reads.length, 2, 'do not start more reads after failure')
    assert.equal(active, 0)
  }
})

test('a workspace batch returns all requested content with the same filtering and metadata as individual reads', async t => {
  const h = await setup(t)
  for (const role of ['view', 'admin']) {
    const batch = await h.request({ ids: ['b', 'a', 'b'] }, { role })
    assert.equal(batch.status, 200)
    assert.equal(batch.headers['cache-control'], 'no-store')
    assert.deepEqual(batch.body.reports.map(report => report.id), ['b', 'a'])
    for (const { id, ...content } of batch.body.reports) {
      const single = await h.request({}, { method: 'GET', path: `/api/reports/${id}`, role })
      assert.deepEqual(content, single.body)
      assert.deepEqual(content.repo, { github: 'org/repo7', directory: id === 'a' ? 'packages/app' : 'packages/app/sub' })
      assert.equal(content.data.findings.length, role === 'admin' ? 3 : 1)
    }
  }
})

test('batch database calls stay constant as report count grows and preserve per-report assignments', async t => {
  const h = await setup(t)
  const original = await h.db.getReport('a')
  const ids = []
  for (let index = 0; index < 32; index++) {
    const id = `report-${index}`, repoId = index % 2 === 0 ? 7 : 9
    await h.db.insertReport({ ...original, id, repoId, repoDirectory: `packages/${index}`, sha256: id }, Date.now())
    h.blobs.set(id, h.blobs.get('a'))
    ids.push(id)
  }
  const calls = new Map(['sessionWithUser', 'getReportAccessSnapshot', 'listAllRepos', 'getReport', 'userCanReadReport', 'reportPermissionsFor']
    .map(name => [name, t.mock.method(h.db, name)]))
  assert.equal((await h.request({ ids: ids.slice(0, 1) }, { role: 'admin' })).status, 200)
  const singleCounts = [...calls.values()].map(method => method.mock.callCount())
  for (const method of calls.values()) method.mock.resetCalls()
  const response = await h.request({ ids }, { role: 'admin' })
  assert.equal(response.status, 200)
  assert.deepEqual([...calls.values()].map(method => method.mock.callCount()), singleCounts)
  assert.equal(calls.get('getReportAccessSnapshot').mock.callCount(), 2)
  for (const name of ['listAllRepos', 'getReport', 'userCanReadReport', 'reportPermissionsFor']) assert.equal(calls.get(name).mock.callCount(), 0)
  assert.equal(response.body.reports.length, ids.length)
  for (const [index, entry] of response.body.reports.entries()) {
    assert.deepEqual(entry.repo, { github: `org/repo${index % 2 === 0 ? 7 : 9}`, directory: `packages/${index}` })
  }
})

test('repository names are revalidated after report reads before returning a batch', async t => {
  const h = await setup(t)
  const repo = (await h.db.listAllRepos()).find(entry => entry.repoId === 7)
  h.store.afterRead = id => id === 'b' && h.db.selectRepo({ ...repo, fullName: 'org/renamed' }, Date.now())
  const response = await h.request({ ids: ['a', 'b'] })
  assert.equal(response.status, 404)
  assert.deepEqual(response.body, { error: 'no-report' })
  h.store.afterRead = null
  const retried = await h.request({ ids: ['a', 'b'] })
  assert.equal(retried.status, 200)
  assert.deepEqual(retried.body.reports.map(entry => entry.repo.github), ['org/renamed', 'org/renamed'])
})

test('batch access is checked per report and rejected atomically before reading any report bytes', async t => {
  const h = await setup(t)
  assert.equal((await h.request({ ids: ['a'] }, { role: 'anonymous' })).status, 401)
  assert.equal((await h.request({ ids: ['a'] }, { role: 'none' })).status, 403)
  for (const id of ['outside', 'foreign', 'draft', 'missing']) {
    const response = await h.request({ ids: ['a', id] })
    assert.equal(response.status, 404)
    assert.deepEqual(response.body, { error: 'no-report' })
  }
  assert.deepEqual(h.reads, [])
  h.blobs.delete('b')
  assert.deepEqual((await h.request({ ids: ['a', 'b'] })).body, { error: 'unavailable' })
})

test('batch request validation, empty workspaces, and deduplication', async t => {
  const h = await setup(t)
  for (const body of [null, {}, { ids: 'a' }, { ids: [null] }, { ids: [''] }, { ids: ['x'.repeat(257)] }]) {
    assert.equal((await h.request(body)).status, 400)
  }
  assert.equal((await h.request({}, { method: 'GET' })).status, 405)
  assert.deepEqual((await h.request({ ids: [] })).body, { reports: [] })
  assert.equal((await h.request({ ids: ['a', 'a'] })).status, 200)
  assert.deepEqual(h.reads, ['a'])
})

test('membership revoked while the batch reads storage prevents the entire response', async t => {
  const h = await setup(t)
  h.store.afterRead = () => h.db.removeTeamMember('team', h.users.view.userId)
  const response = await h.request({ ids: ['a', 'b'] })
  assert.equal(response.status, 404)
  assert.deepEqual(response.body, { error: 'no-report' })
})

test('permission changes during storage reads reject the old snapshot and a retry uses the current grant', async t => {
  const h = await setup(t)
  await h.db.setTeamMember('team', h.users.view.userId, { dependencies: true, security: true })
  h.store.afterRead = () => h.db.setTeamMember('team', h.users.view.userId, { dependencies: false, security: false })
  const response = await h.request({ ids: ['a', 'b'] })
  assert.equal(response.status, 404)
  assert.deepEqual(response.body, { error: 'no-report' })
  h.store.afterRead = null
  const retried = await h.request({ ids: ['a', 'b'] })
  assert.equal(retried.status, 200)
  assert.deepEqual(retried.body.reports.map(report => report.data.findings.map(finding => finding.id)), [['a-own'], ['b-own']])
})

test('markdown and multi-scan CSV are served as parsed JSON with permissions applied after parsing', async t => {
  const h = await setup(t)
  const markdown = '# Security finding\n\n---\n**Severity:** high\n'
  for (const [id, text, filename] of [['md', markdown, 'report.md'], ['csv', managedCsv, 'report.csv']]) {
    await h.db.insertReport({ ...await h.db.getReport('a'), id, filename, sha256: id, byteSize: text.length }, Date.now())
    h.blobs.set(id, Buffer.from(text))
  }
  const all = await h.request({ ids: ['md', 'csv'] }, { role: 'admin' })
  assert.equal(all.status, 200)
  assert.equal(all.body.reports[0].data.source, 'claude-security')
  assert.equal(all.body.reports[0].data.findings.length, 1)
  assert.deepEqual(all.body.reports[1].data.findings.map(f => f.id), managedCsvIds)
  const restricted = await h.request({ ids: ['md', 'csv'] })
  assert.equal(restricted.status, 200)
  assert.ok(restricted.body.reports.every(report => report.data.findings.length === 0))
  await h.db.setTeamMember('team', h.users.view.userId, { dependencies: false, security: true })
  const partial = await h.request({ ids: ['md', 'csv'] })
  assert.equal(partial.body.reports[0].data.findings.length, 1)
  assert.deepEqual(partial.body.reports[1].data.findings.map(f => f.id), [managedCsvIds[0]])
  const single = await h.request({}, { method: 'GET', path: '/api/reports/csv' })
  assert.deepEqual(single.body, { data: partial.body.reports[1].data, repo: partial.body.reports[1].repo })
})

test('unreadable reports fail the whole parsed JSON response', async t => {
  const h = await setup(t)
  h.blobs.set('b', Buffer.from('not a report'))
  for (const options of [{}, { method: 'GET', path: '/api/reports/b' }]) {
    const response = await h.request({ ids: ['a', 'b'] }, options)
    assert.equal(response.status, 422)
    assert.deepEqual(response.body, { error: 'unreadable-report' })
  }
})

test('large batches are rejected before storage reads by report count and total stored bytes', async t => {
  const h = await setup(t)
  const tooMany = await h.request({ ids: Array.from({ length: MAX_REPORT_QUERY_COUNT + 1 }, (_, index) => `id-${index}`) })
  assert.equal(tooMany.status, 413)
  const snapshot = h.db.getReportAccessSnapshot.bind(h.db)
  t.mock.method(h.db, 'getReportAccessSnapshot', async (...args) => {
    const result = await snapshot(...args)
    return { ...result, reports: result.reports.map(report => ({ ...report, byteSize: MAX_REPORT_QUERY_BYTES / 2 + 1 })) }
  })
  assert.equal((await h.request({ ids: ['a', 'b'] })).status, 413)
  assert.deepEqual(h.reads, [])
})

test('actual storage bytes are bounded even when the catalog understates them', async t => {
  const h = await setup(t)
  t.mock.method(h.store, 'get', () => Promise.resolve({
    length: MAX_REPORT_QUERY_BYTES + 1,
    toString() { assert.fail('oversized bytes must never be parsed') },
  }))
  const response = await h.request({ ids: ['a'] })
  assert.equal(response.status, 413)
  assert.deepEqual(response.body, { error: 'batch-too-large' })
})

test('concurrent reads share the aggregate input-byte budget', async t => {
  const h = await setup(t)
  t.mock.method(h.store, 'get', async id => {
    await setImmediate()
    return { length: MAX_REPORT_QUERY_BYTES / 2 + 1, toString: () => h.blobs.get(id).toString('utf8') }
  })
  const response = await h.request({ ids: ['a', 'b'] })
  assert.equal(response.status, 413)
  assert.deepEqual(response.body, { error: 'batch-too-large' })
})

test('access changes to an earlier report during a later read reject all prepared content', async t => {
  const h = await setup(t)
  await h.db.setTeamMember('team', h.users.view.userId, { dependencies: true, security: true })
  h.store.afterRead = id => id === 'b' && h.db.setTeamMember('team', h.users.view.userId, { dependencies: false, security: false })
  const response = await h.request({ ids: ['a', 'b'] })
  assert.equal(response.status, 404)
  assert.deepEqual(response.body, { error: 'no-report' })
})

test('session revocation, role changes, unpublishing, and report reassignment during loading reject the batch', async t => {
  for (const change of [
    async h => {
      const { session } = await readSession(config, h.db, h.users.view.setCookie, Date.now())
      await h.db.deleteSession(session.id)
      return 401
    },
    async h => { await h.db.setUserRole(h.users.view.userId, 'none'); return 404 },
    async h => { await h.db.setReportVisible('a', false); return 404 },
    async h => { await h.db.setReportRepo('a', 9, ''); return 404 },
  ]) {
    const h = await setup(t)
    let status
    h.store.afterRead = async id => { if (id === 'b') status = await change(h) }
    const response = await h.request({ ids: ['a', 'b'] })
    assert.equal(response.status, status)
    assert.equal(response.body.reports, undefined)
  }
})

test('bulk authorization matches individual reads for every role, manager ownership, and overlapping team grants', async t => {
  const h = await setup(t)
  await h.db.setTeamMember('team', h.users.manage.userId, { dependencies: false, security: false })
  await h.db.setTeamMember('team', h.users.triage.userId, { dependencies: false, security: true })
  await h.db.createTeam('extra', 'Overlapping workspace', Date.now())
  await h.db.setTeamRepo('extra', 7, 'packages/app/sub')
  await h.db.setTeamMember('extra', h.users.triage.userId, { dependencies: true, security: false })
  await h.db.insertReport({ ...await h.db.getReport('foreign'), id: 'owned', uploadedBy: h.users.manage.userId, visible: false }, Date.now())
  h.blobs.set('owned', h.blobs.get('foreign'))
  const ids = ['a', 'b', 'outside', 'foreign', 'draft', 'owned', 'missing']
  for (const role of Object.keys(h.users)) {
    const { session } = await readSession(config, h.db, h.users[role].setCookie, Date.now())
    const snapshot = await h.db.getReportAccessSnapshot(session.id, Date.now(), ids)
    const allowed = []
    for (const id of ids) {
      const single = await h.request({}, { method: 'GET', path: `/api/reports/${id}`, role })
      if (single.status !== 200) continue
      allowed.push(id)
      const batch = await h.request({ ids: [id] }, { role })
      assert.deepEqual(batch.body.reports[0], { id, ...single.body })
    }
    assert.deepEqual(snapshot.reports.map(report => report.id).toSorted(), allowed.toSorted())
    if (role === 'triage') {
      assert.deepEqual(snapshot.reports.find(report => report.id === 'a').permissions, { dependencies: false, security: true })
      assert.deepEqual(snapshot.reports.find(report => report.id === 'b').permissions, { dependencies: true, security: true })
    }
  }
})

test('catalog report versions change with grants and repository assignments without reading blobs', async t => {
  const h = await setup(t)
  const catalog = async () => (await h.request({}, { method: 'GET', path: '/api/teams' })).body.teams
  const original = await catalog()
  assert.equal(typeof original[0].reports[0].cacheKey, 'string')
  assert.deepEqual(await catalog(), original)
  await h.db.setTeamMember('team', h.users.view.userId, { dependencies: true, security: false })
  const granted = await catalog()
  assert.notEqual(granted[0].reports[0].cacheKey, original[0].reports[0].cacheKey)
  await h.db.setReportRepo('a', 7, 'packages/app/new')
  const reassigned = await catalog()
  assert.notEqual(reassigned[0].reports.find(r => r.id === 'a').cacheKey, granted[0].reports.find(r => r.id === 'a').cacheKey)
  assert.equal(reassigned[0].reports.find(r => r.id === 'b').cacheKey, granted[0].reports.find(r => r.id === 'b').cacheKey)
  await h.db.removeTeamMember('team', h.users.view.userId)
  assert.deepEqual(await catalog(), [])
  assert.deepEqual(h.reads, [])
})

test('encoded output has its own bound and never returns a partial workspace', async t => {
  // Exercise the real endpoint with a small test budget rather than allocating
  // gigabytes just to prove that JSON envelope/format expansion is counted.
  t.mock.module('../server-managed/report-query.ts', { namedExports: { MAX_REPORT_QUERY_COUNT, MAX_REPORT_QUERY_BYTES: 1024 } })
  const { createManagedRequestHandler: boundedHandler } = await import('../server-managed/http.ts?small-query-budget')
  const h = await setup(t, boundedHandler)
  for (const id of ['a', 'b']) h.blobs.set(id, Buffer.from(JSON.stringify({ findings: [{ id, description: 'x'.repeat(420) }] })))
  assert.ok(h.blobs.get('a').length + h.blobs.get('b').length < 1024)
  const response = await h.request({ ids: ['a', 'b'] }, { role: 'admin' })
  assert.equal(response.status, 413)
  assert.deepEqual(response.body, { error: 'batch-too-large' })
})
