// A repository's dependency review as the database keeps it
// (server-managed/repository-dependency-reviews.ts), on SQLite and Postgres
// alike: its setting, whether it is in effect, who publishes reviews that
// count, and which of the reviews published pass a version.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { hashToken } from '../server-managed/crypto.ts'
import { createSession } from '../server-managed/session.ts'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 3_600_000 }
export const reviewedRepo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const since = 'd'.repeat(40)
export const sri = text => `sha512-${createHash('sha512').update(text).digest('base64')}`

// Users and teams for a repository's reviews: `alice` and `bob` review in
// team `one`, which has the repository; `manager` manages team `two`, which
// doesn't; `carol` triages in none; and `admin`.
export async function people(db) {
  const users = {}
  for (const [n, [login, role]] of [['admin', 'admin'], ['alice', 'triage'], ['bob', 'triage'], ['carol', 'triage'], ['manager', 'manage']].entries()) {
    const session = await createSession(config, db, { githubUserId: n + 1, login, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    await db.setUserTokens(session.userId, { accessToken: 'token', refreshToken: null, expiresAt: null })
    users[login] = { ...session, sid: hashToken(session.setCookie.split(';')[0].slice(4)) }
  }
  await db.selectRepo(reviewedRepo, Date.now())
  for (const id of ['one', 'two', 'off', 'hidden']) {
    await db.createTeam(id, id, Date.now())
    if (id !== 'two') await db.setTeamRepo(id, reviewedRepo.repoId, null)
    if (id !== 'off') await db.setTeamDependencyReview(users.admin.sid, id, true)
  }
  await db.setTeamHidden('hidden', true, Date.now())
  for (const who of ['alice', 'bob']) await db.setTeamMember('one', users[who].userId, { dependencies: true, security: false })
  await db.setTeamMember('two', users.manager.userId, { dependencies: false, security: false })
  return users
}

// Publishes `who`'s review of `context` to `teams`: every one of `files`
// checked, else those of `checked`, with `status`.
export async function publish(db, user, context, teams, { files = ['index.js', 'package.json'], checked = files, status = 'accept' } = {}) {
  let review = null
  for (const file of checked) {
    review = await db.changeDependencyReview(context, user.sid, { action: 'save', reviewId: review?.id ?? null, revision: review?.revision ?? null, entryId: null,
      entry: { file, status, comment: '' } }, Date.now())
  }
  return db.changeDependencyReview(context, user.sid, { action: 'publish', reviewId: review.id, revision: review.revision, teamIds: teams, files, nonTextFiles: [],
    final: { status, comment: '' } }, Date.now())
}
export const context = (name, version, base = null) => ({ ecosystem: 'npm', package: name, version, integrity: sri(`${name}@${version}`),
  basePackage: base ? name : null, baseVersion: base, baseIntegrity: base ? sri(`${name}@${base}`) : null })

export async function checkRepositoryDependencyReviews(db) {
  const users = await people(db)
  assert.equal(await db.repoDependencyReviewState(1, users.alice.userId, ['pkg']), null, 'not enabled')
  assert.equal(await db.setRepoDependencyReview(999, { enabled: true, required: 2, since: null }), false)
  assert.equal(await db.setRepoDependencyReview(1, { enabled: true, required: 2, since }), true)
  assert.deepEqual((await db.listRepoDependencyReviews()).get(1), { enabled: true, required: 2, since })

  await publish(db, users.alice, context('pkg', '1.0.0'), ['one'])
  await publish(db, users.bob, context('pkg', '1.0.0'), ['one'], { status: 'accept-with-nits' })
  await publish(db, users.alice, context('pkg', '1.0.0', '0.9.0'), ['one'], { files: ['index.js', 'package.json'], checked: ['package.json'] })
  await publish(db, users.bob, context('pkg', '1.0.0', '0.9.0'), ['one'], { status: 'reject' })
  await publish(db, users.manager, context('pkg', '1.0.0', '0.8.0'), ['two'])
  const revoked = await publish(db, users.alice, context('pkg', '1.0.0', '0.7.0'), ['one'])
  await db.changeDependencyReview(context('pkg', '1.0.0', '0.7.0'), users.alice.sid, { action: 'revoke', reviewId: revoked.id, revision: revoked.revision }, Date.now())
  await db.changeDependencyReview(context('pkg', '1.0.0', '0.6.0'), users.bob.sid, { action: 'save', reviewId: null, revision: null, entryId: null,
    entry: { file: 'index.js', status: 'accept', comment: '' } }, Date.now())
  await publish(db, users.alice, context('elsewhere', '1.0.0'), ['one'])

  const state = await db.repoDependencyReviewState(1, users.alice.userId, ['pkg', 'pkg'])
  assert.deepEqual({ ...state, reviews: state.reviews.toSorted((a, b) => a.reviewer < b.reviewer ? -1 : 1) }, { required: 2, since, canReview: true, reviews: [
    { package: 'pkg', version: '1.0.0', integrity: sri('pkg@1.0.0'), basePackage: null, baseVersion: null, reviewer: users.alice.userId },
    { package: 'pkg', version: '1.0.0', integrity: sri('pkg@1.0.0'), basePackage: null, baseVersion: null, reviewer: users.bob.userId },
  ].toSorted((a, b) => a.reviewer < b.reviewer ? -1 : 1) }, 'neither a partial review, a rejecting one, one to a team without the repository, a revoked one, a draft, nor another package\'s')
  for (const [who, canReview] of [['admin', true], ['bob', true], ['carol', false], ['manager', false]]) {
    assert.equal((await db.repoDependencyReviewState(1, users[who].userId, [])).canReview, canReview, `${who} ${canReview ? 'publishes' : 'publishes none'} to a team that counts`)
  }
  await db.setTeamDependencyReview(users.admin.sid, 'one', false)
  assert.equal(await db.repoDependencyReviewState(1, users.alice.userId, ['pkg']), null, 'no team reviewing dependencies has it but a hidden one')
}
