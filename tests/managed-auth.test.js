// Managed auth server — the auth logic (crypto, sessions, the GitHub OAuth
// callback) against an in-memory SQLite store and a stubbed GitHub. The HTTP
// router + boot are smoke-covered separately; here we exercise the units that
// a live server can't easily prove (CSRF, token exchange, session lifecycle).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hashToken, randomToken, safeEqual } from '../server-managed/crypto.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession, endSession, readSession } from '../server-managed/session.ts'
import { OAuthError, buildLoginRedirect, handleCallback } from '../server-managed/github-oauth.ts'

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
    return jsonResponse({}, 404)
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
  assert.equal(s.user.githubUserId, 42)
  assert.equal(s.user.login, 'octocat')
  assert.equal(s.session.csrfToken, csrfToken)

  // Unknown cookie → null; expired → null.
  assert.equal(await readSession(config, db, 'dvsid=nope', now), null)
  assert.equal(await readSession(config, db, cookie, now + config.sessionTtlMs + 1), null)

  await endSession(config, db, cookie)
  assert.equal(await readSession(config, db, cookie, now), null)
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
  assert.equal(s.user.githubUserId, 7)
  assert.equal(s.user.login, 'mona')
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
