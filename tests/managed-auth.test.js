// Managed auth server — the auth logic (crypto, sessions, the GitHub OAuth
// callback) against an in-memory SQLite store and a stubbed GitHub. The HTTP
// router + boot are smoke-covered separately; here we exercise the units that
// a live server can't easily prove (CSRF, token exchange, session lifecycle).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { hashToken, randomToken, safeEqual } from '../server-managed/crypto.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession, endSession, readSession } from '../server-managed/session.ts'
import { OAuthError, buildLoginRedirect, handleCallback } from '../server-managed/github-oauth.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'

const config = {
  port: 8765, host: '127.0.0.1', dbPath: ':memory:', debug: false, trustProxyEnv: undefined,
  githubClientId: 'cid', githubClientSecret: 'secret',
  oauthCallbackUrl: 'http://127.0.0.1:8765/api/oauth/github/callback',
  cookieSecure: false, sessionCookieName: 'dvsid', sessionTtlMs: 3_600_000,
}

// "name=value; Path=/; …" → "name=value" (the Cookie request-header form).
function cookiePair(setCookie) {
  return setCookie.split(';', 1)[0]
}

function jsonResponse(obj, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }))
}

// Stub fetch: token JSON for the access_token URL, user JSON for /user.
function makeFetch(responses) {
  return (url) => {
    const u = String(url)
    if (u.includes('login/oauth/access_token')) return jsonResponse(responses.token ?? {})
    if (u.includes('api.github.com/user')) return jsonResponse(responses.user ?? {})
    if (u.startsWith('https://avatars.githubusercontent.com/')) {
      return Promise.resolve(new Response(responses.avatar ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } }))
    }
    return jsonResponse({}, 404)
  }
}

// In-memory AvatarStore double — mirrors createDiskAvatarStore's interface.
function fakeAvatarStore() {
  const map = new Map()
  return {
    map,
    put(uuid, contentType, bytes) { map.set(uuid, { contentType, bytes }); return Promise.resolve() },
    get(uuid) { return Promise.resolve(map.get(uuid) ?? null) },
  }
}

test('crypto: random tokens are unique 43-char base64url; hashing is deterministic; compare is exact', () => {
  assert.notEqual(randomToken(), randomToken())
  assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/u)
  assert.equal(hashToken('x'), hashToken('x'))
  assert.notEqual(hashToken('x'), hashToken('y'))
  assert.ok(safeEqual('abc', 'abc'))
  assert.ok(!safeEqual('abc', 'abd'))
  assert.ok(!safeEqual('abc', 'ab'))
})

test('session: create → read → expire → end', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const user = { githubUserId: 42, login: 'octocat', name: 'The Octocat', avatarUrl: 'https://x/y.png' }
  const { setCookie, csrfToken } = await createSession(config, db, user, now)
  const cookie = cookiePair(setCookie)
  assert.ok(cookie.startsWith('dvsid='))

  const s = await readSession(config, db, cookie, now)
  assert.ok(s)
  assert.match(s.user.id, /^[0-9a-f-]{36}$/u)
  assert.equal(s.user.login, 'octocat')
  assert.equal(s.session.csrfToken, csrfToken)

  // Unknown cookie → null; expired → null.
  assert.equal(await readSession(config, db, 'dvsid=nope', now), null)
  assert.equal(await readSession(config, db, cookie, now + config.sessionTtlMs + 1), null)

  await endSession(config, db, cookie)
  assert.equal(await readSession(config, db, cookie, now), null)
  await db.close()
})

test('db: first user is admin, later users none; setUserRole + listUsers reflect roles', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const first = await createSession(config, db, { githubUserId: 1, login: 'alice', name: 'Alice', avatarUrl: null }, now)
  const second = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)

  const alice = (await readSession(config, db, cookiePair(first.setCookie), now)).user
  const bob = (await readSession(config, db, cookiePair(second.setCookie), now)).user
  assert.equal(alice.role, 'admin')
  assert.equal(bob.role, 'none')

  // A returning first user keeps admin (the upsert doesn't touch role).
  await createSession(config, db, { githubUserId: 1, login: 'alice2', name: 'Alice R', avatarUrl: null }, now + 2000)
  assert.equal((await readSession(config, db, cookiePair(first.setCookie), now)).user.role, 'admin')

  assert.equal(await db.setUserRole(bob.id, 'triage'), true)
  assert.equal((await readSession(config, db, cookiePair(second.setCookie), now)).user.role, 'triage')
  assert.equal(await db.setUserRole('00000000-0000-4000-8000-000000000000', 'view'), false)

  const users = await db.listUsers()
  assert.deepEqual(users.map((u) => [u.login, u.role]), [['alice2', 'admin'], ['bob', 'triage']])
  await db.close()
})

test('GET /api/admin/users: admin-only (401 unauth, 403 non-admin, 200 admin)', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const admin = await createSession(config, db, { githubUserId: 1, login: 'alice', name: 'Alice', avatarUrl: null }, now)
  const plain = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(),
    originGate: { trustProxy: false, isOriginAllowed: () => true },
    isShuttingDown: () => false, track: (p) => { pending = p },
  })
  function mockRes() {
    return {
      statusCode: 0, body: '', ended: false,
      writeHead(s) { this.statusCode = s; return this },
      end(b) { if (b != null) this.body += b; this.ended = true; return this },
      get headersSent() { return this.ended },
    }
  }
  async function call(cookie) {
    const res = mockRes()
    handler({ method: 'GET', url: '/api/admin/users', headers: cookie ? { cookie } : {} }, res)
    await pending
    return res
  }

  assert.equal((await call(null)).statusCode, 401)
  assert.equal((await call(cookiePair(plain.setCookie))).statusCode, 403)
  const ok = await call(cookiePair(admin.setCookie))
  assert.equal(ok.statusCode, 200)
  assert.equal(JSON.parse(ok.body).users.length, 2)
  await db.close()
})

test('POST /api/admin/set-role: admin-only mutation, CSRF, not-self', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const userSess = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)
  const admin = (await readSession(config, db, cookiePair(adminSess.setCookie), now)).user
  const bob = (await readSession(config, db, cookiePair(userSess.setCookie), now)).user

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(),
    originGate: { trustProxy: false, isOriginAllowed: () => true },
    isShuttingDown: () => false, track: (p) => { pending = p },
  })
  function mockRes() {
    return {
      statusCode: 0, body: '', ended: false,
      writeHead(c) { this.statusCode = c; return this },
      end(b) { if (b != null) this.body += b; this.ended = true; return this },
      get headersSent() { return this.ended },
    }
  }
  async function post(cookie, csrf, payload) {
    const res = mockRes()
    const headers = { 'content-type': 'application/json' }
    if (cookie) headers.cookie = cookie
    if (csrf) headers['x-csrf-token'] = csrf
    const req = new Readable({ read() {} })
    req.method = 'POST'
    req.url = '/api/admin/set-role'
    req.headers = headers
    handler(req, res)
    req.push(JSON.stringify(payload))
    req.push(null)
    await pending
    return res
  }
  const aCk = cookiePair(adminSess.setCookie)

  // Non-admin (bob) is refused.
  assert.equal((await post(cookiePair(userSess.setCookie), userSess.csrfToken, { userId: admin.id, role: 'none' })).statusCode, 403)
  // Missing CSRF is refused.
  assert.equal((await post(aCk, null, { userId: bob.id, role: 'view' })).statusCode, 403)
  // Admin can't change their OWN role.
  assert.equal((await post(aCk, adminSess.csrfToken, { userId: admin.id, role: 'view' })).statusCode, 403)
  // Invalid role → 400.
  assert.equal((await post(aCk, adminSess.csrfToken, { userId: bob.id, role: 'wizard' })).statusCode, 400)
  // Admin sets bob → triage.
  assert.equal((await post(aCk, adminSess.csrfToken, { userId: bob.id, role: 'triage' })).statusCode, 200)
  assert.equal((await readSession(config, db, cookiePair(userSess.setCookie), now)).user.role, 'triage')
  await db.close()
})

test('GET /api/avatar/<id>: any session may fetch a user avatar by id (401 unauth, 404 missing)', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const sess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const s = await readSession(config, db, cookiePair(sess.setCookie), now)
  const avatarStore = fakeAvatarStore()
  await avatarStore.put(s.user.id, 'image/png', Buffer.from([1, 2, 3]))

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore,
    originGate: { trustProxy: false, isOriginAllowed: () => true },
    isShuttingDown: () => false, track: (p) => { pending = p },
  })
  function mockRes() {
    return {
      statusCode: 0, body: '', ended: false,
      writeHead(code) { this.statusCode = code; return this },
      end(b) { if (b != null) this.body += b; this.ended = true; return this },
      get headersSent() { return this.ended },
    }
  }
  async function get(url, cookie) {
    const res = mockRes()
    handler({ method: 'GET', url, headers: cookie ? { cookie } : {} }, res)
    await pending
    return res
  }
  const ck = cookiePair(sess.setCookie)
  assert.equal((await get(`/api/avatar/${s.user.id}`, null)).statusCode, 401)
  assert.equal((await get(`/api/avatar/${s.user.id}`, ck)).statusCode, 200)
  assert.equal((await get('/api/avatar/00000000-0000-4000-8000-000000000000', ck)).statusCode, 404)
  await db.close()
})

test('buildLoginRedirect: GitHub authorize URL with a matching state cookie', () => {
  const { location, setCookie } = buildLoginRedirect(config)
  const u = new URL(location)
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize')
  assert.equal(u.searchParams.get('client_id'), 'cid')
  assert.equal(u.searchParams.get('redirect_uri'), config.oauthCallbackUrl)
  assert.equal(u.searchParams.get('scope'), 'read:user')
  const state = u.searchParams.get('state')
  assert.ok(state)
  assert.equal(cookiePair(setCookie), `dvstate=${state}`)
})

test('handleCallback: valid state mints a session for the GitHub identity', async () => {
  const db = openSqliteManagedDb(':memory:')
  const state = 'thestate'
  const fetchImpl = makeFetch({
    token: { access_token: 'gho_x', token_type: 'bearer', scope: 'read:user' },
    user: { id: 7, login: 'mona', name: 'Mona', avatar_url: 'http://a/b' },
  })
  const result = await handleCallback(new URLSearchParams({ code: 'c', state }), `dvstate=${state}`, { config, db, fetchImpl })
  assert.equal(result.location, '/')
  const sessionCookie = result.setCookies.find((c) => c.startsWith('dvsid='))
  assert.ok(sessionCookie, 'a session cookie is set')

  const s = await readSession(config, db, cookiePair(sessionCookie), Date.now())
  assert.ok(s)
  assert.match(s.user.id, /^[0-9a-f-]{36}$/u)
  assert.equal(s.user.login, 'mona')
  await db.close()
})

test('handleCallback: caches the user avatar through the store, keyed by uuid', async () => {
  const db = openSqliteManagedDb(':memory:')
  const avatarStore = fakeAvatarStore()
  const state = 'avst'
  const fetchImpl = makeFetch({
    token: { access_token: 'gho_x' },
    user: { id: 9, login: 'ava', name: 'Ava', avatar_url: 'https://avatars.githubusercontent.com/u/9?v=4' },
  })
  const result = await handleCallback(new URLSearchParams({ code: 'c', state }), `dvstate=${state}`, { config, db, avatarStore, fetchImpl })
  const sessionCookie = result.setCookies.find((c) => c.startsWith('dvsid='))
  const s = await readSession(config, db, cookiePair(sessionCookie), Date.now())
  assert.ok(s)
  assert.match(s.user.id, /^[0-9a-f-]{36}$/u)
  const cached = avatarStore.map.get(s.user.id)
  assert.ok(cached, 'avatar cached under the user uuid')
  assert.equal(cached.contentType, 'image/png')
  assert.ok(cached.bytes.length > 0)
  await db.close()
})

test('handleCallback: state mismatch is refused (400, no GitHub call)', async () => {
  const db = openSqliteManagedDb(':memory:')
  let called = false
  const fetchImpl = () => { called = true; return jsonResponse({}) }
  await assert.rejects(
    handleCallback(new URLSearchParams({ code: 'c', state: 'a' }), 'dvstate=b', { config, db, fetchImpl }),
    (e) => e instanceof OAuthError && e.status === 400,
  )
  assert.equal(called, false, 'CSRF check fails before any GitHub call')
  await db.close()
})

test('handleCallback: GitHub refusing the code surfaces as 502', async () => {
  const db = openSqliteManagedDb(':memory:')
  const state = 's'
  const fetchImpl = makeFetch({ token: { error: 'bad_verification_code' } })
  await assert.rejects(
    handleCallback(new URLSearchParams({ code: 'c', state }), `dvstate=${state}`, { config, db, fetchImpl }),
    (e) => e instanceof OAuthError && e.status === 502,
  )
  await db.close()
})
