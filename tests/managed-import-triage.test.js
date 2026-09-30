import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { prepareWorkspaceImport, runWorkspaceImport } from '../client/managed/workspace-import.js'
import { runLocalTriageImport } from '../client/managed/triage-import.js'

const config = {
  port: 8765, host: '127.0.0.1', dbPath: ':memory:', debug: false,
  githubClientId: 'test', githubClientSecret: 'test', oauthCallbackUrl: 'http://127.0.0.1:8765/api/oauth/github/callback',
  cookieSecure: false, sessionCookieName: 'import-test', sessionTtlMs: 3_600_000,
  maxReportBytes: 10_485_760, maxBundleBytes: 104_857_600,
}
async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
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
  async function addReport(findings, filename = 'other.json') {
    const reportId = randomUUID()
    const content = Buffer.from(JSON.stringify({ findings }))
    await db.insertReport({ id: reportId, filename, repoId: null, repoDirectory: '', contentType: 'application/json', byteSize: content.length,
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

test('local triage import sends only known findings through their reports, retains conflict handling, and attaches history', async t => {
  const { db, request, sessions, id: firstReportId, addReport } = await fixture(t)
  const admin = sessions.admin
  const knownIds = Array.from({ length: 205 }, (_, i) => `known-${i}`)
  const second = await addReport([...knownIds, 'f', 'legacy'].map(id => ({ id, file: 'a.js' })))
  const raw = Object.fromEntries(knownIds.map(id => [id, { color: 'red' }]))
  raw.f = { color: 'red', comment: 'Imported note', flagged: false, ignoredReports: ['local.json'] }
  raw.g = { flagged: true }
  raw.legacy = { deleted: true }
  raw.ignore = { ignoredReports: ['local.json'] }
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
  const { db, request, sessions } = await fixture(t)
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
  assert.deepEqual(visible.reports.map(row => row.filename).toSorted(), ['imported.json', 'links.json'])
  assert.equal((await db.getReport(plan.reports[0].uploaded.id)).repoDirectory, 'src')
  assert.equal((await db.listTriage(['f']))[0].color, 'red')
  assert.equal((await db.listTriage(['f']))[0].fix, 'Existing fix')
  assert.equal((await db.listComments(['f']))[0].body, 'Imported comment')
})
