import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOriginGate } from '../server-common/origin.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession, readSession } from '../server-managed/session.ts'

const host = '127.0.0.1:8765'
const origin = `http://${host}`
const config = {
  sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000,
  githubClientId: 'client', githubClientSecret: 'secret',
  oauthCallbackUrl: `${origin}/api/oauth/github/callback`,
}
const cookiePair = value => value.split(';', 1)[0]

async function fixture(t, overrides = {}) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, 'admin')
  const lease = t.mock.fn(work => work())
  db.withRequest = lease
  const handler = createManagedRequestHandler({
    config, db, originGate: createOriginGate('127.0.0.1', 'false'),
    isShuttingDown: () => false, track() {}, ...overrides,
  })
  async function send(method, url, headers = {}) {
    const req = {
      method, url, headers: { host, cookie: cookiePair(session.setCookie), 'x-csrf-token': session.csrfToken, ...headers },
      [Symbol.asyncIterator]() { assert.fail('Unexpected request body read') },
    }
    const res = {
      status: 0, headers: {}, body: '',
      writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders ?? {} },
      end(body) { this.body = body ?? '' },
    }
    await handler(req, res)
    return res
  }
  return { db, session, lease, send }
}

test('managed router rejects foreign origins on every path and method before dispatch or database access', async t => {
  const serveStatic = t.mock.fn(() => { assert.fail('Foreign origin reached static serving') })
  const next = t.mock.fn(() => { assert.fail('Foreign origin reached the next handler') })
  const { db, session, lease, send } = await fixture(t, { serveStatic, next })
  const sessionRead = t.mock.method(db, 'sessionWithUser')
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Foreign origin reached GitHub') })
  const id = '00000000-0000-4000-8000-000000000001'
  const routes = [
    ['GET', '/api/auth/session'], ['GET', '/api/config'],
    ['GET', '/api/admin/users'], ['GET', '/api/teams'],
    ['GET', `/api/avatar/${session.userId}`], ['GET', `/api/reports/${id}`],
    ['HEAD', `/api/reports/${id}/sources`], ['GET', `/api/teams/${id}/feed`],
    ['GET', `/api/bundles/${id}/metadata`], ['HEAD', `/api/bundles/${id}/contents`],
    ['GET', '/api/oauth/github/login'], ['GET', '/api/oauth/github/issues/login'],
    ['GET', '/api/oauth/github/callback?code=code&state=state'],
    ['GET', `/api/shares/${id}`], ['GET', '/api/teams', { 'x-deepview-share': 'share-token' }],
    ['POST', '/api/auth/logout'], ['POST', '/api/reports/query'],
    ['PUT', '/api/admin/teams'], ['PATCH', `/api/teams/${id}/share`],
    ['DELETE', `/api/admin/reports/${id}`], ['OPTIONS', '/api/auth/session'],
    ['GET', '/assets/example.js'], ['GET', '/fallback'],
  ]
  for (const foreignOrigin of ['https://evil.test', `https://${host}`, 'http://127.0.0.1:8766', 'null']) {
    for (const [method, path, headers] of routes) {
      const res = await send(method, path, { ...headers, origin: foreignOrigin })
      assert.equal(res.status, 403, `${method} ${path} from ${foreignOrigin}`)
      assert.deepEqual(JSON.parse(res.body), { error: 'origin-denied' })
    }
  }
  assert.equal(lease.mock.callCount(), 0, 'denied requests never acquire a database connection')
  assert.equal(sessionRead.mock.callCount(), 0, 'denied reads cannot expose the session or its CSRF token')
  assert.equal(serveStatic.mock.callCount(), 0)
  assert.equal(next.mock.callCount(), 0)
})

test('managed reads allow same-origin and omitted Origin without a CSRF header', async t => {
  const { send, session } = await fixture(t)
  for (const requestOrigin of [undefined, origin]) {
    const headers = { origin: requestOrigin, 'x-csrf-token': undefined }
    const res = await send('GET', '/api/auth/session', headers)
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).csrfToken, session.csrfToken)
    assert.equal((await send('GET', '/api/admin/users', headers)).status, 200)
    assert.equal((await send('GET', '/api/teams', headers)).status, 200)
    assert.equal((await send('GET', '/api/config', headers)).status, 200)
  }
})

test('managed reads use the configured trust policy for forwarded origins', async t => {
  for (const trustProxy of ['false', 'true']) {
    const { send } = await fixture(t, { originGate: createOriginGate('127.0.0.1', trustProxy) })
    const headers = { origin: 'https://managed.test', 'x-forwarded-host': 'managed.test', 'x-forwarded-proto': 'https' }
    assert.equal((await send('GET', '/api/auth/session', headers)).status, trustProxy === 'true' ? 200 : 403)
    assert.equal((await send('GET', '/api/auth/session', { ...headers, origin: 'https://evil.test' })).status, 403)
  }
})

test('OAuth redirects without Origin still validate state and create a session', async t => {
  const { db, send } = await fixture(t)
  const fetchMock = t.mock.method(globalThis, 'fetch', url => {
    if (String(url) === 'https://github.com/login/oauth/access_token') return Promise.resolve(Response.json({ access_token: 'token' }))
    assert.equal(String(url), 'https://api.github.com/user')
    return Promise.resolve(Response.json({ id: 2, login: 'octocat' }))
  })
  const login = await send('GET', '/api/oauth/github/login')
  assert.equal(login.status, 302)
  const state = new URL(login.headers.location).searchParams.get('state')
  const cookie = cookiePair(login.headers['set-cookie'])
  const invalid = await send('GET', '/api/oauth/github/callback?code=code&state=wrong', { cookie })
  assert.equal(invalid.status, 400)
  assert.deepEqual(JSON.parse(invalid.body), { error: 'invalid-oauth-state' })
  assert.equal(fetchMock.mock.callCount(), 0)
  const callback = await send('GET', `/api/oauth/github/callback?code=code&state=${state}`, { cookie })
  assert.equal(callback.status, 302)
  const sessionCookie = callback.headers['set-cookie'].find(value => value.startsWith('sid='))
  const result = await readSession(config, db, cookiePair(sessionCookie), Date.now())
  assert.equal(result.user.login, 'octocat')
})

test('mutations require the current session CSRF token and reject missing or malformed tokens', async t => {
  const { db, session, send } = await fixture(t)
  const other = await createSession(config, db, { githubUserId: 2, login: 'other', name: null, avatarUrl: null }, Date.now())
  const token = session.csrfToken
  const differentFirst = `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`
  const differentLast = `${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`
  for (const csrf of [undefined, '', differentFirst, differentLast, token.slice(1), `${token}x`, `${token}, ${token}`, 'é'.repeat(token.length), other.csrfToken]) {
    const res = await send('POST', '/api/auth/logout', { origin, 'x-csrf-token': csrf })
    assert.equal(res.status, 403)
    assert.deepEqual(JSON.parse(res.body), { error: csrf === undefined ? 'csrf-missing' : 'csrf-mismatch' })
    assert.ok(await readSession(config, db, cookiePair(session.setCookie), Date.now()), 'failed CSRF must preserve the session')
  }
  assert.equal((await send('POST', '/api/auth/logout', { origin })).status, 204)
  assert.equal(await readSession(config, db, cookiePair(session.setCookie), Date.now()), null)
})
