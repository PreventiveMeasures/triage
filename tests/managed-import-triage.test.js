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
  return { db, sessions, id, request, blobs }
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

test('standalone triage import is admin/CSRF gated and validates IDs and versions without requiring reports', async t => {
  const { request } = await fixture(t)
  const send = (body, role = 'admin', csrf = true, method = 'POST') => request(body, role, csrf, method, '/api/admin/import-triage')
  const body = { findingIds: ['not-uploaded'] }
  assert.equal((await send(body, null)).status, 401)
  for (const role of ['manage', 'triage', 'view']) assert.equal((await send(body, role)).status, 403)
  assert.equal((await send(body, 'admin', false)).status, 403)
  assert.equal((await send(body, 'admin', true, 'GET')).status, 405)
  assert.equal((await send({ findingIds: [''] })).status, 400)
  assert.equal((await send({ findingIds: ['x'.repeat(101)] })).status, 400)
  assert.equal((await send({ findingIds: Array.from({ length: 201 }, () => 'f') })).status, 400)
  assert.equal((await send({ entries: { f: {} }, expected: {} })).status, 400)
  assert.equal((await send({ entries: { f: { comment: 'x'.repeat(10001) } }, expected: { f: '0'.repeat(64) } })).status, 400)
  const read = await send(body)
  assert.equal(read.status, 200)
  assert.equal(read.snapshots['not-uploaded'].entry, null)
})

test('standalone import rechecks admin access after receiving the request body', async t => {
  const { db, request, sessions } = await fixture(t)
  const readSession = db.sessionWithUser.bind(db)
  let reads = 0
  t.mock.method(db, 'sessionWithUser', async (...args) => {
    const session = await readSession(...args)
    if (++reads === 1) await db.setUserRole(sessions.admin.userId, 'view')
    return session
  })
  assert.equal((await request({ findingIds: ['f'] }, 'admin', true, 'POST', '/api/admin/import-triage')).status, 403)
})

test('standalone import batches all local triage, resolves concurrent edits, and reimports without duplicating comments or creating files/teams', async t => {
  const { db, request, sessions } = await fixture(t)
  const admin = sessions.admin
  const raw = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`local-${i}`, { color: 'red' }]))
  raw.f = { color: 'red', comment: 'Imported note', flagged: false, ignoredReports: ['local.json'] }
  raw.legacy = { deleted: true }
  raw.ignore = { ignoredReports: ['local.json'] }
  await db.setTriage('f', { color: 'blue', fix: 'Keep this fix', flagged: true }, admin.userId, 'admin', 2)
  const reportIds = (await db.listReports()).map(row => row.id)
  let prompts = 0, writes = 0
  const options = {
    session: { id: admin.userId, role: 'admin', csrfToken: admin.csrfToken },
    api: { async send(path, body) {
      assert.equal(path, '/api/admin/import-triage')
      if (body.entries) writes++
      const response = await request(body, 'admin', true, 'POST', path)
      if (response.status === 409) return { conflict: true }
      assert.equal(response.status, 200)
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
  assert.equal(await runLocalTriageImport(raw, options), 207)
  assert.equal(prompts, 2, 'stale snapshot triggers conflict resolution again')
  assert.equal(writes, 3, 'two batches plus the stale attempt')
  const [finding] = await db.listTriage(['f'])
  assert.equal(finding.color, 'red')
  assert.equal(finding.fix, 'Keep this fix')
  assert.equal(finding.flagged, false)
  assert.equal((await db.listTriage(['legacy']))[0].triage, 'deleted')
  assert.equal((await db.listTriage(['ignore'])).length, 0)
  const comments = await db.listComments(['f'])
  const imported = comments.find(comment => comment.body === 'Imported note')
  assert.equal(imported.authorId, null)
  assert.equal(imported.createdAt, null)
  assert.equal(comments.length, 2)
  await runLocalTriageImport(raw, options)
  assert.equal((await db.listComments(['f'])).length, 2)
  assert.deepEqual((await db.listReports()).map(row => row.id), reportIds)
  assert.equal((await db.listTeams()).length, 0)
  assert.equal((await db.listBundles()).length, 0)
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
