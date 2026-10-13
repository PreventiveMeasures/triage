import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { checkDependencyReviews, reviewContext } from './_managed-dependency-reviews.js'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'

test('dependency review lifecycle, ownership, team access and frozen snapshots (SQLite)', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkDependencyReviews(db)
})

test('legacy notes become one editable note when continuing, without rewriting frozen rows', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dependency-review-notes-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'db.sqlite')
  const original = openSqliteManagedDb(path)
  const session = await createSession({ sessionCookieName: 'sid', sessionTtlMs: 3600000 }, original,
    { githubUserId: 100, login: 'author', name: null, avatarUrl: null }, Date.now())
  await original.setUserRole(session.userId, 'admin')
  const sid = hashToken(session.setCookie.split(';')[0].slice(4))
  await original.createTeam('team', 'Team', 100)
  await original.setTeamMember('team', session.userId, { dependencies: false, security: false })
  await original.setTeamDependencyReview(sid, 'team', true)
  let review = await original.changeDependencyReview(reviewContext, sid, { action: 'save', reviewId: null, revision: null, entryId: null,
    entry: { file: 'index.js', status: 'reject', comment: 'First concern.' } }, 100)
  review = await original.changeDependencyReview(reviewContext, sid, { action: 'publish', reviewId: review.id, revision: review.revision,
    teamIds: ['team'], files: ['index.js'], nonTextFiles: [], final: { status: 'reject', comment: '' } }, 300)
  await original.close()
  const raw = new DatabaseSync(path)
  t.after(() => raw.close())
  raw.prepare('INSERT INTO managed_dependency_file_review (id, review_id, file, status, comment, time) VALUES (?, ?, ?, ?, ?, ?)')
    .run('legacy-note', review.id, 'index.js', 'accept-with-nits', 'Second concern.', 200)
  const db = openSqliteManagedDb(path)
  t.after(() => db.close())
  const frozen = (await db.listDependencyReviews(reviewContext, session.userId))[0]
  assert.equal(frozen.entries.length, 1)
  assert.equal(frozen.entries[0].comment, 'First concern.\n\nSecond concern.')
  assert.equal(frozen.entries[0].status, 'reject')
  let continued = await db.changeDependencyReview(reviewContext, sid, { action: 'continue', reviewId: review.id, revision: review.revision }, 400)
  assert.equal(continued.entries.length, 1)
  continued = await db.changeDependencyReview(reviewContext, sid, { action: 'save', reviewId: continued.id, revision: continued.revision,
    entryId: null, entry: { file: 'index.js', status: 'accept', comment: 'Both resolved.' } }, 500)
  assert.equal(continued.entries.length, 1)
  assert.equal(continued.verdictLimit, 'accept')
  assert.equal(continued.entries[0].comment, 'Both resolved.')
  assert.equal(raw.prepare('SELECT count(*) AS n FROM managed_dependency_file_review WHERE review_id = ?').get(review.id).n, 2)
  assert.deepEqual((await db.listDependencyReviews(reviewContext, session.userId)).find(row => row.id === review.id).entries, frozen.entries)
  await db.discardDependencyReview(sid, continued.id, continued.revision)
  assert.equal(raw.prepare('SELECT count(*) AS n FROM managed_dependency_file_review WHERE review_id = ?').get(continued.id).n, 0)
  assert.equal(raw.prepare('SELECT count(*) AS n FROM managed_dependency_file_review WHERE review_id = ?').get(review.id).n, 2)
  raw.prepare('UPDATE managed_dependency_review SET files = ? WHERE id = ?').run(JSON.stringify(['index.js']), review.id)
  const legacy = (await db.listOwnDependencyReviews(session.userId, null)).reviews.find(row => row.id === review.id)
  assert.equal(legacy.coverage, 'partial', 'a historical snapshot without file type evidence cannot certify a full review')
  assert.equal(legacy.nonTextFiles, null)
  assert.deepEqual(legacy.entries, frozen.entries, 'classification does not rewrite frozen verdicts or notes')
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
