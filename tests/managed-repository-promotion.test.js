import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession, endSession, readSession } from '../server-managed/session.ts'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = {
  sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000,
  githubClientId: 'client', githubClientSecret: 'secret',
  oauthCallbackUrl: 'http://localhost/api/oauth/github/callback',
  githubAppId: '10', githubAppSlug: 'triage-test',
  githubAppPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
}
const repository = { repoId: 7, fullName: 'owner/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'https://github.com/owner/repo' }
const installation = { id: 17, permissions: { contents: 'read' }, suspended_at: null }
const metadata = { id: 7, full_name: 'owner/repo', private: false, visibility: 'public', default_branch: 'main' }
const cookieOf = session => session.setCookie.split(';')[0]

async function fixture(t, { github = {}, role = 'admin', app = config } = {}) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, role)
  await db.selectRepo({ ...repository, addedBy: session.userId }, Date.now())
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url))
    assert.equal(options.redirect, 'error')
    assert.match(options.headers.authorization, /^Bearer /u)
    if (String(url).endsWith('/installation')) {
      await github.beforeLookup?.(db, session)
      return Response.json(github.installation ?? installation, { status: github.status ?? 200 })
    }
    if (String(url).endsWith('/access_tokens')) {
      assert.equal(url, 'https://api.github.com/app/installations/17/access_tokens')
      assert.equal(options.method, 'POST')
      return Response.json({ token: 'installation-token' })
    }
    assert.equal(url, 'https://api.github.com/repos/owner/repo')
    assert.equal(options.headers.authorization, 'Bearer installation-token')
    await github.beforeMetadata?.(db, session)
    return Response.json(github.metadata ?? metadata)
  })
  const handler = createManagedRequestHandler({
    config: app, db, originGate: { isOriginAllowed: req => req.headers.origin === 'http://localhost' },
    isShuttingDown: () => false, track: () => {},
  })
  const send = async ({ method = 'POST', cookie = cookieOf(session), csrf = session.csrfToken, origin = 'http://localhost', body = { repoId: 7 } } = {}) => {
    const req = {
      url: '/api/admin/repositories/connect-app', method,
      headers: { cookie, origin, 'x-csrf-token': csrf },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    }
    const res = { status: 0, body: '', writeHead(status) { this.status = status }, end(value) { this.body = value ?? '' } }
    await handler(req, res)
    return { status: res.status, data: res.body ? JSON.parse(res.body) : null }
  }
  return { db, session, calls, send }
}

test('connect App finds the exact installation, preserves inactive state and team grants, and is idempotent', async t => {
  const { db, session, calls, send } = await fixture(t)
  await db.deactivateRepo(7)
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 7, 'src')
  const before = (await db.listAllRepos())[0]
  await db.setTeamMember('team', session.userId, { dependencies: true, security: true })
  const grants = await db.listRepoScopesForUser(session.userId)
  assert.deepEqual(await send({ body: { repoId: 7, installationId: 999, fullName: 'evil/repo' } }), { status: 200, data: { connected: true } })
  assert.deepEqual((await db.listAllRepos())[0], { ...before, installationId: 17 })
  assert.deepEqual(await db.listRepoScopesForUser(session.userId), grants)
  assert.equal((await db.listAllRepos())[0].addedBy, session.userId)
  assert.deepEqual(calls, [
    'https://api.github.com/repos/owner/repo/installation',
    'https://api.github.com/app/installations/17/access_tokens',
    'https://api.github.com/repos/owner/repo',
  ])
  assert.equal((await send()).status, 200)
  assert.equal(calls.length, 3, 'already connected does not make more GitHub requests')
})

test('missing installation, missing Contents permission, and suspended access open the configured installation flow', async t => {
  for (const github of [{ status: 404 }, { installation: { ...installation, permissions: {} } }, { installation: { ...installation, suspended_at: 'today' } }]) {
    await t.test(JSON.stringify(github), async child => {
      const { db, calls, send } = await fixture(child, { github })
      assert.deepEqual(await send(), { status: 200, data: { connected: false, installUrl: 'https://github.com/apps/triage-test/installations/new' } })
      assert.equal((await db.listAllRepos())[0].installationId, null)
      assert.equal(calls.length, 1)
    })
  }
})

test('GitHub failures never silently redirect or change the connection', async t => {
  for (const status of [401, 403, 429, 500]) {
    await t.test(String(status), async child => {
      const { db, send, calls } = await fixture(child, { github: { status } })
      const result = await send()
      assert.ok(result.status >= 400)
      assert.notEqual(result.status, 401, 'invalid App credentials must not log the user out')
      assert.equal(result.data.installUrl, undefined)
      assert.equal((await db.listAllRepos())[0].installationId, null)
      assert.equal(calls.length, 1)
    })
  }
})

test('promotion rejects malformed installation data and changed repository identity', async t => {
  for (const github of [{ installation: { id: -1 } }, { metadata: { ...metadata, id: 8 } }, { metadata: { ...metadata, full_name: 'other/repo' } }]) {
    await t.test(JSON.stringify(github), async child => {
      const { db, send } = await fixture(child, { github })
      const result = await send()
      assert.ok(result.status >= 400)
      assert.equal(result.data.installUrl, undefined)
      assert.equal((await db.listAllRepos())[0].installationId, null)
    })
  }
})

test('promotion requires an admin session, same origin, CSRF, a valid connected repo, and configured App', async t => {
  const { send, calls } = await fixture(t)
  for (const [request, status] of [[{ cookie: '' }, 401], [{ csrf: '' }, 403], [{ origin: 'https://evil.test' }, 403], [{ body: { repoId: 8 } }, 404], [{ body: { repoId: '7' } }, 400], [{ method: 'GET' }, 405]]) {
    assert.equal((await send(request)).status, status)
  }
  assert.equal(calls.length, 0)
  await t.test('manager cannot promote', async child => {
    const manager = await fixture(child, { role: 'manage' })
    assert.equal((await manager.send()).status, 403)
    assert.equal(manager.calls.length, 0)
  })
  await t.test('unconfigured App cannot promote', async child => {
    const unconfigured = await fixture(child, { app: { ...config, githubAppId: null } })
    assert.deepEqual(await unconfigured.send(), { status: 503, data: { error: 'github-app-not-configured' } })
    assert.equal(unconfigured.calls.length, 0)
  })
})

test('permission revocation and repository changes during GitHub lookup prevent promotion', async t => {
  const races = {
    demotion: (db, session) => db.setUserRole(session.userId, 'manage'),
    logout: (db, session) => endSession(config, db, cookieOf(session)),
    removal: db => db.deleteRepo(7),
    replacement: async db => { await db.deleteRepo(7); await db.selectRepo({ ...repository, addedBy: null }, Date.now() + 1000) },
    'another connection': db => db.selectRepo({ ...repository, installationId: 18, addedBy: null }, Date.now()),
  }
  for (const [name, beforeMetadata] of Object.entries(races)) {
    await t.test(name, async child => {
      const { db, send, calls } = await fixture(child, { github: { beforeMetadata } })
      assert.ok((await send()).status >= 400)
      assert.equal(calls.length, 3, 'the race occurs after authentication and GitHub lookup')
      assert.notEqual((await db.listAllRepos())[0]?.installationId, 17)
    })
  }
})

test('the final database write independently checks current role, expiry, and connection identity', async t => {
  const { db, session } = await fixture(t)
  const stored = (await db.listAllRepos())[0]
  const { session: row } = await readSession(config, db, cookieOf(session), Date.now())
  assert.equal(await db.connectRepoInstallation(stored, 17, row.id, row.expiresAt), false)
  await db.setUserRole(session.userId, 'manage')
  assert.equal(await db.connectRepoInstallation(stored, 17, row.id, Date.now()), false)
  await db.setUserRole(session.userId, 'admin')
  assert.equal(await db.connectRepoInstallation({ ...stored, fullName: 'other/repo' }, 17, row.id, Date.now()), false)
  assert.equal((await db.listAllRepos())[0].installationId, null)
})
