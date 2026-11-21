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
  const pkg = { name: 'pkg', version: '1.0.0' }
  assert.equal(await db.repoDependencyReviewState(1, users.alice.userId, [pkg]), null, 'not enabled')
  assert.equal(await db.setRepoDependencyReview(999, { enabled: true, required: 2, since: null }), null)
  assert.deepEqual(await db.setRepoDependencyReview(1, { enabled: false, required: 3, since }), { enabled: false, required: 3, since, lockfiles: { mode: 'exclude', paths: [] } })
  const lockfiles = { mode: 'exclude', paths: ['examples/'] }
  assert.deepEqual(await db.setRepoDependencyReview(1, { enabled: true, required: 2, lockfiles }), { enabled: true, required: 2, since, lockfiles }, 'its commit kept, none given')
  assert.deepEqual((await db.listRepoDependencyReviews()).get(1), { enabled: true, required: 2, since, lockfiles })
  assert.deepEqual(await db.setRepoDependencyReview(1, { enabled: true, required: 2, since, lockfiles: { mode: 'exclude', paths: [] } }), { enabled: true, required: 2, since, lockfiles: { mode: 'exclude', paths: [] } },
    'every lockfile, stored as none named')
  assert.deepEqual(await db.setRepoDependencyReview(1, { enabled: true, required: 2 }), { enabled: true, required: 2, since, lockfiles: { mode: 'exclude', paths: [] } }, 'its lockfiles kept, none given')
  await db.setRepoDependencyReview(1, { enabled: true, required: 2, lockfiles })

  const start = Date.now()
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
  await publish(db, users.alice, context('pkg', '2.0.0'), ['one'])
  const other = await publish(db, users.alice, context('other', '2.0.0'), ['one'])

  const state = await db.repoDependencyReviewState(1, users.alice.userId, [pkg, pkg, { name: 'other', version: '1.0.0' }])
  const told = review => [review.reviewer === users.alice.userId ? 'alice' : review.reviewer === users.bob.userId ? 'bob' : review.reviewer, review.baseVersion, review.status, review.full]
  assert.deepEqual([state.required, state.since, state.canReview, state.lockfiles], [2, since, true, lockfiles])
  assert.deepEqual(state.reviews.map(told).toSorted(), [['alice', null, 'accept', true], ['alice', '0.9.0', 'accept', false], ['bob', null, 'accept-with-nits', true],
    ['bob', '0.9.0', 'reject', true]], 'every published one, partial and rejecting too, but neither one to a team without the repository, a revoked one, a draft, another package\'s,'
    + ' nor another version\'s, though another package asked has that version')
  assert.deepEqual((await db.repoDependencyReview(1)), { enabled: true, required: 2, since, lockfiles }, 'one repository\'s setting')
  assert.equal(await db.repoDependencyReview(999), null)
  assert.ok(state.reviews.every(review => review.integrity === sri('pkg@1.0.0') && Number.isSafeInteger(review.time)), 'each when it was published')
  assert.deepEqual((await db.listRepoReviewTeams()).get(1), [{ id: 'one', name: 'one' }], 'the teams whose reviews count, neither one that reviews none nor a hidden one')
  for (const [who, canReview] of [['admin', true], ['bob', true], ['carol', false], ['manager', false]]) {
    assert.equal((await db.repoDependencyReviewState(1, users[who].userId, [])).canReview, canReview, `${who} ${canReview ? 'publishes' : 'publishes none'} to a team that counts`)
  }
  // Of the versions asked, those whose reviews counting for a repository were published, or revoked, since a time.
  const asked = ['pkg@1.0.0', 'pkg@2.0.0', 'other@2.0.0', 'elsewhere@1.0.0', 'unasked@9.0.0', 'pkg@0.8.0'].map(key => ({ name: key.split('@')[0], version: key.split('@')[1] }))
  const changed = async (repoIds, at, of = asked) => (await db.changedReviewVersions(repoIds, at, of)).map(({ name, version }) => `${name}@${version}`).toSorted()
  assert.deepEqual(await changed([1, 999], start), ['elsewhere@1.0.0', 'other@2.0.0', 'pkg@1.0.0', 'pkg@2.0.0'],
    'each once, of those published to a team counting for it: neither one to a team without it nor a draft')
  assert.deepEqual(await changed([1], start, asked.slice(1, 2)), ['pkg@2.0.0'], 'of those asked alone')
  assert.deepEqual([await changed([1], Date.now() + 60_000), await changed([999], start), await changed([], start), await changed([1], start, [])], [[], [], [], []],
    'none since, nor of another repository, nor where none is asked')
  const later = Date.now() + 120_000
  await db.changeDependencyReview(context('other', '2.0.0'), users.alice.sid, { action: 'revoke', reviewId: other.id, revision: other.revision }, later)
  assert.deepEqual(await changed([1], later), ['other@2.0.0'], 'one revoked since, published before')
  // One published before to a team without the repository, published since to one with it too.
  const shared = await publish(db, users.manager, context('pkg', '0.8.0'), ['two'])
  assert.deepEqual(await changed([1], start), ['elsewhere@1.0.0', 'other@2.0.0', 'pkg@1.0.0', 'pkg@2.0.0'], 'not yet, of a team without it')
  await db.setTeamMember('one', users.manager.userId, { dependencies: true, security: false })
  const sharedLater = later + 60_000
  await db.changeDependencyReview(context('pkg', '0.8.0'), users.manager.sid, { action: 'publish', reviewId: shared.id, revision: shared.revision, teamIds: ['one'],
    files: ['index.js', 'package.json'], nonTextFiles: [] }, sharedLater)
  assert.deepEqual(await changed([1], sharedLater), ['pkg@0.8.0'], 'published since to one more team, one counting for it')
  await db.removeTeamMember('one', users.manager.userId)

  await db.setTeamDependencyReview(users.admin.sid, 'one', false)
  assert.deepEqual(await changed([1], start), [], 'none where no team counting for it reviews dependencies')
  assert.equal(await db.repoDependencyReviewState(1, users.alice.userId, [pkg]), null, 'no team reviewing dependencies has it but a hidden one')
  assert.equal((await db.listRepoReviewTeams()).get(1), undefined)
}
