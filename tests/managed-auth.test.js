// Managed auth server — the auth logic (crypto, sessions, the GitHub OAuth
// callback) against an in-memory SQLite store and a stubbed GitHub. The HTTP
// router + boot are smoke-covered separately; here we exercise the units that
// a live server can't easily prove (CSRF, token exchange, session lifecycle).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createVerify, generateKeyPairSync } from 'node:crypto'

import { hashToken, randomToken, safeEqual } from '../server-managed/crypto.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession, endSession, readSession } from '../server-managed/session.ts'
import { OAuthError, buildLoginRedirect, ensureUserAccessToken, handleCallback, refreshUserToken } from '../server-managed/github-oauth.ts'
import { appJwt, collectRepos, githubAppConfigured, installUrl, listInstalledRepos, listUserRepos, mergeRepos, repoAccessToken } from '../server-managed/github-app.ts'
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
    // The listing now flags it selected.
    const listed = JSON.parse((await get(aCk)).body).repositories.find((r) => r.id === 55)
    assert.equal(listed.selected, true)
  } finally {
    globalThis.fetch = realFetch
  }

  // Deselect drops the row (no GitHub needed).
  assert.equal((await post(aCk, adminSess.csrfToken, { repoId: 55, selected: false })).statusCode, 200)
  assert.deepEqual(await db.listSelectedRepos(), [])
  await db.close()
})
