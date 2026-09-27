import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable, Writable } from 'node:stream'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { withReap } from '../server-common/reap.ts'
import { createHttpServer } from '../server-e2e/http.ts'

async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const config = { allowShare: true, sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 3600000 }
  const blobs = new Map(), reads = [], sessions = {}
  for (const [i, role] of ['admin', 'manage', 'triage', 'view', 'none', 'outsider'].entries()) {
    const session = await createSession(config, db, { githubUserId: i + 1, login: role, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role === 'outsider' ? 'manage' : role)
    sessions[role] = session
  }
  for (const repoId of [1, 2]) await db.selectRepo({ repoId, fullName: `org/repo${repoId}`, private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: sessions.admin.userId }, Date.now())
  for (const [team, repoId, path] of [['team', 1, 'app'], ['other', 2, ''], ['whole', 1, '']]) {
    await db.createTeam(team, team, Date.now())
    await db.setTeamRepo(team, repoId, path)
    for (const [role, session] of Object.entries(sessions)) if (role !== 'outsider') await db.setTeamMember(team, session.userId, { dependencies: true, security: true })
  }
  async function seed(id, { repoId = 1, directory = 'app', visible = true } = {}) {
    const body = Buffer.from(JSON.stringify({ findings: [{ id: `${id}-finding`, file: 'src/a.js' }] }))
    blobs.set(id, body)
    await db.insertReport({ id, filename: `${id}.json`, contentType: 'application/json', repoId, repoDirectory: directory, visible,
      byteSize: body.length, sha256: body.toString('base64'), uploadedBy: sessions.manage.userId, bundleId: 'bundle', bundleIntegrity: null }, Date.now())
  }
  for (const [id, repoId] of [['bundle', 1], ['foreign-bundle', 2]]) await db.insertBundle({ id, integrity: id, filename: `${id}.map`, kind: 'sourcemap', byteSize: 2, uploadedBy: sessions.manage.userId, uploadedByLogin: 'manage', repoId }, Date.now())
  await seed('visible'); await seed('child', { directory: 'app/child' })
  await seed('draft', { visible: false }); await seed('sibling', { directory: 'application' }); await seed('foreign', { repoId: 2 })
  const store = { async get(id) { reads.push(id); await store.afterRead?.(); return blobs.get(id) } }
  const deps = { config, db, reportStore: store, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {},
    next() { throw new Error('Share escaped to the combined server') },
    bundleStore: { open() { reads.push('bundle'); return Promise.resolve({ stream: Readable.from(['{}']), size: 2 }) } },
  }
  const request = async (path, { role, token, method = 'GET', headers = {} } = {}) => {
    const session = sessions[role]
    const req = Readable.from([])
    Object.assign(req, { url: path, method, headers: { cookie: session?.setCookie.split(';')[0], 'x-csrf-token': session?.csrfToken,
      ...(token === undefined ? {} : { 'x-deepview-share': token }), ...headers } })
    const chunks = []
    const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback() } })
    res.writeHead = (status, values) => { res.status = status; res.headers = values }
    await withReap(createManagedRequestHandler(deps), { managed: () => Promise.reject(new Error('Share reached reap')) }, { secret: 'cron' })(req, res)
    const text = Buffer.concat(chunks).toString()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
  }
  const mint = async (team = 'team') => {
    const response = await request(`/api/teams/${team}/share`, { role: 'manage', method: 'POST' })
    assert.equal(response.status, 200)
    return response.body.path.split('.').at(-1)
  }
  return { db, config, sessions, reads, store, deps, request, mint }
}

test('public sharing is opt-in, requires team management and CSRF; the token is not a login session', async t => {
  const h = await fixture(t)
  h.config.allowShare = false
  assert.equal((await h.request('/api/teams/team/share', { role: 'manage', method: 'POST' })).status, 404)
  h.config.allowShare = true
  for (const role of ['triage', 'view', 'none', 'outsider', undefined]) {
    assert.notEqual((await h.request('/api/teams/team/share', { role, method: 'POST' })).status, 200, role)
  }
  assert.equal((await h.request('/api/teams/team/share', { role: 'manage', method: 'POST', headers: { 'x-csrf-token': 'wrong' } })).status, 403)
  h.deps.originGate.isOriginAllowed = () => false
  assert.equal((await h.request('/api/teams/team/share', { role: 'manage', method: 'POST' })).status, 403)
  h.deps.originGate.isOriginAllowed = () => true
  const token = await h.mint()
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u)
  assert.ok(await h.db.getWorkspaceShare(hashToken(token)))
  assert.equal(await h.db.getWorkspaceShare(token), null, 'only a hash is stored')
  assert.equal((await h.request('/api/auth/session', { headers: { cookie: `sid=${token}` } })).status, 401)
  h.config.allowShare = false
  assert.equal((await h.request('/api/teams/team/reports', { token })).status, 401)
})

test('disabling sharing blocks every public route even when valid links remain in the database', async t => {
  const h = await fixture(t), token = await h.mint('whole')
  assert.equal((await h.request('/api/teams/whole/shared', { token })).status, 200)
  const getShare = h.db.getWorkspaceShare
  h.db.getWorkspaceShare = () => { assert.fail('Disabled sharing looked up a stored token') }
  for (const enabled of [false, undefined]) {
    h.config.allowShare = enabled
    assert.equal((await h.request('/api/config')).body.managed.allowShare, undefined)
    for (const method of ['POST', 'DELETE']) {
      assert.equal((await h.request('/api/teams/whole/share', { role: 'manage', method })).status, 404)
    }
    for (const path of ['/api/teams/whole/shared', '/api/teams/whole/reports',
      '/api/reports/visible/triage', '/api/reports/visible/triage/history?finding=visible-finding',
      '/api/reports/visible/comments', '/api/reports/visible/sources',
      '/api/bundles/bundle/metadata', '/api/bundles/bundle/contents', '/api/bundles/bundle/download',
      '/api/bundles/bundle/advisories', '/api/auth/session', '/api/admin/users', '/api/future-route']) {
      for (const method of ['GET', 'HEAD']) {
        for (const role of [undefined, 'admin']) {
          assert.equal((await h.request(path, { token, role, method })).status, 401, path)
        }
      }
    }
  }
  assert.deepEqual(h.reads, [], 'disabled links cannot read any blobs')
  h.db.getWorkspaceShare = getShare
  assert.ok(await h.db.getWorkspaceShare(hashToken(token)), 'the link still exists in the database')
  h.config.allowShare = true
  assert.equal((await h.request('/api/teams/whole/shared', { token })).status, 200)
})

test('an anonymous token sees one published workspace, its annotations and no global endpoints', async t => {
  const h = await fixture(t), token = await h.mint()
  const bootstrap = await h.request('/api/teams/team/shared', { token })
  assert.equal(bootstrap.status, 200)
  assert.equal(bootstrap.body.user.role, 'view')
  assert.equal(bootstrap.body.csrfToken, undefined)
  assert.deepEqual(bootstrap.body.team.reports.map(r => r.id), ['child', 'visible'])
  assert.deepEqual(bootstrap.body.team.bundles, [])
  assert.deepEqual((await h.request('/api/teams/team/reports', { token })).body.reports.map(r => r.id), ['child', 'visible'])
  await h.db.setTriage('visible-finding', { color: 'red' }, null, 'manager', Date.now())
  await h.db.setTriage('foreign-finding', { color: 'blue' }, null, 'manager', Date.now())
  assert.deepEqual((await h.request('/api/reports/visible/triage', { token })).body.entries, { 'visible-finding': { color: 'red' } })
  assert.equal((await h.request('/api/reports/visible/triage/history?finding=foreign-finding', { token })).status, 404)
  assert.equal((await h.request('/api/reports/visible/triage/history?finding=visible-finding', { token })).status, 200)
  await h.db.createComment({ findingId: 'visible-finding', body: 'Shared comment', authorId: h.sessions.manage.userId, authorLogin: 'manage', reportId: 'visible' }, Date.now())
  assert.equal((await h.request('/api/reports/visible/comments', { token })).body.comments[0].body, 'Shared comment')
  h.reads.length = 0
  const denied = ['/api/teams', '/api/teams/other/shared', '/api/teams/other/reports', '/api/teams/whole/reports',
    '/api/reports/foreign/triage', '/api/reports/draft/comments', '/api/reports/sibling/sources',
    '/api/reports/visible', '/api/reports/visible/triage?team=other', '/api/reports/visible/triage?team=team&team=other',
    '/api/reports/query', '/api/auth/session', '/api/auth/logout', '/api/config', '/api/oauth/github/login', '/api/oauth/github/callback',
    '/api/admin/users', '/api/admin/reports', '/api/admin/history', '/api/admin/bundles', '/api/admin/teams', '/api/admin/models',
    '/api/avatar/user', '/api/github/repos', '/api/sync', '/api/sync/events', '/api/objstore/mint', '/api/npm/advisories', '/api/future-route',
    '/api/bundles/bundle/download', '/api/bundles/foreign-bundle/metadata', '/api/reap', '/', '/api/teams/team/share']
  for (const path of denied) {
    for (const role of [undefined, 'admin']) {
    const result = await h.request(path, { token, role, headers: { authorization: 'Bearer cron' } })
    assert.ok([401, 403, 404].includes(result.status), `${path}: ${result.status}`)
    }
  }
  assert.deepEqual(h.reads, [], 'reject before blob access or fallback routing')
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await h.request('/api/reports/visible/triage', { token, role: 'admin', method })).status, 403)
  for (const invalid of ['', 'wrong', token.slice(0, -1), 'A'.repeat(43), `${token},${token}`]) assert.equal((await h.request('/api/teams/team/reports', { token: invalid, role: 'admin' })).status, 401)
})

test('whole-repository bundles stay scoped and directory shares expose only cited source files', async t => {
  const h = await fixture(t), token = await h.mint(), whole = await h.mint('whole')
  assert.equal((await h.request('/api/bundles/bundle/download', { token: whole })).status, 200)
  assert.equal((await h.request('/api/bundles/foreign-bundle/download', { token: whole })).status, 404)
  h.deps.reportSourcesCache = { open(report, bundle, permissions, paths) {
    assert.equal(report.id, 'visible'); assert.equal(bundle.id, 'bundle')
    assert.deepEqual([...paths], ['src/a.js'])
    return Promise.resolve({ stream: Readable.from(['{}']), size: 2, repo: { github: 'org/repo1' } })
  } }
  assert.equal((await h.request('/api/reports/visible/sources', { token })).status, 200)
  h.deps.bundleStore.open = async () => {
    await h.db.setBundleRepo('bundle', 2)
    return { stream: Readable.from(['{}']), size: 2 }
  }
  assert.equal((await h.request('/api/bundles/bundle/download', { token: whole })).status, 404)
})

test('revocation and live role, membership, publication and scope changes invalidate public reads', async t => {
  for (const change of ['revoke', 'role', 'membership', 'publication', 'scope', 'delete', 'flag']) {
    const h = await fixture(t), token = await h.mint()
    h.store.afterRead = async () => {
      h.store.afterRead = null
      if (change === 'revoke') assert.equal((await h.request('/api/teams/team/share', { role: 'manage', method: 'DELETE' })).status, 200)
      if (change === 'role') await h.db.setUserRole(h.sessions.manage.userId, 'view')
      if (change === 'membership') await h.db.removeTeamMember('team', h.sessions.manage.userId)
      if (change === 'publication') await h.db.setReportVisible('visible', false)
      if (change === 'scope') await h.db.removeTeamRepo('team', 1)
      if (change === 'delete') await h.db.deleteTeam('team')
      if (change === 'flag') h.config.allowShare = false
    }
    const result = await h.request('/api/teams/team/reports', { token })
    assert.equal(result.status, 404, change)
    assert.equal(result.body.reports, undefined, change)
  }
})

test('public capabilities cannot enter the WebSocket upgrade transport', () => {
  const server = createHttpServer({ serverInfo: { mode: 'e2e', managed: null },
    wss: { handleUpgrade() { assert.fail('Share reached WebSocket upgrade') } }, isOriginAllowed: () => true,
  })
  let response
  server.emit('upgrade', { url: '/api/sync', headers: { 'x-deepview-share': 'A'.repeat(43) } }, { end(value) { response = value } }, Buffer.alloc(0))
  assert.match(response, /^HTTP\/1\.1 403 /u)
  server.close()
})
