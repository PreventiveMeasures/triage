import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { ensureUserAccessToken } from '../server-managed/github-oauth.ts'
import { runViewing } from '../server-managed/view-as.ts'
import { checkViewSessions } from './_managed-view-sessions.js'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 3_600_000,
  githubClientId: 'client', githubClientSecret: 'secret', oauthCallbackUrl: 'http://localhost/api/oauth/github/callback' }
const pair = setCookie => setCookie.split(';', 1)[0]

async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const sessions = {}
  for (const [i, [login, role]] of [['admin', 'admin'], ['second', 'admin'], ['viewed', 'triage'], ['reader', 'view']].entries()) {
    sessions[login] = await createSession(config, db, { githubUserId: i + 1, login, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(sessions[login].userId, role)
  }
  await db.selectRepo({ repoId: 1, fullName: 'org/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: sessions.admin.userId }, Date.now())
  const blobs = new Map()
  for (const team of ['team', 'other']) {
    await db.createTeam(team, team, Date.now())
    await db.setTeamRepo(team, 1, team)
    const body = Buffer.from(JSON.stringify({ findings: [{ id: `${team}-finding`, file: 'src/a.js' }] }))
    blobs.set(team, body)
    await db.insertReport({ id: team, filename: `${team}.json`, analyzer: null, contentType: 'application/json', repoId: 1, repoDirectory: team,
      visible: true, byteSize: body.length, sha256: body.toString('base64'), uploadedBy: sessions.admin.userId, bundleId: null, bundleIntegrity: null }, Date.now())
  }
  await db.setTeamMember('team', sessions.viewed.userId, { dependencies: false, security: false })
  for (const team of ['team', 'other']) await db.setTeamMember(team, sessions.admin.userId, { dependencies: true, security: true })
  // Requests the managed router leaves to a combined e2e server.
  const escaped = []
  const deps = { config, db, reportStore: { get: id => Promise.resolve(blobs.get(id)) }, originGate: { isOriginAllowed: () => true },
    isShuttingDown: () => false, track() {}, next(req, res) { escaped.push(`${req.method} ${req.url}`); res.writeHead(204); res.end() } }
  const handler = createManagedRequestHandler(deps)
  // `cookies` lists Cookie header pairs; a refused request must not read its body.
  async function request(path, { cookies = [], csrf, method = 'GET', body, unread = false } = {}) {
    const req = unread
      ? { [Symbol.asyncIterator]() { assert.fail(`${method} ${path} read its body`) } }
      : Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { url: path, method, headers: { cookie: cookies.join('; '), ...(csrf ? { 'x-csrf-token': csrf } : {}) } })
    const chunks = []
    const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback() } })
    res.writeHead = (status, values) => { res.status = status; res.headers = values ?? {} }
    await handler(req, res)
    const text = Buffer.concat(chunks).toString()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
  }
  const own = name => ({ cookies: [pair(sessions[name].setCookie)], csrf: sessions[name].csrfToken })
  async function view(as, by = 'admin') {
    const started = await request('/api/auth/view-as', { ...own(by), method: 'POST', body: { userId: sessions[as].userId } })
    assert.equal(started.status, 204)
    const cookies = [pair(sessions[by].setCookie), pair(started.headers['set-cookie'])]
    const session = await request('/api/auth/session', { cookies })
    assert.equal(session.status, 200)
    return { cookies, csrf: session.body.csrfToken, cookie: started.headers['set-cookie'], session: session.body }
  }
  return { db, sessions, request, own, view, escaped }
}

test('view sessions share their database semantics', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkViewSessions(db)
})

test('SQLite adds view sessions to existing session tables', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-view-as-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(path)
  const admin = await db.upsertUser({ githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, 1)
  const viewed = await db.upsertUser({ githubUserId: 2, login: 'viewed', name: null, avatarUrl: null }, 1)
  await db.setUserRole(admin, 'admin')
  await db.createSession({ id: 'session', userId: admin, csrfToken: 'csrf', expiresAt: 100 }, 1)
  await db.close()
  const legacy = new DatabaseSync(path)
  legacy.exec(`CREATE TABLE legacy_session (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES managed_user(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, upload_key TEXT) STRICT;
    INSERT INTO legacy_session SELECT id, user_id, csrf_token, created_at, expires_at, upload_key FROM managed_session;
    DROP TABLE managed_session;
    ALTER TABLE legacy_session RENAME TO managed_session;`)
  legacy.close()
  db = openSqliteManagedDb(path)
  t.after(() => db.close())
  assert.equal((await db.sessionWithUser('session', 2)).user.id, admin, 'existing sign-ins are kept')
  assert.equal(await db.createViewSession({ id: 'view', viewerSessionId: 'session', userId: viewed, csrfToken: 'view-csrf' }, 2), true)
  assert.equal((await db.viewSessionWithUser('view', 'session', 3)).user.id, viewed)
  await db.deleteSession('session')
  assert.equal(await db.viewSessionWithUser('view', 'session', 3), null)
})

test('admins see exactly what another user can access, recorded in the activity history', async t => {
  const h = await fixture(t)
  const viewing = await h.view('viewed')
  assert.match(viewing.cookie, /^dvview=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/u)
  assert.deepEqual(viewing.session.user, { id: h.sessions.viewed.userId, login: 'viewed', name: null, role: 'triage' })
  assert.deepEqual(viewing.session.viewer, { id: h.sessions.admin.userId, login: 'admin', name: null })
  assert.notEqual(viewing.csrf, h.sessions.admin.csrfToken, 'the view has its own CSRF token')
  assert.notEqual(viewing.csrf, h.sessions.viewed.csrfToken)

  const teams = async options => (await h.request('/api/teams', options)).body.teams.map(team => team.id).toSorted()
  assert.deepEqual(await teams(h.own('admin')), ['other', 'team'])
  assert.deepEqual(await teams(viewing), ['team'])
  assert.equal((await h.request('/api/teams/team/reports', viewing)).status, 200)
  assert.equal((await h.request('/api/teams/other/reports', viewing)).status, 404)
  assert.equal((await h.request('/api/reports/team/triage?team=team', viewing)).status, 200)
  assert.equal((await h.request('/api/reports/other/triage?team=other', viewing)).status, 404)
  for (const path of ['/api/admin/users', '/api/admin/teams', '/api/admin/reports']) {
    assert.equal((await h.request(path, viewing)).status, 403, `${path} follows the viewed role`)
    assert.equal((await h.request(path, h.own('admin'))).status, 200, `${path} is still the admin's own`)
  }
  // Batch previews are a read-only POST, so they run, as the viewed user.
  assert.deepEqual(await h.request('/api/reports/query', { ...viewing, method: 'POST', body: { ids: ['team'] } }),
    { status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: { error: 'forbidden' } })

  const history = await h.db.listActivity({ page: 1, limit: 100, kind: 'access', query: '', contexts: null })
  assert.deepEqual(history.history.map(row => [row.actor, row.action]), [['admin', 'viewed as viewed']])
  const users = await h.db.listUsers()
  assert.equal(users.find(user => user.login === 'viewed').lastActivityAt, null, 'nothing is attributed to the viewed user')
})

test('a view refuses every write before reading it, whichever CSRF token it carries', async t => {
  const h = await fixture(t)
  const viewing = await h.view('viewed')
  const writes = [
    ['POST', '/api/reports/team/triage?team=team'], ['POST', '/api/reports/team/comments?team=team'],
    ['PATCH', '/api/reports/team/comments/00000000-0000-4000-8000-000000000000?team=team'],
    ['POST', '/api/teams/team/issues'], ['POST', '/api/teams/team/share'], ['DELETE', '/api/teams/team/share'],
    ['POST', '/api/admin/set-role'], ['POST', '/api/admin/teams'], ['POST', '/api/admin/teams/set-member'],
    ['POST', '/api/admin/reports'], ['DELETE', '/api/admin/reports/team'], ['POST', '/api/admin/reports/set-visible'],
    ['POST', '/api/admin/bundles/create'], ['POST', '/api/admin/repositories/select'], ['POST', '/api/admin/deduplication'],
    ['POST', '/api/admin/uploads/reports/00000000-0000-4000-8000-000000000000/0'], ['PUT', '/api/admin/teams'],
    ['POST', '/api/auth/view-as'], ['GET', '/api/oauth/github/issues/login'], ['POST', '/api/admin/unknown'], ['PUT', '/api/auth/session'],
  ]
  for (const csrf of [viewing.csrf, h.sessions.admin.csrfToken, h.sessions.viewed.csrfToken]) {
    for (const [method, path] of writes) {
      const res = await h.request(path, { cookies: viewing.cookies, csrf, method, unread: true })
      assert.deepEqual([res.status, res.body], [403, { error: 'view-only' }], `${method} ${path}`)
    }
  }
  // An issue authorization begun before the view cannot complete during it.
  t.mock.method(globalThis, 'fetch', () => assert.fail('the callback reached GitHub'))
  const callback = await h.request('/api/oauth/github/callback?code=code&state=state', { cookies: [...viewing.cookies, 'dvissuestate=state.session.1'] })
  assert.deepEqual([callback.status, callback.body], [403, { error: 'view-only' }])
  assert.deepEqual(await h.db.listTriage(['team-finding']), [])
  assert.equal((await h.db.listUsers()).find(user => user.login === 'reader').role, 'view')
  assert.ok((await h.request('/api/auth/session', viewing)).body.viewer, 'refusals do not end the view')
})

test('a view leaves requests for a combined e2e server to its own authentication', async t => {
  const h = await fixture(t)
  const viewing = await h.view('viewed')
  const requests = [['POST', '/api/objstore/blob'], ['PUT', '/api/sync'], ['POST', '/']]
  for (const [method, path] of requests) assert.equal((await h.request(path, { ...viewing, method, unread: true })).status, 204)
  assert.deepEqual(h.escaped, requests.map(([method, path]) => `${method} ${path}`))
})

test('a view token authenticates nothing without the admin session that opened it', async t => {
  const h = await fixture(t)
  const viewing = await h.view('viewed')
  const token = viewing.cookies[1].split('=')[1]
  for (const cookies of [[`sid=${token}`], [viewing.cookies[1]], [pair(h.sessions.second.setCookie), viewing.cookies[1]], [pair(h.sessions.viewed.setCookie), viewing.cookies[1]]]) {
    assert.equal((await h.request('/api/teams', { cookies })).status, 401, cookies.join('; '))
    const write = await h.request('/api/reports/team/triage?team=team', { cookies, csrf: viewing.csrf, method: 'POST', body: { entries: { 'team-finding': { triage: 'fixed' } } } })
    assert.notEqual(write.status, 200, cookies.join('; '))
  }
  // The session probe drops a view the cookies cannot use, returning to the own session.
  const other = await h.request('/api/auth/session', { cookies: [pair(h.sessions.second.setCookie), viewing.cookies[1]] })
  assert.equal(other.body.user.login, 'second')
  assert.equal(other.body.viewer, undefined)
  assert.equal(other.headers['set-cookie'], 'dvview=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  assert.deepEqual(await h.db.listTriage(['team-finding']), [])
})

test('ending the view, the admin role, or the admin session returns to the own session', async t => {
  const h = await fixture(t)
  let viewing = await h.view('viewed')
  assert.equal((await h.request('/api/auth/view-as', { cookies: viewing.cookies, method: 'DELETE' })).status, 403, 'ending a view needs its CSRF token')
  const ended = await h.request('/api/auth/view-as', { ...viewing, method: 'DELETE' })
  assert.equal(ended.status, 204)
  assert.equal(ended.headers['set-cookie'], 'dvview=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  assert.equal((await h.request('/api/teams', viewing)).status, 401, 'a leftover cookie never falls back to the admin')
  const restored = await h.request('/api/auth/session', viewing)
  assert.deepEqual([restored.body.user.login, restored.body.viewer, restored.headers['set-cookie']], ['admin', undefined, ended.headers['set-cookie']])

  viewing = await h.view('reader')
  const demoted = await h.request('/api/admin/set-role', { ...h.own('second'), method: 'POST', body: { userId: h.sessions.admin.userId, role: 'manage' } })
  assert.equal(demoted.status, 200)
  assert.equal((await h.request('/api/teams', viewing)).status, 401)
  const after = await h.request('/api/auth/session', viewing)
  assert.deepEqual([after.body.user.login, after.body.user.role, after.body.viewer], ['admin', 'manage', undefined])
  await h.db.setUserRole(h.sessions.admin.userId, 'admin')
  assert.equal((await h.request('/api/teams', viewing)).status, 401, 'restoring the role does not resume the view')

  viewing = await h.view('viewed')
  const logout = await h.request('/api/auth/logout', { ...viewing, method: 'POST' })
  assert.equal(logout.status, 204)
  assert.deepEqual(logout.headers['set-cookie'], ['sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0', 'dvview=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'])
  assert.equal((await h.request('/api/auth/session', viewing)).status, 401, 'signing out ends the admin session too')
  assert.equal((await h.request('/api/auth/session', h.own('admin'))).status, 401)
})

test('only admins open views, of other existing users, as a CSRF-checked POST', async t => {
  const h = await fixture(t)
  const start = (name, body, options = {}) => h.request('/api/auth/view-as', { ...h.own(name), method: 'POST', body, ...options })
  for (const role of ['none', 'view', 'triage', 'manage']) {
    await h.db.setUserRole(h.sessions.second.userId, role)
    assert.deepEqual((await start('second', { userId: h.sessions.reader.userId })).body, { error: 'forbidden' }, role)
  }
  assert.deepEqual((await start('admin', { userId: h.sessions.admin.userId })).body, { error: 'cannot-view-as-self' })
  assert.deepEqual((await start('admin', { userId: 'missing' })).body, { error: 'not-found' })
  for (const body of [null, {}, { userId: 1 }]) assert.deepEqual((await start('admin', body)).body, { error: 'bad-request' })
  assert.deepEqual((await start('admin', { userId: h.sessions.reader.userId }, { csrf: undefined, unread: true })).body, { error: 'csrf-missing' })
  assert.equal((await h.request('/api/auth/view-as', h.own('admin'))).status, 405)
  assert.equal((await h.db.listActivity({ page: 1, limit: 100, kind: 'access', query: '', contexts: null })).total, 0, 'refusals are not recorded')
  assert.equal((await h.request('/api/auth/session', h.own('admin'))).body.viewer, undefined)
})

test('a view never uses the viewed user\'s GitHub authorization', async t => {
  const h = await fixture(t)
  for (const name of ['second', 'viewed']) await h.db.setUserTokens(h.sessions[name].userId, { accessToken: `${name}-token`, refreshToken: null, expiresAt: null })
  assert.equal(await runViewing(true, () => ensureUserAccessToken(config, h.db, h.sessions.viewed.userId, Date.now())), null)
  assert.equal(await runViewing(false, () => ensureUserAccessToken(config, h.db, h.sessions.viewed.userId, Date.now())), 'viewed-token')
  const authorizations = []
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    authorizations.push(new Headers(init?.headers).get('authorization'))
    return Promise.resolve(Response.json([]))
  })
  const viewing = await h.view('second')
  const listing = await h.request('/api/admin/repositories', viewing)
  assert.equal(listing.status, 200)
  assert.equal(listing.body.tokenMissing, true)
  assert.deepEqual(authorizations, [])
  await h.request('/api/admin/repositories', h.own('second'))
  assert.ok(authorizations.some(value => value?.includes('second-token')), 'the admin\'s own listing uses their token')
})
