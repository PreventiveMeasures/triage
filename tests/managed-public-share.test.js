import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
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
  async function seed(id, { repoId = 1, directory = 'app', visible = true, analyzer = null, findings = [{ id: `${id}-finding`, file: 'src/a.js' }] } = {}) {
    const body = Buffer.from(JSON.stringify({ findings }))
    blobs.set(id, body)
    await db.insertReport({ id, filename: `${id}.json`, analyzer, contentType: 'application/json', repoId, repoDirectory: directory, visible,
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
  const request = async (path, { role, token, method = 'GET', headers = {}, body } = {}) => {
    const session = sessions[role]
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { url: path, method, headers: { cookie: session?.setCookie.split(';')[0], 'x-csrf-token': session?.csrfToken,
      ...(token === undefined ? {} : { 'x-deepview-share': token }), ...headers } })
    const chunks = []
    const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback() } })
    res.writeHead = (status, values) => { res.status = status; res.headers = values }
    await withReap(createManagedRequestHandler(deps), { managed: () => Promise.reject(new Error('Share reached reap')) }, { secret: 'cron' })(req, res)
    const text = Buffer.concat(chunks).toString()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
  }
  const mint = async (team = 'team', permissions) => {
    const response = await request(`/api/teams/${team}/share`, { role: 'manage', method: 'POST', body: permissions })
    assert.equal(response.status, 200)
    const token = response.body.path.split('.').at(-1)
    assert.equal(new URL(response.body.path, 'https://triage.test').pathname, `/team/${(await db.listTeams()).find(entry => entry.id === team).slug}`)
    assert.equal(new URL(response.body.path, 'https://triage.test').hash, `#public=${hashToken(token).slice(0, 8)}.${token}`)
    return token
  }
  return { db, config, sessions, reads, store, deps, request, mint, seed }
}

test('public workspace catalogs preserve analyzer metadata without loading report content', async t => {
  const h = await fixture(t)
  await h.seed('claude', { analyzer: 'claude-security' })
  const token = await h.mint()
  // Unavailable content only leaves the workspace's App classification unknown.
  h.store.get = id => { h.reads.push(id); return Promise.resolve(null) }
  const response = await h.request('/api/teams/team/shared', { token })
  assert.equal(response.status, 200)
  assert.equal(response.body.team.reports.find(report => report.id === 'claude').analyzer, 'claude-security')
  assert.equal(response.body.team.reports.find(report => report.id === 'visible').analyzer, null)
  assert.equal(response.body.team.app, null)
})

test('directory team links include bundles at or below their scope and immediately lose moved bundles', async t => {
  const h = await fixture(t), token = await h.mint()
  const catalog = async () => (await h.request('/api/teams/team/shared', { token })).body.team.bundles
  assert.deepEqual(await catalog(), [], 'root bundles are outside /app')
  for (const directory of ['app', 'app/child']) {
    await h.db.setBundleRepo('bundle', 1, directory)
    assert.equal((await catalog())[0].repoDirectory, directory)
    assert.equal((await h.request('/api/bundles/bundle/download', { token })).status, 200)
  }
  await h.db.setBundleRepo('bundle', 1, 'application')
  assert.deepEqual(await catalog(), [])
  for (const suffix of ['metadata', 'contents', 'download', 'advisories']) {
    assert.equal((await h.request(`/api/bundles/bundle/${suffix}`, { token })).status, 404)
  }
})

test('link listings name the private repositories in the team\'s scope for its managers, internal ones as such', async t => {
  const h = await fixture(t)
  const listing = (team, role = 'manage') => h.request(`/api/teams/${team}/share`, { role })
  const repo = (repoId, fields) => h.db.selectRepo({ repoId, fullName: `org/repo${repoId}`, installationId: 7, defaultBranch: 'main', htmlUrl: '', addedBy: h.sessions.admin.userId, ...fields }, Date.now())
  const repo1 = { fullName: 'org/repo1', visibility: 'private' }, repo2 = { fullName: 'org/repo2', visibility: 'private' }
  assert.deepEqual((await listing('team')).body, { shares: [], privateRepositories: [repo1] }, 'a directory scope names its whole repository')
  assert.deepEqual((await listing('other', 'admin')).body.privateRepositories, [repo2])
  await h.db.setTeamRepo('team', 2, '')
  assert.deepEqual((await listing('team')).body.privateRepositories, [repo1, repo2])
  // GitHub calls an internal repository not private; it is stored as private all the same.
  await repo(2, { private: false, visibility: 'internal' })
  assert.equal((await h.db.listAllRepos()).find(entry => entry.repoId === 2).private, true)
  assert.deepEqual((await listing('team')).body.privateRepositories, [repo1, { ...repo2, visibility: 'internal' }])
  await repo(1, { private: false, visibility: 'public' })
  assert.deepEqual((await listing('team')).body.privateRepositories, [{ ...repo2, visibility: 'internal' }])
  assert.deepEqual((await listing('whole')).body.privateRepositories, [])
  for (const role of ['triage', 'view', 'none', 'outsider']) {
    const response = await listing('other', role)
    assert.notEqual(response.status, 200, role)
    assert.equal(response.body.privateRepositories, undefined, role)
  }
})

test('link listings ask GitHub once for repositories selected before visibility was recorded', async t => {
  const h = await fixture(t)
  Object.assign(h.config, { githubAppId: '1', githubAppPrivateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) })
  // Selected through the App before visibility was recorded: GitHub's private flag alone.
  for (const repoId of [1, 2]) await h.db.selectRepo({ repoId, fullName: `org/repo${repoId}`, private: false, installationId: 7, defaultBranch: 'main', htmlUrl: '', addedBy: h.sessions.admin.userId }, Date.now())
  await h.db.setTeamRepo('team', 2, '')
  const answers = { 1: [{ id: 1, private: false, visibility: 'internal' }], 2: [null, { id: 2, private: false, visibility: 'public' }] }, requests = []
  t.mock.method(globalThis, 'fetch', url => {
    const path = new URL(url).pathname
    if (path === '/app/installations/7/access_tokens') return Response.json({ token: 'installation', expires_at: new Date(Date.now() + 3600000).toISOString() })
    requests.push(path)
    const repoAnswers = answers[path.at(-1)]
    const answer = repoAnswers.length > 1 ? repoAnswers.shift() : repoAnswers[0]
    return answer ? Response.json(answer) : new Response('unavailable', { status: 503 })
  })
  const listing = async () => (await h.request('/api/teams/team/share', { role: 'manage' })).body.privateRepositories
  assert.deepEqual(await listing(), [{ fullName: 'org/repo1', visibility: 'internal' }, { fullName: 'org/repo2', visibility: null }],
    'an internal repository is recorded, and one GitHub could not answer for is named as unchecked')
  assert.deepEqual((await h.db.listAllRepos()).map(repo => [repo.repoId, repo.private, repo.visibility]), [[1, true, 'internal'], [2, false, null]])
  assert.deepEqual(await listing(), [{ fullName: 'org/repo1', visibility: 'internal' }], 'the unchecked one is asked again, and is public')
  assert.deepEqual(requests, ['/repos/org/repo1', '/repos/org/repo2', '/repos/org/repo2'], 'a recorded visibility is not asked for again')
  assert.deepEqual(await listing(), [{ fullName: 'org/repo1', visibility: 'internal' }])
  assert.equal(requests.length, 3)
})

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
  assert.deepEqual((await h.db.getWorkspaceShare(hashToken(token))).permissions, { dependencies: false, security: false })
  h.config.allowShare = false
  assert.equal((await h.request('/api/teams/team/reports', { token })).status, 401)
})

test('disabling sharing blocks every public route even when valid links remain in the database', async t => {
  const h = await fixture(t), token = await h.mint('whole')
  assert.equal((await h.request('/api/teams/whole/shared', { token })).status, 200)
  h.reads.length = 0
  const getShare = h.db.getWorkspaceShare
  h.db.getWorkspaceShare = () => { assert.fail('Disabled sharing looked up a stored token') }
  for (const enabled of [false, undefined]) {
    h.config.allowShare = enabled
    assert.equal((await h.request('/api/config')).body.managed.allowShare, undefined)
    for (const method of ['GET', 'POST', 'DELETE']) {
      assert.equal((await h.request('/api/teams/whole/share', { role: 'manage', method })).status, 404)
    }
    assert.equal((await h.request('/api/admin/links', { role: 'admin' })).status, 404)
    assert.equal((await h.request(`/api/teams/whole/share/${hashToken(token)}`, { role: 'admin', method: 'PATCH', body: { security: true } })).status, 404)
    for (const path of [`/api/shares/${hashToken(token).slice(0, 8)}/workspace`, '/api/teams/whole/shared', '/api/teams/whole/reports',
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

test('link IDs bootstrap only the token workspace and legacy team prefixes still work', async t => {
  const h = await fixture(t), other = await h.mint('other'), token = await h.mint()
  const path = `/api/shares/${hashToken(token).slice(0, 8)}/workspace`
  const otherPath = `/api/shares/${hashToken(other).slice(0, 8)}/workspace`
  const bootstrap = await h.request(path, { token })
  assert.equal(bootstrap.status, 200)
  assert.equal(bootstrap.body.team.id, 'team')
  assert.deepEqual([...new Set(h.reads)].toSorted(), ['child', 'visible'], 'a link classifies only its own published workspace')
  h.reads.length = 0
  assert.deepEqual(bootstrap.body, (await h.request('/api/teams/team/shared', { token })).body)
  assert.deepEqual(bootstrap.body, (await h.request('/api/shares/team/workspace', { token })).body, 'legacy links keep working')
  assert.equal((await h.request(otherPath, { token: other })).body.team.id, 'other')
  assert.deepEqual([...new Set(h.reads)], ['foreign'])
  h.reads.length = 0
  for (const role of [undefined, 'admin']) {
    assert.equal((await h.request(path, { token: other, role })).status, 404)
    assert.equal((await h.request(otherPath, { token, role })).status, 404)
    assert.equal((await h.request('/api/shares/other/workspace', { token, role })).status, 404)
    assert.equal((await h.request(path, { token: 'A'.repeat(43), role })).status, 401)
    assert.equal((await h.request(path, { role })).status, 401, 'a link ID or login cookie is not a capability')
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await h.request(path, { token, method })).status, 403)
  for (const global of ['/api/shares', '/api/shares/workspace', '/api/shares/all/workspace']) {
    assert.notEqual((await h.request(global, { token })).status, 200)
  }
  assert.equal((await h.request(`${path}?team=other`, { token })).status, 404)
  assert.deepEqual(h.reads, [], 'refused and repeated bootstraps read nothing more')
})

test('an anonymous token sees one published workspace, its annotations and no global endpoints', async t => {
  const h = await fixture(t), token = await h.mint()
  const bootstrap = await h.request('/api/teams/team/shared', { token })
  assert.equal(bootstrap.status, 200)
  assert.equal(bootstrap.body.user.role, 'view')
  assert.equal(bootstrap.body.csrfToken, undefined)
  assert.deepEqual(bootstrap.body.team.reports.map(r => r.id), ['child', 'visible'])
  assert.deepEqual(bootstrap.body.team.reports.map(r => [r.repoFullName, r.repoDirectory]), [['org/repo1', 'app/child'], ['org/repo1', 'app']])
  assert.deepEqual(bootstrap.body.team.bundles, [])
  assert.deepEqual((await h.request('/api/teams/team/reports', { token })).body.reports.map(r => r.id), ['child', 'visible'])
  await h.db.setTriage('visible-finding', { color: 'red' }, null, 'manager', Date.now())
  await h.db.setTriage('foreign-finding', { color: 'blue' }, null, 'manager', Date.now())
  assert.deepEqual((await h.request('/api/reports/visible/triage', { token })).body.entries, { 'visible-finding': { color: 'red' } })
  for (const finding of ['foreign-finding', 'visible-finding']) {
    for (const role of [undefined, 'triage', 'admin']) {
      for (const method of ['GET', 'HEAD']) {
        assert.equal((await h.request(`/api/reports/visible/triage/history?finding=${finding}`, { token, role, method })).status, 403)
      }
    }
  }
  await h.db.createComment({ findingId: 'visible-finding', body: 'Shared comment', authorId: h.sessions.manage.userId, authorLogin: 'manage', reportId: 'visible' }, Date.now())
  assert.equal((await h.request('/api/reports/visible/comments', { token })).body.comments[0].body, 'Shared comment')
  h.reads.length = 0
  const denied = ['/api/teams', '/api/teams/other/shared', '/api/teams/other/reports', '/api/teams/whole/reports',
    '/api/reports/foreign/triage', '/api/reports/draft/comments', '/api/reports/sibling/sources',
    '/api/reports/visible', '/api/reports/visible/triage?team=other', '/api/reports/visible/triage?team=team&team=other',
    '/api/reports/query', '/api/auth/session', '/api/auth/logout', '/api/config', '/api/oauth/github/login', '/api/oauth/github/callback', '/api/teams/team/fixes',
    '/api/admin/users', '/api/admin/reports', '/api/admin/history', '/api/admin/bundles', '/api/admin/teams', '/api/admin/scan/models', '/api/admin/links',
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

test('warm encoded public responses recheck the live capability before sending cached findings', async t => {
  const h = await fixture(t), token = await h.mint()
  const path = '/api/teams/team/reports'
  assert.equal((await h.request(path, { token })).status, 200)
  const reads = h.reads.length, snapshot = h.db.getWorkspaceShare
  let first = true
  t.mock.method(h.db, 'getWorkspaceShare', async (...args) => {
    const result = await snapshot(...args)
    if (first) { first = false; h.config.allowShare = false }
    return result
  })
  const result = await h.request(path, { token })
  assert.equal(result.status, 404)
  assert.equal(result.body.reports, undefined)
  assert.equal(h.reads.length, reads)
})

test('link permissions are independent opt-ins and edits filter cached findings, annotations and sources', async t => {
  const h = await fixture(t)
  const findings = [
    { id: 'own', file: 'src/own.js' }, { id: 'secure', file: 'src/security.js', security: true },
    { id: 'dep', file: 'node_modules/third/dep.js' }, { id: 'secure-dep', file: 'node_modules/third/security.js', security: true },
  ]
  await h.seed('mixed', { findings })
  for (const finding of findings) {
    await h.db.setTriage(finding.id, { color: 'red' }, null, 'manager', Date.now())
    await h.db.createComment({ findingId: finding.id, body: finding.id, authorId: h.sessions.manage.userId, authorLogin: 'manage', reportId: 'mixed' }, Date.now())
  }
  const token = await h.mint()
  const id = hashToken(token), separate = await h.mint()
  const cacheKeys = new Set()
  for (const [security, dependencies, expected] of [
    [false, false, ['own']], [true, false, ['own', 'secure']], [false, true, ['own', 'dep']],
    [true, true, ['own', 'secure', 'dep', 'secure-dep']], [false, false, ['own']],
  ]) {
    assert.equal((await h.request(`/api/teams/team/share/${id}`, { role: 'manage', method: 'PATCH', body: { security, dependencies } })).status, 200)
    const bootstrap = await h.request('/api/teams/team/shared', { token })
    assert.deepEqual(bootstrap.body.team.permissions, { security, dependencies })
    cacheKeys.add(bootstrap.body.team.reports.find(report => report.id === 'mixed').cacheKey)
    const reports = await h.request('/api/teams/team/reports', { token })
    assert.deepEqual(reports.body.reports.find(report => report.id === 'mixed').data.findings.map(finding => finding.id), expected)
    assert.deepEqual(Object.keys((await h.request('/api/reports/mixed/triage', { token })).body.entries).toSorted(), [...expected].toSorted())
    assert.deepEqual((await h.request('/api/reports/mixed/comments', { token })).body.comments.map(comment => comment.body).toSorted(), [...expected].toSorted())
    assert.equal((await h.request('/api/reports/mixed/triage/history?finding=secure-dep', { token })).status, 403)
    h.deps.reportSourcesCache = { open(_report, _bundle, permissions, paths) {
      assert.deepEqual(permissions, { security, dependencies })
      assert.deepEqual([...paths].toSorted(), findings.filter(finding => expected.includes(finding.id)).map(finding => finding.file).toSorted())
      return Promise.resolve({ stream: Readable.from(['{}']), size: 2, repo: { github: 'org/repo1' } })
    } }
    assert.equal((await h.request('/api/reports/mixed/sources', { token })).status, 200)
    assert.deepEqual((await h.db.getWorkspaceShare(hashToken(separate))).permissions, { dependencies: false, security: false })
  }
  assert.equal(cacheKeys.size, 4, 'permission edits change the client report cache key')
  const notOptedIn = await h.mint('team', { security: 'true', dependencies: 1 })
  assert.deepEqual((await h.db.getWorkspaceShare(hashToken(notOptedIn))).permissions, { dependencies: false, security: false })
})

test('link listings include creators, scope managers to their teams, and let admins manage all links', async t => {
  const h = await fixture(t), other = await h.mint('other'), own = await h.mint()
  await h.db.removeTeamMember('other', h.sessions.manage.userId)
  await h.db.removeTeamMember('other', h.sessions.admin.userId)
  const listing = await h.request('/api/admin/links', { role: 'manage' })
  assert.equal(listing.status, 200)
  assert.deepEqual(listing.body.shares.map(link => link.teamId), ['team'])
  const link = listing.body.shares[0]
  assert.equal(link.createdBy, 'manage')
  assert.ok(link.createdAt > 0)
  assert.equal(link.id, hashToken(own))
  assert.ok(!JSON.stringify(listing.body).includes(own), 'list never reveals a bearer token')
  assert.deepEqual((await h.request('/api/admin/links', { role: 'outsider' })).body.shares, [])
  for (const role of ['view', 'triage', 'none', undefined]) assert.notEqual((await h.request('/api/admin/links', { role })).status, 200)
  assert.deepEqual(new Set((await h.request('/api/admin/links', { role: 'admin' })).body.shares.map(share => share.teamId)), new Set(['team', 'other']))
  const path = `/api/teams/other/share/${hashToken(other)}`
  assert.equal((await h.request('/api/teams/other/share', { role: 'manage' })).status, 404)
  assert.equal((await h.request('/api/teams/other/share', { role: 'admin' })).body.shares.length, 1)
  assert.equal((await h.request(path, { role: 'manage', method: 'PATCH', body: { security: true } })).status, 404)
  assert.equal((await h.request(path, { role: 'manage', method: 'DELETE' })).status, 404)
  assert.equal((await h.request(`/api/teams/team/share/${hashToken(other)}`, { role: 'manage', method: 'PATCH' })).status, 404)
  for (const method of ['PATCH', 'DELETE']) {
    assert.equal((await h.request(path, { role: 'admin', method, headers: { 'x-csrf-token': 'bad' } })).status, 403)
    assert.equal((await h.request(path, { role: 'admin', method, token: own })).status, 403)
  }
  assert.equal((await h.request(path, { role: 'admin', method: 'PATCH', body: { security: true } })).status, 200)
  assert.deepEqual((await h.request('/api/teams/other/share', { role: 'admin' })).body.shares[0].permissions, { dependencies: false, security: true })
  assert.equal((await h.request(path, { role: 'admin', method: 'DELETE' })).status, 200)
  assert.equal((await h.request('/api/admin/links', { role: 'admin' })).body.shares.length, 1)
  assert.equal((await h.request('/api/teams/team/shared', { token: own })).status, 200)
})

test('public security advisories require security opt-in and permission changes invalidate slow reads', async t => {
  const h = await fixture(t), token = await h.mint('whole')
  const id = hashToken(token)
  let inventories = 0
  h.deps.bundleCache = { advisoryInventory() { inventories++; return Promise.resolve({ packages: [], skipped: [] }) } }
  await h.db.insertBundle({ id: 'stasis', integrity: 'stasis', filename: 'sources.stasis', kind: 'stasis', byteSize: 2, uploadedBy: h.sessions.manage.userId, uploadedByLogin: 'manage', repoId: 1 }, Date.now())
  assert.equal((await h.request('/api/bundles/stasis/advisories', { token })).status, 403)
  assert.equal(inventories, 0)
  assert.equal((await h.request(`/api/teams/whole/share/${id}`, { role: 'manage', method: 'PATCH', body: { security: true } })).status, 200)
  assert.equal((await h.request('/api/bundles/stasis/advisories', { token })).status, 200, 'security is independent of dependency access')
  h.store.afterRead = async () => {
    h.store.afterRead = null
    await h.request(`/api/teams/whole/share/${id}`, { role: 'manage', method: 'PATCH', body: { security: false } })
  }
  assert.equal((await h.request('/api/teams/whole/reports', { token })).status, 404)
  h.deps.bundleCache.advisoryInventory = async () => {
    await h.request(`/api/teams/whole/share/${id}`, { role: 'manage', method: 'PATCH', body: { security: false } })
    return { packages: [], skipped: [] }
  }
  await h.request(`/api/teams/whole/share/${id}`, { role: 'manage', method: 'PATCH', body: { security: true } })
  assert.equal((await h.request('/api/bundles/stasis/advisories', { token })).status, 404)
})

test('public repository rechecks retain skipped dependencies and enforce security after repository lookups', async t => {
  const h = await fixture(t), token = await h.mint('whole')
  await h.db.setUserTokens(h.sessions.manage.userId, { accessToken: 'share-owner-token', refreshToken: null, expiresAt: null })
  const id = hashToken(token)
  const skipped = [{ ecosystem: 'cargo-git', name: 'private-crate', version: '1.0.0', because: 'Git crate.' }]
  h.deps.bundleCache = { advisoryInventory: () => Promise.resolve({ packages: [{ ecosystem: 'npm', name: 'dep', versions: ['1.0.0'] }], skipped }) }
  await h.db.insertBundle({ id: 'stasis', integrity: 'stasis', filename: 'sources.stasis', kind: 'stasis', byteSize: 2, uploadedBy: h.sessions.manage.userId, uploadedByLogin: 'manage', repoId: 1 }, Date.now())
  await h.request(`/api/teams/whole/share/${id}`, { role: 'manage', method: 'PATCH', body: { security: true } })
  let calls = 0, revoke = false
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++
    assert.equal(new Headers(init.headers).get('authorization'), null, 'public shares never borrow the owner credential')
    if (url.endsWith('/advisories/bulk')) return Response.json({})
    // Revoke mid-audit: the repository's listing is answered from the cache.
    if (revoke) await h.request(`/api/teams/whole/share/${id}`, { role: 'manage', method: 'PATCH', body: { security: false } })
    if (url.endsWith('/dep/1.0.0')) return Response.json({ name: 'dep', version: '1.0.0', repository: 'https://github.com/org/dep' })
    assert.match(url, /\/repos\/org\/dep\/security-advisories/u)
    return Response.json([{ ghsa_id: 'GHSA-2345-6789-cfgh', state: 'published', summary: 'Maintainer vulnerability', description: '# Impact\n\nFull advisory text.',
      vulnerabilities: [{ package: { ecosystem: 'npm', name: 'dep' }, vulnerable_version_range: '<2.0.0' }] }])
  })
  const path = '/api/bundles/stasis/advisories'
  const base = await h.request(path, { token })
  assert.equal(base.status, 200)
  assert.deepEqual(base.body.skipped, skipped)
  assert.deepEqual(base.body.advisories, [])
  assert.equal(calls, 1)
  const recheck = await h.request(`${path}?repoAdvisories=true&details=true`, { token })
  assert.equal(recheck.status, 200)
  assert.equal(recheck.body.advisories[0].source, 'repository')
  assert.equal(recheck.body.advisories[0].details, '# Impact\n\nFull advisory text.')
  assert.deepEqual(recheck.body.skipped, skipped)
  assert.equal(calls, 4)
  revoke = true
  const denied = await h.request(`${path}?repoAdvisories=true&details=true`, { token })
  assert.equal(denied.status, 404)
  assert.equal(denied.body.advisories, undefined)
  assert.equal(denied.body.skipped, undefined)
  assert.equal(calls, 6, 'the cached listing is withheld without asking GitHub again')
})

for (const focused of [false, true]) {
  test(`shared ${focused ? 'focused' : 'team'} annotation batches retain capability filtering and recheck revocation`, async t => {
    const h = await fixture(t), token = await h.mint()
    await h.db.setTriage('visible-finding', { color: 'blue' }, null, null, 1)
    await h.db.createComment({ findingId: 'child-finding', body: 'unrelated', authorId: null, authorLogin: null }, 1)
    const path = `/api/teams/team/annotations${focused ? '?reportId=visible' : ''}`
    const batch = await h.request(path, { token })
    assert.equal(batch.status, 200)
    assert.equal(Object.hasOwn(batch.body.reports, 'foreign'), false)
    const triage = await h.request('/api/reports/visible/triage', { token })
    const comments = await h.request('/api/reports/visible/comments', { token })
    const visibleIds = new Set(batch.body.reports.visible)
    assert.deepEqual(Object.fromEntries(Object.entries(batch.body.entries).filter(([id]) => visibleIds.has(id))), triage.body.entries)
    assert.deepEqual(batch.body.comments.filter(comment => visibleIds.has(comment.findingId)), comments.body.comments)
    if (focused) {
      assert.deepEqual(Object.keys(batch.body.reports), ['visible'])
      assert.deepEqual(batch.body.comments, [])
    }
    assert.equal((await h.request('/api/teams/other/annotations', { token })).status, 404)
    for (const report of ['missing', 'foreign', 'draft', 'sibling', '']) {
      assert.equal((await h.request(`/api/teams/team/annotations?reportId=${report}`, { token })).status, 404)
    }
    const original = h.db.getAnnotations
    h.db.getAnnotations = async ids => {
      const data = await original(ids)
      h.config.allowShare = false
      return data
    }
    const revoked = await h.request(path, { token })
    assert.equal(revoked.status, 404)
    assert.equal(revoked.body.reports, undefined)
  })
}
