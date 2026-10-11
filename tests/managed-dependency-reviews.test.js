import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { checkDependencyReviews } from './_managed-dependency-reviews.js'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'

test('dependency review lifecycle, ownership, team access and frozen snapshots (SQLite)', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkDependencyReviews(db)
})


test('SQLite upgrades existing teams without enabling review or losing memberships', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dependency-review-migration-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'db.sqlite')
  const original = openSqliteManagedDb(path)
  await original.createTeam('team', 'Existing team', 100)
  await original.close()
  const legacy = new DatabaseSync(path)
  legacy.exec(`DROP TABLE managed_dependency_review_team; DROP TABLE managed_dependency_file_review;
    DROP TABLE managed_dependency_review; ALTER TABLE managed_team DROP COLUMN dependency_review;`)
  legacy.close()
  const upgraded = openSqliteManagedDb(path)
  t.after(() => upgraded.close())
  assert.equal((await upgraded.getTeam('team')).name, 'Existing team')
  assert.deepEqual(await upgraded.listDependencyReviewEnabledTeams(), [])
})

test('My reviews paginates tied timestamps without skipping or repeating sets', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession({ sessionCookieName: 'sid', sessionTtlMs: 3600000 }, db,
    { githubUserId: 100, login: 'author', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, 'triage')
  const id = hashToken(session.setCookie.split(';')[0].slice(4))
  for (let version = 0; version < 51; version++) {
    await db.changeDependencyReview({ ecosystem: 'npm', package: 'lib', version: `1.0.${version}`, integrity: `sha512-${version}`,
      basePackage: null, baseVersion: null, baseIntegrity: null }, id, { action: 'start', reviewId: null, revision: null }, 100)
  }
  const first = await db.listOwnDependencyReviews(session.userId, null)
  assert.equal(first.reviews.length, 50)
  assert.ok(first.next)
  const second = await db.listOwnDependencyReviews(session.userId, first.next)
  assert.equal(second.reviews.length, 1)
  assert.equal(second.next, null)
  assert.equal(new Set([...first.reviews, ...second.reviews].map(review => review.id)).size, 51)
})
