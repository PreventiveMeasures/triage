import assert from 'node:assert/strict'
import { createSession, readSession } from '../server-managed/session.ts'

// Exercise the login boundary against both managed database implementations.
export async function checkInitialAdminRecovery(db) {
  const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
  const identity = { githubUserId: 7, login: 'owner', name: null, avatarUrl: null }
  let now = 1000
  const login = cfg => createSession(cfg, db, identity, ++now)
  const role = async session => (await readSession(config, db, session.setCookie.split(';')[0], now)).user.role
  const first = await login(config)
  assert.equal(await role(first), 'none')

  const configured = { ...config, initialAdminGithubId: 7 }
  assert.equal((await readSession(configured, db, first.setCookie.split(';')[0], ++now)).user.role, 'none',
    'reading an existing session after configuration changes must not promote')
  for (const initialAdminGithubId of [undefined, null, 8]) {
    assert.equal(await role(await login({ ...config, initialAdminGithubId })), 'none',
      'an unset or nonmatching configured identity must not promote')
  }
  const recovered = await login(configured)
  assert.equal(recovered.userId, first.userId, 'recovery retains the existing identity')
  assert.equal(await role(recovered), 'admin', 'the configured sole user recovers access on login')
  assert.equal(await role(first), 'admin', 'existing sessions observe the stored promotion')
  assert.equal((await db.listUsers()).length, 1)
  for (const assigned of ['view', 'triage', 'manage', 'admin']) {
    await db.setUserRole(first.userId, assigned)
    assert.equal(await role(await login(configured)), assigned, 'login must preserve an assigned role')
  }

  await createSession(config, db, { ...identity, githubUserId: 8, login: 'other' }, ++now)
  await db.setUserRole(first.userId, 'none')
  assert.equal(await role(await login(configured)), 'none', 'even another No access user prevents promotion')
  assert.deepEqual((await db.listUsers()).map(user => user.role), ['none', 'none'])
}
