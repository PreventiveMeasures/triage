import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession, endSession, readSession } from '../server-managed/session.ts'
import { checkInitialAdminRecovery } from './_managed-initial-admin.js'

const config = {
  sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000,
  githubClientId: 'client', githubClientSecret: 'secret',
  oauthCallbackUrl: 'http://localhost/api/oauth/github/callback',
}
const identity = id => ({ githubUserId: id, login: `user${id}`, name: null, avatarUrl: null })
const cookieOf = session => session.setCookie.split(';')[0]
const id = '00000000-0000-4000-8000-000000000000'

function harness(db, extra = {}) {
  const handler = createManagedRequestHandler({
    config, db, originGate: { isOriginAllowed: () => true },
    isShuttingDown: () => false, track: () => {}, ...extra,
  })
  return async (path, { method = 'GET', session, cookie = session && cookieOf(session), body, beforeBody } = {}) => {
    const req = {
      url: path, method, headers: { cookie, 'x-csrf-token': session?.csrfToken },
      async *[Symbol.asyncIterator]() {
        assert.notEqual(body, undefined, 'a denied request must not read the body')
        await beforeBody?.()
        yield Buffer.from(JSON.stringify(body))
      },
    }
    const res = {
      status: 0, headers: {}, body: '',
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(value) { this.body = value ?? '' },
    }
    await handler(req, res)
    return res
  }
}

// Include real resource-shaped paths and invalid methods: approval is checked
// before dispatch, validation, reading a body, loading blobs, or calling GitHub.
const dataPaths = [
  '/api/teams', `/api/teams/${id}/reports`, `/api/teams/${id}/fixes`, `/api/avatar/${id}`, '/api/github/pull-requests',
  '/api/admin/users', '/api/admin/set-role', '/api/admin/history', '/api/admin/scan/models',
  '/api/admin/repositories', '/api/admin/repositories/select', '/api/admin/repositories/add-public',
  '/api/admin/repositories/impact', '/api/admin/repositories/remove',
  '/api/admin/reports', `/api/admin/reports/${id}`, '/api/admin/reports/set-repo', '/api/admin/reports/set-visible',
  '/api/admin/bundles', `/api/admin/bundles/${id}`, '/api/admin/bundles/set-repo',
  `/api/admin/uploads/reports/${id}/0`, `/api/admin/uploads/bundles/${id}/0`,
  '/api/admin/teams', ...['rename', 'delete', 'set-repo', 'remove-repo', 'set-member', 'remove-member'].map(action => `/api/admin/teams/${action}`),
  '/api/reports/query', `/api/reports/${id}`, `/api/reports/${id}/sources`,
  `/api/reports/${id}/triage`, `/api/reports/${id}/triage/history?finding=secret`,
  `/api/reports/${id}/comments`, `/api/reports/${id}/comments/${id}`,
  ...['metadata', 'contents', 'download'].map(part => `/api/bundles/${id}/${part}`),
  '/api/admin/unknown', '/api/github/unknown', '/api/teams/unknown',
]

test('every managed data route rejects anonymous, invalid, expired, revoked, and unapproved sessions before any work', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const now = Date.now()
  const pending = await createSession(config, db, identity(1), now)
  const expired = await createSession(config, db, identity(2), now - config.sessionTtlMs)
  const revoked = await createSession(config, db, identity(3), now)
  const demoted = await createSession(config, db, identity(4), now)
  await endSession(config, db, cookieOf(revoked))
  await db.setUserRole(demoted.userId, 'admin')
  await db.setUserRole(demoted.userId, 'none')
  for (const session of [pending, demoted]) {
    await db.setUserTokens(session.userId, { accessToken: 'token', refreshToken: 'refresh', expiresAt: 1 })
    await db.createTeam(session.userId, session.userId, now)
    await db.setTeamMember(session.userId, session.userId, { dependencies: true, security: true })
  }
  const guardedDb = new Proxy(db, {
    get(target, name) {
      if (name === 'sessionWithUser') return target[name]
      return () => assert.fail(`denied request accessed db.${String(name)}`)
    },
  })
  const send = harness(guardedDb, {
    serveStatic: () => assert.fail('managed data fell through to static'),
    next: () => assert.fail('managed data fell through to another server'),
  })
  t.mock.method(globalThis, 'fetch', () => assert.fail('denied request reached GitHub'))
  for (const [name, options, status, error] of [
    ['anonymous', {}, 401, 'unauthenticated'],
    ['forged cookie', { cookie: 'sid=unknown' }, 401, 'unauthenticated'],
    ['expired', { session: expired }, 401, 'unauthenticated'],
    ['revoked', { session: revoked }, 401, 'unauthenticated'],
    ['pending approval', { session: pending }, 403, 'forbidden'],
    ['demoted admin', { session: demoted }, 403, 'forbidden'],
  ]) {
    for (const path of dataPaths) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const res = await send(path, { ...options, method })
        assert.equal(res.status, status, `${name}: ${method} ${path}`)
        assert.deepEqual(JSON.parse(res.body), { error })
        assert.equal(res.headers['cache-control'], 'no-store')
      }
    }
  }
})

test('role and team mutations reject admin access lost while the request body is pending', async t => {
  for (const revocation of ['none', 'manage', 'logout', 'expired']) {
    await t.test(revocation, async st => {
      const db = openSqliteManagedDb(':memory:')
      st.after(() => db.close())
      const now = Date.now()
      const target = await createSession(config, db, identity(1), now)
      await db.selectRepo({ repoId: 7, fullName: 'example/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: 'https://github.com/example/repo', addedBy: target.userId }, now)
      await db.createTeam('team', 'Team', now)
      await db.setTeamRepo('team', 7, 'src')
      await db.setTeamMember('team', target.userId, { dependencies: false, security: false })
      const teams = await db.listTeams()
      const send = harness(db)
      const mutations = [
        ['/api/admin/set-role', { userId: target.userId, role: 'admin' }],
        ['/api/admin/teams', { name: 'New team' }],
        ['/api/admin/teams/rename', { teamId: 'team', name: 'Renamed team' }],
        ['/api/admin/teams/delete', { teamId: 'team' }],
        ['/api/admin/teams/set-repo', { teamId: 'team', repoId: 7, path: '' }],
        ['/api/admin/teams/remove-repo', { teamId: 'team', repoId: 7 }],
        ['/api/admin/teams/set-member', { teamId: 'team', userId: target.userId, dependencies: true, security: true }],
        ['/api/admin/teams/remove-member', { teamId: 'team', userId: target.userId }],
      ]
      for (const [path, body] of mutations) {
        const session = await createSession(config, db, identity(2), now)
        await db.setUserRole(session.userId, 'admin')
        let bodyRead = false
        const res = await send(path, { method: 'POST', session, body, beforeBody: async () => {
          // This hook runs only after the initial authorization, modeling a
          // client withholding its body until an administrator revokes access.
          bodyRead = true
          if (revocation === 'logout') await endSession(config, db, cookieOf(session))
          else if (revocation === 'expired') st.mock.method(Date, 'now', () => now + config.sessionTtlMs)
          else await db.setUserRole(session.userId, revocation)
        } })
        assert.equal(bodyRead, true, path)
        const error = revocation === 'logout' || revocation === 'expired' ? 'unauthenticated' : 'forbidden'
        assert.equal(res.status, error === 'unauthenticated' ? 401 : 403, path)
        assert.deepEqual(JSON.parse(res.body), { error }, path)
        assert.equal((await db.listUsers()).find(user => user.id === target.userId).role, 'none', path)
        assert.deepEqual(await db.listTeams(), teams, path)
        st.mock.restoreAll()
      }
    })
  }
})

test('all concurrent signups start with no access; identity updates and re-login cannot restore revoked approval', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const sessions = await Promise.all(Array.from({ length: 8 }, (_, i) => createSession(config, db, { ...identity(i + 1), role: 'admin' }, Date.now())))
  assert.deepEqual((await db.listUsers()).map(user => user.role), Array.from({ length: 8 }, () => 'none'))
  const session = sessions[0]
  await db.setUserRole(session.userId, 'view')
  await createSession(config, db, { ...identity(1), login: 'renamed' }, Date.now())
  assert.equal((await readSession(config, db, cookieOf(session), Date.now())).user.role, 'view')
  await db.setUserRole(session.userId, 'none')
  const again = await createSession(config, db, identity(1), Date.now())
  for (const s of [session, again]) assert.equal((await readSession(config, db, cookieOf(s), Date.now())).user.role, 'none')
})

test('SQLite recovers the configured sole No access user on login only', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkInitialAdminRecovery(db)
})

test('concurrent SQLite first logins check initial-admin approval atomically', async t => {
  for (const firstMatches of [true, false]) {
    const db = openSqliteManagedDb(':memory:')
    t.after(() => db.close())
    const cfg = { ...config, initialAdminGithubId: 7 }
    const ids = firstMatches ? [7, 8, 7] : [8, 7, 7]
    await Promise.all(ids.map(githubId => createSession(cfg, db, identity(githubId), Date.now())))
    assert.deepEqual(Object.fromEntries((await db.listUsers()).map(user => [user.login, user.role])), {
      user7: firstMatches ? 'admin' : 'none', user8: 'none',
    })
  }
})

test('concurrent SQLite recovery and registration check the sole-user condition atomically', async t => {
  for (const recoveryFirst of [true, false]) {
    const db = openSqliteManagedDb(':memory:')
    t.after(() => db.close())
    await createSession(config, db, identity(7), 1)
    const cfg = { ...config, initialAdminGithubId: 7 }
    const ids = recoveryFirst ? [7, 8, 7] : [8, 7, 7]
    await Promise.all(ids.map(githubId => createSession(cfg, db, identity(githubId), 2)))
    assert.deepEqual(Object.fromEntries((await db.listUsers()).map(user => [user.login, user.role])), {
      user7: recoveryFirst ? 'admin' : 'none', user8: 'none',
    })
  }
})

test('login bootstrap, own account status, and CSRF-protected sign-out expose no workspace data', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(config, db, identity(1), Date.now())
  const send = harness(db)
  const login = await send('/api/oauth/github/login')
  assert.equal(login.status, 302)
  assert.equal(new URL(login.headers.location).origin, 'https://github.com')
  assert.equal((await send('/api/oauth/github/callback')).status, 400)
  assert.equal((await send('/api/auth/session')).status, 401)
  assert.equal((await send('/api/config')).status, 200)
  const status = await send('/api/auth/session', { session })
  assert.deepEqual(JSON.parse(status.body), {
    user: { id: session.userId, login: 'user1', name: null, role: 'none' }, csrfToken: session.csrfToken,
  })
  assert.equal((await send('/api/auth/logout', { method: 'POST', cookie: cookieOf(session) })).status, 403)
  assert.equal((await send('/api/auth/logout', { method: 'POST', session })).status, 204)
  assert.equal((await send('/api/auth/session', { session })).status, 401)
})
