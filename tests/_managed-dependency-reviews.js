import assert from 'node:assert/strict'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'

export const reviewContext = { ecosystem: 'npm', package: '@scope/pkg', version: '2.0.0', integrity: 'sha512-target',
  basePackage: '@scope/pkg', baseVersion: '1.0.0', baseIntegrity: 'sha512-base' }
const config = { sessionCookieName: 'sid', sessionTtlMs: 3600000 }
export async function checkDependencyReviews(db) {
  const users = {}
  for (const [i, login] of ['alice', 'bob', 'outsider', 'admin'].entries()) {
    const session = await createSession(config, db, { githubUserId: i + 100, login, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, login === 'admin' ? 'admin' : 'triage')
    users[login] = { ...session, sid: hashToken(session.setCookie.split(';')[0].slice(4)) }
  }
  for (const id of ['one', 'two', 'disabled', 'not-member', 'hidden']) {
    await db.createTeam(id, id, Date.now())
    if (id !== 'not-member') await db.setTeamMember(id, users.alice.userId, { dependencies: false, security: false })
    if (id !== 'disabled') await db.setTeamDependencyReview(users.admin.sid, id, true)
  }
  await db.setTeamHidden('hidden', true, Date.now())
  await db.setTeamMember('one', users.bob.userId, { dependencies: false, security: false })
  assert.deepEqual((await db.listDependencyReviewTeams(users.alice.userId)).map(team => team.id), ['one', 'two'])
  const catalog = await db.getUserTeamFeedSnapshot(users.alice.sid, Date.now())
  assert.deepEqual(catalog.teams.filter(team => team.dependencyReview).map(team => team.id), ['one', 'two'])
  assert.deepEqual((await db.listTeamsForUser(users.admin.userId)).filter(team => team.dependencyReview), [], 'admins do not gain review access without membership')
  await assert.rejects(db.setTeamDependencyReview(users.alice.sid, 'one', false), /forbidden/u)
  const change = (action, who = 'alice', context = reviewContext) => db.changeDependencyReview(context, users[who].sid,
    action.action === 'publish' ? { files: ['index.js', 'other.js', 'README.md'], final: null, ...action } : action, Date.now())
  const save = (review, file, status, comment = '', entryId = null) => ({ action: 'save', reviewId: review?.id ?? null,
    revision: review?.revision ?? null, entryId, entry: { file, status, comment } })
  let review = await change(save(null, 'index.js', 'accept-with-nits', 'Rename this.'))
  assert.equal(review.user, users.alice.userId)
  assert.equal(review.publishedAt, null)
  assert.equal(Object.hasOwn(review, 'draft'), false)
  assert.deepEqual(await db.listDependencyReviews(reviewContext, users.bob.userId), [], 'unpublished reviews are private')
  assert.deepEqual(await db.listDependencyReviews({ ...reviewContext, integrity: 'different' }, users.alice.userId), [])
  const old = review
  review = await change(save(review, 'other.js', 'request-changes', 'Fix before updating.'))
  review = await change(save(review, 'README.md', null, 'A note without a verdict.'))
  await assert.rejects(change(save(old, 'index.js', 'reject')), /review-conflict/u, 'stale edits do not overwrite')
  await assert.rejects(change(save(review, null, 'reject'), 'bob'), /review-conflict/u, 'another author cannot edit')
  for (const teamIds of [[], ['disabled'], ['not-member'], ['hidden'], ['one', 'disabled']]) {
    await assert.rejects(change({ action: 'publish', reviewId: review.id, revision: review.revision, teamIds }), /bad-review-teams/u)
    assert.equal((await db.listDependencyReviews(reviewContext, users.alice.userId))[0].publishedAt, null)
  }
  const publication = { action: 'publish', reviewId: review.id, revision: review.revision, teamIds: ['one'] }
  await assert.rejects(change(publication), /bad-final-verdict/u, 'publication requires a separate final verdict')
  await assert.rejects(change({ ...publication, final: { status: 'accept', comment: '' } }), /bad-final-verdict/u, 'file verdicts limit the final verdict')
  review = await change({ ...publication, final: { status: 'request-changes', comment: 'Resolve the remaining concerns.' } })
  const published = review
  assert.ok(review.publishedAt)
  assert.equal(review.status, 'request-changes')
  assert.equal(review.coverage, 'partial')
  assert.equal(review.checkedFiles, 2)
  assert.equal(review.totalFiles, 3)
  assert.equal(review.comment, 'Resolve the remaining concerns.')
  assert.equal((await db.listDependencyReviews(reviewContext, users.bob.userId))[0].entries.length, 3)
  assert.deepEqual(await db.listDependencyReviews(reviewContext, users.outsider.userId), [])
  await assert.rejects(change(save(review, 'index.js', 'accept', 'Edit frozen', review.entries[0].id)), /review-conflict/u)
  review = await change({ action: 'publish', reviewId: review.id, revision: review.revision, teamIds: ['one', 'two'] })
  assert.deepEqual(review.teams.map(team => team.id), ['one', 'two'])
  assert.equal(review.publishedAt, published.publishedAt)
  assert.equal(review.time, published.time, 'adding recipients does not change the saved review time')
  assert.deepEqual(review.entries, published.entries, 'more teams leave every file review unchanged')
  assert.deepEqual([review.files, review.coverage, review.status, review.comment], [published.files, published.coverage, published.status, published.comment])
  review = await change({ action: 'revoke', reviewId: review.id, revision: review.revision })
  assert.ok(review.revokedAt)
  assert.deepEqual(review.teams.map(team => team.id), ['one', 'two'])
  assert.deepEqual(review.entries, published.entries)
  assert.ok((await db.listDependencyReviews(reviewContext, users.bob.userId))[0].revokedAt, 'recipients see the revoked snapshot')
  await assert.rejects(change(save(review, null, 'accept')), /review-conflict/u)
  await assert.rejects(change({ action: 'publish', reviewId: review.id, revision: review.revision, teamIds: ['one'] }), /review-conflict/u)
  let continued = await change({ action: 'continue', reviewId: review.id, revision: review.revision })
  assert.notEqual(continued.id, review.id)
  assert.equal(continued.publishedAt, null)
  assert.equal(continued.revokedAt, null)
  assert.equal(continued.status, null, 'continuation needs a new final verdict')
  assert.equal(continued.comment, published.comment, 'continuation retains the final note for editing')
  assert.deepEqual(continued.teams, [])
  assert.equal(continued.entries.length, review.entries.length)
  assert.ok(continued.entries.every(entry => !review.entries.some(original => original.id === entry.id)), 'continuation copies to separate rows')
  continued = await change(save(continued, continued.entries[0].file, 'accept', 'Addressed.', continued.entries[0].id))
  assert.deepEqual((await db.listDependencyReviews(reviewContext, users.bob.userId))[0].entries, published.entries)
  assert.equal((await db.listDependencyReviews(reviewContext, users.bob.userId)).length, 1, 'continuation stays private')
  await assert.rejects(change({ action: 'continue', reviewId: review.id, revision: review.revision }), /review-conflict/u, 'one working review per context')
  await db.setTeamDependencyReview(users.admin.sid, 'two', false)
  const updatedCatalog = await db.getUserTeamFeedSnapshot(users.alice.sid, Date.now())
  assert.notEqual(updatedCatalog.revision, catalog.revision, 'review settings invalidate the live team catalog')
  assert.deepEqual(updatedCatalog.teams.filter(team => team.dependencyReview).map(team => team.id), ['one'])
  await assert.rejects(change({ action: 'publish', reviewId: continued.id, revision: continued.revision, teamIds: ['two'] }), /bad-review-teams/u)
  assert.deepEqual((await db.listDependencyReviews(reviewContext, users.alice.userId)).find(row => row.id === review.id).teams.map(team => team.id), ['one', 'two'])
  await db.removeTeamMember('one', users.bob.userId)
  assert.deepEqual(await db.listDependencyReviews(reviewContext, users.bob.userId), [], 'removed members lose team review access')
  await db.setUserRole(users.alice.userId, 'view')
  await assert.rejects(change(save(continued, null, 'accept')), /forbidden/u)
  const own = await db.listOwnDependencyReviews(users.alice.userId, null)
  assert.deepEqual(new Set(own.reviews.map(item => item.id)), new Set([review.id, continued.id]))
  assert.deepEqual((await db.listOwnDependencyReviews(users.bob.userId, null)).reviews, [], 'My reviews never lists another author’s records')
  await db.setTeamMember('one', users.outsider.userId, { dependencies: false, security: false })
  await checkCoverage(db, users.outsider.sid)
}

async function checkCoverage(db, session) {
  const files = ['a.js', 'b.js', 'c.js', 'd.js']
  const change = action => db.changeDependencyReview(reviewContext, session, action, Date.now())
  let review = await change({ action: 'start', reviewId: null, revision: null })
  const unchecked = () => change({ action: 'publish', reviewId: review.id, revision: review.revision, teamIds: ['one'], files,
    final: { status: 'accept', comment: '' } })
  await assert.rejects(unchecked(), /no-reviewed-files/u)
  review = await change({ action: 'save', reviewId: review.id, revision: review.revision, entryId: null,
    entry: { file: 'a.js', status: null, comment: 'A note is not a verdict.' } })
  await assert.rejects(unchecked(), /no-reviewed-files/u)
  for (const [index, file] of files.entries()) {
    review = await change({ action: 'save', reviewId: review?.id ?? null, revision: review?.revision ?? null, entryId: null,
      entry: { file, status: index < 3 ? index === 1 ? 'accept-with-nits' : 'accept' : null, comment: index === 3 ? 'Still to review.' : '' } })
  }
  const publish = (final, paths = files) => ({ action: 'publish', reviewId: review.id, revision: review.revision, teamIds: ['one'], files: paths, final })
  await assert.rejects(change(publish({ status: 'accept', comment: '' })), /bad-final-verdict/u)
  review = await change(publish({ status: 'accept-with-nits', comment: 'Three files checked; one remains.' }))
  assert.equal(review.coverage, 'partial')
  assert.equal(review.checkedFiles, 3)
  assert.equal(review.totalFiles, 4)
  assert.equal(review.status, 'accept-with-nits')
  const partial = review
  review = await change({ action: 'continue', reviewId: review.id, revision: review.revision })
  const fourth = review.entries.find(entry => entry.file === 'd.js')
  review = await change({ action: 'save', reviewId: review.id, revision: review.revision, entryId: fourth.id,
    entry: { file: fourth.file, status: 'accept', comment: 'Checked now.' } })
  review = await change(publish({ status: 'accept-with-nits', comment: 'All files checked.' }))
  assert.equal(review.coverage, 'full')
  assert.equal(review.checkedFiles, 4)
  assert.equal(review.totalFiles, 4)
  review = await change(publish(null, []))
  assert.equal(review.coverage, 'full', 'additional team publication retains the frozen coverage')
  assert.deepEqual(review.files, files)
  assert.equal(partial.coverage, 'partial')
  assert.equal(partial.comment, 'Three files checked; one remains.')
}
