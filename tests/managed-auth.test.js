// Managed auth server — the auth logic (crypto, sessions, the GitHub OAuth
// callback) against an in-memory SQLite store and a stubbed GitHub. The HTTP
// router + boot are smoke-covered separately; here we exercise the units that
// a live server can't easily prove (CSRF, token exchange, session lifecycle).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { createVerify, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliDecompressSync } from 'node:zlib'

import { hashToken, randomToken, safeEqual } from '../server-managed/crypto.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession, endSession, readSession } from '../server-managed/session.ts'
import { OAuthError, buildLoginRedirect, ensureUserAccessToken, handleCallback, refreshUserToken } from '../server-managed/github-oauth.ts'
import { appJwt, collectRepos, githubAppConfigured, installUrl, listInstalledRepos, listUserRepos, mergeRepos, repoAccessToken } from '../server-managed/github-app.ts'
import { bundleIntegrity } from '../server-managed/bundle.ts'
import { createBundleStore } from '../server-managed/bundle-store.ts'
import { filterReportContent } from '../common/managed/report-filter.ts'
import { MAX_TRIAGE_HISTORY, parseTriageEntryPatch } from '../common/managed/triage.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { managedCsv, managedCsvIds } from './_managed-csv.js'
import { defaultScanModels } from '../ui/scan/default-models.js'

const config = {
  port: 8765, host: '127.0.0.1', dbPath: ':memory:', debug: false, trustProxyEnv: undefined,
  githubClientId: 'cid', githubClientSecret: 'secret',
  oauthCallbackUrl: 'http://127.0.0.1:8765/api/oauth/github/callback',
  cookieSecure: false, sessionCookieName: 'dvsid', sessionTtlMs: 3_600_000,
  maxReportBytes: 10_485_760, maxBundleBytes: 104_857_600,
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

// In-memory BlobStore double — mirrors createDiskBlobStore's interface (backs
// both the report + bundle stores).
function fakeBlobStore() {
  const map = new Map()
  return {
    map,
    put(id, bytes) { map.set(id, bytes); return Promise.resolve() },
    get(id) { return Promise.resolve(map.get(id) ?? null) },
    open(id) {
      const bytes = map.get(id)
      return Promise.resolve(bytes ? { size: bytes.length, stream: Readable.from([bytes]) } : null)
    },
    delete(id) { map.delete(id); return Promise.resolve() },
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

test('last seen: session activity is independent of identity, role, and token updates', async (t) => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const now = 1_000_000
  const user = { githubUserId: 42, login: 'octocat', name: null, avatarUrl: null }
  const userId = await db.upsertUser(user, now)
  const lastSeen = async () => (await db.listUsers()).find((u) => u.id === userId).lastSeenAt
  assert.equal(await lastSeen(), null, 'creating an identity alone is not evidence of a session')
  const { setCookie } = await createSession(config, db, user, now + 100)
  const cookie = cookiePair(setCookie)
  assert.equal(await lastSeen(), now + 100)
  await db.setUserRole(userId, 'triage')
  await db.setUserTokens(userId, { accessToken: 'background-refresh', refreshToken: null, expiresAt: null })
  await db.upsertUser({ ...user, name: 'Updated name' }, now + 200)
  assert.equal(await lastSeen(), now + 100, 'user mutations do not imply presence')
  assert.ok(await readSession(config, db, cookie, now + 300))
  assert.equal(await lastSeen(), now + 300, 'authenticated reads advance presence')
  await readSession(config, db, cookie, now + 250)
  assert.equal(await lastSeen(), now + 300, 'an older request cannot move presence backwards')
  assert.equal(await readSession(config, db, 'dvsid=missing', now + 400), null)
  assert.equal(await readSession(config, db, cookie, now + config.sessionTtlMs + 200), null)
  assert.equal(await lastSeen(), now + 300, 'invalid and expired sessions do not count')
  await endSession(config, db, cookie)
  assert.equal(await readSession(config, db, cookie, now + 500), null)
  assert.equal(await lastSeen(), now + 300, 'revoked sessions do not count')
  assert.equal((await db.listUsers())[0].lastActivityAt, null, 'reads do not create write activity')
})

test('last seen migration: only known session creation is backfilled, and reopening preserves presence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-last-seen-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(path)
  const known = await db.upsertUser({ githubUserId: 1, login: 'known', name: null, avatarUrl: null }, 100)
  const unknown = await db.upsertUser({ githubUserId: 2, login: 'unknown', name: null, avatarUrl: null }, 100)
  await db.createSession({ id: 'known-session', userId: known, csrfToken: 'csrf', expiresAt: 1000 }, 200)
  await db.createSession({ id: 'earlier-session', userId: known, csrfToken: 'csrf', expiresAt: 1000 }, 150)
  await db.setUserRole(unknown, 'view')
  await db.close()
  // Reproduce the pre-migration schema while retaining actual session data.
  const legacy = new DatabaseSync(path)
  legacy.exec('ALTER TABLE managed_user DROP COLUMN last_seen_at')
  legacy.close()
  db = openSqliteManagedDb(path)
  const users = await db.listUsers()
  assert.equal(users.find((u) => u.id === known).lastSeenAt, 200)
  assert.equal(users.find((u) => u.id === unknown).lastSeenAt, null)
  await db.sessionWithUser('known-session', 300)
  await db.deleteExpiredSessions(2000)
  await db.close()
  db = openSqliteManagedDb(path)
  t.after(() => db.close())
  assert.equal((await db.listUsers()).find((u) => u.id === known).lastSeenAt, 300)
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

  await db.setTriage('activity-finding', { color: 'red' }, bob.id, 'bob', now + 3000)

  const users = await db.listUsers()
  assert.deepEqual(users.map((u) => [u.login, u.role]), [['alice2', 'admin'], ['bob', 'triage']])
  assert.equal(users.find((u) => u.login === 'bob').lastActivityAt, now + 3000)
  await db.close()
})

test('GET /api/admin/models: managed users receive the same starting catalogue as the UI', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const manageSess = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)
  const noneSess = await createSession(config, db, { githubUserId: 3, login: 'cy', name: null, avatarUrl: null }, now + 2000)
  const manage = (await readSession(config, db, cookiePair(manageSess.setCookie), now)).user
  await db.setUserRole(manage.id, 'manage')
  const { send } = bundleHarness(db)
  const modelsPath = '/api/admin/models'
  assert.equal((await send('GET', modelsPath, cookiePair(noneSess.setCookie))).statusCode, 403)
  assert.equal((await send('POST', modelsPath, cookiePair(adminSess.setCookie))).statusCode, 405)
  const response = await send('GET', modelsPath, cookiePair(manageSess.setCookie))
  assert.equal(response.statusCode, 200)
  const body = JSON.parse(response.body)
  assert.deepEqual(body, defaultScanModels())
  assert.equal(body.defaultModel, 'anthropic/claude-opus-5.5')
  assert.ok(body.models.some((model) => model.id === 'openai/gpt-6-astra-pro' && model.efforts.includes('max')))
  await db.close()
})

test('GET /api/admin/users: admin-only (401 unauth, 403 non-admin, 200 admin)', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const admin = await createSession(config, db, { githubUserId: 1, login: 'alice', name: 'Alice', avatarUrl: null }, now)
  const plain = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: createBundleStore(fakeBlobStore(), fakeBlobStore()),
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
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: createBundleStore(fakeBlobStore(), fakeBlobStore()),
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
    config, db, avatarStore, reportStore: fakeBlobStore(), bundleStore: createBundleStore(fakeBlobStore(), fakeBlobStore()),
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
  assert.equal(u.searchParams.get('scope'), null) // GitHub App user-auth: no scope
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

test('github-app: installUrl builds from the optional slug (null when unset)', () => {
  assert.equal(installUrl({ ...config }), null)
  assert.equal(installUrl({ ...config, githubAppSlug: 'my-app' }), 'https://github.com/apps/my-app/installations/new')
})

test('github-app: appJwt is a verifiable RS256 JWT; githubAppConfigured needs id + key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' })
  const now = 1_700_000_000_000
  const [h, p, sig] = appJwt('appid-9', pem, now).split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), { alg: 'RS256', typ: 'JWT' })
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
  assert.equal(payload.iss, 'appid-9')
  assert.ok(payload.exp - payload.iat <= 600, 'lifetime within GitHub 10-min cap')
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url')), 'signature verifies')

  // The separate repositories App is "configured" only with id AND key.
  assert.equal(githubAppConfigured({ ...config }), false)
  assert.equal(githubAppConfigured({ ...config, githubAppId: '1' }), false)
  assert.equal(githubAppConfigured({ ...config, githubAppId: '1', githubAppPrivateKey: pem }), true)
})

test('mergeRepos: unions sources, dedupes by full name, sorts (later source wins)', () => {
  const pub = [{ fullName: 'o/zeta', private: false, htmlUrl: '' }, { fullName: 'o/alpha', private: false, htmlUrl: '' }]
  const priv = [{ fullName: 'o/alpha', private: true, htmlUrl: '' }, { fullName: 'o/beta', private: true, htmlUrl: '' }]
  const merged = mergeRepos(pub, priv)
  assert.deepEqual(merged.map((r) => r.fullName), ['o/alpha', 'o/beta', 'o/zeta'])
  assert.equal(merged.find((r) => r.fullName === 'o/alpha').private, true)
})

test('listInstalledRepos: aggregates the separate App\'s installations, skips archived', async () => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const cfg = { ...config, githubAppId: '1', githubAppPrivateKey: pem, githubAppSlug: 'app' }
  const calls = []
  const fetchImpl = (url, opts) => {
    const u = String(url)
    calls.push(`${opts?.method ?? 'GET'} ${u}`)
    if (u.endsWith('/app/installations?per_page=100')) return jsonResponse([{ id: 11 }, { id: 22 }])
    if (u.includes('/app/installations/11/access_tokens')) return jsonResponse({ token: 'tok-11' })
    if (u.includes('/app/installations/22/access_tokens')) return jsonResponse({ token: 'tok-22' })
    if (u.includes('/installation/repositories')) {
      const repos = opts.headers.authorization === 'Bearer tok-11'
        ? [{ id: 1, full_name: 'o/zeta', private: true, html_url: 'https://github.com/o/zeta' },
           { id: 2, full_name: 'o/alpha', private: true, html_url: 'https://github.com/o/alpha' }]
        // install 22 re-sees alpha (dupe), adds beta, and an archived repo to skip
        : [{ id: 2, full_name: 'o/alpha', private: true, html_url: 'https://github.com/o/alpha' },
           { id: 3, full_name: 'o/beta', private: true, html_url: 'https://github.com/o/beta' },
           { id: 4, full_name: 'o/old', private: true, archived: true, html_url: 'https://github.com/o/old' }]
      return jsonResponse({ total_count: repos.length, repositories: repos })
    }
    return jsonResponse({}, 404)
  }
  const repos = await listInstalledRepos(cfg, fetchImpl)
  assert.deepEqual(repos.map((r) => r.fullName), ['o/alpha', 'o/beta', 'o/zeta']) // o/old archived-skipped
  // One installation-token mint per installation; not configured → empty + no calls.
  assert.equal(calls.filter((c) => c.startsWith('POST')).length, 2)
  assert.deepEqual(await listInstalledRepos({ ...config }, fetchImpl), [])
})

test('listUserRepos: paginates GET /user/repos, dedupes + sorts (read-only)', async () => {
  const calls = []
  const fetchImpl = (url, opts) => {
    const u = String(url)
    calls.push(`${opts?.method ?? 'GET'} ${u}`)
    assert.equal(opts.headers.authorization, 'Bearer utok')
    const page = new URL(u).searchParams.get('page')
    // Full first page (length === per_page) → a second page is fetched.
    if (page === '1') {
      return jsonResponse(Array.from({ length: 100 }, (_, i) => (
        { id: i + 1, full_name: `o/r${String(i).padStart(3, '0')}`, private: false, html_url: `https://github.com/o/r${i}` }
      )))
    }
    // Short second page → stop; re-sends r000 (dupe), a later name, + an
    // archived repo that must be excluded.
    if (page === '2') {
      return jsonResponse([
        { id: 201, full_name: 'o/zeta', private: false, html_url: 'https://github.com/o/zeta' },
        { id: 1, full_name: 'o/r000', private: true, html_url: 'https://github.com/o/r000' },
        { id: 202, full_name: 'o/old', private: false, archived: true, html_url: 'https://github.com/o/old' },
      ])
    }
    return jsonResponse([])
  }
  const repos = await listUserRepos('utok', fetchImpl)
  // 100 from page 1 + zeta from page 2; r000 deduped, o/old archived-skipped.
  assert.equal(repos.length, 101)
  assert.equal(repos[0].fullName, 'o/r000')
  assert.equal(repos.at(-1).fullName, 'o/zeta')
  assert.ok(!repos.some((r) => r.fullName === 'o/old'), 'archived repo excluded')
  assert.equal(repos.find((r) => r.fullName === 'o/r000').private, true) // last page wins
  // Stopped after the short 2nd page (no page 3); GET-only, no writes.
  assert.equal(calls.length, 2)
  assert.ok(calls.every((c) => c.startsWith('GET')))
})

test('db: selectRepo upserts (keeps added_at/by), listSelectedRepos reads, deselectRepo removes', async () => {
  const db = openSqliteManagedDb(':memory:')
  const uid = await db.upsertUser({ githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, 1000)
  await db.selectRepo({ repoId: 42, fullName: 'o/repo', private: true, installationId: 7, defaultBranch: 'main', htmlUrl: 'https://github.com/o/repo', addedBy: uid }, 2000)
  let rows = await db.listSelectedRepos()
  assert.deepEqual(rows, [{ repoId: 42, fullName: 'o/repo', private: true, installationId: 7, defaultBranch: 'main', htmlUrl: 'https://github.com/o/repo', addedBy: uid, addedAt: 2000 }])
  // Re-select refreshes the mutable context (rename, now public, no install) but
  // keeps the original added_at (audit).
  await db.selectRepo({ repoId: 42, fullName: 'o/renamed', private: false, installationId: null, defaultBranch: 'dev', htmlUrl: 'https://github.com/o/renamed', addedBy: uid }, 5000)
  rows = await db.listSelectedRepos()
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].fullName, rows[0].private, rows[0].installationId, rows[0].addedAt], ['o/renamed', false, null, 2000])
  assert.equal(await db.deselectRepo(42), true)
  assert.equal(await db.deselectRepo(42), false) // already gone → false
  assert.deepEqual(await db.listSelectedRepos(), [])
  await db.close()
})

test('collectRepos: merges public + private (install-tagged); tokenMissing without a user token', async () => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const cfg = { ...config, githubAppId: '1', githubAppPrivateKey: pem, githubAppSlug: 'app' }
  const fetchImpl = (url) => {
    const u = String(url)
    if (u.includes('/user/repos')) return jsonResponse([{ id: 1, full_name: 'o/pub', private: false, default_branch: 'main', html_url: 'h' }])
    if (u.endsWith('/app/installations?per_page=100')) return jsonResponse([{ id: 9 }])
    if (u.includes('/access_tokens')) return jsonResponse({ token: 'tok' })
    if (u.includes('/installation/repositories')) return jsonResponse({ total_count: 1, repositories: [{ id: 2, full_name: 'o/priv', private: true, default_branch: 'release', html_url: 'h' }] })
    return jsonResponse({}, 404)
  }
  const out = await collectRepos(cfg, 'user-token', fetchImpl)
  assert.equal(out.tokenMissing, false)
  // Both sources, sorted; private carries its installation id + default branch.
  assert.deepEqual(out.repositories.map((r) => [r.fullName, r.private, r.installationId, r.defaultBranch]),
    [['o/priv', true, 9, 'release'], ['o/pub', false, null, 'main']])
  // No user token → public skipped + tokenMissing, but private still lists.
  const noTok = await collectRepos(cfg, null, fetchImpl)
  assert.equal(noTok.tokenMissing, true)
  assert.deepEqual(noTok.repositories.map((r) => r.fullName), ['o/priv'])
})

test('repoAccessToken: installation id → installation token; null for public/unconfigured', async () => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const cfg = { ...config, githubAppId: '1', githubAppPrivateKey: pem }
  const fetchImpl = (url, opts) => (String(url).includes('/app/installations/7/access_tokens') && opts?.method === 'POST'
    ? jsonResponse({ token: 'inst-tok' })
    : jsonResponse({}, 404))
  assert.equal(await repoAccessToken(cfg, 7, fetchImpl), 'inst-tok') // private repo → installation token
  assert.equal(await repoAccessToken(cfg, null, fetchImpl), null) // public repo → no token needed
  assert.equal(await repoAccessToken({ ...config }, 7, fetchImpl), null) // App not configured
})

test('refreshUserToken: posts grant_type=refresh_token, parses the new token set', async () => {
  const now = 1_700_000_000_000
  const fetchImpl = (url, opts) => {
    assert.match(String(url), /login\/oauth\/access_token/u)
    const sent = JSON.parse(opts.body)
    assert.equal(sent.grant_type, 'refresh_token')
    assert.equal(sent.refresh_token, 'r-old')
    return jsonResponse({ access_token: 'a-new', refresh_token: 'r-new', expires_in: 28800 })
  }
  const t = await refreshUserToken(config, 'r-old', now, fetchImpl)
  assert.deepEqual(t, { accessToken: 'a-new', refreshToken: 'r-new', expiresAt: now + 28800 * 1000 })
})

test('ensureUserAccessToken: valid passthrough, refresh when expired, null when unrefreshable', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const sess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const me = (await readSession(config, db, cookiePair(sess.setCookie), now)).user

  // No token stored → null.
  assert.equal(await ensureUserAccessToken(config, db, me.id, now), null)

  // Valid (non-expiring) token → returned as-is, fetch never called.
  await db.setUserTokens(me.id, { accessToken: 'fresh', refreshToken: null, expiresAt: null })
  assert.equal(await ensureUserAccessToken(config, db, me.id, now, () => { throw new Error('no fetch') }), 'fresh')

  // Expired + refresh token → refreshed and re-persisted.
  await db.setUserTokens(me.id, { accessToken: 'old', refreshToken: 'r1', expiresAt: now - 1 })
  const refreshFetch = () => jsonResponse({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 })
  assert.equal(await ensureUserAccessToken(config, db, me.id, now, refreshFetch), 'new')
  const stored = await db.getUserTokens(me.id)
  assert.deepEqual([stored.accessToken, stored.refreshToken, stored.expiresAt], ['new', 'r2', now + 3600 * 1000])

  // Expired with NO refresh token → null (caller prompts re-login).
  await db.setUserTokens(me.id, { accessToken: 'old2', refreshToken: null, expiresAt: now - 1 })
  assert.equal(await ensureUserAccessToken(config, db, me.id, now), null)
  await db.close()
})

test('handleCallback: persists the user token for later repo listing', async () => {
  const db = openSqliteManagedDb(':memory:')
  const state = 'tk'
  const now = 1_700_000_000_000
  const fetchImpl = makeFetch({
    token: { access_token: 'gho_user', refresh_token: 'ghr', expires_in: 28800 },
    user: { id: 5, login: 'tok', name: null, avatar_url: null },
  })
  const result = await handleCallback(new URLSearchParams({ code: 'c', state }), `dvstate=${state}`, { config, db, now, fetchImpl })
  const sessionCookie = result.setCookies.find((c) => c.startsWith('dvsid='))
  const s = await readSession(config, db, cookiePair(sessionCookie), now)
  const tokens = await db.getUserTokens(s.user.id)
  assert.deepEqual([tokens.accessToken, tokens.refreshToken, tokens.expiresAt], ['gho_user', 'ghr', now + 28800 * 1000])
  await db.close()
})

test('GET /api/admin/repositories: admin only; no stored token → tokenMissing', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const manageSess = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)
  const noneSess = await createSession(config, db, { githubUserId: 3, login: 'cy', name: null, avatarUrl: null }, now + 2000)
  const bob = (await readSession(config, db, cookiePair(manageSess.setCookie), now)).user
  await db.setUserRole(bob.id, 'manage')

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: createBundleStore(fakeBlobStore(), fakeBlobStore()),
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
  async function get(cookie) {
    const res = mockRes()
    handler({ method: 'GET', url: '/api/admin/repositories', headers: cookie ? { cookie } : {} }, res)
    await pending
    return res
  }

  assert.equal((await get(null)).statusCode, 401)
  assert.equal((await get(cookiePair(noneSess.setCookie))).statusCode, 403) // 'none' role
  const asManage = await get(cookiePair(manageSess.setCookie))
  assert.equal(asManage.statusCode, 403)
  // No slug + no token persisted for this user → the tokenMissing response.
  const asAdmin = await get(cookiePair(adminSess.setCookie))
  assert.equal(asAdmin.statusCode, 200)
  assert.deepEqual(JSON.parse(asAdmin.body), { installUrl: null, repositories: [], tokenMissing: true })
  await db.close()
})

test('POST /api/admin/repositories/select: admin + CSRF; verifies access, persists, marks, deselects', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const noneSess = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)
  const admin = (await readSession(config, db, cookiePair(adminSess.setCookie), now)).user
  // A non-expiring token so collectRepos can list the admin's public repos.
  await db.setUserTokens(admin.id, { accessToken: 'gho_x', refreshToken: null, expiresAt: null })

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: createBundleStore(fakeBlobStore(), fakeBlobStore()),
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
    req.method = 'POST'; req.url = '/api/admin/repositories/select'; req.headers = headers
    handler(req, res)
    req.push(JSON.stringify(payload)); req.push(null)
    await pending
    return res
  }
  async function get(cookie) {
    const res = mockRes()
    handler({ method: 'GET', url: '/api/admin/repositories', headers: { cookie } }, res)
    await pending
    return res
  }
  const aCk = cookiePair(adminSess.setCookie)

  // authz / CSRF / validation (no GitHub call reached)
  assert.equal((await post(cookiePair(noneSess.setCookie), noneSess.csrfToken, { repoId: 1, selected: true })).statusCode, 403) // 'none'
  assert.equal((await post(aCk, null, { repoId: 1, selected: true })).statusCode, 403) // CSRF missing
  assert.equal((await post(aCk, adminSess.csrfToken, { repoId: 'x', selected: true })).statusCode, 400) // bad repoId

  // Stub GitHub so collectRepos sees one reachable public repo (id 55).
  const realFetch = globalThis.fetch
  globalThis.fetch = (url) => (String(url).includes('/user/repos')
    ? jsonResponse([{ id: 55, full_name: 'o/pub', private: false, default_branch: 'main', html_url: 'https://github.com/o/pub' }])
    : jsonResponse({}, 404))
  try {
    assert.equal((await post(aCk, adminSess.csrfToken, { repoId: 999, selected: true })).statusCode, 404) // not reachable
    assert.equal((await post(aCk, adminSess.csrfToken, { repoId: 55, selected: true })).statusCode, 200)
    const stored = await db.listSelectedRepos()
    assert.deepEqual([stored.length, stored[0].fullName, stored[0].addedBy], [1, 'o/pub', admin.id])
    // The listing now flags it selected; a public repo (no installation) is not
    // installed, so the default "Manage repositories" tab filters it out.
    const listed = JSON.parse((await get(aCk)).body).repositories.find((r) => r.id === 55)
    assert.deepEqual([listed.selected, listed.installed], [true, false])
  } finally {
    globalThis.fetch = realFetch
  }

  // Deselect drops the row (no GitHub needed).
  assert.equal((await post(aCk, adminSess.csrfToken, { repoId: 55, selected: false })).statusCode, 200)
  assert.deepEqual(await db.listSelectedRepos(), [])
  await db.close()
})

test('db: reports — insert records metadata + attribution, list joins login, get reads, delete removes', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const uid = await db.upsertUser({ githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const id = randomUUID()
  await db.insertReport({ id, filename: 'scan.json', contentType: 'application/json', byteSize: 42, sha256: 'h4sh', uploadedBy: uid, repoId: null, bundleId: null, bundleIntegrity: null, visible: true }, now)
  const hiddenId = randomUUID()
  await db.insertReport({ id: hiddenId, filename: 'hidden.json', contentType: 'application/json', byteSize: 3, sha256: 'hidden', uploadedBy: uid, repoId: null, bundleId: null, bundleIntegrity: null }, now)

  const list = await db.listReports()
  assert.equal(list.length, 2)
  assert.equal(list.find((report) => report.id === hiddenId).visible, false)
  const listedReport = list.find((report) => report.id === id)
  assert.deepEqual(
    [listedReport.id, listedReport.filename, listedReport.byteSize, listedReport.sha256, listedReport.uploadedByLogin, listedReport.uploadedAt],
    [id, 'scan.json', 42, 'h4sh', 'alice', now],
  )

  const rec = await db.getReport(id)
  assert.deepEqual([rec.filename, rec.contentType, rec.uploadedBy], ['scan.json', 'application/json', uid])
  assert.equal(await db.getReport(randomUUID()), null) // unknown id → null

  assert.equal(await db.deleteReport(id), true)
  assert.equal(await db.deleteReport(id), false) // already gone → false
  assert.deepEqual((await db.listReports()).map((report) => report.id), [hiddenId])
  assert.equal(await db.deleteReport(hiddenId), true)
  assert.deepEqual(await db.listReports(), [])
  await db.close()
})

test('db: uploader login is saved durably — the snapshot survives a removed uploader', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const uid = await db.upsertUser({ githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  // Normal upload (uploader present) → the list shows the login.
  await db.insertReport({ id: randomUUID(), filename: 'r.json', contentType: 'application/json', byteSize: 1, sha256: 'x', uploadedBy: uid, uploadedByLogin: 'alice', repoId: null, bundleId: null, bundleIntegrity: null, visible: true }, now)
  // A report whose uploader is already gone (uploaded_by NULL) keeps the durable
  // login snapshot — "who uploaded it" isn't lost.
  await db.insertReport({ id: randomUUID(), filename: 'g.json', contentType: 'application/json', byteSize: 1, sha256: 'y', uploadedBy: null, uploadedByLogin: 'ghost', repoId: null, bundleId: null, bundleIntegrity: null, visible: true }, now)
  assert.deepEqual((await db.listReports()).map((r) => [r.filename, r.uploadedByLogin]), [['g.json', 'ghost'], ['r.json', 'alice']])
  // Bundles snapshot the uploader the same way.
  await db.insertBundle({ id: randomUUID(), integrity: 'sha512-A', filename: 'a.map', kind: 'sourcemap', byteSize: 1, uploadedBy: null, uploadedByLogin: 'ghost', repoId: null }, now)
  assert.equal((await db.listBundles())[0].uploadedByLogin, 'ghost')
  await db.close()
})

test('GET /api/admin/reports: admin|manage only (401 unauth, 403 none, 200 admin|manage)', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const manageSess = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)
  const noneSess = await createSession(config, db, { githubUserId: 3, login: 'cy', name: null, avatarUrl: null }, now + 2000)
  await db.setUserRole((await readSession(config, db, cookiePair(manageSess.setCookie), now)).user.id, 'manage')

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: createBundleStore(fakeBlobStore(), fakeBlobStore()),
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
  async function get(cookie) {
    const res = mockRes()
    handler({ method: 'GET', url: '/api/admin/reports', headers: cookie ? { cookie } : {} }, res)
    await pending
    return res
  }

  assert.equal((await get(null)).statusCode, 401)
  assert.equal((await get(cookiePair(noneSess.setCookie))).statusCode, 403)
  assert.equal((await get(cookiePair(manageSess.setCookie))).statusCode, 200)
  const ok = await get(cookiePair(adminSess.setCookie))
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(JSON.parse(ok.body), { reports: [], maxBytes: config.maxReportBytes, repos: [], repoScopes: null })
  await db.close()
})

test('reports upload/download/delete: CSRF + role, sanitised filename, attribution, 413/400/404', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const noneSess = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)
  const admin = (await readSession(config, db, cookiePair(adminSess.setCookie), now)).user
  // Small cap so the too-large path is cheap to exercise.
  const smallCap = { ...config, maxReportBytes: 64 }

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config: smallCap, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: createBundleStore(fakeBlobStore(), fakeBlobStore()),
    originGate: { trustProxy: false, isOriginAllowed: () => true },
    isShuttingDown: () => false, track: (p) => { pending = p },
  })
  function mockRes() {
    return {
      statusCode: 0, headers: {}, body: '', ended: false,
      writeHead(c, h) { this.statusCode = c; if (h) this.headers = h; return this },
      end(b) { if (b != null) this.body += b; this.ended = true; return this },
      get headersSent() { return this.ended },
    }
  }
  async function upload(cookie, csrf, body, extraHeaders = {}) {
    const res = mockRes()
    const headers = { 'content-type': 'application/json', ...extraHeaders }
    if (cookie) headers.cookie = cookie
    if (csrf) headers['x-csrf-token'] = csrf
    const req = new Readable({ read() {} })
    req.method = 'POST'; req.url = '/api/admin/reports'; req.headers = headers
    handler(req, res)
    if (body) req.push(body)
    req.push(null)
    await pending
    return res
  }
  async function send(method, url, cookie, csrf) {
    const res = mockRes()
    const headers = cookie ? { cookie } : {}
    if (csrf) headers['x-csrf-token'] = csrf
    handler({ method, url, headers }, res)
    await pending
    return res
  }
  const aCk = cookiePair(adminSess.setCookie)

  // authz / CSRF / validation (no bytes stored)
  assert.equal((await upload(cookiePair(noneSess.setCookie), noneSess.csrfToken, '{}')).statusCode, 403) // 'none'
  assert.equal((await upload(aCk, null, '{}')).statusCode, 403) // CSRF missing
  assert.equal((await upload(aCk, adminSess.csrfToken, '')).statusCode, 400) // empty body
  assert.equal((await upload(aCk, adminSess.csrfToken, 'x'.repeat(100))).statusCode, 413) // over the 64-byte cap

  // Upload succeeds; the filename header is URL-decoded + path-stripped.
  const up = await upload(aCk, adminSess.csrfToken, '{"findings":[]}', { 'x-report-filename': encodeURIComponent(`sub/dir/scan${String.fromCodePoint(0x7f)}.json`) })
  assert.equal(up.statusCode, 201)
  const { id, slug } = JSON.parse(up.body)
  assert.match(id, /^[0-9a-f-]{36}$/u)
  assert.equal(slug, id.split('-').at(-1))

  // It lists with the sanitised filename + uploader attribution.
  const listed = JSON.parse((await send('GET', '/api/admin/reports', aCk)).body).reports
  assert.equal(listed.length, 1)
  assert.deepEqual([listed[0].id, listed[0].filename, listed[0].uploadedByLogin], [id, 'sub_dir_scan.json', admin.login])

  // Download returns the stored bytes + recorded content-type + a filename.
  const dl = await send('GET', `/api/admin/reports/${id}`, aCk)
  assert.equal(dl.statusCode, 200)
  assert.equal(dl.body, '{"findings":[]}')
  assert.equal(dl.headers['content-type'], 'application/json')
  assert.match(dl.headers['content-disposition'], /filename="sub_dir_scan\.json"/u)
  assert.equal(dl.headers['x-content-type-options'], 'nosniff') // uploader content-type can't be sniffed inline
  assert.equal((await send('GET', `/api/admin/reports/${randomUUID()}`, aCk)).statusCode, 404) // unknown id

  // Delete needs CSRF; then the row is gone and a repeat 404s.
  assert.equal((await send('DELETE', `/api/admin/reports/${id}`, aCk, null)).statusCode, 403) // CSRF missing
  assert.equal((await send('DELETE', `/api/admin/reports/${id}`, aCk, adminSess.csrfToken)).statusCode, 200)
  assert.deepEqual(await db.listReports(), [])
  assert.equal((await send('DELETE', `/api/admin/reports/${id}`, aCk, adminSess.csrfToken)).statusCode, 404)
  await db.close()
})

test('db: bundles — insert/get/list/delete, integrity dedup-key, report link + FK null on delete', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const uid = await db.upsertUser({ githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: uid }, now)
  const bId = randomUUID()
  await db.insertBundle({ id: bId, integrity: 'sha512-AAA', filename: 'a.map', kind: 'sourcemap', byteSize: 10, uploadedBy: uid, repoId: 7 }, now)

  assert.equal((await db.getBundleByIntegrity('sha512-AAA')).id, bId)
  assert.equal((await db.getBundle(bId)).filename, 'a.map')
  assert.equal(await db.getBundleByIntegrity('sha512-NOPE'), null)
  const [bl] = await db.listBundles()
  assert.deepEqual([bl.filename, bl.kind, bl.uploadedByLogin, bl.repoFullName], ['a.map', 'sourcemap', 'alice', 'o/r'])

  // A report that declared this integrity before the bundle landed → link it now.
  const rId = randomUUID()
  await db.insertReport({ id: rId, filename: 'r.json', contentType: 'application/json', byteSize: 5, sha256: 'h', uploadedBy: uid, repoId: null, bundleId: null, bundleIntegrity: 'sha512-AAA', visible: true }, now)
  await db.linkReportsToBundle('sha512-AAA', bId)
  const [rl] = await db.listReports()
  assert.deepEqual([rl.bundleId, rl.bundleFilename, rl.bundleIntegrity], [bId, 'a.map', 'sha512-AAA'])

  // Deleting the bundle nulls the report's bundle_id (FK SET NULL) but keeps the
  // declared integrity, so a re-upload can re-link.
  assert.equal(await db.deleteBundle(bId), true)
  const [rl2] = await db.listReports()
  assert.deepEqual([rl2.bundleId, rl2.bundleFilename, rl2.bundleIntegrity], [null, null, 'sha512-AAA'])
  assert.equal(await db.deleteBundle(bId), false) // already gone
  await db.close()
})

// Shared HTTP harness for the bundle / link / report-triage tests: a handler
// over in-memory stores + an always-allow origin gate, with raw-body upload +
// plain send. Pass a reportStore when a fixture needs to seed report bytes.
function bundleHarness(db, cfg = config, reportStore = fakeBlobStore()) {
  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config: cfg, db, avatarStore: fakeAvatarStore(), reportStore, bundleStore: createBundleStore(fakeBlobStore(), fakeBlobStore()),
    originGate: { trustProxy: false, isOriginAllowed: () => true },
    isShuttingDown: () => false, track: (p) => { pending = p },
  })
  function mockRes() {
    return new class extends Writable {
      statusCode = 0
      headers = {}
      body = ''
      bytes = Buffer.alloc(0)
      ended = false
      writeHead(c, h) { this.statusCode = c; if (h) this.headers = h; return this }
      _write(chunk, _encoding, callback) {
        this.body += chunk; this.bytes = Buffer.concat([this.bytes, chunk]); callback()
      }
      _final(callback) { this.ended = true; callback() }
      get headersSent() { return this.ended }
    }()
  }
  async function upload(url, cookie, csrf, body, extraHeaders = {}) {
    const res = mockRes()
    const headers = { 'content-type': 'application/json', ...extraHeaders }
    if (cookie) headers.cookie = cookie
    if (csrf) headers['x-csrf-token'] = csrf
    const req = new Readable({ read() {} })
    req.method = 'POST'; req.url = url; req.headers = headers
    handler(req, res)
    if (body) req.push(body)
    req.push(null)
    await pending
    return res
  }
  async function send(method, url, cookie, csrf) {
    const res = mockRes()
    const headers = cookie ? { cookie } : {}
    if (csrf) headers['x-csrf-token'] = csrf
    handler({ method, url, headers }, res)
    await pending
    return res
  }
  return { upload, send }
}

for (const [label, filename] of [
  ['short filename', 'export.csv'],
  ['long filename', `${'a'.repeat(250)}.csv`],
  ['encoded path and uppercase suffix', `reports/${'long name '.repeat(30)}.CSV`],
]) {
  test(`managed CSV reports support downloads, filtering, triage, and repository impact: ${label}`, async (t) => {
    const db = openSqliteManagedDb(':memory:')
    t.after(() => db.close())
    const now = Date.now()
    const admin = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, now)
    const member = await createSession(config, db, { githubUserId: 2, login: 'member', name: null, avatarUrl: null }, now)
    await db.setUserRole(member.userId, 'triage')
    await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: admin.userId }, now)
    const team = randomUUID()
    await db.createTeam(team, 'CSV team', now)
    await db.setTeamRepo(team, 7, null)
    await db.setTeamMember(team, member.userId, { dependencies: false, security: true })
    const { upload, send } = bundleHarness(db)
    const adminCookie = cookiePair(admin.setCookie), memberCookie = cookiePair(member.setCookie)
    const created = await upload('/api/admin/reports', adminCookie, admin.csrfToken, managedCsv, {
      'x-report-filename': encodeURIComponent(filename), 'content-type': 'text/csv', 'x-repo-id': '7',
    })
    assert.equal(created.statusCode, 201)
    const rec = JSON.parse(created.body)
    assert.ok(rec.filename.length <= 200)
    assert.ok(rec.filename.endsWith(filename.endsWith('.CSV') ? '.CSV' : '.csv'), 'truncation must keep the format suffix')
    assert.equal(rec.analyzer, 'codex-security')
    assert.equal(rec.repoEmbedded, false)
    await db.setReportVisible(rec.id, true)
    const view = `/api/reports/${rec.id}`
    const triage = `${view}/triage`
    assert.equal((await send('GET', `/api/admin/reports/${rec.id}`, adminCookie)).body, managedCsv)
    assert.equal((await send('GET', view, adminCookie)).body, managedCsv)
    const own = await send('GET', view, memberCookie)
    assert.equal(own.statusCode, 200)
    assert.deepEqual(JSON.parse(own.body).findings.map((finding) => finding.id), managedCsvIds.slice(0, 1))
    const annotate = (cookie, csrf, id) => upload(triage, cookie, csrf, JSON.stringify({ entries: { [id]: { fix: 'Reviewed' } } }))
    assert.equal((await annotate(memberCookie, member.csrfToken, managedCsvIds[0])).statusCode, 200)
    assert.equal((await annotate(memberCookie, member.csrfToken, managedCsvIds[1])).statusCode, 404)
    assert.equal((await annotate(adminCookie, admin.csrfToken, managedCsvIds[1])).statusCode, 200)
    assert.deepEqual(Object.keys(JSON.parse((await send('GET', triage, memberCookie)).body).entries), managedCsvIds.slice(0, 1))
    const impact = await send('GET', '/api/admin/repositories/impact?repoId=7', adminCookie)
    assert.equal(impact.statusCode, 200)
    assert.equal(JSON.parse(impact.body).triageCount, 2)
    await db.setTeamMember(team, member.userId, { dependencies: true, security: false })
    assert.deepEqual(JSON.parse((await send('GET', view, memberCookie)).body).findings, [])
    assert.deepEqual(JSON.parse((await send('GET', triage, memberCookie)).body).entries, {})
    assert.equal((await annotate(memberCookie, member.csrfToken, managedCsvIds[0])).statusCode, 404)
  })
}


for (const role of ['view', 'triage', 'admin']) {
  test(`report reads return 404 if metadata is deleted while bytes are loading (${role})`, async (t) => {
    const db = openSqliteManagedDb(':memory:')
    t.after(() => db.close())
    const now = Date.now()
    const admin = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, now)
    const viewer = await createSession(config, db, { githubUserId: 2, login: 'viewer', name: null, avatarUrl: null }, now)
    await db.setUserRole(viewer.userId, role)
    await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: admin.userId }, now)
    const id = randomUUID(), team = randomUUID()
    await db.createTeam(team, 'Restricted CSV team', now)
    await db.setTeamRepo(team, 7, null)
    await db.setTeamMember(team, viewer.userId, { dependencies: false, security: true })
    await db.insertReport({ id, filename: 'export.csv', contentType: 'text/csv', byteSize: managedCsv.length, sha256: 'csv', uploadedBy: admin.userId, repoId: 7, visible: true }, now)
    const store = fakeBlobStore()
    await store.put(id, Buffer.from(managedCsv))
    const { send } = bundleHarness(db, config, store)
    // Authorization succeeds first, but deletion wins before the pending blob
    // read returns. Keep those already-read bytes to reproduce the real race.
    t.mock.method(store, 'get', async (reportId) => {
      const bytes = store.map.get(reportId)
      assert.equal(await db.deleteReport(reportId), true)
      return bytes
    })
    const response = await send('GET', `/api/reports/${id}`, cookiePair(viewer.setCookie))
    assert.equal(response.statusCode, 404)
    assert.deepEqual(JSON.parse(response.body), { error: 'no-report' })
    assert.ok(!response.body.includes(managedCsvIds[1]), 'never release the forbidden dependency finding')
  })
}

test('bundles upload/download/delete: CSRF + role, sha512 dedup, kind, 413/400/404', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const noneSess = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)
  const { upload, send } = bundleHarness(db, { ...config, maxBundleBytes: 64 })
  const aCk = cookiePair(adminSess.setCookie)
  const B = '/api/admin/bundles'

  // authz / CSRF / validation
  assert.equal((await upload(B, cookiePair(noneSess.setCookie), noneSess.csrfToken, '{}')).statusCode, 403) // 'none'
  assert.equal((await upload(B, aCk, null, '{}')).statusCode, 403) // CSRF missing
  assert.equal((await upload(B, aCk, adminSess.csrfToken, '')).statusCode, 400) // empty
  assert.equal((await upload(B, aCk, adminSess.csrfToken, 'x'.repeat(100))).statusCode, 413) // over the 64-byte cap

  // Upload → 201 with the content-addressed integrity; '.map' → sourcemap kind.
  const body = '{"stasis":1}'
  const up = await upload(B, aCk, adminSess.csrfToken, body, { 'x-bundle-filename': encodeURIComponent('app.js.map') })
  assert.equal(up.statusCode, 201)
  const { id, integrity } = JSON.parse(up.body)
  assert.match(id, /^[0-9a-f-]{36}$/u)
  assert.equal(integrity, bundleIntegrity(Buffer.from(body)))
  const listed = JSON.parse((await send('GET', B, aCk)).body).bundles
  assert.deepEqual([listed.length, listed[0].kind, listed[0].uploadedByLogin], [1, 'sourcemap', 'alice'])

  // Re-upload identical bytes → dedupe to the same row (no second copy).
  const dup = await upload(B, aCk, adminSess.csrfToken, body, { 'x-bundle-filename': encodeURIComponent('copy.map') })
  assert.equal(dup.statusCode, 200)
  assert.deepEqual([JSON.parse(dup.body).id, JSON.parse(dup.body).deduped], [id, true])
  assert.equal(JSON.parse((await send('GET', B, aCk)).body).bundles.length, 1)

  // Download → octet-stream bytes; delete (CSRF) → gone; repeat → 404.
  const dl = await send('GET', `/api/admin/bundles/${id}`, aCk)
  assert.equal(dl.statusCode, 200)
  assert.equal(dl.headers['content-encoding'], 'br')
  assert.equal(brotliDecompressSync(dl.bytes).toString(), body)
  assert.equal(dl.headers['content-type'], 'application/octet-stream')
  assert.equal(dl.headers['x-content-type-options'], 'nosniff')
  assert.equal((await send('DELETE', `/api/admin/bundles/${id}`, aCk, null)).statusCode, 403) // CSRF missing
  assert.equal((await send('DELETE', `/api/admin/bundles/${id}`, aCk, adminSess.csrfToken)).statusCode, 200)
  assert.equal((await send('DELETE', `/api/admin/bundles/${id}`, aCk, adminSess.csrfToken)).statusCode, 404)
  await db.close()
})

test('report↔bundle auto-link (both upload orders) + optional repo link', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const admin = (await readSession(config, db, cookiePair(adminSess.setCookie), now)).user
  await db.selectRepo({ repoId: 42, fullName: 'o/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: admin.id }, now)
  const { upload, send } = bundleHarness(db)
  const aCk = cookiePair(adminSess.setCookie)
  const csrf = adminSess.csrfToken

  // ── Order A: bundle first, then a report that references it + links a repo ──
  const bundleA = '{"a":1}'
  const integA = bundleIntegrity(Buffer.from(bundleA))
  const upB = await upload('/api/admin/bundles', aCk, csrf, bundleA, { 'x-bundle-filename': encodeURIComponent('a.map') })
  const bundleAId = JSON.parse(upB.body).id
  const upR = await upload('/api/admin/reports', aCk, csrf, JSON.stringify({ bundleHashes: [integA] }), { 'x-repo-id': '42' })
  assert.equal(upR.statusCode, 201)
  assert.deepEqual([JSON.parse(upR.body).bundleId, JSON.parse(upR.body).repoId], [bundleAId, 42])
  let reports = JSON.parse((await send('GET', '/api/admin/reports', aCk)).body).reports
  const rA = reports.find((r) => r.id === JSON.parse(upR.body).id)
  assert.deepEqual([rA.bundleFilename, rA.repoFullName, rA.bundleIntegrity], ['a.map', 'o/repo', integA])

  // ── Order B: report first (bundle absent → unlinked), then the bundle ──
  const bundleB = '{"b":2}'
  const integB = bundleIntegrity(Buffer.from(bundleB))
  const upR2 = await upload('/api/admin/reports', aCk, csrf, JSON.stringify({ bundleHashes: [integB] }))
  const r2Id = JSON.parse(upR2.body).id
  assert.equal(JSON.parse(upR2.body).bundleId, null) // not stored yet
  await upload('/api/admin/bundles', aCk, csrf, bundleB, { 'x-bundle-filename': encodeURIComponent('b.map') })
  reports = JSON.parse((await send('GET', '/api/admin/reports', aCk)).body).reports
  const r2 = reports.find((r) => r.id === r2Id)
  assert.equal(r2.bundleFilename, 'b.map') // auto-linked on bundle upload
  assert.equal(r2.bundleIntegrity, integB)

  // Unknown repo id on upload → 400 (validated against the selected set).
  assert.equal((await upload('/api/admin/reports', aCk, csrf, '{}', { 'x-repo-id': '999999' })).statusCode, 400)
  await db.close()
})

test('reports/bundles set-repo: db attach/detach + endpoint (role, CSRF, validation, 404)', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const noneSess = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)
  const admin = (await readSession(config, db, cookiePair(adminSess.setCookie), now)).user
  await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: admin.id }, now)
  const reportId = randomUUID()
  await db.insertReport({ id: reportId, filename: 'r.json', contentType: 'application/json', byteSize: 2, sha256: 'x', uploadedBy: admin.id, repoId: null, bundleId: null, bundleIntegrity: null, visible: true }, now)
  const bundleId = randomUUID()
  await db.insertBundle({ id: bundleId, integrity: 'sha512-Z', filename: 'b.map', kind: 'sourcemap', byteSize: 3, uploadedBy: admin.id, repoId: null }, now)

  // db layer: attach, detach, and not-found.
  assert.equal(await db.setReportRepo(reportId, 7), true)
  assert.equal((await db.listReports())[0].repoId, 7)
  assert.equal(await db.setReportRepo(reportId, null), true)
  assert.equal((await db.listReports())[0].repoId, null)
  assert.equal(await db.setReportRepo(randomUUID(), 7), false) // no such report
  assert.equal(await db.setBundleRepo(bundleId, 7), true)
  assert.equal((await db.listBundles())[0].repoId, 7)

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: createBundleStore(fakeBlobStore(), fakeBlobStore()),
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
  async function post(path, cookie, csrf, payload) {
    const res = mockRes()
    const headers = { 'content-type': 'application/json' }
    if (cookie) headers.cookie = cookie
    if (csrf) headers['x-csrf-token'] = csrf
    const req = new Readable({ read() {} })
    req.method = 'POST'; req.url = path; req.headers = headers
    handler(req, res); req.push(JSON.stringify(payload)); req.push(null)
    await pending
    return res
  }
  const aCk = cookiePair(adminSess.setCookie); const csrf = adminSess.csrfToken
  const RR = '/api/admin/reports/set-repo'
  assert.equal((await post(RR, cookiePair(noneSess.setCookie), noneSess.csrfToken, { reportId, repoId: 7 })).statusCode, 403) // 'none'
  assert.equal((await post(RR, aCk, null, { reportId, repoId: 7 })).statusCode, 403) // CSRF missing
  assert.equal((await post(RR, aCk, csrf, { reportId, repoId: 999 })).statusCode, 400) // repo not selected
  assert.equal((await post(RR, aCk, csrf, { reportId: 'nope', repoId: 7 })).statusCode, 404) // no such report
  assert.equal((await post(RR, aCk, csrf, { reportId, repoId: 7 })).statusCode, 200) // attach
  assert.equal((await db.listReports())[0].repoId, 7)
  assert.equal((await post(RR, aCk, csrf, { reportId, repoId: null })).statusCode, 200) // detach
  assert.equal((await db.listReports())[0].repoId, null)
  // bundle endpoint: the set-repo exact path is matched before the per-id prefix.
  assert.equal((await post('/api/admin/bundles/set-repo', aCk, csrf, { bundleId, repoId: 7 })).statusCode, 200)
  await db.close()
})

test('db: teams — create/list/delete, repo (+path) & member (+perms) links, FK cascade', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const uid = await db.upsertUser({ githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: uid }, now)
  const tId = randomUUID()
  assert.equal(await db.createTeam(tId, 'Blue', now), true)
  assert.equal(await db.createTeam(randomUUID(), 'Blue', now), false) // name taken (UNIQUE)
  assert.deepEqual(await db.getTeam(tId), { id: tId, slug: tId.split('-').at(-1), name: 'Blue' })
  assert.deepEqual(await db.listUserOptions(), [{ id: uid, login: 'alice', name: null }])

  await db.setTeamRepo(tId, 7, 'src/app')
  await db.setTeamMember(tId, uid, { dependencies: true, security: false })
  let [t] = await db.listTeams()
  assert.deepEqual(t.repos, [{ repoId: 7, fullName: 'o/r', path: 'src/app' }])
  assert.deepEqual(t.members, [{ userId: uid, login: 'alice', dependencies: true, security: false }])

  // Upsert: refresh the path (→ null) + flip perms.
  await db.setTeamRepo(tId, 7, null)
  await db.setTeamMember(tId, uid, { dependencies: true, security: true })
  ;[t] = await db.listTeams()
  assert.equal(t.repos[0].path, null)
  assert.deepEqual([t.members[0].dependencies, t.members[0].security], [true, true])

  // Deselecting the repo cascades the team_repo link away.
  await db.deselectRepo(7)
  ;[t] = await db.listTeams()
  assert.deepEqual(t.repos, [])

  assert.equal(await db.removeTeamMember(tId, uid), true)
  assert.equal(await db.removeTeamMember(tId, uid), false) // already gone
  assert.equal(await db.deleteTeam(tId), true)
  assert.deepEqual(await db.listTeams(), [])
  await db.close()
})

test('db: renameTeam — ok, same-name idempotent, name-taken, not-found', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const a = randomUUID(); const b = randomUUID()
  await db.createTeam(a, 'Alpha', now)
  await db.createTeam(b, 'Beta', now)
  assert.equal(await db.renameTeam(a, 'Alpha 2', now), 'ok')
  assert.equal((await db.getTeam(a)).name, 'Alpha 2')
  assert.equal(await db.renameTeam(a, 'Alpha 2', now), 'ok') // same name is idempotent
  assert.equal(await db.renameTeam(a, 'Beta', now), 'name-taken') // taken by b
  assert.equal((await db.getTeam(a)).name, 'Alpha 2') // unchanged after the clash
  assert.equal(await db.renameTeam(randomUUID(), 'Gamma', now), 'not-found')
  await db.close()
})

test('GET /api/teams + db.listTeamsForUser: a user sees only their own teams', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const aliceSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const bobSess = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)
  const alice = (await readSession(config, db, cookiePair(aliceSess.setCookie), now)).user
  const bob = (await readSession(config, db, cookiePair(bobSess.setCookie), now)).user
  const blue = randomUUID(); const red = randomUUID()
  await db.createTeam(blue, 'Blue', now)
  await db.createTeam(red, 'Red', now)
  await db.setTeamMember(blue, alice.id, { dependencies: false, security: false })
  await db.setTeamMember(red, alice.id, { dependencies: false, security: false })
  await db.setTeamMember(blue, bob.id, { dependencies: false, security: false })

  // db: alice in Blue+Red (name-sorted), bob in Blue only.
  assert.deepEqual((await db.listTeamsForUser(alice.id)).map((t) => t.name), ['Blue', 'Red'])
  assert.deepEqual((await db.listTeamsForUser(bob.id)).map((t) => t.name), ['Blue'])

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: createBundleStore(fakeBlobStore(), fakeBlobStore()),
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
  async function get(cookie) {
    const res = mockRes()
    handler({ method: 'GET', url: '/api/teams', headers: cookie ? { cookie } : {} }, res)
    await pending
    return res
  }
  assert.equal((await get(null)).statusCode, 401) // unauthenticated
  // A signed-in 'none' account cannot read even its own team membership.
  assert.equal((await get(cookiePair(bobSess.setCookie))).statusCode, 403)
  await db.setUserRole(bobSess.userId, 'view')
  assert.deepEqual(JSON.parse((await get(cookiePair(bobSess.setCookie))).body).teams.map((t) => t.name), ['Blue'])
  await db.close()
})

test('team reports: read iff admin, OR (>=view role AND in a team holding the repo)', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  // alice = first user = admin, deliberately NOT in any team (tests the admin bypass).
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const viewerSess = await createSession(config, db, { githubUserId: 2, login: 'viewer', name: null, avatarUrl: null }, now + 1000)
  const nonerSess = await createSession(config, db, { githubUserId: 3, login: 'noner', name: null, avatarUrl: null }, now + 2000)
  const outsiderSess = await createSession(config, db, { githubUserId: 4, login: 'outsider', name: null, avatarUrl: null }, now + 3000)
  const admin = (await readSession(config, db, cookiePair(adminSess.setCookie), now)).user
  const viewer = (await readSession(config, db, cookiePair(viewerSess.setCookie), now)).user
  const noner = (await readSession(config, db, cookiePair(nonerSess.setCookie), now)).user
  const outsider = (await readSession(config, db, cookiePair(outsiderSess.setCookie), now)).user
  await db.setUserRole(viewer.id, 'view')
  await db.setUserRole(outsider.id, 'view') // noner stays 'none'

  // repo 7 in team Blue (viewer + noner are members); repo 8 in team Green (outsider).
  await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: admin.id }, now)
  await db.selectRepo({ repoId: 8, fullName: 'o/other', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: admin.id }, now)
  const blue = randomUUID(); await db.createTeam(blue, 'Blue', now); await db.setTeamRepo(blue, 7, null)
  await db.setTeamMember(blue, viewer.id, { dependencies: false, security: false })
  await db.setTeamMember(blue, noner.id, { dependencies: false, security: false })
  const green = randomUUID(); await db.createTeam(green, 'Green', now); await db.setTeamRepo(green, 8, null)
  await db.setTeamMember(green, outsider.id, { dependencies: false, security: false })
  const reportId = randomUUID()
  await db.insertReport({ id: reportId, filename: 'scan.json', contentType: 'application/json', byteSize: 5, sha256: 'x', uploadedBy: admin.id, repoId: 7, bundleId: null, bundleIntegrity: null, visible: true }, now)

  const reportStore = fakeBlobStore()
  await reportStore.put(reportId, Buffer.from('{"findings":[]}'))
  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(), reportStore, bundleStore: createBundleStore(fakeBlobStore(), fakeBlobStore()),
    originGate: { trustProxy: false, isOriginAllowed: () => true },
    isShuttingDown: () => false, track: (p) => { pending = p },
  })
  function mockRes() {
    return {
      statusCode: 0, headers: {}, body: '', ended: false,
      writeHead(c, h) { this.statusCode = c; if (h) this.headers = h; return this },
      end(b) { if (b != null) this.body += b; this.ended = true; return this },
      get headersSent() { return this.ended },
    }
  }
  async function req(url, cookie, accept) {
    const res = mockRes()
    handler({ method: 'GET', url, headers: { ...(cookie ? { cookie } : {}), ...(accept ? { accept } : {}) } }, res)
    await pending
    return res
  }
  const view = (sess, id) => req(`/api/reports/${id}`, sess && cookiePair(sess.setCookie))

  // GET /api/reports/<id> — the access rule, enforced SERVER-SIDE.
  assert.equal((await view(null, reportId)).statusCode, 401) // unauthenticated
  const okAdmin = await view(adminSess, reportId)
  assert.equal(okAdmin.statusCode, 200) // admin, NOT in any team → still allowed
  assert.equal(okAdmin.body, '{"findings":[]}')
  assert.equal(okAdmin.headers['content-type'], 'text/plain; charset=utf-8')
  assert.equal(okAdmin.headers['x-content-type-options'], 'nosniff')
  assert.equal((await view(viewerSess, reportId)).statusCode, 200) // >=view + member of the team holding repo 7
  assert.equal((await view(nonerSess, reportId)).statusCode, 403) // IN the team, but role 'none' → refused
  assert.equal((await view(outsiderSess, reportId)).statusCode, 404) // >=view, but wrong team (no repo 7)
  assert.equal((await view(adminSess, randomUUID())).statusCode, 404) // admin, but the report doesn't exist
  for (const [session, status] of [[null, 401], [nonerSess, 403], [outsiderSess, 404]]) {
    assert.equal((await req(`/api/reports/${reportId}`, session && cookiePair(session.setCookie), 'application/json')).statusCode, status, 'metadata follows the same access checks as content')
  }

  // The db check is team-only (the role gate lives in the handler): viewer AND noner
  // are both members of Blue, but only viewer's role clears the endpoint above.
  assert.equal(await db.userCanReadReport(viewer.id, reportId), true)
  assert.equal(await db.userCanReadReport(noner.id, reportId), true)
  assert.equal(await db.userCanReadReport(outsider.id, reportId), false)
  assert.equal(await db.userCanReadReport(admin.id, reportId), false) // admin isn't a member

  // No access accounts cannot read the team or any of its content.
  const teamsOf = async (sess) => JSON.parse((await req('/api/teams', cookiePair(sess.setCookie))).body).teams
  assert.deepEqual((await teamsOf(viewerSess)).map((t) => [t.name, t.reports.map((r) => r.filename)]), [['Blue', ['scan.json']]])
  assert.equal((await req('/api/teams', cookiePair(nonerSess.setCookie))).statusCode, 403)
  await db.close()
})

test('team paths gate report listings, reads, triage, and permission aggregation', async (t) => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, now)
  const memberSess = await createSession(config, db, { githubUserId: 2, login: 'member', name: null, avatarUrl: null }, now)
  const admin = (await readSession(config, db, cookiePair(adminSess.setCookie), now)).user
  const member = (await readSession(config, db, cookiePair(memberSess.setCookie), now)).user
  await db.setUserRole(member.id, 'triage')
  await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: admin.id }, now)
  const team = randomUUID()
  await db.createTeam(team, 'Scoped team', now)
  await db.setTeamRepo(team, 7, 'packages/a')
  await db.setTeamMember(team, member.id, { dependencies: false, security: false })
  const reportStore = fakeBlobStore()
  const directories = ['packages/a', 'packages/a/sub', 'packages/ab', 'packages/b', 'packages/A', 'packages', '', null, 'pkg/%_/child', 'pkg/xx/child']
  const reportIds = []
  for (const repoDirectory of directories) {
    const id = randomUUID()
    reportIds.push(id)
    const content = Buffer.from(JSON.stringify({ source: 'native', findings: [{ id: 'own', file: 'src/a.js' }] }))
    await db.insertReport({ id, filename: `${reportIds.length}.json`, contentType: 'application/json', byteSize: content.length, sha256: id, uploadedBy: admin.id, repoId: 7, repoDirectory, bundleId: null, bundleIntegrity: null, visible: true }, now)
    await reportStore.put(id, content)
  }
  const { send, upload } = bundleHarness(db, config, reportStore)
  const cookie = cookiePair(memberSess.setCookie)
  const list = JSON.parse((await send('GET', '/api/teams', cookie)).body).teams
  assert.deepEqual(list[0].reports.map((r) => r.id).toSorted(), reportIds.slice(0, 2).toSorted())
  for (const [index, id] of reportIds.entries()) {
    const allowed = index < 2
    assert.equal(await db.userCanReadReport(member.id, id), allowed, `scope: ${directories[index]}`)
    for (const suffix of ['', '/triage', '/triage/history?finding=own']) {
      assert.equal((await send('GET', `/api/reports/${id}${suffix}`, cookie)).statusCode, allowed ? 200 : 404, `${directories[index]}${suffix}`)
    }
    const edit = await upload(`/api/reports/${id}/triage`, cookie, memberSess.csrfToken, JSON.stringify({ entries: { own: { fix: 'checked' } } }))
    assert.equal(edit.statusCode, allowed ? 200 : 404)
    assert.equal((await send('GET', `/api/reports/${id}`, cookiePair(adminSess.setCookie))).statusCode, 200, 'admins retain full access')
  }
  // A second team's wider permissions must not bleed into a sibling path.
  const other = randomUUID()
  await db.createTeam(other, 'Sibling team', now)
  await db.setTeamRepo(other, 7, 'packages/b')
  await db.setTeamMember(other, member.id, { dependencies: true, security: true })
  assert.deepEqual(await db.reportPermissionsFor(member.id, reportIds[0]), { dependencies: false, security: false })
  assert.deepEqual(await db.reportPermissionsFor(member.id, reportIds[3]), { dependencies: true, security: true })
  await db.setTeamRepo(other, 7, 'packages/a/sub')
  assert.deepEqual(await db.reportPermissionsFor(member.id, reportIds[0]), { dependencies: false, security: false })
  assert.deepEqual(await db.reportPermissionsFor(member.id, reportIds[1]), { dependencies: true, security: true })
  await db.setTeamRepo(team, 7, 'packages/a/sub')
  const overlap = (await db.listTeamsForUser(member.id)).find(entry => entry.id === team)
  assert.equal(overlap.reports.length, new Set(overlap.reports.map(report => report.id)).size)
  // Paths are literal and case-sensitive, including SQL wildcard characters.
  await db.removeTeamRepo(team, 7)
  await db.setTeamRepo(team, 7, 'pkg/%_')
  const scoped = (await db.listTeamsForUser(member.id)).find((entry) => entry.id === team)
  assert.deepEqual(scoped.reports.map((r) => r.id), [reportIds[8]])
  assert.equal(await db.userCanReadReport(member.id, reportIds[9]), false)
  await db.removeTeamRepo(other, 7)
  // Both representations of a whole-repository scope include root reports.
  for (const path of [null, '']) {
    await db.setTeamRepo(team, 7, path)
    assert.equal((await db.listTeamsForUser(member.id))[0].reports.length, directories.length)
    for (const id of reportIds) assert.equal(await db.userCanReadReport(member.id, id), true)
  }
})

test('filterReportContent: strips dependency + security findings per the viewer permissions', () => {
  const report = JSON.stringify({
    source: 'native',
    findings: [
      { id: 'own', file: 'src/a.js', type: 'correctness' },
      { id: 'dep', file: 'node_modules/lodash/x.js', type: 'correctness' },
      { id: 'secAnalyzer', file: 'src/b.js', analyzer: 'codex-security' },
      // a dedup group: the primary is correctness, but a duplicate is stamped security.
      [{ id: 'secDup', file: 'src/c.js', type: 'correctness' }, { id: 'secDupB', file: 'src/c.js', security: true }],
      { id: 'secFlag', file: 'src/d.js', security: true },
    ],
  })
  const ids = (s) => JSON.parse(s).findings.map((e) => (Array.isArray(e) ? e[0].id : e.id))

  assert.deepEqual(ids(filterReportContent(report, { dependencies: true, security: true })), ['own', 'dep', 'secAnalyzer', 'secDup', 'secFlag'])
  assert.deepEqual(ids(filterReportContent(report, { dependencies: false, security: true })), ['own', 'secAnalyzer', 'secDup', 'secFlag']) // dep dropped
  assert.deepEqual(ids(filterReportContent(report, { dependencies: true, security: false })), ['own', 'dep']) // analyzer/dup/flag security dropped
  assert.deepEqual(ids(filterReportContent(report, { dependencies: false, security: false })), ['own'])
})

test('filterReportContent: report-level security source, non-JSON + no-strip passthrough', () => {
  // Whole report from a security analyzer (source includes "security") → every
  // finding is security; a viewer without that permission sees none.
  const sec = JSON.stringify({ source: 'claude-security', findings: [{ id: 'x', file: 'src/a.js' }, { id: 'y', file: 'src/b.js' }] })
  assert.deepEqual(JSON.parse(filterReportContent(sec, { dependencies: true, security: false })).findings, [])
  assert.equal(JSON.parse(filterReportContent(sec, { dependencies: true, security: true })).findings.length, 2)
  // Non-JSON (markdown) and JSON-without-findings pass through byte-for-byte.
  const md = '# Findings\n- something'
  assert.equal(filterReportContent(md, { dependencies: false, security: false }), md)
  const noFindings = JSON.stringify({ hello: 'world' })
  assert.equal(filterReportContent(noFindings, { dependencies: false, security: false }), noFindings)
})

test('GET /api/reports/<id>: filtered content and authoritative repo metadata (admin/manage exempt)', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const viewerSess = await createSession(config, db, { githubUserId: 2, login: 'viewer', name: null, avatarUrl: null }, now + 1000)
  const admin = (await readSession(config, db, cookiePair(adminSess.setCookie), now)).user
  const viewer = (await readSession(config, db, cookiePair(viewerSess.setCookie), now)).user
  await db.setUserRole(viewer.id, 'view')
  await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: admin.id }, now)
  const team = randomUUID()
  await db.createTeam(team, 'Blue', now)
  await db.setTeamRepo(team, 7, null)
  await db.setTeamMember(team, viewer.id, { dependencies: false, security: true }) // may see security, NOT dependencies
  const reportId = randomUUID()
  await db.insertReport({ id: reportId, filename: 'scan.json', contentType: 'application/json', byteSize: 5, sha256: 'x', uploadedBy: admin.id, repoId: 7, bundleId: null, bundleIntegrity: null, visible: true }, now)
  const content = JSON.stringify({ source: 'native', repo: { github: 'wrong/embedded', directory: 'wrong-dir' }, findings: [
    { id: 'own', file: 'src/a.js' },
    { id: 'dep', file: 'node_modules/x/y.js' },
    { id: 'sec', file: 'src/b.js', security: true },
  ] })
  const reportStore = fakeBlobStore()
  await reportStore.put(reportId, Buffer.from(content))

  assert.deepEqual(await db.reportPermissionsFor(viewer.id, reportId), { dependencies: false, security: true })

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(), reportStore, bundleStore: createBundleStore(fakeBlobStore(), fakeBlobStore()),
    originGate: { trustProxy: false, isOriginAllowed: () => true },
    isShuttingDown: () => false, track: (p) => { pending = p },
  })
  function mockRes() {
    return {
      statusCode: 0, headers: {}, body: '', ended: false,
      writeHead(c, h) { this.statusCode = c; if (h) this.headers = h; return this },
      end(b) { if (b != null) this.body += b; this.ended = true; return this },
      get headersSent() { return this.ended },
    }
  }
  async function view(sess, id, accept) {
    const res = mockRes()
    handler({ method: 'GET', url: `/api/reports/${id}`, headers: { cookie: cookiePair(sess.setCookie), ...(accept ? { accept } : {}) } }, res)
    await pending
    return res
  }
  // admin is exempt → sees the whole report; viewer (deps off) → 'dep' stripped, 'sec' kept.
  const adminBody = (await view(adminSess, reportId)).body
  assert.deepEqual(JSON.parse(adminBody).findings.map((f) => f.id), ['own', 'dep', 'sec'])
  const viewerRes = await view(viewerSess, reportId)
  assert.equal(viewerRes.statusCode, 200)
  assert.deepEqual(JSON.parse(viewerRes.body).findings.map((f) => f.id), ['own', 'sec'])
  // content-length must match the FILTERED body, not the original.
  assert.equal(Number(viewerRes.headers['content-length']), Buffer.byteLength(viewerRes.body))
  const metadata = await view(viewerSess, reportId, 'application/json')
  assert.equal(metadata.statusCode, 200)
  assert.equal(metadata.headers['cache-control'], 'no-store')
  assert.equal(metadata.headers.vary, 'Accept')
  assert.deepEqual(JSON.parse(metadata.body), { content: viewerRes.body, repo: { github: 'o/r', directory: '' } })
  for (const accept of ['application/json, */*', 'application/json; q=1', 'text/plain, APPLICATION/JSON; q=0.5']) {
    assert.deepEqual(JSON.parse((await view(viewerSess, reportId, accept)).body), JSON.parse(metadata.body), accept)
  }
  for (const accept of ['*/*', 'text/plain', 'application/json; q=0, */*']) {
    assert.equal((await view(viewerSess, reportId, accept)).body, viewerRes.body, accept)
  }
  assert.equal(JSON.parse(JSON.parse(metadata.body).content).repo.github, 'wrong/embedded', 'metadata does not rewrite the report or triage identity')
  await db.setReportRepo(reportId, 7, 'packages/updated')
  assert.deepEqual(JSON.parse((await view(adminSess, reportId, 'application/json')).body), {
    content, repo: { github: 'o/r', directory: 'packages/updated' },
  }, 'each load includes the current assignment, without a separate catalogue refresh')
  await db.setReportRepo(reportId, null, '')
  assert.deepEqual(JSON.parse((await view(adminSess, reportId, 'application/json')).body).repo, { github: null, directory: '' }, 'unassigned is explicit, never inferred from embedded data')
  await db.close()
})

test('managers cannot bypass admin-only repository and team routes with direct requests', async (t) => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(config, db, { githubUserId: 1, login: 'manager', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, 'manage')
  const { upload, send } = bundleHarness(db)
  const cookie = cookiePair(session.setCookie)
  for (const path of ['/api/admin/repositories', '/api/admin/repositories?scope=installed', '/api/admin/repositories?scope=public', '/api/admin/repositories/impact?repoId=7', '/api/admin/teams']) {
    assert.equal((await send('GET', path, cookie)).statusCode, 403, path)
  }
  const mutations = [
    ['/api/admin/repositories/select', { repoId: 7, selected: true }],
    ['/api/admin/repositories/select', { repoId: 7, selected: false }],
    ['/api/admin/repositories/remove', { repoId: 7, fullName: 'o/r', acknowledge: true, deleteTriage: true }],
    ['/api/admin/teams', { name: 'Unauthorized' }],
    ['/api/admin/teams/rename', { teamId: 'team', name: 'Unauthorized' }],
    ['/api/admin/teams/delete', { teamId: 'team' }],
    ['/api/admin/teams/set-repo', { teamId: 'team', repoId: 7 }],
    ['/api/admin/teams/remove-repo', { teamId: 'team', repoId: 7 }],
    ['/api/admin/teams/set-member', { teamId: 'team', userId: session.userId, dependencies: true, security: true }],
    ['/api/admin/teams/remove-member', { teamId: 'team', userId: session.userId }],
  ]
  for (const [path, body] of mutations) {
    assert.equal((await upload(path, cookie, session.csrfToken, JSON.stringify(body))).statusCode, 403, path)
  }
  for (const path of ['/api/admin/reports', '/api/admin/bundles', '/api/admin/models', '/api/teams']) {
    assert.equal((await send('GET', path, cookie)).statusCode, 200, `content management remains available: ${path}`)
  }
})

test('repository removal skips report parsing when keeping triage and preserves shared annotations', async (t) => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const now = Date.now()
  const session = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, now)
  for (const repoId of [7, 8]) await db.selectRepo({ repoId, fullName: `o/r${repoId}`, private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: session.userId }, now)
  const store = fakeBlobStore()
  const reads = []
  const get = store.get
  store.get = (id) => { reads.push(id); return get(id) }
  const { upload, send } = bundleHarness(db, config, store)
  const cookie = cookiePair(session.setCookie)
  const exclusive = randomUUID(), shared = randomUUID()
  const finding = (id) => ({ id, severity: 'high', file: 'index.js', description: 'Test finding' })
  const reports = []
  for (const [repoId, ids] of [[7, [shared, exclusive]], [8, [shared]]]) {
    const response = await upload('/api/admin/reports', cookie, session.csrfToken,
      JSON.stringify({ findings: ids.map(finding) }), { 'x-repo-id': String(repoId) })
    assert.equal(response.statusCode, 201)
    reports.push(JSON.parse(response.body).id)
  }
  reads.length = 0
  const empty = await send('GET', '/api/admin/repositories/impact?repoId=7', cookie)
  assert.equal(JSON.parse(empty.body).triageCount, 0)
  assert.deepEqual(reads, [reports[0]], 'unannotated findings need no other-report overlap scan')
  for (const id of [shared, exclusive]) await db.setTriage(id, { color: 'red' }, session.userId, 'admin', now)
  const impact = await send('GET', '/api/admin/repositories/impact?repoId=7', cookie)
  assert.equal(JSON.parse(impact.body).triageCount, 1, 'a shared annotation is not exclusive')
  reads.length = 0
  const remove = (repoId, deleteTriage) => upload('/api/admin/repositories/remove', cookie, session.csrfToken,
    JSON.stringify({ repoId, fullName: `o/r${repoId}`, acknowledge: true, deleteTriage }))
  for (const id of reports) {
    const bytes = await get(id)
    for (const unavailable of [null, Buffer.from('not a report')]) {
      store.map.set(id, unavailable)
      assert.equal((await send('GET', '/api/admin/repositories/impact?repoId=7', cookie)).statusCode, 500)
      assert.equal((await remove(7, true)).statusCode, 500)
      assert.equal((await db.listReports()).length, 2, 'failed overlap checks preserve report rows')
      assert.equal((await db.listAllRepos()).length, 2, 'failed overlap checks preserve repositories')
      assert.equal((await db.listTriage([shared, exclusive])).length, 2, 'failed overlap checks preserve all annotations')
      assert.equal(store.map.size, 2, 'no blobs are deleted before overlap is established')
    }
    store.map.set(id, bytes)
  }
  assert.equal(JSON.parse((await send('GET', '/api/admin/repositories/impact?repoId=7', cookie)).body).triageCount, 1, 'repairing the blobs allows retry')
  reads.length = 0
  const kept = await remove(7, false)
  assert.equal(kept.statusCode, 200)
  assert.equal(JSON.parse(kept.body).deletedTriage, 0)
  assert.deepEqual(reads, [], 'keeping triage never reads report blobs')
  assert.equal((await db.listTriage([shared, exclusive])).length, 2)
  assert.equal((await db.listTriageHistory(shared, 10)).length, 1, 'keeping triage also keeps history')
  assert.equal((await db.listTriageHistory(exclusive, 10)).length, 1)
  const deleted = await remove(8, true)
  assert.equal(deleted.statusCode, 200)
  assert.equal(JSON.parse(deleted.body).deletedTriage, 1)
  assert.deepEqual((await db.listTriage([shared, exclusive])).map((entry) => entry.findingId), [exclusive])
  assert.deepEqual(await db.listTriageHistory(shared, 10), [], 'permanent deletion removes the trail')
  assert.equal((await db.listTriageHistory(exclusive, 10)).length, 1, 'unrelated history remains')
})

test('repository paths: invalid team scopes, embedded headers, upload headers, and location edits are rejected', async (t) => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const now = Date.now()
  const session = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, now)
  await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: session.userId }, now)
  const teamId = randomUUID()
  await db.createTeam(teamId, 'Scoped', now)
  const { upload } = bundleHarness(db)
  const cookie = cookiePair(session.setCookie)
  const post = (path, body, headers) => upload(path, cookie, session.csrfToken, JSON.stringify(body), headers)
  const boundary = 'a/'.repeat(249) + 'aa'
  assert.equal((await post('/api/admin/teams/set-repo', { teamId, repoId: 7, path: boundary })).statusCode, 200)
  const created = await post('/api/admin/reports', { findings: [] }, { 'x-repo-id': '7', 'x-repo-directory': boundary })
  assert.equal(created.statusCode, 201)
  const reportId = JSON.parse(created.body).id
  for (const directory of [
    boundary + 'x', boundary + 'y', 'packages/au\tth', '\tpackages/auth', 'packages/auth\n', 'packages/au\u0000th', 'packages/auth\u007F', '\u0085packages/auth',
    ' packages/auth', 'packages/auth ', '\u00A0packages/auth', 'packages/auth\uFEFF', './ packages/auth/', 'packages/auth /sub', 'packages\\auth',
  ]) {
    assert.equal((await post('/api/admin/teams/set-repo', { teamId, repoId: 7, path: directory })).statusCode, 400)
    assert.equal((await post('/api/admin/reports', { repo: { github: 'o/r', directory }, findings: [] })).statusCode, 400)
    assert.equal((await post('/api/admin/reports', { findings: [] }, { 'x-repo-id': '7', 'x-repo-directory': encodeURIComponent(directory) })).statusCode, 400)
    assert.equal((await post('/api/admin/reports/set-repo', { reportId, repoId: 7, directory })).statusCode, 400)
  }
  assert.equal((await db.listReports()).length, 1, 'invalid uploads create no report rows')
  assert.equal((await db.getReport(reportId)).repoDirectory, boundary, 'invalid edits preserve the original location')
  assert.equal((await db.listTeams())[0].repos[0].path, boundary, 'invalid scope edits preserve the original team scope')
})

test('repository removal deletes exclusive triage history and keeps shared history across rescans', async (t) => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const now = Date.now()
  const session = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, now)
  const repo = (repoId) => ({ repoId, fullName: `o/r${repoId}`, private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: session.userId })
  for (const repoId of [7, 8]) await db.selectRepo(repo(repoId), now)
  const { send, upload } = bundleHarness(db)
  const cookie = cookiePair(session.setCookie)
  const exclusive = randomUUID(), shared = randomUUID()
  const uploadReport = (repoId, ids) => upload('/api/admin/reports', cookie, session.csrfToken,
    JSON.stringify({ findings: ids.map((id) => ({ id, file: 'a.js', description: 'Finding' })) }), { 'x-repo-id': String(repoId) })
  await uploadReport(7, [exclusive, shared])
  const retained = JSON.parse((await uploadReport(8, [shared])).body).id
  for (const id of [exclusive, shared]) {
    await db.setTriage(id, { comment: 'Private discussion', fix: 'PR-1' }, session.userId, 'admin', now)
    await db.setTriage(id, null, session.userId, 'admin', now + 1)
  }
  const response = await upload('/api/admin/repositories/remove', cookie, session.csrfToken,
    JSON.stringify({ repoId: 7, fullName: 'o/r7', acknowledge: true, deleteTriage: true }))
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).deletedTriage, 1)
  assert.deepEqual(await db.listTriageHistory(exclusive, 10), [], 'history is deleted even if the latest annotation was cleared')
  const history = async (reportId, finding) => {
    const result = await send('GET', `/api/reports/${reportId}/triage/history?finding=${finding}`, cookie)
    assert.equal(result.statusCode, 200)
    return JSON.parse(result.body).events
  }
  const sharedHistory = await history(retained, shared)
  assert.equal(sharedHistory.length, 2, 'retained reports keep their shared history')
  await db.selectRepo(repo(7), now + 2)
  const rescan = JSON.parse((await uploadReport(7, [exclusive, shared])).body).id
  assert.deepEqual(await history(rescan, exclusive), [], 'a future report cannot expose deleted comments or actors')
  assert.deepEqual(await history(rescan, shared), sharedHistory)
})

test('teams API: admin gating, create (409 dup), repo/member links + perms, CSRF', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const noneSess = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)
  const admin = (await readSession(config, db, cookiePair(adminSess.setCookie), now)).user
  const bob = (await readSession(config, db, cookiePair(noneSess.setCookie), now)).user
  await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: admin.id }, now)
  const { upload, send } = bundleHarness(db)
  const aCk = cookiePair(adminSess.setCookie)
  const csrf = adminSess.csrfToken
  const T = '/api/admin/teams'

  // list gating + payload (pickers + permission keys)
  assert.equal((await send('GET', T, null)).statusCode, 401)
  assert.equal((await send('GET', T, cookiePair(noneSess.setCookie))).statusCode, 403) // 'none'
  const payload = JSON.parse((await send('GET', T, aCk)).body)
  assert.deepEqual(payload.permissions, ['dependencies', 'security'])
  assert.ok(payload.users.some((u) => u.login === 'alice'))
  assert.ok(payload.repos.some((r) => r.repoId === 7))

  // create: role + CSRF + duplicate-name
  assert.equal((await upload(T, cookiePair(noneSess.setCookie), noneSess.csrfToken, JSON.stringify({ name: 'Blue' }))).statusCode, 403)
  assert.equal((await upload(T, aCk, null, JSON.stringify({ name: 'Blue' }))).statusCode, 403) // CSRF missing
  const created = await upload(T, aCk, csrf, JSON.stringify({ name: 'Blue' }))
  assert.equal(created.statusCode, 201)
  const teamId = JSON.parse(created.body).id
  assert.equal((await upload(T, aCk, csrf, JSON.stringify({ name: 'Blue' }))).statusCode, 409) // dup

  // rename: CSRF + validation, 409 onto another team's name, 404 unknown, 200 ok
  assert.equal((await upload(T, aCk, csrf, JSON.stringify({ name: 'Crimson' }))).statusCode, 201) // a second team to clash with
  assert.equal((await upload('/api/admin/teams/rename', aCk, null, JSON.stringify({ teamId, name: 'Z' }))).statusCode, 403) // CSRF missing
  assert.equal((await upload('/api/admin/teams/rename', aCk, csrf, JSON.stringify({ teamId, name: '   ' }))).statusCode, 400) // blank
  assert.equal((await upload('/api/admin/teams/rename', aCk, csrf, JSON.stringify({ teamId: 'nope', name: 'Z' }))).statusCode, 404) // no such team
  assert.equal((await upload('/api/admin/teams/rename', aCk, csrf, JSON.stringify({ teamId, name: 'Crimson' }))).statusCode, 409) // taken
  assert.equal((await upload('/api/admin/teams/rename', aCk, csrf, JSON.stringify({ teamId, name: 'Indigo' }))).statusCode, 200) // ok

  // set-repo validates the selected set; set-member validates team + user
  assert.equal((await upload('/api/admin/teams/set-repo', aCk, csrf, JSON.stringify({ teamId, repoId: 999 }))).statusCode, 400) // not selected
  // A messy-but-valid subpath normalises (leading + duplicate separators dropped → 'pkg/a', asserted below).
  assert.equal((await upload('/api/admin/teams/set-repo', aCk, csrf, JSON.stringify({ teamId, repoId: 7, path: '/pkg//a/' }))).statusCode, 200)
  // A '..' subpath is refused — it can't escape the repo subtree.
  assert.equal((await upload('/api/admin/teams/set-repo', aCk, csrf, JSON.stringify({ teamId, repoId: 7, path: 'pkg/../../etc' }))).statusCode, 400)
  assert.equal((await upload('/api/admin/teams/set-member', aCk, csrf, JSON.stringify({ teamId, userId: bob.id, dependencies: true }))).statusCode, 200)
  assert.equal((await upload('/api/admin/teams/set-member', aCk, csrf, JSON.stringify({ teamId: 'nope', userId: bob.id }))).statusCode, 404)
  assert.equal((await upload('/api/admin/teams/set-member', aCk, csrf, JSON.stringify({ teamId, userId: 'nope' }))).statusCode, 404)

  // the list reflects the links, the path, and the per-member perms
  const team = JSON.parse((await send('GET', T, aCk)).body).teams.find((t) => t.id === teamId)
  assert.equal(team.name, 'Indigo') // the rename above stuck
  assert.deepEqual(team.repos, [{ repoId: 7, fullName: 'o/r', path: 'pkg/a' }])
  assert.deepEqual(team.members, [{ userId: bob.id, login: 'bob', dependencies: true, security: false }])

  // Multiple paths coexist; re-adding the same normalized path is idempotent.
  const links = async () => JSON.parse((await send('GET', T, aCk)).body).teams.find((t) => t.id === teamId).repos
  const setPath = path => upload('/api/admin/teams/set-repo', aCk, csrf, JSON.stringify({ teamId, repoId: 7, path }))
  const removePath = path => upload('/api/admin/teams/remove-repo', aCk, csrf, JSON.stringify({ teamId, repoId: 7, path }))
  assert.equal((await setPath('pkg/b')).statusCode, 200)
  assert.equal((await setPath('/pkg//a/')).statusCode, 200)
  assert.deepEqual((await links()).map(link => link.path), ['pkg/a', 'pkg/b'])
  assert.equal((await removePath('/pkg//a/')).statusCode, 200)
  assert.deepEqual((await links()).map(link => link.path), ['pkg/b'])
  assert.equal((await removePath('missing')).statusCode, 404)
  assert.equal((await removePath('..')).statusCode, 400)
  assert.equal((await removePath({})).statusCode, 400)
  assert.deepEqual((await links()).map(link => link.path), ['pkg/b'])
  assert.equal((await setPath('')).statusCode, 200)
  assert.deepEqual((await links()).map(link => link.path), [null])
  assert.equal((await setPath('pkg/c')).statusCode, 200)
  assert.deepEqual((await links()).map(link => link.path), [null], 'whole-repository access already covers this path')
  assert.equal((await removePath(null)).statusCode, 200)
  assert.deepEqual(await links(), [])
  await setPath('pkg/a')
  await setPath('pkg/b')

  // unlink + delete
  assert.equal((await upload('/api/admin/teams/remove-member', aCk, csrf, JSON.stringify({ teamId, userId: bob.id }))).statusCode, 200)
  assert.equal((await upload('/api/admin/teams/remove-repo', aCk, csrf, JSON.stringify({ teamId, repoId: 7 }))).statusCode, 200)
  assert.equal((await upload('/api/admin/teams/delete', aCk, csrf, JSON.stringify({ teamId }))).statusCode, 200)
  assert.equal((await upload('/api/admin/teams/delete', aCk, csrf, JSON.stringify({ teamId }))).statusCode, 404) // gone
  await db.close()
})

test('db: finding triage — set/list by id, whole-entry upsert, null/empty tombstones, batch atomicity, login snapshot', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const uid = await db.upsertUser({ githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)

  // Two entries: flagged false (the explicit un-flag tombstone) must round-trip
  // as false, not collapse to null; a writer already gone (updated_by NULL)
  // keeps the durable login snapshot, like uploaded_by_login on reports. Rows
  // are keyed by finding id alone — listTriage reads the ids it is asked for.
  await db.setTriage('f1', { color: 'red', comment: 'look', flagged: false }, uid, 'alice', now)
  await db.setTriage('f2', { triage: 'fixed', fix: 'PR-9', flagged: true }, null, 'ghost', now + 1)
  assert.deepEqual(await db.listTriage(['f1', 'f2', 'never']), [
    { findingId: 'f1', color: 'red', triage: null, comment: 'look', fix: null, flagged: false, updatedByLogin: 'alice', updatedAt: now },
    { findingId: 'f2', color: null, triage: 'fixed', comment: null, fix: 'PR-9', flagged: true, updatedByLogin: 'ghost', updatedAt: now + 1 },
  ])
  assert.deepEqual(await db.listTriage(['f2']), [
    { findingId: 'f2', color: null, triage: 'fixed', comment: null, fix: 'PR-9', flagged: true, updatedByLogin: 'ghost', updatedAt: now + 1 },
  ])
  assert.deepEqual(await db.listTriage([]), [])

  // Upsert replaces the WHOLE entry (no field merge — absent fields null out),
  // and the live login wins over a stale write-time snapshot while the user exists.
  await db.setTriage('f1', { triage: 'invalid' }, uid, 'old-alice', now + 2)
  assert.deepEqual(await db.listTriage(['f1']), [
    { findingId: 'f1', color: null, triage: 'invalid', comment: null, fix: null, flagged: null, updatedByLogin: 'alice', updatedAt: now + 2 },
  ])

  // null (and an all-absent entry) writes the tombstone: the row stays, every
  // field null, the writer and time stamped — "cleared", not "never set".
  await db.setTriage('f1', null, uid, 'alice', now + 3)
  await db.setTriage('f2', {}, uid, 'alice', now + 3)
  assert.deepEqual(await db.listTriage(['f1', 'f2']), [
    { findingId: 'f1', color: null, triage: null, comment: null, fix: null, flagged: null, updatedByLogin: 'alice', updatedAt: now + 3 },
    { findingId: 'f2', color: null, triage: null, comment: null, fix: null, flagged: null, updatedByLogin: 'alice', updatedAt: now + 3 },
  ])

  // A batch lands whole or not at all: the second entry has no finding id
  // (NOT NULL) — and the first must not be left behind when it fails.
  await db.setTriageEntries([['f4', { color: 'red' }], ['f5', null]], uid, 'alice', now + 4)
  assert.deepEqual((await db.listTriage(['f4', 'f5', 'f6'])).map((r) => [r.findingId, r.color]), [['f4', 'red'], ['f5', null]])
  await assert.rejects(async () => { await db.setTriageEntries([['f6', { comment: 'c' }], [null, { comment: 'd' }]], uid, 'alice', now + 5) }, /NOT NULL/u)
  assert.deepEqual((await db.listTriage(['f6'])), [])
  await db.close()
})

test('db: finding triage trail — one event per change, none for a no-op write, batches grouped, newest first', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const alice = await db.upsertUser({ githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const bob = await db.upsertUser({ githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now)

  await db.setTriage('f1', { color: 'red' }, alice, 'alice', now)
  // The same entry again is a no-op: no event, and the row keeps its writer + time.
  await db.setTriage('f1', { color: 'red' }, bob, 'bob', now + 1)
  assert.deepEqual((await db.listTriage(['f1'])).map((r) => [r.updatedByLogin, r.updatedAt]), [['alice', now]])
  await db.setTriage('f1', { color: 'red', triage: 'fixed', flagged: false }, bob, 'bob', now + 2)
  await db.setTriage('f1', null, alice, 'alice', now + 3)
  const trail = await db.listTriageHistory('f1', 10)
  assert.deepEqual(trail.map((e) => [e.actorLogin, e.at, e.color, e.triage, e.flagged]), [
    ['alice', now + 3, null, null, null],
    ['bob', now + 2, 'red', 'fixed', false],
    ['alice', now, 'red', null, null],
  ])
  assert.ok(trail[0].seq > trail[1].seq && trail[1].seq > trail[2].seq, 'seq orders the trail')
  assert.equal(new Set(trail.map((e) => e.batchId)).size, 3, 'single writes are their own batches')
  // A batch shares one batch id across its changed entries; an unchanged one
  // (f1 is already cleared) adds nothing.
  await db.setTriageEntries([['f2', { fix: 'PR-1' }], ['f3', { comment: 'c' }], ['f1', null]], bob, 'bob', now + 4)
  const [e2] = await db.listTriageHistory('f2', 10)
  const [e3] = await db.listTriageHistory('f3', 10)
  assert.equal(e2.batchId, e3.batchId)
  assert.equal((await db.listTriageHistory('f1', 10)).length, 3)
  assert.equal((await db.listTriageHistory('f1', 2)).length, 2, 'limit applies')
  assert.deepEqual(await db.listTriageHistory('never', 10), [])
  // Everything is kept by default: a writer changing a value past the read cap
  // loses nothing — the read cap only pages what one call returns.
  for (let i = 0; i < MAX_TRIAGE_HISTORY + 5; i++) await db.setTriage('f9', { comment: `v${i}` }, bob, 'bob', now + 10 + i)
  const all = await db.listTriageHistory('f9', MAX_TRIAGE_HISTORY + 50)
  assert.equal(all.length, MAX_TRIAGE_HISTORY + 5)
  assert.equal(all.at(-1).comment, 'v0')
  assert.equal((await db.listTriageHistory('f9', MAX_TRIAGE_HISTORY)).length, MAX_TRIAGE_HISTORY, 'the read cap pages')
  await db.close()

  // An operator-set retention limit keeps only the newest that many per
  // finding, oldest trimmed first, other findings untouched.
  const capped = openSqliteManagedDb(':memory:', { triageHistoryLimit: 3 })
  const cid = await capped.upsertUser({ githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  for (let i = 0; i < 5; i++) await capped.setTriage('g', { comment: `v${i}` }, cid, 'alice', now + i)
  await capped.setTriage('h', { comment: 'once' }, cid, 'alice', now)
  assert.deepEqual((await capped.listTriageHistory('g', 10)).map((e) => e.comment), ['v4', 'v3', 'v2'])
  assert.equal((await capped.listTriageHistory('h', 10)).length, 1)
  await capped.close()
})

test('db: permanent triage deletion rolls back current rows if history deletion fails', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-triage-delete-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.sqlite')
  const db = openSqliteManagedDb(path)
  t.after(() => db.close())
  await db.setTriage('deleted', { comment: 'Must be atomic' }, null, 'writer', 100)
  await db.setTriage('retained', { fix: 'Keep this' }, null, 'writer', 101)
  await db.setTriage('history-only', { comment: 'Legacy history' }, null, 'writer', 102)
  const raw = new DatabaseSync(path)
  t.after(() => raw.close())
  // Reproduce a legacy orphan and inject a failure in the second DELETE.
  raw.exec("DELETE FROM finding_triage WHERE finding_id = 'history-only'")
  raw.exec(`CREATE TRIGGER fail_history_delete BEFORE DELETE ON finding_triage_event
    BEGIN SELECT RAISE(ABORT, 'test history deletion failure'); END`)
  assert.throws(() => db.deleteTriage(['deleted']), /test history deletion failure/u)
  assert.equal((await db.listTriage(['deleted'])).length, 1, 'the first DELETE is rolled back')
  assert.equal((await db.listTriageHistory('deleted', 10)).length, 1)
  raw.exec('DROP TRIGGER fail_history_delete')
  assert.equal(await db.deleteTriage(['deleted', 'deleted', 'history-only']), 1, 'the count describes current annotations, not event rows')
  assert.deepEqual(await db.listTriageHistory('deleted', 10), [])
  assert.deepEqual(await db.listTriageHistory('history-only', 10), [])
  assert.equal((await db.listTriage(['retained'])).length, 1)
  assert.equal((await db.listTriageHistory('retained', 10)).length, 1)
  assert.equal(await db.deleteTriage([]), 0)
})

test('parseTriageEntryPatch: full/partial/null round-trip; malformed values are invalid', () => {
  // Full + partial patches pass through; empty strings count as absent.
  assert.deepEqual(parseTriageEntryPatch({ color: 'red', triage: 'fixed', comment: 'c', fix: 'PR-1', flagged: true }),
    { color: 'red', triage: 'fixed', comment: 'c', fix: 'PR-1', flagged: true })
  assert.deepEqual(parseTriageEntryPatch({ comment: 'only' }), { comment: 'only' })
  assert.deepEqual(parseTriageEntryPatch({ color: '', comment: '' }), {})
  // flagged:false is a real value (the explicit un-flag tombstone), not empty.
  assert.deepEqual(parseTriageEntryPatch({ flagged: false }), { flagged: false })
  // null = clear; unknown keys (e.g. the client-local ignoredReports) are ignored.
  assert.equal(parseTriageEntryPatch(null), null)
  assert.deepEqual(parseTriageEntryPatch({ fix: 'x', ignoredReports: ['r.json'] }), { fix: 'x' })
  // Malformed: unknown bucket, over-cap strings, non-boolean flag, non-objects.
  assert.equal(parseTriageEntryPatch({ triage: 'wizard' }), 'invalid')
  assert.equal(parseTriageEntryPatch({ comment: 'x'.repeat(10_001) }), 'invalid')
  assert.equal(parseTriageEntryPatch({ color: 'x'.repeat(51) }), 'invalid')
  assert.equal(parseTriageEntryPatch({ flagged: 'yes' }), 'invalid')
  assert.equal(parseTriageEntryPatch({ color: 42 }), 'invalid')
  assert.equal(parseTriageEntryPatch('red'), 'invalid')
  assert.equal(parseTriageEntryPatch([]), 'invalid')
})

// Shared fixture for the report-triage endpoint tests: admin alice (in no
// team); three Blue members on repo 7 — bob (role triage, sees security but
// not dependencies), carol (role view, sees dependencies but not security),
// dave (role none) — plus erin (role triage) in Green, whose repo 8 has no
// report. One stored report on repo 7 with an own / dependency / security
// finding, ids explicit so the triage keys are stable.
async function reportTriageFixture(db, reportStore) {
  const now = Date.now()
  const mk = (githubUserId, login, offset) => createSession(config, db, { githubUserId, login, name: null, avatarUrl: null }, now + offset)
  const adminSess = await mk(1, 'alice', 0)
  const bobSess = await mk(2, 'bob', 1000)
  const carolSess = await mk(3, 'carol', 2000)
  const daveSess = await mk(4, 'dave', 3000)
  const erinSess = await mk(5, 'erin', 4000)
  const frankSess = await mk(6, 'frank', 5000)
  const userOf = async (sess) => (await readSession(config, db, cookiePair(sess.setCookie), now)).user
  const admin = await userOf(adminSess)
  const bob = await userOf(bobSess)
  const carol = await userOf(carolSess)
  const dave = await userOf(daveSess)
  const erin = await userOf(erinSess)
  const frank = await userOf(frankSess)
  await db.setUserRole(bob.id, 'triage')
  await db.setUserRole(carol.id, 'view')
  await db.setUserRole(erin.id, 'triage') // dave stays 'none'
  await db.setUserRole(frank.id, 'manage') // frank is in no team
  await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: admin.id }, now)
  await db.selectRepo({ repoId: 8, fullName: 'o/other', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: admin.id }, now)
  const blue = randomUUID()
  await db.createTeam(blue, 'Blue', now)
  await db.setTeamRepo(blue, 7, null)
  await db.setTeamMember(blue, bob.id, { dependencies: false, security: true })
  await db.setTeamMember(blue, carol.id, { dependencies: true, security: false })
  await db.setTeamMember(blue, dave.id, { dependencies: true, security: true })
  const green = randomUUID()
  await db.createTeam(green, 'Green', now)
  await db.setTeamRepo(green, 8, null)
  await db.setTeamMember(green, erin.id, { dependencies: true, security: true })
  const reportId = randomUUID()
  await db.insertReport({ id: reportId, filename: 'scan.json', contentType: 'application/json', byteSize: 5, sha256: 'x', uploadedBy: admin.id, uploadedByLogin: 'alice', repoId: 7, bundleId: null, bundleIntegrity: null, visible: true }, now)
  await reportStore.put(reportId, Buffer.from(JSON.stringify({ source: 'native', findings: [
    { id: 'own', file: 'src/a.js' },
    { id: 'dep', file: 'node_modules/x/y.js' },
    { id: 'sec', file: 'src/b.js', security: true },
  ] })))
  return { now, reportId, admin, adminSess, bobSess, carolSess, daveSess, erinSess, frankSess }
}

for (const permission of ['dependencies', 'security']) {
  for (const operation of ['entries', 'history', 'write']) {
    test(`triage ${operation} rechecks ${permission} visibility after a cold report read`, async t => {
      const db = openSqliteManagedDb(':memory:')
      t.after(() => db.close())
      const store = fakeBlobStore()
      const fx = await reportTriageFixture(db, store)
      const userId = fx.bobSess.userId
      const team = (await db.listTeams()).find(item => item.name === 'Blue')
      await db.setTeamMember(team.id, userId, { dependencies: true, security: true })
      const hidden = permission === 'dependencies' ? 'dep' : 'sec'
      for (const id of ['own', hidden]) await db.setTriage(id, { fix: `before ${id}` }, fx.admin.id, 'alice', fx.now)
      const before = await db.listTriage(['own', hidden])
      const beforeHistory = await db.listTriageHistory(hidden, 20)
      const gate = Promise.withResolvers(), started = Promise.withResolvers()
      const get = store.get
      let reads = 0
      store.get = async id => {
        if (reads++ === 0) { started.resolve(); await gate.promise }
        return get(id)
      }
      const { send, upload } = bundleHarness(db, config, store)
      const cookie = cookiePair(fx.bobSess.setCookie), path = `/api/reports/${fx.reportId}/triage`
      const response = operation === 'write'
        ? upload(path, cookie, fx.bobSess.csrfToken, JSON.stringify({ entries: { own: { fix: 'must not partially write' }, [hidden]: { fix: 'revoked' } } }))
        : send('GET', operation === 'history' ? `${path}/history?finding=${hidden}` : path, cookie)
      await started.promise
      await db.setTeamMember(team.id, userId, { dependencies: true, security: true, [permission]: false })
      gate.resolve()
      const res = await response
      if (operation === 'entries') {
        assert.equal(res.statusCode, 200)
        assert.deepEqual(JSON.parse(res.body), { entries: { own: { fix: 'before own' } } })
      } else {
        assert.equal(res.statusCode, 404)
        assert.deepEqual(JSON.parse(res.body), { error: 'no-finding' })
      }
      assert.deepEqual(await db.listTriage(['own', hidden]), before)
      assert.deepEqual(await db.listTriageHistory(hidden, 20), beforeHistory)
      // The still-visible finding remains usable, including through the cache.
      assert.equal((await upload(path, cookie, fx.bobSess.csrfToken, JSON.stringify({ entries: { own: { fix: 'allowed' } } }))).statusCode, 200)
    })
  }
}

test('workspace history enforces roles and current report access before search, totals, and pagination', async (t) => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const reportStore = fakeBlobStore()
  const fx = await reportTriageFixture(db, reportStore)
  const { send, upload } = bundleHarness(db, config, reportStore)
  const path = '/api/admin/history'
  const adminCookie = cookiePair(fx.adminSess.setCookie)
  const managerCookie = cookiePair(fx.frankSess.setCookie)
  assert.equal((await send('GET', path)).statusCode, 401)
  for (const session of [fx.bobSess, fx.carolSess, fx.daveSess]) {
    assert.equal((await send('GET', path, cookiePair(session.setCookie))).statusCode, 403)
  }
  assert.equal((await send('POST', path, adminCookie)).statusCode, 405)
  for (const query of ['page=0', 'page=Infinity', 'limit=0', 'limit=101', 'limit=1.5', 'kind=unknown', `q=${'a'.repeat(501)}`, `repo=${'r'.repeat(501)}`, `actor=${'a'.repeat(501)}`]) {
    assert.equal((await send('GET', `${path}?${query}`, adminCookie)).statusCode, 400)
  }
  await db.setTriage('own', { color: 'red' }, fx.admin.id, 'alice', fx.now)
  await db.setTriage('foreign', { color: 'blue' }, fx.daveSess.userId, 'private-user', fx.now + 1)
  const read = async (cookie, query = '') => {
    const res = await send('GET', path + query, cookie)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    return JSON.parse(res.body)
  }
  assert.equal((await read(managerCookie)).total, 0, 'a manager outside any team sees no activity')
  assert.deepEqual((await read(managerCookie)).filters, { repos: [], users: [] })
  const team = (await db.listTeams()).find(row => row.name === 'Blue')
  await db.setTeamMember(team.id, fx.frankSess.userId, { dependencies: false, security: false })

  // A private report carries the same globally shared finding. Its name and
  // repository must not leak through the event, its search fields, or totals.
  await db.insertReport({ id: 'private-report', filename: 'confidential.json', contentType: 'application/json', byteSize: 2, sha256: 'secret', uploadedBy: fx.admin.id, repoId: 8, visible: false, bundleId: null, bundleIntegrity: null }, fx.now)
  await db.setTriageEntries([['own', { triage: 'fixed' }]], fx.admin.id, 'alice', fx.now + 2, 'private-report')
  const manager = await read(managerCookie, '?limit=1')
  assert.equal(manager.total, 3)
  assert.equal(manager.history.length, 1)
  assert.equal(manager.history[0].reportId, fx.reportId)
  assert.equal(manager.history[0].repo, 'o/r')
  assert.doesNotMatch(JSON.stringify(manager), /confidential|private-report|o\/other/u)
  assert.equal((await read(managerCookie, '?q=confidential')).total, 0)
  assert.equal((await read(managerCookie, '?repo=o%2Fother')).total, 0)
  assert.equal((await read(managerCookie, '?actor=user:unknown')).total, 0)
  assert.equal((await read(managerCookie, `?actor=user:${fx.daveSess.userId}`)).total, 0)
  assert.equal(manager.filters.users.some(user => user.id === `user:${fx.daveSess.userId}`), false)
  assert.equal((await read(managerCookie, `?repo=o%2Fr&actor=user:${fx.admin.id}&kind=triage&limit=1&page=2`)).total, 2)
  assert.equal((await read(adminCookie, `?repo=o%2Fother&actor=user:${fx.admin.id}&kind=triage`)).total, 1)
  assert.deepEqual(manager.filters, { repos: ['o/r'], users: [{ id: `user:${fx.admin.id}`, login: 'alice', detail: null }] })
  assert.equal((await read(managerCookie, '?kind=upload')).total, 1)
  assert.equal((await read(adminCookie, '?q=confidential&kind=triage')).total, 1)

  const write = await upload(`/api/reports/${fx.reportId}/triage`, adminCookie, fx.adminSess.csrfToken, JSON.stringify({ entries: { dep: { fix: 'private annotation body' } } }))
  assert.equal(write.statusCode, 200)
  const events = await read(adminCookie, '?kind=triage&q=dep')
  assert.equal(events.history[0].reportId, fx.reportId)
  assert.equal(events.history[0].report, 'scan.json')
  assert.doesNotMatch(JSON.stringify(events), /private annotation body/u)
  await db.setReportVisible(fx.reportId, false)
  assert.equal((await read(managerCookie)).total, 4, 'managers can oversee unpublished reports within their team scopes')
  await db.setReportVisible(fx.reportId, true)
  await db.removeTeamRepo(team.id, 7)
  await db.setTeamRepo(team.id, 7, 'allowed')
  assert.equal((await read(managerCookie)).total, 0, 'team repository paths are enforced')
  await db.setReportRepo(fx.reportId, 7, 'allowed/subdir')
  assert.equal((await read(managerCookie)).total, 4)
  await db.removeTeamMember(team.id, fx.frankSess.userId)
  assert.equal((await read(managerCookie)).total, 0, 'membership revocation applies without restarting')
})

test('workspace history records successful content and access changes, but not failed or duplicate mutations', async (t) => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const reportStore = fakeBlobStore()
  const fx = await reportTriageFixture(db, reportStore)
  const { send, upload } = bundleHarness(db, config, reportStore)
  const cookie = cookiePair(fx.adminSess.setCookie)
  const csrf = fx.adminSess.csrfToken
  const post = (path, body, token = csrf) => upload(`/api/admin/${path}`, cookie, token, JSON.stringify(body))
  const history = async () => JSON.parse((await send('GET', '/api/admin/history', cookie)).body).history
  const count = async () => (await history()).length
  const baseline = await count()
  const wholeRepoTeam = (await db.listTeams()).find(team => team.name === 'Blue')
  assert.equal((await post('teams/set-repo', { teamId: wholeRepoTeam.id, repoId: 7, path: 'src' })).statusCode, 200)
  assert.equal(await count(), baseline, 'a whole-repository grant already covers every subpath')
  assert.equal((await post('reports/set-visible', { reportId: fx.reportId, visible: false }, null)).statusCode, 403)
  assert.equal((await post('reports/set-visible', { reportId: 'missing', visible: true })).statusCode, 404)
  assert.equal(await count(), baseline)
  await post('reports/set-visible', { reportId: fx.reportId, visible: false })
  await post('reports/set-visible', { reportId: fx.reportId, visible: false })
  assert.equal(await count(), baseline + 1)
  await post('reports/set-repo', { reportId: fx.reportId, repoId: 8, directory: 'src' })
  await post('set-role', { userId: fx.bobSess.userId, role: 'manage' })
  await post('set-role', { userId: fx.bobSess.userId, role: 'manage' })
  const team = JSON.parse((await post('teams', { name: 'New team' })).body)
  await post('teams', { name: 'New team' }) // conflict
  await post('teams/rename', { teamId: team.id, name: 'Renamed team' })
  await post('teams/rename', { teamId: team.id, name: 'Renamed team' })
  await post('teams/set-member', { teamId: team.id, userId: fx.bobSess.userId, security: true })
  await post('teams/set-member', { teamId: team.id, userId: fx.bobSess.userId, security: true })
  await post('teams/set-repo', { teamId: team.id, repoId: 7, path: 'src' })
  await post('teams/set-repo', { teamId: team.id, repoId: 7, path: 'src' })
  await post('teams/remove-repo', { teamId: team.id, repoId: 7, path: 'src' })
  await post('teams/remove-member', { teamId: team.id, userId: fx.bobSess.userId })
  await post('teams/delete', { teamId: team.id })
  await post('repositories/select', { repoId: 7, selected: false })
  await post('repositories/select', { repoId: 7, selected: false })
  const entries = await history()
  assert.equal(entries.length, baseline + 11, 'repeated edits and rejected changes add no entries')
  assert.ok(entries.some(entry => entry.kind === 'visibility' && entry.report === 'scan.json'))
  assert.ok(entries.some(entry => entry.action.includes("bob's role to manage")))
  assert.ok(entries.some(entry => entry.action.includes('deleted team Renamed team')))
  assert.ok(entries.every(entry => entry.actor === 'alice'))

  await post('reports/set-repo', { reportId: fx.reportId, repoId: null })
  const detachedCount = await count()
  await post('reports/set-repo', { reportId: fx.reportId, repoId: null, directory: 'ignored/when/detached' })
  assert.equal(await count(), detachedCount, 'detached reports always store an empty directory')

  const bundle = JSON.parse((await upload('/api/admin/bundles', cookie, csrf, Buffer.from('archive'), { 'x-bundle-filename': 'archive.zip' })).body)
  const afterUpload = await count()
  await upload('/api/admin/bundles', cookie, csrf, Buffer.from('archive'))
  assert.equal(await count(), afterUpload, 'deduplicated uploads produce one event')
  await post('bundles/set-repo', { bundleId: bundle.id, repoId: 8 })
  assert.equal((await send('DELETE', `/api/admin/bundles/${bundle.id}`, cookie, csrf)).statusCode, 200)
  assert.equal((await send('DELETE', `/api/admin/reports/${fx.reportId}`, cookie, csrf)).statusCode, 200)
  const deleted = await history()
  assert.ok(deleted.some(entry => entry.kind === 'delete' && entry.report === 'scan.json'))
  assert.equal(deleted.filter(entry => entry.kind === 'upload').length, 2, 'uploads survive deletion')
})

test('filterReportContent: a groups-shaped dump is filtered the same way, under its own key', () => {
  const grouped = JSON.stringify({ source: 'native', groups: [
    [{ id: 'a', file: 'src/a.js' }],
    [{ id: 'd', file: 'node_modules/x/y.js' }],
    [{ id: 's', file: 'src/s.js', security: true }, { id: 's2', file: 'src/s2.js' }],
  ] })
  const ids = (s) => JSON.parse(s).groups.map((g) => g[0].id)
  const noDeps = filterReportContent(grouped, { dependencies: false, security: true })
  assert.deepEqual(ids(noDeps), ['a', 's'])
  assert.equal(JSON.parse(noDeps).findings, undefined, 'written back as groups, no findings key invented')
  assert.deepEqual(ids(filterReportContent(grouped, { dependencies: true, security: false })), ['a', 'd'])
  assert.deepEqual(ids(filterReportContent(grouped, { dependencies: false, security: false })), ['a'])
  assert.equal(filterReportContent(grouped, { dependencies: true, security: true }), grouped)
})

test('GET /api/reports/<id>/triage: view-gated (401/404), entries filtered to the viewer visible findings', async () => {
  const db = openSqliteManagedDb(':memory:')
  const reportStore = fakeBlobStore()
  const fx = await reportTriageFixture(db, reportStore)
  const { send } = bundleHarness(db, config, reportStore)
  // Seed one entry per finding straight through the db — the endpoint's READ
  // side (gating + per-viewer filtering) is what's under test here.
  await db.setTriage('own', { color: 'red' }, fx.admin.id, 'alice', fx.now)
  await db.setTriage('dep', { triage: 'invalid' }, fx.admin.id, 'alice', fx.now)
  await db.setTriage('sec', { fix: 'urgent', flagged: false }, fx.admin.id, 'alice', fx.now)
  // An entry on a finding no report carries, and one the report carries but
  // nobody annotated: neither shows up.
  await db.setTriage('elsewhere', { color: 'blue' }, fx.admin.id, 'alice', fx.now)

  const T = (id) => `/api/reports/${id}/triage`
  assert.equal((await send('GET', T(fx.reportId), null)).statusCode, 401) // unauthenticated
  assert.equal((await send('GET', T(fx.reportId), cookiePair(fx.daveSess.setCookie))).statusCode, 403) // role 'none', even in-team
  assert.equal((await send('GET', T(fx.reportId), cookiePair(fx.erinSess.setCookie))).statusCode, 404) // wrong team (no repo 7)
  assert.equal((await send('GET', T(fx.reportId), cookiePair(fx.frankSess.setCookie))).statusCode, 404) // manage, but no membership (the admin surface is his read path)
  assert.equal((await send('GET', T(randomUUID()), cookiePair(fx.adminSess.setCookie))).statusCode, 404) // unknown report
  assert.equal((await send('PUT', T(fx.reportId), cookiePair(fx.adminSess.setCookie))).statusCode, 405) // GET/POST only

  // admin (in no team) sees every entry, unfiltered; flagged:false round-trips.
  const adminRes = await send('GET', T(fx.reportId), cookiePair(fx.adminSess.setCookie))
  assert.equal(adminRes.statusCode, 200)
  assert.deepEqual(JSON.parse(adminRes.body), { entries: {
    own: { color: 'red' },
    dep: { triage: 'invalid' },
    sec: { fix: 'urgent', flagged: false },
  } })
  // bob (security yes, dependencies no) has the 'dep' entry withheld — an
  // entry on a stripped finding would leak that the finding exists.
  const bobRes = await send('GET', T(fx.reportId), cookiePair(fx.bobSess.setCookie))
  assert.equal(bobRes.statusCode, 200)
  assert.deepEqual(Object.keys(JSON.parse(bobRes.body).entries).toSorted(), ['own', 'sec'])
  // carol (dependencies yes, security no) has 'sec' withheld instead.
  const carolRes = await send('GET', T(fx.reportId), cookiePair(fx.carolSess.setCookie))
  assert.deepEqual(Object.keys(JSON.parse(carolRes.body).entries).toSorted(), ['dep', 'own'])

  // Entries are per finding id, shared by every report carrying the finding:
  // a re-scan (same repo, 'own' again plus a new finding) reads 'own' as is,
  // and a cleared entry arrives as null — the tombstone, unlike 'new', which
  // the server has never seen.
  const rescanId = randomUUID()
  await db.insertReport({ id: rescanId, filename: 'scan2.json', contentType: 'application/json', byteSize: 5, sha256: 'y', uploadedBy: fx.admin.id, uploadedByLogin: 'alice', repoId: 7, bundleId: null, bundleIntegrity: null, visible: true }, fx.now)
  await reportStore.put(rescanId, Buffer.from(JSON.stringify({ source: 'native', findings: [{ id: 'own', file: 'src/a.js' }, { id: 'new', file: 'src/c.js' }] })))
  await db.setTriage('sec', null, fx.admin.id, 'alice', fx.now + 1)
  assert.deepEqual(JSON.parse((await send('GET', T(rescanId), cookiePair(fx.bobSess.setCookie))).body), { entries: { own: { color: 'red' } } })
  assert.deepEqual(JSON.parse((await send('GET', T(fx.reportId), cookiePair(fx.bobSess.setCookie))).body), { entries: { own: { color: 'red' }, sec: null } })

  // A pre-deduplicated (groups-shaped) dump is filtered for the viewer just the
  // same: bob (no dependencies) must not learn of 'dep' through its entry.
  const groupedId = randomUUID()
  await db.insertReport({ id: groupedId, filename: 'scan3.json', contentType: 'application/json', byteSize: 5, sha256: 'z', uploadedBy: fx.admin.id, uploadedByLogin: 'alice', repoId: 7, bundleId: null, bundleIntegrity: null, visible: true }, fx.now)
  await reportStore.put(groupedId, Buffer.from(JSON.stringify({ source: 'native', groups: [
    [{ id: 'own', file: 'src/a.js' }, { id: 'own2', file: 'src/a2.js' }],
    [{ id: 'dep', file: 'node_modules/x/y.js' }],
  ] })))
  assert.deepEqual(JSON.parse((await send('GET', T(groupedId), cookiePair(fx.bobSess.setCookie))).body), { entries: { own: { color: 'red' } } })
  assert.deepEqual(JSON.parse((await send('GET', T(groupedId), cookiePair(fx.adminSess.setCookie))).body), { entries: { own: { color: 'red' }, dep: { triage: 'invalid' } } })
  await db.close()
})

test('POST /api/reports/<id>/triage: CSRF + role/membership gating, validation, visibility, clear + overwrite', async () => {
  const db = openSqliteManagedDb(':memory:')
  const reportStore = fakeBlobStore()
  const fx = await reportTriageFixture(db, reportStore)
  const { upload, send } = bundleHarness(db, config, reportStore)
  const T = `/api/reports/${fx.reportId}/triage`
  const bCk = cookiePair(fx.bobSess.setCookie)
  const post = (cookie, csrf, payload) => upload(T, cookie, csrf, JSON.stringify(payload))

  // Gating: CSRF missing → 403; role below 'triage' (carol view / dave none)
  // and a triage-role NON-member (erin) → 404 — existence and denial both hidden.
  assert.equal((await post(bCk, null, { entries: { own: null } })).statusCode, 403)
  assert.equal((await post(cookiePair(fx.carolSess.setCookie), fx.carolSess.csrfToken, { entries: { own: null } })).statusCode, 404)
  assert.equal((await post(cookiePair(fx.daveSess.setCookie), fx.daveSess.csrfToken, { entries: { own: null } })).statusCode, 403)
  assert.equal((await post(cookiePair(fx.erinSess.setCookie), fx.erinSess.csrfToken, { entries: { own: null } })).statusCode, 404)
  // ...and so does a manage-role NON-member: nobody writes triage on a report
  // they can't read through this plane (write ⊆ read).
  assert.equal((await post(cookiePair(fx.frankSess.setCookie), fx.frankSess.csrfToken, { entries: { own: null } })).statusCode, 404)
  // Validation: bad body shape, malformed entry, over the entry-count cap.
  assert.equal((await post(bCk, fx.bobSess.csrfToken, { entries: [] })).statusCode, 400)
  assert.equal((await post(bCk, fx.bobSess.csrfToken, { entries: { own: { triage: 'wizard' } } })).statusCode, 400)
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}`, null]))
  assert.equal((await post(bCk, fx.bobSess.csrfToken, { entries: many })).statusCode, 400)
  // bob may not touch 'dep' — his permissions strip it from the report, so a
  // write to it 404s without revealing the finding exists (through a
  // groups-shaped dump of the same findings just the same)...
  assert.equal((await post(bCk, fx.bobSess.csrfToken, { entries: { dep: { color: 'red' } } })).statusCode, 404)
  const groupedId = randomUUID()
  await db.insertReport({ id: groupedId, filename: 'scan3.json', contentType: 'application/json', byteSize: 5, sha256: 'z', uploadedBy: fx.admin.id, uploadedByLogin: 'alice', repoId: 7, bundleId: null, bundleIntegrity: null, visible: true }, fx.now)
  await reportStore.put(groupedId, Buffer.from(JSON.stringify({ source: 'native', groups: [[{ id: 'own', file: 'src/a.js' }], [{ id: 'dep', file: 'node_modules/x/y.js' }]] })))
  assert.equal((await upload(`/api/reports/${groupedId}/triage`, bCk, fx.bobSess.csrfToken, JSON.stringify({ entries: { dep: { color: 'red' } } }))).statusCode, 404)
  assert.equal((await upload(`/api/reports/${groupedId}/triage`, bCk, fx.bobSess.csrfToken, JSON.stringify({ entries: { own: { color: 'red' } } }))).statusCode, 200)
  // ...while the admin (unrestricted) may annotate it — but not a finding the
  // report doesn't carry: the report is the scope, even for an admin.
  assert.equal((await post(cookiePair(fx.adminSess.setCookie), fx.adminSess.csrfToken, { entries: { dep: { color: 'gray' } } })).statusCode, 200)
  assert.equal((await post(cookiePair(fx.adminSess.setCookie), fx.adminSess.csrfToken, { entries: { elsewhere: { color: 'gray' } } })).statusCode, 404)

  // bob (triage role) writes two entries; flagged:false lands as false.
  assert.equal((await post(bCk, fx.bobSess.csrfToken, { entries: {
    own: { color: 'red', flagged: false },
    sec: { triage: 'fixed', fix: 'patched upstream' },
  } })).statusCode, 200)
  const bobView = async () => JSON.parse((await send('GET', T, bCk)).body).entries
  assert.deepEqual(await bobView(), {
    own: { color: 'red', flagged: false },
    sec: { triage: 'fixed', fix: 'patched upstream' },
  })
  // The write is attributed to bob.
  const [ownRow] = await db.listTriage(['own'])
  assert.equal(ownRow.updatedByLogin, 'bob')

  // End-to-end read plane: carol (view role, dependencies-only) sees bob's
  // 'own' entry + the admin's 'dep' one; the security entry stays withheld.
  const carolEntries = JSON.parse((await send('GET', T, cookiePair(fx.carolSess.setCookie))).body).entries
  assert.deepEqual(carolEntries, { own: { color: 'red', flagged: false }, dep: { color: 'gray' } })

  // Whole-entry overwrite drops the fields the replacement doesn't carry.
  assert.equal((await post(bCk, fx.bobSess.csrfToken, { entries: { sec: { fix: 'still open' } } })).statusCode, 200)
  assert.deepEqual((await bobView()).sec, { fix: 'still open' })
  // null clears an entry — which reads back as null (the tombstone), so a
  // reader adopts the clear rather than mistaking it for never-set.
  assert.equal((await post(bCk, fx.bobSess.csrfToken, { entries: { own: null } })).statusCode, 200)
  assert.equal((await bobView()).own, null)

  // The trail behind it: GET …/triage/history?finding=<id> is gated like the
  // entries (401; 404 for a non-member; a stripped finding 404s; 400 without a
  // finding) and lists bob's writes on 'own' newest first, attributed to him.
  const H = (id, finding) => `/api/reports/${id}/triage/history${finding == null ? '' : `?finding=${encodeURIComponent(finding)}`}`
  assert.equal((await send('GET', H(fx.reportId, 'own'), null)).statusCode, 401)
  assert.equal((await send('GET', H(fx.reportId, 'own'), cookiePair(fx.erinSess.setCookie))).statusCode, 404)
  assert.equal((await send('GET', H(fx.reportId, 'dep'), bCk)).statusCode, 404)
  assert.equal((await send('GET', H(fx.reportId), bCk)).statusCode, 400)
  assert.equal((await send('POST', H(fx.reportId, 'own'), bCk)).statusCode, 405)
  const history = JSON.parse((await send('GET', H(fx.reportId, 'own'), bCk)).body)
  assert.equal(history.finding, 'own')
  assert.deepEqual(history.events.map((e) => [e.actorLogin, e.entry]), [
    ['bob', null],
    ['bob', { color: 'red', flagged: false }],
    ['bob', { color: 'red' }], // the grouped-report write above
  ])
  assert.ok(history.events[0].seq > history.events[1].seq)
  // The admin's write on 'dep' is in dep's trail — readable by the admin, not bob.
  const depHistory = JSON.parse((await send('GET', H(fx.reportId, 'dep'), cookiePair(fx.adminSess.setCookie))).body)
  assert.deepEqual(depHistory.events.map((e) => [e.actorLogin, e.entry]), [['alice', { color: 'gray' }]])
  await db.close()
})

async function managerContentFixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const reportStore = fakeBlobStore()
  const fx = await reportTriageFixture(db, reportStore)
  const team = (await db.listTeams()).find(row => row.name === 'Blue')
  await db.setTeamMember(team.id, fx.frankSess.userId, { dependencies: false, security: false })
  await db.removeTeamRepo(team.id, 7)
  await db.setTeamRepo(team.id, 7, 'src')
  await db.setReportRepo(fx.reportId, 7, 'src/app')
  const { send, upload } = bundleHarness(db, config, reportStore)
  const cookie = cookiePair(fx.frankSess.setCookie)
  const adminCookie = cookiePair(fx.adminSess.setCookie)
  const get = async path => JSON.parse((await send('GET', path, cookie)).body)
  const post = (path, body) => upload(`/api/admin/${path}`, cookie, fx.frankSess.csrfToken, JSON.stringify(body))
  return { ...fx, db, reportStore, team, cookie, adminCookie, get, post, send, upload }
}

test('managers manage unpublished reports only inside team repository paths, including reads, moves, triage and revocation', async (t) => {
  const f = await managerContentFixture(t)
  const { db, send, cookie, reportId, post, get } = f
  const template = (await db.listReports())[0]
  for (const [id, repoId, repoDirectory] of [['other', 8, 'src/app'], ['sibling', 7, 'src-other'], ['root', 7, ''], ['unassigned', null, '']]) {
    await db.insertReport({ ...template, id, repoId, repoDirectory, uploadedBy: f.admin.id }, f.now)
    await f.reportStore.put(id, Buffer.from('{}'))
    for (const path of [`/api/admin/reports/${id}`, `/api/reports/${id}`, `/api/reports/${id}/triage`]) assert.equal((await send('GET', path, cookie)).statusCode, 404, path)
    assert.equal((await post('reports/set-visible', { reportId: id, visible: true })).statusCode, 404)
    assert.equal((await post('reports/set-repo', { reportId: id, repoId: 7, directory: 'src' })).statusCode, 404)
    assert.equal((await send('DELETE', `/api/admin/reports/${id}`, cookie, f.frankSess.csrfToken)).statusCode, 404)
    assert.ok(await db.getReport(id), 'denied deletion keeps metadata')
    assert.ok(await f.reportStore.get(id), 'denied deletion keeps bytes')
  }
  await db.setReportVisible(reportId, false)
  const catalogue = await get('/api/admin/reports')
  assert.deepEqual(catalogue.reports.map(r => r.id), [reportId])
  assert.deepEqual(catalogue.repos, [{ repoId: 7, fullName: 'o/r' }])
  assert.deepEqual(catalogue.repoScopes, [{ repoId: 7, path: 'src' }])
  assert.ok((await get('/api/teams')).teams.some(team => team.reports.some(r => r.id === reportId)))
  for (const path of [`/api/admin/reports/${reportId}`, `/api/reports/${reportId}`, `/api/reports/${reportId}/triage`]) assert.equal((await send('GET', path, cookie)).statusCode, 200, path)
  assert.equal((await f.upload(`/api/reports/${reportId}/triage`, cookie, f.frankSess.csrfToken, JSON.stringify({ entries: { own: { color: 'blue' } } }))).statusCode, 200)
  assert.equal((await post('reports/set-visible', { reportId, visible: true })).statusCode, 200)
  for (const [repoId, directory] of [[8, 'src'], [7, ''], [7, 'src-other']]) assert.equal((await post('reports/set-repo', { reportId, repoId, directory })).statusCode, 403)
  assert.equal((await post('reports/set-repo', { reportId, repoId: 7, directory: 'src/new' })).statusCode, 200)
  const admin = JSON.parse((await send('GET', '/api/admin/reports', f.adminCookie)).body)
  assert.equal(admin.reports.length, 5, 'admin still has the entire catalogue')
  await db.removeTeamMember(f.team.id, f.frankSess.userId)
  assert.deepEqual((await get('/api/admin/reports')).reports, [])
  assert.equal((await send('GET', `/api/admin/reports/${reportId}`, cookie)).statusCode, 404)
  assert.equal((await post('reports/set-visible', { reportId, visible: false })).statusCode, 404)
})

test('manager uploads enforce embedded and explicit repository paths before storing content', async (t) => {
  const f = await managerContentFixture(t)
  const upload = (body, headers = {}) => f.upload('/api/admin/reports', f.cookie, f.frankSess.csrfToken, body, headers)
  const before = (await f.db.listReports()).length
  for (const headers of [{ 'x-repo-id': '8', 'x-repo-directory': 'src' }, { 'x-repo-id': '7' }, { 'x-repo-id': '7', 'x-repo-directory': 'src2' }]) {
    assert.equal((await upload('{}', headers)).statusCode, 403)
  }
  assert.equal((await upload(JSON.stringify({ repo: { github: 'o/other', directory: 'src' }, findings: [] }), { 'x-repo-id': '7', 'x-repo-directory': 'src' })).statusCode, 403, 'headers cannot override embedded private metadata')
  assert.equal((await upload(JSON.stringify({ repo: { github: 'o/r', directory: 'src/app' }, findings: [] }))).statusCode, 201)
  assert.equal((await upload('{}', { 'x-repo-id': '7', 'x-repo-directory': 'src' })).statusCode, 201)
  assert.equal((await upload('{}')).statusCode, 201, 'managers can own unattached uploads')
  assert.equal((await f.db.listReports()).length, before + 3)
  await f.db.removeTeamMember(f.team.id, f.frankSess.userId)
  assert.equal((await upload('{}', { 'x-repo-id': '7', 'x-repo-directory': 'src' })).statusCode, 403)
})

test('manager bundle access, deduplication and report auto-linking respect team scopes', async (t) => {
  const f = await managerContentFixture(t)
  const uploadBundle = (bytes, repoId, admin = false) => f.upload('/api/admin/bundles', admin ? f.adminCookie : f.cookie, admin ? f.adminSess.csrfToken : f.frankSess.csrfToken, bytes, repoId == null ? {} : { 'x-repo-id': String(repoId) })
  const privateUpload = await uploadBundle('private bytes', 8, true)
  assert.equal(privateUpload.statusCode, 201)
  const privateBundle = JSON.parse(privateUpload.body)
  assert.equal((await uploadBundle('private bytes', 7)).statusCode, 409)
  const unattached = await uploadBundle('new bytes', null)
  assert.equal(unattached.statusCode, 201)
  assert.equal((await f.send('DELETE', `/api/admin/bundles/${JSON.parse(unattached.body).id}`, f.cookie, f.frankSess.csrfToken)).statusCode, 200)
  assert.equal((await uploadBundle('new bytes', 8)).statusCode, 403)
  assert.equal((await f.send('GET', `/api/admin/bundles/${privateBundle.id}`, f.cookie)).statusCode, 404)
  assert.equal((await f.send('DELETE', `/api/admin/bundles/${privateBundle.id}`, f.cookie, f.frankSess.csrfToken)).statusCode, 404)
  assert.equal((await f.post('bundles/set-repo', { bundleId: privateBundle.id, repoId: 7 })).statusCode, 404)
  const legacy = JSON.parse((await f.upload('/api/admin/reports', f.adminCookie, f.adminSess.csrfToken, JSON.stringify({ bundleHashes: [privateBundle.integrity] }), { 'x-repo-id': '7', 'x-repo-directory': 'src' })).body)
  const safeList = (await f.get('/api/admin/reports')).reports.find(r => r.id === legacy.id)
  assert.equal(safeList.bundleId, null, 'legacy cross-scope links do not expose private bundle IDs or names')
  assert.equal(safeList.bundleFilename, null)
  const newReport = JSON.parse((await f.upload('/api/admin/reports', f.cookie, f.frankSess.csrfToken, JSON.stringify({ bundleHashes: [privateBundle.integrity] }), { 'x-repo-id': '7', 'x-repo-directory': 'src' })).body)
  assert.equal(newReport.bundleId, null, 'new reports never resolve inaccessible bundle hashes')
  const futureHash = bundleIntegrity(Buffer.from('future bytes'))
  const template = (await f.db.listReports())[0]
  for (const [id, repoId, repoDirectory] of [['allowed-link', 7, 'src'], ['private-link', 8, 'src'], ['sibling-link', 7, 'elsewhere']]) {
    await f.db.insertReport({ ...template, id, repoId, repoDirectory, bundleId: null, bundleIntegrity: futureHash, uploadedBy: f.admin.id }, f.now)
  }
  const allowed = JSON.parse((await uploadBundle('future bytes', 7)).body)
  for (const row of (await f.db.listReports()).filter(r => r.id.endsWith('-link'))) assert.equal(row.bundleId, row.id === 'allowed-link' ? allowed.id : null)
  assert.deepEqual((await f.get('/api/admin/bundles')).bundles.map(b => b.id), [allowed.id])
  assert.equal((await f.send('GET', `/api/admin/bundles/${allowed.id}`, f.cookie)).statusCode, 200)
  assert.equal((await f.post('bundles/set-repo', { bundleId: allowed.id, repoId: 8 })).statusCode, 403)
  assert.equal((await f.post('bundles/set-repo', { bundleId: allowed.id, repoId: null })).statusCode, 200)
  assert.equal((await f.post('bundles/set-repo', { bundleId: allowed.id, repoId: 7 })).statusCode, 200)
  await f.db.setReportRepo('sibling-link', 7, 'src/new')
  assert.equal((await uploadBundle('future bytes', 7)).statusCode, 200)
  assert.equal((await f.db.listReports()).find(r => r.id === 'sibling-link').bundleId, allowed.id, 'dedup reconciles reports that became accessible since the original upload')
  assert.equal((await f.send('DELETE', `/api/admin/bundles/${allowed.id}`, f.cookie, f.frankSess.csrfToken)).statusCode, 200)
  assert.ok(await f.db.getBundle(privateBundle.id))
})

test('manager history includes scoped content changes and deletions, excludes repository and access administration, and rechecks grants', async (t) => {
  const f = await managerContentFixture(t)
  const history = (q = '') => f.get('/api/admin/history' + q)
  await f.db.recordActivity({ kind: 'repository', actor: 'alice', action: 'deactivated repository', repo: 'o/r' }, f.now)
  await f.db.recordActivity({ kind: 'access', actor: 'alice', action: 'changed team membership', repo: 'o/r' }, f.now)
  await f.post('reports/set-visible', { reportId: f.reportId, visible: false })
  const bundle = JSON.parse((await f.upload('/api/admin/bundles', f.cookie, f.frankSess.csrfToken, 'archive', { 'x-repo-id': '7' })).body)
  await f.db.recordActivity({ kind: 'repository', actor: 'alice', action: 'assigned from private/repository', bundleId: bundle.id, report: 'old-private-name.zip', repo: 'private/repository' }, f.now)
  assert.equal((await history('?kind=upload')).total, 2)
  assert.equal((await history('?kind=visibility')).total, 1)
  assert.equal((await history('?kind=access')).total, 0)
  const assignments = await history('?kind=repository')
  assert.equal(assignments.total, 1)
  assert.equal(assignments.history[0].report, 'bundle')
  assert.doesNotMatch(JSON.stringify(assignments), /private|deactivated/u)
  assert.equal((await history('?q=private')).total, 0)
  await f.db.setBundleRepo(bundle.id, 8)
  assert.equal((await history('?kind=repository')).total, 0, 'moving content out of scope also removes its history')
  await f.db.setBundleRepo(bundle.id, 7)
  assert.equal((await f.send('DELETE', `/api/admin/reports/${f.reportId}`, f.cookie, f.frankSess.csrfToken)).statusCode, 200)
  assert.equal((await f.send('DELETE', `/api/admin/bundles/${bundle.id}`, f.cookie, f.frankSess.csrfToken)).statusCode, 200)
  assert.equal((await history('?kind=delete&limit=1')).total, 2, 'deletion scopes survive the content row')
  await f.db.removeTeamRepo(f.team.id, 7)
  await f.db.setTeamRepo(f.team.id, 7, 'other-path')
  assert.equal((await history('?kind=delete')).total, 1, 'report deletion still requires its path grant; bundles use repository access')
  await f.db.removeTeamMember(f.team.id, f.frankSess.userId)
  assert.equal((await history()).total, 0)
  const admin = JSON.parse((await f.send('GET', '/api/admin/history', f.adminCookie)).body)
  assert.ok(admin.history.some(entry => entry.action === 'deactivated repository'))
  assert.ok(admin.history.some(entry => entry.action === 'changed team membership'))
  assert.ok(admin.history.some(entry => entry.report === 'old-private-name.zip'))
})

test('manager duplicate bundle races do not disclose an inaccessible winner', async (t) => {
  const f = await managerContentFixture(t)
  const insert = f.db.insertBundle.bind(f.db)
  t.mock.method(f.db, 'insertBundle', async (bundle, now) => {
    await insert({ ...bundle, id: 'private-winner', filename: 'secret-name.zip', repoId: 8, uploadedBy: f.admin.id }, now)
    await insert(bundle, now)
  })
  const res = await f.upload('/api/admin/bundles', f.cookie, f.frankSess.csrfToken, 'racing bytes', { 'x-repo-id': '7' })
  assert.equal(res.statusCode, 409)
  assert.deepEqual(JSON.parse(res.body), { error: 'bundle-conflict' })
  assert.deepEqual((await f.get('/api/admin/bundles')).bundles, [])
})

test('Users Last Activity reflects successful authenticated changes, not reads, rejected requests or no-ops', async (t) => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const reportStore = fakeBlobStore()
  const f = await reportTriageFixture(db, reportStore)
  const { send, upload } = bundleHarness(db, config, reportStore)
  const cookie = cookiePair(f.adminSess.setCookie)
  const csrf = f.adminSess.csrfToken
  let now = f.now + 10_000
  t.mock.method(Date, 'now', () => now)
  const users = async () => {
    const res = await send('GET', '/api/admin/users', cookie)
    assert.equal(res.statusCode, 200)
    return JSON.parse(res.body).users
  }
  const activityAt = async () => (await users()).find(user => user.id === f.admin.id).lastActivityAt
  const post = (path, body, token = csrf) => upload(`/api/admin/${path}`, cookie, token, JSON.stringify(body))
  assert.equal(await activityAt(), f.now, 'an authenticated read does not add activity')
  assert.equal((await post('reports/set-visible', { reportId: f.reportId, visible: false }, null)).statusCode, 403)
  assert.equal((await post('reports/set-visible', { reportId: 'missing', visible: false })).statusCode, 404)
  assert.equal((await post('reports/set-visible', { reportId: f.reportId, visible: true })).statusCode, 200)
  assert.equal(await activityAt(), f.now, 'rejected and unchanged mutations add no activity')
  assert.equal((await post('reports/set-visible', { reportId: f.reportId, visible: false })).statusCode, 200)
  assert.equal(await activityAt(), now)
  now += 1000
  assert.equal((await post('set-role', { userId: f.bobSess.userId, role: 'view' })).statusCode, 200)
  assert.equal(await activityAt(), now)
  assert.equal((await users()).find(user => user.id === f.bobSess.userId).lastActivityAt, null, 'the admin gets activity, not the edited account')
  now += 1000
  assert.equal((await post('teams', { name: 'New team' })).statusCode, 201)
  assert.equal(await activityAt(), now)
  now += 1000
  assert.equal((await upload('/api/admin/reports', cookie, csrf, '{}')).statusCode, 201)
  assert.equal(await activityAt(), now)
  now += 1000
  assert.equal((await upload('/api/admin/bundles', cookie, csrf, 'archive')).statusCode, 201)
  assert.equal(await activityAt(), now)
  const lastUpload = now
  now += 1000
  assert.equal((await upload('/api/admin/bundles', cookie, csrf, 'archive')).statusCode, 200)
  assert.equal(await activityAt(), lastUpload, 'a deduplicated upload creates no activity')
})
async function reportAccessFixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const sessions = {}
  for (const [index, role] of ['admin', 'manage', 'manage', 'view'].entries()) {
    const session = await createSession(config, db, { githubUserId: index + 1, login: `access${index}`, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    sessions[['admin', 'owner', 'manager', 'viewer'][index]] = session
  }
  for (const repoId of [1, 2]) await db.selectRepo({ repoId, fullName: `org/repo${repoId}`, private: true, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: sessions.admin.userId }, Date.now())
  const team = randomUUID()
  await db.createTeam(team, 'Scoped team', Date.now())
  await db.setTeamRepo(team, 1, 'packages/app')
  for (const who of ['manager', 'viewer']) await db.setTeamMember(team, sessions[who].userId, { dependencies: true, security: true })
  const store = fakeBlobStore()
  const harness = bundleHarness(db, config, store)
  async function seed({ owner = 'admin', repoId = 1, directory = 'packages/app', visible = true } = {}) {
    const id = randomUUID(), text = JSON.stringify({ findings: [{ id: 'shared-finding', title: 'Private finding', description: 'Report content', severity: 'high' }] })
    await db.insertReport({ id, filename: `${id}.json`, contentType: 'application/json', byteSize: text.length, sha256: id, uploadedBy: sessions[owner].userId, uploadedByLogin: owner, repoId, repoDirectory: directory, visible }, Date.now())
    await store.put(id, Buffer.from(text))
    return id
  }
  function get(path, who = 'manager') { return harness.send('GET', path, cookiePair(sessions[who].setCookie)) }
  function post(path, body, who = 'manager') { return harness.upload(path, cookiePair(sessions[who].setCookie), sessions[who].csrfToken, JSON.stringify(body)) }
  return { db, sessions, store, harness, team, seed, get, post }
}

test('manager report lists, previews, downloads and triage reads share ownership/team path access', async t => {
  const h = await reportAccessFixture(t)
  const own = await h.seed({ owner: 'manager', repoId: null, visible: false })
  const ownedElsewhere = await h.seed({ owner: 'manager', repoId: 2, visible: false })
  const scoped = await h.seed({ directory: 'packages/app/src' })
  const draft = await h.seed({ visible: false })
  const unrelated = await h.seed({ directory: 'packages/application' })
  const list = JSON.parse((await h.get('/api/admin/reports')).body).reports
  assert.deepEqual(new Set(list.map(r => r.id)), new Set([own, ownedElsewhere, scoped, draft]))
  assert.equal(list.find(r => r.id === ownedElsewhere).canChangeRepo, false)
  assert.equal(JSON.parse((await h.get('/api/admin/reports', 'admin')).body).reports.length, 5)
  for (const id of [own, ownedElsewhere, scoped, draft]) {
    for (const path of [`/api/reports/${id}`, `/api/admin/reports/${id}`, `/api/reports/${id}/triage`]) assert.equal((await h.get(path)).statusCode, 200, path)
  }
  for (const path of [`/api/reports/${unrelated}`, `/api/admin/reports/${unrelated}`, `/api/reports/${unrelated}/triage`, `/api/reports/${unrelated}/triage/history?finding=shared-finding`]) assert.equal((await h.get(path)).statusCode, 404, path)
  assert.equal((await h.get(`/api/reports/${draft}`, 'viewer')).statusCode, 404, 'drafts remain hidden from viewers')
  assert.equal((await h.get(`/api/reports/${scoped}`, 'viewer')).statusCode, 200)
  await h.db.removeTeamMember(h.team, h.sessions.manager.userId)
  assert.equal((await h.get(`/api/reports/${scoped}/triage`)).statusCode, 404, 'warm triage cache cannot bypass revoked membership')
  assert.equal((await h.get(`/api/reports/${own}`)).statusCode, 200)
  await h.db.setUserRole(h.sessions.manager.userId, 'view')
  assert.equal((await h.get(`/api/reports/${own}`)).statusCode, 404, 'ownership alone does not grant a viewer access')
})

test('report mutations cannot bypass scoped access or remove an inaccessible repository link', async t => {
  const h = await reportAccessFixture(t)
  const unrelated = await h.seed({ repoId: 2 })
  const own = await h.seed({ owner: 'manager', repoId: 2 })
  const scoped = await h.seed()
  const del = id => h.harness.send('DELETE', `/api/admin/reports/${id}`, cookiePair(h.sessions.manager.setCookie), h.sessions.manager.csrfToken)
  for (const id of [unrelated, own]) {
    const status = id === own ? 403 : 404
    assert.equal((await h.post('/api/admin/reports/set-visible', { reportId: id, visible: false })).statusCode, status)
    assert.equal((await h.post('/api/admin/reports/set-repo', { reportId: id, repoId: null })).statusCode, status)
    assert.equal((await del(id)).statusCode, status)
    assert.ok(await h.db.getReport(id))
  }
  assert.equal((await h.post('/api/admin/reports/set-repo', { reportId: scoped, repoId: 1, directory: 'packages/elsewhere' })).statusCode, 403)
  assert.equal((await h.post('/api/admin/reports/set-repo', { reportId: scoped, repoId: 1, directory: 'packages/app/subdir' })).statusCode, 200)
  assert.equal((await h.post('/api/admin/reports/set-visible', { reportId: scoped, visible: false })).statusCode, 200)
  assert.equal((await del(scoped)).statusCode, 200)
  const unattached = await h.seed({ owner: 'manager', repoId: null })
  assert.equal((await del(unattached)).statusCode, 200)
  const upload = directory => h.harness.upload('/api/admin/reports', cookiePair(h.sessions.manager.setCookie), h.sessions.manager.csrfToken, '{}', { 'x-repo-id': '1', 'x-repo-directory': directory })
  assert.equal((await upload('packages/app')).statusCode, 201)
  assert.equal((await upload('packages/application')).statusCode, 403)
})

test('No access overrides report/bundle ownership and teams for every managed data route', async t => {
  const h = await reportAccessFixture(t)
  const id = await h.seed({ owner: 'manager' })
  const bundle = randomUUID()
  await h.db.insertBundle({ id: bundle, integrity: 'private-integrity', filename: 'private.map', kind: 'sourcemap', byteSize: 2, uploadedBy: h.sessions.manager.userId, repoId: 1 }, Date.now())
  await h.db.setUserRole(h.sessions.manager.userId, 'none')
  const reads = [
    '/api/teams', `/api/avatar/${h.sessions.admin.userId}`, '/api/admin/reports', '/api/admin/bundles',
    '/api/admin/users', '/api/admin/teams', '/api/admin/repositories', '/api/admin/models',
    `/api/reports/${id}`, `/api/admin/reports/${id}`, `/api/reports/${id}/triage`, `/api/reports/${id}/triage/history?finding=shared-finding`,
    `/api/bundles/${bundle}/metadata`, `/api/bundles/${bundle}/contents`, `/api/bundles/${bundle}/download`, `/api/admin/bundles/${bundle}`,
  ]
  let bodyReads = 0
  h.store.get = () => { bodyReads++; throw new Error('Blocked accounts must not read data') }
  for (const path of reads) {
    const res = await h.get(path)
    assert.equal(res.statusCode, 403, path)
    assert.deepEqual(JSON.parse(res.body), { error: 'forbidden' })
  }
  for (const path of ['/api/admin/reports', '/api/admin/bundles', '/api/admin/reports/set-visible', '/api/admin/reports/set-repo', '/api/admin/bundles/set-repo', `/api/reports/${id}/triage`]) assert.equal((await h.post(path, { reportId: id, bundleId: bundle, repoId: null, visible: false })).statusCode, 403, path)
  for (const path of [`/api/admin/reports/${id}`, `/api/admin/bundles/${bundle}`]) assert.equal((await h.harness.send('DELETE', path, cookiePair(h.sessions.manager.setCookie), h.sessions.manager.csrfToken)).statusCode, 403)
  assert.equal(bodyReads, 0)
  assert.ok(await h.db.getReport(id)); assert.ok(await h.db.getBundle(bundle))
  assert.equal((await h.get('/api/auth/session')).statusCode, 200, 'blocked users can see their own role')
  assert.equal((await h.post('/api/auth/logout', {})).statusCode, 204, 'blocked users can sign out')
})

for (const suffix of ['', '/triage']) {
  test(`report access revoked during blob loading is denied (${suffix || 'body'})`, async t => {
    const h = await reportAccessFixture(t), id = await h.seed()
    const original = h.store.get
    h.store.get = async key => { await h.db.setUserRole(h.sessions.manager.userId, 'none'); return original(key) }
    assert.equal((await h.get(`/api/reports/${id}${suffix}`)).statusCode, 404)
  })
}


test('team slugs are assigned by the server and cannot be edited through create or rename', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
  const cookie = cookiePair(session.setCookie)
  const { send, upload } = bundleHarness(db)
  const created = await upload('/api/admin/teams', cookie, session.csrfToken, JSON.stringify({ name: 'Team', slug: 'custom' }))
  assert.equal(created.statusCode, 201)
  const team = JSON.parse(created.body)
  assert.equal(team.slug, team.id.split('-').at(-1))
  const renamed = await upload('/api/admin/teams/rename', cookie, session.csrfToken, JSON.stringify({ teamId: team.id, name: 'Renamed', slug: 'custom' }))
  assert.equal(renamed.statusCode, 200)
  assert.equal((await db.getTeam(team.id)).slug, team.slug)
  await db.setTeamMember(team.id, session.userId, { dependencies: false, security: false })
  assert.equal(JSON.parse((await send('GET', '/api/teams', cookie)).body).teams[0].slug, team.slug)
  assert.equal(JSON.parse((await send('GET', '/api/admin/teams', cookie)).body).teams[0].slug, team.slug)
})
