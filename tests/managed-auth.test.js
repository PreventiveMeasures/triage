// Managed auth server — the auth logic (crypto, sessions, the GitHub OAuth
// callback) against an in-memory SQLite store and a stubbed GitHub. The HTTP
// router + boot are smoke-covered separately; here we exercise the units that
// a live server can't easily prove (CSRF, token exchange, session lifecycle).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createVerify, generateKeyPairSync, randomUUID } from 'node:crypto'

import { hashToken, randomToken, safeEqual } from '../server-managed/crypto.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession, endSession, readSession } from '../server-managed/session.ts'
import { OAuthError, buildLoginRedirect, ensureUserAccessToken, handleCallback, refreshUserToken } from '../server-managed/github-oauth.ts'
import { appJwt, collectRepos, githubAppConfigured, installUrl, listInstalledRepos, listUserRepos, mergeRepos, repoAccessToken } from '../server-managed/github-app.ts'
import { bundleIntegrity } from '../server-managed/bundle.ts'
import { filterReportContent } from '../common/managed/report-filter.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'

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
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: fakeBlobStore(),
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
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: fakeBlobStore(),
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
    config, db, avatarStore, reportStore: fakeBlobStore(), bundleStore: fakeBlobStore(),
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

test('GET /api/admin/repositories: admin|manage only; no stored token → tokenMissing', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const manageSess = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)
  const noneSess = await createSession(config, db, { githubUserId: 3, login: 'cy', name: null, avatarUrl: null }, now + 2000)
  const bob = (await readSession(config, db, cookiePair(manageSess.setCookie), now)).user
  await db.setUserRole(bob.id, 'manage')

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: fakeBlobStore(),
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
  assert.equal(asManage.statusCode, 200)
  // No slug + no token persisted for this user → the tokenMissing response.
  assert.deepEqual(JSON.parse(asManage.body), { installUrl: null, repositories: [], tokenMissing: true })
  assert.equal((await get(cookiePair(adminSess.setCookie))).statusCode, 200)
  await db.close()
})

test('POST /api/admin/repositories/select: admin|manage + CSRF; verifies access, persists, marks, deselects', async () => {
  const db = openSqliteManagedDb(':memory:')
  const now = Date.now()
  const adminSess = await createSession(config, db, { githubUserId: 1, login: 'alice', name: null, avatarUrl: null }, now)
  const noneSess = await createSession(config, db, { githubUserId: 2, login: 'bob', name: null, avatarUrl: null }, now + 1000)
  const admin = (await readSession(config, db, cookiePair(adminSess.setCookie), now)).user
  // A non-expiring token so collectRepos can list the admin's public repos.
  await db.setUserTokens(admin.id, { accessToken: 'gho_x', refreshToken: null, expiresAt: null })

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: fakeBlobStore(),
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
  await db.insertReport({ id, filename: 'scan.json', contentType: 'application/json', byteSize: 42, sha256: 'h4sh', uploadedBy: uid, repoId: null, bundleId: null, bundleIntegrity: null }, now)

  const list = await db.listReports()
  assert.equal(list.length, 1)
  assert.deepEqual(
    [list[0].id, list[0].filename, list[0].byteSize, list[0].sha256, list[0].uploadedByLogin, list[0].uploadedAt],
    [id, 'scan.json', 42, 'h4sh', 'alice', now],
  )

  const rec = await db.getReport(id)
  assert.deepEqual([rec.filename, rec.contentType, rec.uploadedBy], ['scan.json', 'application/json', uid])
  assert.equal(await db.getReport(randomUUID()), null) // unknown id → null

  assert.equal(await db.deleteReport(id), true)
  assert.equal(await db.deleteReport(id), false) // already gone → false
  assert.deepEqual(await db.listReports(), [])
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
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: fakeBlobStore(),
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
  assert.deepEqual(JSON.parse(ok.body), { reports: [], maxBytes: config.maxReportBytes, repos: [] })
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
    config: smallCap, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: fakeBlobStore(),
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
  const { id } = JSON.parse(up.body)
  assert.match(id, /^[0-9a-f-]{36}$/u)

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
  await db.insertReport({ id: rId, filename: 'r.json', contentType: 'application/json', byteSize: 5, sha256: 'h', uploadedBy: uid, repoId: null, bundleId: null, bundleIntegrity: 'sha512-AAA' }, now)
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

// Shared HTTP harness for the bundle / link tests: a handler over in-memory
// stores + an always-allow origin gate, with raw-body upload + plain send.
function bundleHarness(db, cfg = config) {
  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config: cfg, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: fakeBlobStore(),
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
  assert.equal(dl.body, body)
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
  await db.insertReport({ id: reportId, filename: 'r.json', contentType: 'application/json', byteSize: 2, sha256: 'x', uploadedBy: admin.id, repoId: null, bundleId: null, bundleIntegrity: null }, now)
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
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: fakeBlobStore(),
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
  assert.deepEqual(await db.getTeam(tId), { id: tId, name: 'Blue' })
  assert.deepEqual(await db.listUserOptions(), [{ id: uid, login: 'alice' }])

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
    config, db, avatarStore: fakeAvatarStore(), reportStore: fakeBlobStore(), bundleStore: fakeBlobStore(),
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
  // bob is role 'none' but logged in → still sees his own team (Blue only).
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
  await db.insertReport({ id: reportId, filename: 'scan.json', contentType: 'application/json', byteSize: 5, sha256: 'x', uploadedBy: admin.id, repoId: 7, bundleId: null, bundleIntegrity: null }, now)

  const reportStore = fakeBlobStore()
  await reportStore.put(reportId, Buffer.from('{"findings":[]}'))
  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(), reportStore, bundleStore: fakeBlobStore(),
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
  async function req(url, cookie) {
    const res = mockRes()
    handler({ method: 'GET', url, headers: cookie ? { cookie } : {} }, res)
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
  assert.equal((await view(nonerSess, reportId)).statusCode, 404) // IN the team, but role 'none' → refused
  assert.equal((await view(outsiderSess, reportId)).statusCode, 404) // >=view, but wrong team (no repo 7)
  assert.equal((await view(adminSess, randomUUID())).statusCode, 404) // admin, but the report doesn't exist

  // The db check is team-only (the role gate lives in the handler): viewer AND noner
  // are both members of Blue, but only viewer's role clears the endpoint above.
  assert.equal(await db.userCanReadReport(viewer.id, reportId), true)
  assert.equal(await db.userCanReadReport(noner.id, reportId), true)
  assert.equal(await db.userCanReadReport(outsider.id, reportId), false)
  assert.equal(await db.userCanReadReport(admin.id, reportId), false) // admin isn't a member

  // GET /api/teams matches the rule: viewer sees the report; noner (role 'none') sees
  // the team but NO reports (stripped server-side).
  const teamsOf = async (sess) => JSON.parse((await req('/api/teams', cookiePair(sess.setCookie))).body).teams
  assert.deepEqual((await teamsOf(viewerSess)).map((t) => [t.name, t.reports.map((r) => r.filename)]), [['Blue', ['scan.json']]])
  assert.deepEqual((await teamsOf(nonerSess)).map((t) => [t.name, t.reports.length]), [['Blue', 0]])
  await db.close()
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

test('GET /api/reports/<id>: server-side content filter by viewer permissions (admin/manage exempt)', async () => {
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
  await db.insertReport({ id: reportId, filename: 'scan.json', contentType: 'application/json', byteSize: 5, sha256: 'x', uploadedBy: admin.id, repoId: 7, bundleId: null, bundleIntegrity: null }, now)
  const content = JSON.stringify({ source: 'native', findings: [
    { id: 'own', file: 'src/a.js' },
    { id: 'dep', file: 'node_modules/x/y.js' },
    { id: 'sec', file: 'src/b.js', security: true },
  ] })
  const reportStore = fakeBlobStore()
  await reportStore.put(reportId, Buffer.from(content))

  assert.deepEqual(await db.reportPermissionsFor(viewer.id, reportId), { dependencies: false, security: true })

  let pending = Promise.resolve()
  const handler = createManagedRequestHandler({
    config, db, avatarStore: fakeAvatarStore(), reportStore, bundleStore: fakeBlobStore(),
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
  async function view(sess, id) {
    const res = mockRes()
    handler({ method: 'GET', url: `/api/reports/${id}`, headers: { cookie: cookiePair(sess.setCookie) } }, res)
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
  await db.close()
})

test('teams API: admin|manage gating, create (409 dup), repo/member links + perms, CSRF', async () => {
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

  // unlink + delete
  assert.equal((await upload('/api/admin/teams/remove-member', aCk, csrf, JSON.stringify({ teamId, userId: bob.id }))).statusCode, 200)
  assert.equal((await upload('/api/admin/teams/remove-repo', aCk, csrf, JSON.stringify({ teamId, repoId: 7 }))).statusCode, 200)
  assert.equal((await upload('/api/admin/teams/delete', aCk, csrf, JSON.stringify({ teamId }))).statusCode, 200)
  assert.equal((await upload('/api/admin/teams/delete', aCk, csrf, JSON.stringify({ teamId }))).statusCode, 404) // gone
  await db.close()
})
