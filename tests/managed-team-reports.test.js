import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'

async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 3600000 }
  const blobs = new Map(), reads = [], sessions = {}
  for (const [i, role] of ['admin', 'manage', 'triage', 'view', 'none'].entries()) {
    const s = await createSession(config, db, { githubUserId: i + 1, login: role, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(s.userId, role)
    sessions[role] = s
  }
  await db.selectRepo({ repoId: 1, fullName: 'own/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: sessions.admin.userId }, Date.now())
  for (const [team, security, dependencies] of [['restricted', false, false], ['broad', true, true], ['no-deps', true, false], ['no-security', false, true]]) {
    await db.createTeam(team, team, Date.now())
    await db.setTeamRepo(team, 1, 'app')
    for (const s of Object.values(sessions)) await db.setTeamMember(team, s.userId, { security, dependencies })
  }
  const store = { async get(id) { reads.push(id); await store.afterRead?.(id); return blobs.get(id) } }
  async function seed(id, data, { directory = 'app', visible = true, filename = `${id}.json`, analyzer = null } = {}) {
    const body = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))
    blobs.set(id, body)
    await db.insertReport({ id, filename, analyzer, repoId: 1, repoDirectory: directory, contentType: 'application/json', byteSize: body.length, sha256: body.toString('base64'), uploadedBy: sessions.admin.userId, visible, bundleId: null, bundleIntegrity: null }, Date.now())
  }
  await seed('a', { findings: [
    { id: 'own', file: 'src/a.js' }, { id: 'other', file: 'src/b.js' },
    { id: 'dependent', file: 'node_modules/other/index.js' },
    [{ id: 'row', file: 'src/row.js' }, { id: 'sibling', file: 'node_modules/private/index.js' }],
    { id: 'linked', file: 'src/c.js' }, { id: 'transitive', file: 'src/d.js' },
  ] })
  await seed('b', { type: 'security', findings: [{ id: 'secret', file: 'src/secret.js' }, { id: 'downgraded', file: 'src/okay.js', security: false }] })
  await seed('links', [
    [{ id: 'sibling' }, { id: 'secret' }], [{ id: 'linked' }, { id: 'secret' }],
    [{ id: 'transitive' }, { id: 'unknown' }], [{ id: 'unknown' }, { id: 'linked' }],
    [{ id: 'own' }, { id: 'other' }, { id: 'dependent' }, { id: 'unavailable' }],
    [{ id: 'downgraded' }, { id: 'unavailable' }],
  ])
  // Neither unpublished nor out-of-scope links affect ordinary team answers.
  await seed('private-links', [[{ id: 'own' }, { id: 'secret' }]], { visible: false })
  await seed('foreign-links', [[{ id: 'other' }, { id: 'secret' }]], { directory: 'elsewhere' })
  let pending
  const handler = createManagedRequestHandler({ config, db, reportStore: store,
    originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track: p => { pending = p } })
  async function request(path, role = 'triage', method = 'GET', body) {
    const session = sessions[role]
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { url: path, method, headers: { cookie: session?.setCookie.split(';')[0], 'x-csrf-token': session?.csrfToken } })
    const res = { statusCode: 0, body: '', headersSent: false,
      writeHead(status) { this.statusCode = status }, write(data) { this.body += data; return true }, end(data) { this.body += data ?? ''; this.headersSent = true } }
    handler(req, res)
    await pending
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
  }
  return { db, store, seed, sessions, reads, request }
}

test('finding history requires triage or higher and uses the selected team visibility', async t => {
  const h = await fixture(t)
  await h.seed('matrix', { findings: [
    { id: 'plain', file: 'src/plain.js' }, { id: 'security', file: 'src/security.js', security: true },
    { id: 'dependency', file: 'node_modules/third/dep.js' },
    { id: 'both', file: 'node_modules/third/security.js', security: true },
  ] })
  for (const id of ['plain', 'security', 'dependency', 'both']) await h.db.setTriage(id, { fix: `private ${id}` }, h.sessions.admin.userId, 'admin', Date.now())
  const path = (team, id = 'plain') => `/api/reports/matrix/triage/history?team=${team}&finding=${id}`
  for (const role of ['none', 'view']) assert.notEqual((await h.request(path('broad'), role)).status, 200, role)
  for (const role of ['triage', 'manage', 'admin']) assert.equal((await h.request(path('broad'), role)).status, 200, role)
  for (const [team, allowed] of [
    ['restricted', ['plain']], ['no-deps', ['plain', 'security']],
    ['no-security', ['plain', 'dependency']], ['broad', ['plain', 'security', 'dependency', 'both']],
  ]) {
    for (const id of ['plain', 'security', 'dependency', 'both', 'missing']) {
      const result = await h.request(path(team, id))
      assert.equal(result.status, allowed.includes(id) ? 200 : 404, `${team}: ${id}`)
      if (!allowed.includes(id)) assert.equal(JSON.stringify(result.body).includes('private'), false)
    }
  }
  assert.equal((await h.request('/api/reports/matrix/triage/history?finding=plain')).status, 404, 'triage cannot omit team scope')
  assert.equal((await h.request(path('foreign'))).status, 404)
  // Links propagate security restrictions across reports, including transitively.
  for (const id of ['linked', 'transitive', 'row', 'sibling']) {
    assert.equal((await h.request(`/api/reports/a/triage/history?team=restricted&finding=${id}`)).status, 404, id)
  }
})

for (const change of ['security', 'dependencies', 'role', 'membership', 'links']) {
  test(`finding history discards an in-flight read after ${change} revocation`, async t => {
    const h = await fixture(t)
    const id = change === 'security' ? 'secret' : change === 'dependencies' ? 'dependent' : 'own'
    const report = change === 'security' ? 'b' : 'a'
    const team = change === 'links' ? 'restricted' : 'broad'
    await h.db.setTriage(id, { fix: 'must not leak' }, h.sessions.admin.userId, 'admin', Date.now())
    const read = h.db.listTriageHistory.bind(h.db)
    t.mock.method(h.db, 'listTriageHistory', async (...args) => {
      const events = await read(...args)
      if (change === 'role') await h.db.setUserRole(h.sessions.triage.userId, 'view')
      else if (change === 'membership') await h.db.removeTeamMember(team, h.sessions.triage.userId)
      else if (change === 'links') await h.seed('revoked-links', [[{ id: 'own' }, { id: 'secret' }]])
      else await h.db.setTeamMember(team, h.sessions.triage.userId, { security: true, dependencies: true, [change]: false })
      return events
    })
    const result = await h.request(`/api/reports/${report}/triage/history?team=${team}&finding=${id}`)
    assert.equal(result.status, 404)
    assert.equal(JSON.stringify(result.body).includes('must not leak'), false)
  })
}
const ids = report => (report.data.findings ?? report.data.groups).flat().map(f => f.id).toSorted()
const workspace = (h, team, role) => h.request(`/api/teams/${team}/reports`, role)

test('managed catalogs identify Claude Markdown before loading it, and team navigation serves its findings', async t => {
  const h = await fixture(t)
  await h.seed('claude', '# Security finding\n\n---\n**Severity:** high\n', { filename: 'report.md', analyzer: 'claude-security' })
  const catalog = await h.request('/api/teams')
  assert.equal(catalog.status, 200)
  const reports = catalog.body.teams.find(team => team.id === 'broad').reports
  assert.equal(reports.find(report => report.id === 'claude').analyzer, 'claude-security')
  assert.equal(reports.find(report => report.id === 'a').analyzer, null)
  assert.deepEqual(h.reads, [], 'sidebar branding needs no report content fetch')
  const loaded = (await workspace(h, 'broad')).body.reports.find(report => report.id === 'claude')
  assert.equal(loaded.filename, 'report.md')
  assert.equal(loaded.data.source, 'claude-security')
  assert.equal(loaded.data.findings.length, 1)
})

test('team workspaces use only their own grants and links; security removes rows before dependencies remove components', async t => {
  const h = await fixture(t)
  const restricted = await workspace(h, 'restricted')
  assert.equal(restricted.status, 200)
  assert.deepEqual(restricted.body.reports.map(r => r.id), ['a', 'b', 'links'])
  assert.deepEqual(ids(restricted.body.reports[0]), ['other', 'own'])
  assert.deepEqual(ids(restricted.body.reports[1]), ['downgraded'])
  assert.deepEqual(restricted.body.reports[2].data.links, [['own', 'other']])
  const noSecurity = (await workspace(h, 'no-security')).body.reports
  assert.deepEqual(ids(noSecurity[0]), ['dependent', 'other', 'own'])
  const noDeps = (await workspace(h, 'no-deps')).body.reports
  assert.deepEqual(ids(noDeps[0]), ['linked', 'other', 'own', 'row', 'transitive'])
  assert.equal(noDeps[0].data.findings.flat().find(f => f.id === 'row').isSecurity, true, 'hidden dependency sibling still makes the row security-related')
  assert.deepEqual(noDeps[2].data.links, [['linked', 'secret'], ['own', 'other']])
  assert.equal(ids((await workspace(h, 'broad')).body.reports[0]).length, 7)
  for (const role of ['admin', 'manage']) assert.equal(ids((await workspace(h, 'restricted', role)).body.reports[0]).length, 7, role)
})

test('ordinary users cannot fetch individual or arbitrary report batches; invalid teams fail before blob reads', async t => {
  const h = await fixture(t)
  for (const role of ['view', 'triage', 'none']) {
    assert.equal((await h.request('/api/reports/a', role)).status, 403)
    assert.equal((await h.request('/api/reports/query', role, 'POST', { ids: ['a'] })).status, 403)
  }
  assert.equal((await workspace(h, 'missing')).status, 404)
  assert.deepEqual(h.reads, [])
  for (const role of ['admin', 'manage']) assert.equal((await h.request('/api/reports/a', role)).status, 200)
  await h.db.createTeam('empty', 'Empty', Date.now())
  await h.db.setTeamMember('empty', h.sessions.triage.userId, { dependencies: false, security: false })
  assert.deepEqual((await workspace(h, 'empty')).body, { reports: [] })
})

test('triage and comments use the team visible IDs, while annotations remain shared by finding ID', async t => {
  const h = await fixture(t)
  const triage = team => `/api/reports/a/triage?team=${team}`
  assert.equal((await h.request(triage('broad'), 'triage', 'POST', { entries: { own: { color: 'red' }, linked: { color: 'blue' } } })).status, 200)
  assert.deepEqual((await h.request(triage('restricted'))).body.entries, { own: { color: 'red' } })
  assert.equal((await h.request(triage('restricted'), 'triage', 'POST', { entries: { linked: { color: 'red' } } })).status, 404)
  assert.equal((await h.request('/api/reports/a/triage')).status, 404, 'no union-of-teams fallback')
  assert.equal((await h.request('/api/reports/a/triage/history?team=restricted&finding=linked')).status, 404)
  const comment = await h.request('/api/reports/a/comments?team=broad', 'triage', 'POST', { findingId: 'linked', body: 'Hidden discussion' })
  assert.equal(comment.status, 201)
  assert.deepEqual((await h.request('/api/reports/a/comments?team=restricted')).body.comments, [])
  assert.equal((await h.request('/api/reports/a/comments?team=no-deps')).body.comments[0].id, comment.body.comment.id)
})

test('membership, grants, links and report changes during storage reads reject the complete workspace', async t => {
  for (const change of ['membership', 'permission', 'links']) {
    const h = await fixture(t)
    h.store.afterRead = async () => {
      h.store.afterRead = null
      if (change === 'membership') await h.db.removeTeamMember('restricted', h.sessions.triage.userId)
      if (change === 'permission') await h.db.setTeamMember('restricted', h.sessions.triage.userId, { dependencies: true, security: true })
      if (change === 'links') await h.seed('new-links', [[{ id: 'other' }, { id: 'secret' }]])
    }
    assert.equal((await workspace(h, 'restricted')).status, 404, change)
  }
})

test('warm annotation authorization invalidates when team links change, without splitting triage state', async t => {
  const h = await fixture(t)
  await h.db.setTriageEntries([['own', { color: 'red' }]], h.sessions.admin.userId, 'admin', Date.now(), 'a')
  await workspace(h, 'restricted')
  h.reads.length = 0
  assert.deepEqual((await h.request('/api/reports/a/triage?team=restricted')).body.entries, { own: { color: 'red' } })
  assert.deepEqual(h.reads, [], 'reuse only a matching workspace visibility snapshot')
  await h.seed('new-links', [[{ id: 'own' }, { id: 'secret' }]])
  assert.deepEqual((await h.request('/api/reports/a/triage?team=restricted')).body.entries, {})
  assert.deepEqual((await h.request('/api/reports/a/triage?team=broad')).body.entries, { own: { color: 'red' } })
})
