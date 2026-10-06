import { parseStorageKey } from '../server-common/storage-crypto.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { prepareWorkspaceImport, runWorkspaceImport } from '../client/managed/workspace-import.js'
import { runLocalTriageImport } from '../client/managed/triage-import.js'
import { prepareLocalTriageComparison } from '../client/managed/triage-compare.js'
import { FINDING_CATALOG_PAGE_BYTES, FINDING_CATALOG_PAGE_COUNT, MAX_REPORT_QUERY_BYTES, MAX_REPORT_QUERY_COUNT } from '../server-managed/report-query.ts'

const config = {
  port: 8765, host: '127.0.0.1', dbPath: ':memory:', debug: false,
  githubClientId: 'test', githubClientSecret: 'test', oauthCallbackUrl: 'http://127.0.0.1:8765/api/oauth/github/callback',
  cookieSecure: false, sessionCookieName: 'import-test', sessionTtlMs: 3_600_000,
  maxReportBytes: 10_485_760, maxBundleBytes: 104_857_600,
}
async function fixture(t, options = {}) {
  const db = openSqliteManagedDb(':memory:', options)
  t.after(() => db.close())
  const sessions = {}
  for (const [index, role] of ['admin', 'manage', 'triage', 'view'].entries()) {
    const session = await createSession(config, db, { githubUserId: index + 1, login: role, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    sessions[role] = session
  }
  const id = randomUUID()
  const bytes = Buffer.from(JSON.stringify({ findings: [{ id: 'f', file: 'a.js' }, { id: 'g', file: 'b.js', security: true }] }))
  await db.insertReport({ id, filename: 'report.json', repoId: null, repoDirectory: '', contentType: 'application/json', byteSize: bytes.length, sha256: id, uploadedBy: sessions.admin.userId, bundleId: null, bundleIntegrity: null, visible: false }, 1)
  let pending
  const stored = new Map([[id, bytes]])
  const blobs = { get: key => Promise.resolve(stored.get(key)), put: (key, value) => { stored.set(key, value); return Promise.resolve() }, delete: key => { stored.delete(key); return Promise.resolve() } }
  const handler = createManagedRequestHandler({ config, db, reportStore: blobs, bundleStore: {}, avatarStore: {},
    originGate: { trustProxy: false, isOriginAllowed: () => true }, isShuttingDown: () => false, track: promise => { pending = promise },
  })
  async function request(body, role = 'admin', csrf = true, method = 'POST', path = `/api/admin/reports/${id}/import-triage`, headers = {}) {
    const session = sessions[role]
    const req = new Readable({ read() {} })
    req.method = method; req.url = path
    req.headers = { 'content-type': 'application/json', ...headers }
    if (session) req.headers.cookie = session.setCookie.split(';', 1)[0]
    if (session && csrf) req.headers['x-csrf-token'] = session.csrfToken
    const res = { statusCode: 0, body: '', headersSent: false,
      writeHead(status) { this.statusCode = status }, end(data) { this.body = data?.toString() ?? ''; this.headersSent = true },
    }
    handler(req, res)
    if (body !== undefined) req.push(body instanceof File ? Buffer.from(await body.arrayBuffer()) : JSON.stringify(body))
    req.push(null)
    await pending
    return { status: res.statusCode, ...(res.body ? JSON.parse(res.body) : {}) }
  }
  async function addReport(findings, filename = 'other.json', { reportId = randomUUID(), byteSize } = {}) {
    const content = Buffer.from(JSON.stringify({ findings }))
    await db.insertReport({ id: reportId, filename, repoId: null, repoDirectory: '', contentType: 'application/json', byteSize: byteSize ?? content.length,
      sha256: reportId, uploadedBy: sessions.admin.userId, bundleId: null, bundleIntegrity: null, visible: false }, 1)
    await blobs.put(reportId, content)
    return reportId
  }
  return { db, sessions, id, request, blobs, addReport }
}

test('import triage endpoint is admin/CSRF gated and restricts IDs to the uploaded report, including unpublished/security findings', async t => {
  const { request } = await fixture(t)
  const body = { findingIds: ['f', 'g'] }
  assert.equal((await request(body, null)).status, 401)
  for (const role of ['manage', 'triage', 'view']) assert.equal((await request(body, role)).status, 403)
  assert.equal((await request(body, 'admin', false)).status, 403)
  assert.equal((await request(body, 'admin', true, 'GET')).status, 405)
  assert.equal((await request({ findingIds: ['foreign'] })).status, 404)
  assert.equal((await request({ findingIds: Array.from({ length: 201 }, () => 'f') })).status, 400)
  assert.equal((await request({ entries: { f: {} }, expected: {} })).status, 400)
  const read = await request(body)
  assert.equal(read.status, 200)
  assert.deepEqual(Object.keys(read.snapshots), ['f', 'g'])
  assert.equal(read.snapshots.f.entry, null)
})

test('stale imports are rejected atomically; accepted triage and unattributed comments remain unified by finding ID', async t => {
  const { db, request, sessions } = await fixture(t)
  const actor = { id: sessions.admin.userId, login: 'admin' }
  const initial = (await request({ findingIds: ['f', 'g'] })).snapshots
  await db.setTriage('g', { color: 'blue' }, actor.id, actor.login, 2)
  const body = { entries: { f: { color: 'red', comment: 'Imported note' }, g: { color: 'green' } }, expected: Object.fromEntries(Object.entries(initial).map(([id, value]) => [id, value.version])) }
  assert.equal((await request(body)).status, 409)
  assert.equal((await db.listTriage(['f'])).length, 0)
  assert.equal((await db.listComments(['f'])).length, 0)
  const fresh = (await request({ findingIds: ['f', 'g'] })).snapshots
  body.expected = Object.fromEntries(Object.entries(fresh).map(([id, value]) => [id, value.version]))
  assert.equal((await request(body)).status, 200)
  assert.equal((await db.listTriage(['g']))[0].color, 'green')
  const [comment] = await db.listComments(['f'])
  assert.equal(comment.body, 'Imported note')
  assert.equal(comment.authorId, null)
  assert.equal(comment.authorLogin, null)
  assert.equal(comment.createdAt, null)
  const beforeComment = (await request({ findingIds: ['f'] })).snapshots.f
  await db.createComment({ findingId: 'f', body: 'New discussion', authorId: actor.id, authorLogin: actor.login }, 3)
  assert.equal((await request({ entries: { f: { color: 'blue' } }, expected: { f: beforeComment.version } })).status, 409)
  const latest = (await request({ findingIds: ['f'] })).snapshots.f
  assert.equal((await request({ entries: { f: body.entries.f }, expected: { f: latest.version } })).status, 200)
  assert.equal((await db.listComments(['f'])).length, 2, 'reimport does not duplicate equal comments or delete existing discussion')
})

test('Compare triage reads current managed annotations without changing either side', async t => {
  const { db, request, sessions } = await fixture(t)
  await db.setTriage('f', { color: 'blue' }, sessions.admin.userId, 'admin', 2)
  await db.createComment({ findingId: 'g', body: 'Only managed', authorId: sessions.admin.userId, authorLogin: 'admin' }, 3)
  const before = await db.getImportTriage(['f', 'g'])
  const raw = { f: { color: 'red', fix: 'Local fix' }, foreign: { comment: 'Private local note' } }
  const local = JSON.stringify(raw)
  const file = new File(['{"findings":[{"id":"f"},{"id":"g"},{"id":"foreign"}]}'], 'local.json')
  const comparison = await prepareLocalTriageComparison({
    source: { list: () => [{ value: 'local', label: 'local.json' }], importItem: (_kind, _value, read) => read(file) },
    readTriage: () => raw, signal: new AbortController().signal,
    api: { send: async (path, body) => {
      if (body) assert.deepEqual(Object.keys(body), ['findingIds'])
      assert.equal(JSON.stringify(body ?? '').includes('foreign'), false)
      const response = await request(body, 'admin', true, body ? 'POST' : 'GET', path)
      assert.equal(response.status, 200)
      return response
    } },
  })
  assert.equal(comparison.matched, 2)
  assert.deepEqual(comparison.findings.map(row => [row.id, row.differences.map(diff => diff.kind)]), [
    ['f', ['mismatch', 'local-only']], ['g', ['managed-only']],
  ])
  assert.deepEqual(await db.getImportTriage(['f', 'g']), before)
  assert.equal(JSON.stringify(raw), local)
})

test('admin role is rechecked after loading report content', async t => {
  const { db, sessions, request, blobs } = await fixture(t)
  const get = blobs.get
  blobs.get = async id => { await db.setUserRole(sessions.admin.userId, 'view'); return get(id) }
  assert.equal((await request({ findingIds: ['f'] })).status, 403)
})

test('finding catalog is admin-only and bodyless; unscoped triage import is no longer available', async t => {
  const { db, id, request } = await fixture(t)
  const catalog = (role = 'admin', method = 'GET') => request(undefined, role, false, method, '/api/admin/reports/finding-ids')
  assert.equal((await catalog(null)).status, 401)
  for (const role of ['manage', 'triage', 'view']) assert.equal((await catalog(role)).status, 403)
  assert.equal((await catalog('admin', 'POST')).status, 405)
  const read = await catalog()
  assert.equal(read.status, 200)
  assert.deepEqual(read.reports, [{ id, findingIds: ['f', 'g'] }], 'includes unpublished/security findings for the administrator')
  assert.equal(read.nextCursor, null)
  assert.equal((await request(undefined, 'admin', false, 'GET', '/api/admin/reports/finding-ids?after=invalid')).status, 400)
  const snapshot = (await db.getImportTriage(['foreign'])).foreign
  assert.equal((await request({ entries: { foreign: { comment: 'Do not save' } }, expected: { foreign: snapshot.version } },
    'admin', true, 'POST', '/api/admin/import-triage')).status, 404)
  assert.equal((await request({ entries: { foreign: { comment: 'Do not save' } }, expected: { foreign: snapshot.version } })).status, 404)
  assert.equal((await db.listTriage(['foreign'])).length, 0)
  assert.equal((await db.listComments(['foreign'])).length, 0)
})

test('finding catalog rechecks admin access after loading report content', async t => {
  const { db, request, sessions, blobs } = await fixture(t)
  const get = blobs.get
  blobs.get = async id => { await db.setUserRole(sessions.admin.userId, 'view'); return get(id) }
  const response = await request(undefined, 'admin', false, 'GET', '/api/admin/reports/finding-ids')
  assert.equal(response.status, 403)
  assert.equal(response.reports, undefined)
})

test('local import traverses empty catalog pages beyond the old report-count and total-byte limits', async t => {
  const { addReport, db, request } = await fixture(t)
  // Advertise large metadata sizes without allocating a gigabyte of test data.
  // These empty reports used to reject the entire catalog before matching.
  const count = MAX_REPORT_QUERY_COUNT + 1
  for (let i = 0; i < count; i++) {
    await addReport([], 'empty.json', { reportId: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
      byteSize: Math.ceil(MAX_REPORT_QUERY_BYTES / MAX_REPORT_QUERY_COUNT) })
  }
  const target = await addReport([{ id: 'match', file: 'a.js' }], 'match.json', { reportId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })
  const scan = db.listFindingCatalogReports.bind(db)
  let catalogRequests = 0, emptyPages = 0
  t.mock.method(db, 'listFindingCatalogReports', (after, limit) => {
    assert.ok(limit <= FINDING_CATALOG_PAGE_COUNT + 1, 'metadata queries are bounded too')
    return scan(after, limit)
  })
  t.mock.method(db, 'listReports', () => assert.fail('do not load the entire report store'))
  const imported = await runLocalTriageImport({ match: { comment: 'Import me' }, unknown: { comment: 'Keep local' } }, {
    session: { role: 'admin', csrfToken: 'csrf' },
    api: { async send(path, body) {
      if (path.startsWith('/api/admin/reports/finding-ids')) {
        assert.equal(body, undefined)
        catalogRequests++
        const response = await request(undefined, 'admin', false, 'GET', path)
        assert.equal(response.status, 200)
        if (response.reports.length === 0) emptyPages++
        return response
      }
      assert.equal(path, `/api/admin/reports/${target}/import-triage`)
      assert.doesNotMatch(JSON.stringify(body), /unknown|Keep local/u)
      const response = await request(body, 'admin', true, 'POST', path)
      assert.equal(response.status, 200)
      return response
    } },
  })
  assert.equal(imported, 1)
  assert.ok(catalogRequests > 1)
  assert.ok(emptyPages > 0, 'empty pages must not end discovery')
  assert.equal((await db.listComments(['match']))[0].body, 'Import me')
  assert.equal((await db.listComments(['unknown'])).length, 0)
})

test('catalog byte-limited pages advance over empty and oversized reports and survive cursor deletion', async t => {
  const { addReport, db, id, request } = await fixture(t)
  await db.deleteReport(id)
  const ids = [1, 2, 3].map(i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
  for (const [i, reportId] of ids.entries()) {
    await addReport(i === 2 ? [{ id: 'match', file: 'a.js' }] : [], 'sized.json', {
      reportId, byteSize: i === 1 ? FINDING_CATALOG_PAGE_BYTES + 1 : FINDING_CATALOG_PAGE_BYTES / 2 + 1,
    })
  }
  const first = await request(undefined, 'admin', false, 'GET', '/api/admin/reports/finding-ids')
  assert.deepEqual(first, { status: 200, reports: [], nextCursor: ids[0] })
  await db.deleteReport(ids[0])
  const second = await request(undefined, 'admin', false, 'GET', `/api/admin/reports/finding-ids?after=${first.nextCursor}`)
  assert.deepEqual(second, { status: 200, reports: [], nextCursor: ids[1] }, 'one large report occupies its own page')
  const third = await request(undefined, 'admin', false, 'GET', `/api/admin/reports/finding-ids?after=${second.nextCursor}`)
  assert.deepEqual(third, { status: 200, reports: [{ id: ids[2], findingIds: ['match'] }], nextCursor: null })
})

test('cancelling catalog pagination or losing admin access on a later page prevents imports', async t => {
  const { db, request, sessions } = await fixture(t)
  for (const revoke of [false, true]) {
    const signal = new AbortController()
    let calls = 0
    await assert.rejects(runLocalTriageImport({ f: { color: 'red' } }, {
      session: { role: 'admin', csrfToken: 'csrf' }, signal: signal.signal,
      api: { async send(path, body) {
        assert.equal(body, undefined, 'all pages finish before sending any annotations')
        if (++calls === 1) {
          if (revoke) await db.setUserRole(sessions.admin.userId, 'view')
          else signal.abort()
          return { reports: [{ id: 'report', findingIds: ['f'] }], nextCursor: '00000000-0000-4000-8000-000000000001' }
        }
        const response = await request(undefined, 'admin', false, 'GET', path)
        assert.equal(response.status, 403)
        throw new Error('Forbidden')
      } },
    }), revoke ? /Forbidden/u : { name: 'AbortError' })
    assert.equal(calls, revoke ? 2 : 1)
  }
  assert.equal((await db.listTriage(['f'])).length, 0)
})

test('local triage import sends only known findings through their reports, retains conflict handling, and attaches history', async t => {
  const { db, request, sessions, id: firstReportId, addReport } = await fixture(t)
  const admin = sessions.admin
  const knownIds = Array.from({ length: 205 }, (_, i) => `known-${i}`)
  const second = await addReport([...knownIds, 'f', 'legacy'].map(id => ({ id, file: 'a.js' })))
  const raw = Object.fromEntries(knownIds.map(id => [id, { color: 'red' }]))
  raw.f = { color: 'red', comment: 'Imported note', flagged: false, ignoredReports: ['local.json'], scopedIgnoredReports: ['local.json'] }
  raw.g = { flagged: true }
  raw.legacy = { deleted: true }
  raw.ignore = { ignoredReports: ['local.json'], scopedIgnoredReports: ['local.json'] }
  raw.unknown = { color: 'blue', comment: 'Local-only secret' }
  raw.oversizedUnknown = { comment: 'x'.repeat(10001) }
  const before = JSON.stringify(raw)
  const memberships = new Map([[firstReportId, new Set(['f', 'g'])], [second, new Set([...knownIds, 'f', 'legacy'])]])
  await db.setTriage('f', { color: 'blue', fix: 'Keep this fix', flagged: true }, admin.userId, 'admin', 2)
  const reportIds = (await db.listReports()).map(row => row.id)
  let prompts = 0
  const committed = new Set()
  const options = {
    session: { id: admin.userId, role: 'admin', csrfToken: admin.csrfToken },
    api: { async send(path, body) {
      if (path === '/api/admin/reports/finding-ids') assert.equal(body, undefined, 'discovery sends no local data')
      else {
        const reportId = /^\/api\/admin\/reports\/([^/]+)\/import-triage$/u.exec(path)?.[1]
        assert.ok(memberships.has(reportId), 'every request is attached to an existing report')
        const ids = body.findingIds ?? Object.keys(body.entries)
        assert.ok(ids.every(id => memberships.get(reportId).has(id)), 'unknown IDs are never transmitted, even for snapshots')
        assert.doesNotMatch(JSON.stringify(body), /unknown|Local-only secret|oversizedUnknown/u)
      }
      const response = await request(body, 'admin', true, body === undefined ? 'GET' : 'POST', path)
      if (response.status === 409) return { conflict: true }
      assert.equal(response.status, 200)
      if (body?.entries) {
        for (const id of Object.keys(body.entries)) {
          assert.equal(committed.has(id), false, 'a finding shared by reports is imported once')
          committed.add(id)
        }
      }
      return response
    } },
    async resolveConflicts(conflicts) {
      prompts++
      if (prompts === 1) {
        await db.setTriage('f', { color: 'green', fix: 'Keep this fix', flagged: true }, admin.userId, 'admin', 3)
        await db.createComment({ findingId: 'f', body: 'Concurrent discussion', authorId: admin.userId, authorLogin: 'admin' }, 3)
      }
      return Object.fromEntries(conflicts.map(c => [`${c.id}:${c.property}`, 'imported']))
    },
  }
  assert.equal(await runLocalTriageImport(raw, options), 208)
  assert.equal(prompts, 2, 'stale snapshot triggers conflict resolution again')
  assert.equal(committed.size, 208)
  const [finding] = await db.listTriage(['f'])
  assert.equal(finding.color, 'red')
  assert.equal(finding.fix, 'Keep this fix')
  assert.equal(finding.flagged, false)
  assert.equal((await db.listTriage(['legacy']))[0].triage, 'deleted')
  assert.equal((await db.listTriage(['ignore', 'unknown', 'oversizedUnknown'])).length, 0)
  assert.equal((await db.listComments(['unknown', 'oversizedUnknown'])).length, 0)
  const comments = await db.listComments(['f'])
  const imported = comments.find(comment => comment.body === 'Imported note')
  assert.equal(imported.authorId, null)
  assert.equal(imported.createdAt, null)
  assert.equal(comments.length, 2)
  const { history } = await db.listActivity({ page: 1, limit: 1000, kind: 'triage', query: '', contexts: null })
  const importEvents = history.filter(event => event.at > 3)
  assert.equal(importEvents.length, 209)
  assert.ok(importEvents.every(event => memberships.get(event.reportId)?.has(event.finding)), 'both triage and comment history retain report context')
  committed.clear()
  await runLocalTriageImport(raw, options)
  assert.equal((await db.listComments(['f'])).length, 2)
  assert.equal(JSON.stringify(raw), before, 'local data is preserved')
  assert.deepEqual((await db.listReports()).map(row => row.id), reportIds)
  assert.equal((await db.listTeams()).length, 0)
  assert.equal((await db.listBundles()).length, 0)
})

test('imports with no matching findings send only a bodyless catalog request', async t => {
  const { request } = await fixture(t)
  let calls = 0
  const count = await runLocalTriageImport({ unknown: { comment: 'Keep local' } }, {
    session: { role: 'admin', csrfToken: 'csrf' },
    api: { send(path, body) {
      calls++
      assert.equal(path, '/api/admin/reports/finding-ids')
      assert.equal(body, undefined)
      return request(undefined, 'admin', false, 'GET', path)
    } },
  })
  assert.equal(count, 0)
  assert.equal(calls, 1)
})

test('a report deleted between matching and import cannot leave orphan triage or comments', async t => {
  const { db, id, request, sessions } = await fixture(t)
  const snapshot = (await request({ findingIds: ['f'] })).snapshots.f
  await db.deleteReport(id)
  const entries = { f: { color: 'red', comment: 'Do not save' } }
  assert.equal((await request({ entries, expected: { f: snapshot.version } })).status, 404)
  assert.equal(await db.importTriage(Object.entries(entries), { f: snapshot.version }, { id: sessions.admin.userId, login: 'admin' }, id, 2), false)
  assert.equal((await db.listTriage(['f'])).length, 0)
  assert.equal((await db.listComments(['f'])).length, 0)
})

test('whole workspace import uses real managed routes to create a team, upload reports/links, resolve conflicts, and publish', async t => {
  const { db, request, sessions } = await fixture(t, { storageEncryptionKey: parseStorageKey(Buffer.alloc(32, 77).toString('base64')) })
  const admin = sessions.admin
  await db.selectRepo({ repoId: 7, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'https://github.com/org/repo', addedBy: admin.userId }, 1)
  await db.setTriage('f', { color: 'blue', fix: 'Existing fix' }, admin.userId, 'admin', 2)
  const data = { workspace: { name: 'Imported workspace' }, reports: [
    { name: 'imported.json', content: JSON.stringify({ repo: { github: 'org/repo', directory: 'src' }, findings: [{ id: 'f', file: 'a.js' }] }) },
    { name: 'links.json', content: JSON.stringify([[{ id: 'f' }, { id: 'g' }]]), repo: { github: 'org/repo' } },
  ], triage: { f: { color: 'red', comment: 'Imported comment' } } }
  const plan = await prepareWorkspaceImport(data, [{ repoId: 7, fullName: 'org/repo' }])
  let prompts = 0
  const team = await runWorkspaceImport(plan, { session: { id: admin.userId, role: 'admin', csrfToken: admin.csrfToken }, includeTriage: true,
    api: { async send(path, body, headers) {
      const response = await request(body, 'admin', true, body === undefined ? 'GET' : 'POST', path, headers)
      assert.ok(response.status >= 200 && response.status < 300, `${path}: ${JSON.stringify(response)}`)
      return response
    } },
    resolveConflicts(conflicts) { prompts++; assert.equal(conflicts[0].local, 'blue'); return { 'f:color': 'imported' } },
  })
  assert.equal(prompts, 1)
  assert.equal(team.name, 'Imported workspace')
  const [visible] = await db.listTeamsForUser(admin.userId)
  assert.equal(visible.id, team.id)
  assert.deepEqual(visible.reports.map(row => row.filename).toSorted(), ['imported.json'])
  assert.deepEqual((await db.listLinkReports()).map(row => [row.filename, row.enabled]), [['links.json', true]])
  assert.equal((await db.getReport(plan.reports[0].uploaded.id)).repoDirectory, 'src')
  assert.equal((await db.listTriage(['f']))[0].color, 'red')
  assert.equal((await db.listTriage(['f']))[0].fix, 'Existing fix')
  assert.equal((await db.listComments(['f']))[0].body, 'Imported comment')
})


test('shared ignored survives managed import, read, and history', async t => {
  const { request, id, db } = await fixture(t)
  const initial = (await request({ findingIds: ['f'] })).snapshots.f
  assert.equal((await request({ entries: { f: { triage: 'ignored' } }, expected: { f: initial.version } })).status, 200)
  const result = await request(undefined, 'admin', true, 'GET', `/api/reports/${id}/triage`)
  assert.equal(result.status, 200)
  assert.equal(result.entries.f.triage, 'ignored')
  assert.equal((await db.listTriage(['f']))[0].triage, 'ignored')
  const history = await db.listTriageHistory('f', 10)
  assert.equal(history.length, 1)
  assert.match(JSON.stringify(history), /ignored/u)
})

test('workspace import migrates own/App ignores and omits dependency report ignores', async () => {
  const data = { workspace: { name: 'Old export' }, reports: [{ name: 'old.json', content: JSON.stringify({ findings: [
    { id: 'own', file: 'src/app.js' },
    { id: 'app', file: 'node_modules/pkg/app.js', isApp: true },
    { id: 'dep', file: 'node_modules/pkg/source.js', isApp: false },
  ] }) }], triage: Object.fromEntries(['own', 'app', 'dep'].map(id => [id, { ignoredReports: ['old.json'] }])) }
  const plan = await prepareWorkspaceImport(data, [])
  assert.deepEqual({ ...plan.triage }, { own: { triage: 'ignored' }, app: { triage: 'ignored' } })
})
