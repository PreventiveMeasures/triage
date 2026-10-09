import assert from 'node:assert/strict'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'
import { setup } from './_managed-mutation-safety.js'

const config = { sessionCookieName: 'sid', sessionTtlMs: 3_600_000 }

export async function checkTeamNpmScopes(db) {
  const admin = await setup(db), sid = hashToken(admin.setCookie.split(';')[0].slice(4))
  const member = await createSession(config, db, { githubUserId: 2, login: 'member', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(member.userId, 'view')
  await db.createTeam('team-a', 'Team A', Date.now())
  await db.createTeam('team-b', 'Team B', Date.now())
  await db.setTeamMember('team-a', member.userId, { dependencies: false, security: false })
  assert.deepEqual(await db.setTeamNpmScopes(sid, 'team-a', ['Acme', ' @tools ', '@acme']), { added: ['@acme', '@tools'], removed: [] })
  await db.setTeamNpmScopes(sid, 'team-b', ['@other'])
  assert.deepEqual(await db.listTeamNpmScopes(), { 'team-a': ['@acme', '@tools'], 'team-b': ['@other'] })
  assert.deepEqual(await db.listUserNpmScopes(member.userId), ['@acme', '@tools'], 'only the teams a user is a member of')
  assert.deepEqual(await db.setTeamNpmScopes(sid, 'team-a', ['@tools', '@new']), { added: ['@new'], removed: ['@acme'] })
  assert.deepEqual(await db.setTeamNpmScopes(sid, 'team-a', ['@new', '@tools']), { added: [], removed: [] })
  assert.equal(await db.setTeamNpmScopes(sid, 'missing', ['@acme']), null)
  for (const bad of [['@'], ['@.dot'], ['@_under'], ['@a/b'], ['has space'], [3], '@acme']) {
    await assert.rejects(db.setTeamNpmScopes(sid, 'team-a', bad), /bad-scope/u)
  }
  await assert.rejects(db.setTeamNpmScopes(sid, 'team-a', Array.from({ length: 101 }, (_, i) => `@s${i}`)), /too-many-scopes/u)
  assert.deepEqual(await db.listUserNpmScopes(member.userId), ['@new', '@tools'], 'a refused list changes nothing')
  // Hidden teams grant nothing; restoring one grants its scopes again.
  await db.setTeamHidden('team-a', true, Date.now())
  assert.deepEqual(await db.listUserNpmScopes(member.userId), [])
  await db.setTeamHidden('team-a', false, Date.now())
  await db.removeTeamMember('team-a', member.userId)
  assert.deepEqual(await db.listUserNpmScopes(member.userId), [])
  await db.setUserRole(admin.userId, 'manage')
  await assert.rejects(db.setTeamNpmScopes(sid, 'team-a', []), /forbidden/u)
  await db.setUserRole(admin.userId, 'admin')
  await db.deleteTeam('team-a')
  assert.deepEqual(await db.listTeamNpmScopes(), { 'team-b': ['@other'] }, 'scopes go with their team')
}
