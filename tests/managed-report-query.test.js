import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { managedCsv, managedCsvIds } from './_managed-csv.js'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 3_600_000 }

async function setup(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const now = Date.now(), users = {}
  for (const [index, role] of ['admin', 'view', 'none'].entries()) {
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
  const handler = createManagedRequestHandler({
    config, db, reportStore: store, originGate: { isOriginAllowed: () => true },
    isShuttingDown: () => false, track: promise => { pending = promise },
  })
  async function request(body, { role = 'view', method = 'POST', path = '/api/reports/query' } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: path, headers: { accept: 'application/json', cookie: users[role]?.setCookie.split(';')[0] } })
    const res = { statusCode: 0, headers: {}, body: '', headersSent: false,
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this },
      end(value) { this.body += value ?? ''; this.headersSent = true; return this },
    }
    handler(req, res)
    await pending
    return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) }
  }
  return { db, users, blobs, reads, store, request }
}

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

test('permission changes during storage reads filter every report using the current grant', async t => {
  const h = await setup(t)
  await h.db.setTeamMember('team', h.users.view.userId, { dependencies: true, security: true })
  h.store.afterRead = () => h.db.setTeamMember('team', h.users.view.userId, { dependencies: false, security: false })
  const response = await h.request({ ids: ['a', 'b'] })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.reports.map(report => report.data.findings.map(finding => finding.id)), [['a-own'], ['b-own']])
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
