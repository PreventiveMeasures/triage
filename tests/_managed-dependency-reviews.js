import assert from 'node:assert/strict'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'

export const reviewContext = { ecosystem: 'npm', package: '@scope/pkg', version: '2.0.0', integrity: 'sha512-target',
  basePackage: '@scope/pkg', baseVersion: '1.0.0', baseIntegrity: 'sha512-base' }
const config = { sessionCookieName: 'sid', sessionTtlMs: 3600000 }
// Who reviews dependencies in a team: a member who triages and may see its
// dependencies, a member who manages it, or an admin, of any team; one that
// reviews dependencies to publish to, not hidden.
export async function checkDependencyReviews(db) {
  const users = {}
  const roles = { admin: 'admin', manager: 'manage', viewer: 'view' }
  for (const [i, login] of ['alice', 'bob', 'outsider', 'admin', 'carol', 'manager', 'viewer'].entries()) {
    const session = await createSession(config, db, { githubUserId: i + 100, login, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, roles[login] ?? 'triage')
    users[login] = { ...session, sid: hashToken(session.setCookie.split(';')[0].slice(4)) }
  }
  const dependencies = { dependencies: true, security: false }
  for (const id of ['one', 'two', 'disabled', 'not-member', 'hidden']) {
    await db.createTeam(id, id, Date.now())
    if (id !== 'not-member') await db.setTeamMember(id, users.alice.userId, dependencies)
    if (id !== 'disabled') await db.setTeamDependencyReview(users.admin.sid, id, true)
  }
  await db.setTeamHidden('hidden', true, Date.now())
  await db.setTeamMember('one', users.bob.userId, dependencies)
  await db.setTeamMember('one', users.carol.userId, { dependencies: false, security: true })
  await db.setTeamMember('one', users.manager.userId, { dependencies: false, security: false })
  await db.setTeamMember('one', users.viewer.userId, dependencies)
  const reviewTeams = async who => (await db.listDependencyReviewTeams(users[who].userId)).map(team => team.id)
  assert.deepEqual(await reviewTeams('alice'), ['one', 'two'])
  assert.deepEqual(await reviewTeams('carol'), [], 'a member who triages without Dependencies reviews none')
  assert.deepEqual(await reviewTeams('viewer'), [], 'one who views reviews none, with Dependencies')
  assert.deepEqual(await reviewTeams('manager'), ['one'], 'a member who manages reviews in their team without Dependencies')
  assert.deepEqual(await reviewTeams('admin'), ['not-member', 'one', 'two'], 'an admin reviews in every team that reviews dependencies, a member or not, but a hidden one')
  const catalog = await db.getUserTeamFeedSnapshot(users.alice.sid, Date.now())
  assert.deepEqual(catalog.teams.filter(team => team.dependencyReview).map(team => team.id), ['one', 'two'])
  for (const [who, teams] of [['carol', []], ['viewer', []], ['manager', ['one']]]) {
    assert.deepEqual((await db.listTeamsForUser(users[who].userId)).filter(team => team.dependencyReview).map(team => team.id), teams, `${who}'s catalog marks the teams they review in`)
  }
  await assert.rejects(db.changeDependencyReview(reviewContext, users.carol.sid, { action: 'start', reviewId: null, revision: null }, Date.now()), /review-access-required/u,
    'a draft is begun by one who publishes to some team')
  await assert.rejects(db.setTeamDependencyReview(users.alice.sid, 'one', false), /forbidden/u)
  const change = (action, who = 'alice', context = reviewContext) => db.changeDependencyReview(context, users[who].sid,
    action.action === 'publish' ? { files: ['index.js', 'other.js', 'README.md', 'package.json'], nonTextFiles: [], final: null, ...action } : action, Date.now())
  const save = (review, file, status, comment = '', entryId = null) => ({ action: 'save', reviewId: review?.id ?? null,
    revision: review?.revision ?? null, entryId, entry: { file, status, comment } })
  let review = await change(save(null, 'index.js', 'accept-with-nits', 'Rename this.'))
  assert.equal(review.user, users.alice.userId)
  assert.equal(review.publishedAt, null)
  assert.equal(Object.hasOwn(review, 'draft'), false)
  assert.deepEqual(await db.listDependencyReviews(reviewContext, users.bob.userId), [], 'unpublished reviews are private')
  assert.deepEqual(await db.listDependencyReviews({ ...reviewContext, integrity: 'different' }, users.alice.userId), [])
  const fileId = review.entries[0].id
  review = await change(save(review, 'index.js', 'reject', 'Replace this note.'))
  review = await change(save(review, 'index.js', 'accept-with-nits', 'Rename this.'))
  assert.equal(review.entries.length, 1, 'saving by file replaces its note and verdict instead of adding a row')
  assert.equal(review.entries[0].id, fileId)
  assert.equal(review.entries[0].comment, 'Rename this.')
  assert.equal(review.verdictLimit, 'accept-with-nits', 'a replaced verdict does not constrain the final verdict')
  const old = review
  review = await change(save(review, 'other.js', 'request-changes', 'Fix before updating.'))
  await assert.rejects(change(save(review, 'README.md', null, 'A note without a verdict.')), /bad-review/u)
  await assert.rejects(change(save(review, 'other.js', 'accept', '', fileId)), /review-conflict/u, 'entry IDs cannot change another file')
  await assert.rejects(change(save(old, 'index.js', 'reject')), /review-conflict/u, 'stale edits do not overwrite')
  await assert.rejects(change(save(review, null, 'reject'), 'bob'), /review-conflict/u, 'another author cannot edit')
  for (const teamIds of [[], ['disabled'], ['not-member'], ['hidden'], ['one', 'disabled']]) {
    await assert.rejects(change({ action: 'publish', reviewId: review.id, revision: review.revision, teamIds }), /bad-review-teams/u)
    assert.equal((await db.listDependencyReviews(reviewContext, users.alice.userId))[0].publishedAt, null)
  }
  review = await change(save(review, 'package.json', 'accept'))
  const publication = { action: 'publish', reviewId: review.id, revision: review.revision, teamIds: ['one'] }
  await assert.rejects(change(publication), /bad-final-verdict/u, 'publication requires a separate final verdict')
  await assert.rejects(change({ ...publication, final: { status: 'accept', comment: '' } }), /bad-final-verdict/u, 'file verdicts limit the final verdict')
  review = await change({ ...publication, final: { status: 'request-changes', comment: 'Resolve the remaining concerns.' } })
  const published = review
  assert.ok(review.publishedAt)
  assert.equal(review.status, 'request-changes')
  assert.equal(review.coverage, 'partial')
  assert.equal(review.checkedFiles, 3)
  assert.equal(review.totalFiles, 4)
  assert.equal(review.comment, 'Resolve the remaining concerns.')
  assert.equal((await db.listDependencyReviews(reviewContext, users.bob.userId))[0].entries.length, 3)
  const emptyBase = { ...reviewContext, basePackage: null, baseVersion: null, baseIntegrity: null }
  assert.deepEqual(await db.listDependencyReviews(emptyBase, users.bob.userId), [])
  assert.deepEqual((await db.listDependencyReviews(emptyBase, users.bob.userId, true)).map(row => row.id), [review.id], 'version lists include team publications against other bases')
  assert.deepEqual(await db.listDependencyReviews(emptyBase, users.outsider.userId, true), [])
  assert.deepEqual(await db.listDependencyReviews(reviewContext, users.outsider.userId), [])
  for (const who of ['carol', 'viewer']) assert.deepEqual(await db.listDependencyReviews(reviewContext, users[who].userId), [], `${who}, a member who reviews none, reads none`)
  for (const who of ['manager', 'admin']) {
    const [read] = await db.listDependencyReviews(reviewContext, users[who].userId)
    assert.equal(read?.id, review.id, `${who} reads the team's reviews`)
    assert.deepEqual(read.teams.map(team => team.id), ['one'])
  }
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
  for (const who of ['bob', 'admin']) {
    await assert.rejects(db.discardDependencyReview(users[who].sid, continued.id, continued.revision), /review-conflict/u, 'only the author can discard')
  }
  await assert.rejects(db.discardDependencyReview(users.alice.sid, continued.id, continued.revision - 1), /review-conflict/u, 'stale confirmation cannot discard newer edits')
  await assert.rejects(db.discardDependencyReview(users.alice.sid, review.id, review.revision), /review-conflict/u, 'revoked sets stay frozen')
  await db.setUserRole(users.alice.userId, 'view')
  await assert.rejects(change(save(continued, null, 'accept')), /forbidden/u)
  await assert.rejects(db.discardDependencyReview(users.alice.sid, continued.id, continued.revision), /forbidden/u)
  const own = await db.listOwnDependencyReviews(users.alice.userId, null)
  assert.deepEqual(new Set(own.reviews.map(item => item.id)), new Set([review.id, continued.id]))
  assert.deepEqual((await db.listOwnDependencyReviews(users.bob.userId, null)).reviews, [], 'My reviews never lists another author’s records')
  await db.setUserRole(users.alice.userId, 'triage')
  await db.discardDependencyReview(users.alice.sid, continued.id, continued.revision)
  assert.deepEqual((await db.listOwnDependencyReviews(users.alice.userId, null)).reviews.map(item => item.id), [review.id])
  // Those published to a team, revoked ones too, of one who reads them there.
  const team = await db.listTeamDependencyReviews('one', users.alice.userId, null)
  assert.deepEqual([team.reviews.map(item => [item.id, item.userLogin, item.revokedAt !== null]), team.next], [[[review.id, 'alice', true]], null])
  assert.deepEqual((await db.listTeamDependencyReviews('one', users.admin.userId, null)).reviews.map(item => item.id), [review.id], 'an admin reads every team’s')
  for (const who of ['bob', 'carol', 'viewer', 'outsider']) assert.equal(await db.listTeamDependencyReviews('one', users[who].userId, null), null, `${who} reads none there`)
  assert.deepEqual((await db.listTeamDependencyReviews('disabled', users.alice.userId, null)).reviews, [], 'none published there')
  assert.equal(await db.listTeamDependencyReviews('hidden', users.alice.userId, null), null, 'a hidden team’s none')
  assert.deepEqual(await Promise.all([['one', 'alice'], ['one', 'admin'], ['one', 'bob'], ['hidden', 'alice']]
    .map(async ([teamId, who]) => (await db.getNpmReviewReader(users[who].sid, null, Date.now(), teamId)).readsTeam)), [true, true, false, false], 'who reads them, as asked again')
  assert.equal((await db.getLatestOwnDependencyReview(users.alice.userId, reviewContext)).id, review.id)
  assert.equal(await db.getLatestOwnDependencyReview(users.bob.userId, reviewContext), null)
  await assert.rejects(change(save(continued, 'index.js', 'accept')), /review-conflict/u, 'an autosave cannot resurrect a discarded review')
  await assert.rejects(db.discardDependencyReview(users.alice.sid, continued.id, continued.revision), /review-conflict/u)
  const restarted = await change({ action: 'start', reviewId: null, revision: null })
  assert.deepEqual(restarted.entries, [])
  await db.discardDependencyReview(users.alice.sid, restarted.id, restarted.revision)
  await db.setTeamMember('one', users.outsider.userId, dependencies)
  await checkCoverage(db, users.outsider.sid)
}

async function checkCoverage(db, session) {
  const files = ['package.json', 'b.js', 'c.js', 'd.js']
  const change = action => db.changeDependencyReview(reviewContext, session, action, Date.now())
  let review = await change({ action: 'start', reviewId: null, revision: null })
  const unchecked = () => change({ action: 'publish', reviewId: review.id, revision: review.revision, teamIds: ['one'], files, nonTextFiles: [],
    final: { status: 'accept', comment: '' } })
  await assert.rejects(unchecked(), /no-reviewed-files/u)
  await assert.rejects(change({ action: 'save', reviewId: review.id, revision: review.revision, entryId: null,
    entry: { file: 'package.json', status: null, comment: 'A note is not a verdict.' } }), /bad-review/u)
  await assert.rejects(unchecked(), /no-reviewed-files/u)
  review = await change({ action: 'save', reviewId: review.id, revision: review.revision, entryId: null,
    entry: { file: 'b.js', status: 'accept', comment: '' } })
  await assert.rejects(unchecked(), /package-json-not-reviewed/u, 'a package.json note does not allow partial publication')
  for (const [index, file] of files.slice(0, 3).entries()) {
    review = await change({ action: 'save', reviewId: review?.id ?? null, revision: review?.revision ?? null, entryId: null,
      entry: { file, status: index === 1 ? 'accept-with-nits' : 'accept', comment: '' } })
  }
  assert.equal(review.entries.length, 3, 'unchecked files have no rows')
  const publish = (final, paths = files) => ({ action: 'publish', reviewId: review.id, revision: review.revision, teamIds: ['one'], files: paths, nonTextFiles: [], final })
  await assert.rejects(change(publish({ status: 'accept', comment: '' })), /bad-final-verdict/u)
  const manifest = review.entries.find(entry => entry.file === 'package.json')
  review = await change({ action: 'save', reviewId: review.id, revision: review.revision, entryId: manifest.id,
    entry: { file: 'package.json', status: null, comment: '' } })
  await assert.rejects(change(publish({ status: 'accept-with-nits', comment: '' })), /package-json-not-reviewed/u, 'clearing the verdict blocks publication again')
  assert.equal(review.entries.some(entry => entry.file === 'package.json'), false)
  review = await change({ action: 'save', reviewId: review.id, revision: review.revision, entryId: null,
    entry: { file: 'package.json', status: 'accept', comment: '' } })
  review = await change(publish({ status: 'accept-with-nits', comment: 'Three files checked; one remains.' }))
  assert.equal(review.coverage, 'partial')
  assert.equal(review.checkedFiles, 3)
  assert.equal(review.totalFiles, 4)
  assert.equal(review.status, 'accept-with-nits')
  const partial = review
  review = await change({ action: 'continue', reviewId: review.id, revision: review.revision })
  review = await change({ action: 'save', reviewId: review.id, revision: review.revision, entryId: null,
    entry: { file: 'd.js', status: 'accept', comment: 'Checked now.' } })
  review = await change(publish({ status: 'accept-with-nits', comment: 'All files checked.' }))
  await assert.rejects(db.discardDependencyReview(session, review.id, review.revision), /review-conflict/u, 'published sets cannot be discarded')
  assert.equal(review.coverage, 'full')
  assert.equal(review.checkedFiles, 4)
  assert.equal(review.totalFiles, 4)
  review = await change(publish(null, []))
  assert.equal(review.coverage, 'full', 'additional team publication retains the frozen coverage')
  assert.deepEqual(review.files, files.toSorted())
  assert.equal(partial.coverage, 'partial')
  assert.equal(partial.comment, 'Three files checked; one remains.')
}

// SQLite rows have no prototype; rows read out of JSON have the plain one.
const plain = value => structuredClone(value)

// A team's reviews read in one statement (listTeamDependencyReviews), each
// as the reads that statement folds read it (listDependencyReviews, of any
// base): its entries, and the teams its reader reads it in, all of theirs
// for its author; those published there alone, the latest first, a page on
// from where one ended; none for one who doesn't read them there. And who
// reads them, asked again in one statement (getNpmReviewReader), as their
// session, their npm scopes and the team's list tell it, a view of another's
// as an admin's.
export async function checkTeamReviewList(db) {
  const users = {}
  for (const [i, [login, role]] of [['admin', 'admin'], ['alice', 'triage'], ['bob', 'triage'], ['outsider', 'manage']].entries()) {
    const session = await createSession(config, db, { githubUserId: i + 200, login, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    users[login] = { ...session, sid: hashToken(session.setCookie.split(';')[0].slice(4)) }
  }
  const dependencies = { dependencies: true, security: false }
  for (const id of ['team-a', 'team-b', 'team-c']) {
    await db.createTeam(id, id, Date.now())
    await db.setTeamDependencyReview(users.admin.sid, id, true)
    await db.setTeamMember(id, users.alice.userId, dependencies)
  }
  await db.setTeamMember('team-a', users.bob.userId, dependencies)
  await db.setTeamNpmScopes(users.admin.sid, 'team-a', ['@corp', '@acme'])
  await db.setTeamNpmScopes(users.admin.sid, 'team-c', ['@hidden'])
  const publish = async (who, version, teams, now) => {
    const context = { ...reviewContext, version, integrity: `sha512-${version}` }
    let review = await db.changeDependencyReview(context, users[who].sid, { action: 'start', reviewId: null, revision: null }, now)
    for (const [at, file] of ['package.json', 'index.js', 'lib/a.js'].entries()) {
      review = await db.changeDependencyReview(context, users[who].sid, { action: 'save', reviewId: review.id, revision: review.revision, entryId: null,
        entry: { file, status: at === 1 ? 'accept-with-nits' : 'accept', comment: `${file} by ${who}` } }, now + at)
    }
    return db.changeDependencyReview(context, users[who].sid, { action: 'publish', reviewId: review.id, revision: review.revision, teamIds: teams,
      files: ['package.json', 'index.js', 'lib/a.js'], nonTextFiles: [], final: { status: 'accept-with-nits', comment: 'fine' } }, now + 10)
  }
  const reviews = [await publish('alice', '3.0.0', ['team-a'], 100), await publish('alice', '3.0.1', ['team-a', 'team-b'], 200),
    await publish('alice', '3.0.2', ['team-a', 'team-b', 'team-c'], 300), await publish('bob', '3.0.3', ['team-a'], 300)]
  await db.changeDependencyReview({ ...reviewContext, version: '3.0.1', integrity: 'sha512-3.0.1' }, users.alice.sid,
    { action: 'revoke', reviewId: reviews[1].id, revision: reviews[1].revision }, 400)
  await db.setTeamHidden('team-c', true, Date.now())
  // Each as listDependencyReviews reads it for `who`.
  const asRead = (list, who) => Promise.all(list.map(async review => (await db.listDependencyReviews(review, users[who].userId, true)).find(one => one.id === review.id)))
  for (const [team, who, ids] of [['team-a', 'alice', [3, 2, 1, 0]], ['team-a', 'bob', [3, 2, 1, 0]], ['team-a', 'admin', [3, 2, 1, 0]], ['team-b', 'alice', [2, 1]],
    ['team-b', 'admin', [2, 1]], ['team-b', 'bob', null], ['team-a', 'outsider', null], ['team-c', 'alice', null], ['team-c', 'admin', null], ['missing', 'admin', null]]) {
    const listed = await db.listTeamDependencyReviews(team, users[who].userId, null)
    const sorted = ids && [...ids].toSorted((a, b) => reviews[b].publishedAt - reviews[a].publishedAt || (reviews[b].id < reviews[a].id ? -1 : 1))
    assert.deepEqual(listed && listed.reviews.map(review => reviews.findIndex(one => one.id === review.id)), sorted, `${team} for ${who}`)
    if (!listed) continue
    assert.deepEqual(plain(listed), plain({ reviews: await asRead(listed.reviews, who), next: null }), `${team} for ${who}, as each is read`)
    const [, second] = listed.reviews
    if (second) {
      assert.deepEqual(plain(await db.listTeamDependencyReviews(team, users[who].userId, { time: second.publishedAt, id: second.id })),
        plain({ reviews: listed.reviews.slice(2), next: null }), `${team} for ${who}, on from the second`)
    }
  }
  const third = (await db.listTeamDependencyReviews('team-a', users.bob.userId, null)).reviews.find(review => review.id === reviews[2].id)
  assert.deepEqual([third.teams.map(team => team.id), third.entries.length, third.revokedAt], [['team-a'], 3, null], 'a team bob reads none of told him')
  assert.deepEqual((await db.listTeamDependencyReviews('team-a', users.alice.userId, null)).reviews.find(review => review.id === reviews[2].id).teams.map(team => team.id),
    ['team-a', 'team-b', 'team-c'], 'its author told all of theirs')

  // Its reader asked again, as the session, the npm scopes and the team's list tell it.
  const now = Date.now()
  for (const who of ['alice', 'bob', 'admin', 'outsider']) {
    for (const team of ['team-a', 'team-b', 'team-c']) {
      const { user } = await db.getSessionWithUser(users[who].sid, now)
      assert.deepEqual(plain(await db.getNpmReviewReader(users[who].sid, null, now, team)), { id: user.id, role: user.role, scopes: await db.listUserNpmScopes(user.id),
        readsTeam: await db.listTeamDependencyReviews(team, user.id, null) !== null }, `${who} in ${team}`)
    }
  }
  assert.deepEqual((await db.getNpmReviewReader(users.alice.sid, null, now, 'team-a')).scopes, ['@acme', '@corp'], 'those of hidden teams none')
  assert.equal(await db.getNpmReviewReader('nobody', null, now, 'team-a'), null)
  assert.equal(await db.getNpmReviewReader(users.alice.sid, null, now + 3_600_001, 'team-a'), null, 'an expired session none')
  assert.equal(await db.createViewSession({ id: 'view-alice', viewerSessionId: users.admin.sid, userId: users.alice.userId, csrfToken: 'view-csrf' }, now), true)
  assert.deepEqual(plain(await db.getNpmReviewReader('view-alice', users.admin.sid, now, 'team-b')), { id: users.alice.userId, role: 'triage',
    scopes: ['@acme', '@corp'], readsTeam: true }, 'an admin viewing as alice reads as alice')
  assert.equal((await db.getViewSessionWithUser('view-alice', users.admin.sid, now)).user.id, users.alice.userId)
  assert.equal(await db.getNpmReviewReader('view-alice', null, now, 'team-b'), null, 'a view none but of the session it is a view of')
  assert.equal(await db.getNpmReviewReader('view-alice', users.bob.sid, now, 'team-b'), null)
  await db.setUserRole(users.admin.userId, 'manage')
  assert.equal(await db.getNpmReviewReader('view-alice', users.admin.sid, now, 'team-b'), null, 'nor of one no longer an admin')
  assert.equal(await db.getViewSessionWithUser('view-alice', users.admin.sid, now), null)
}

// The shasums of the tarballs a review reads, as its writer tells them
// (changeDependencyReview `tarballs`): kept as a draft is begun, saved and
// first published, and as one is continued; left as they were as it is
// published to more teams, or revoked; none where none is told; each as
// every read lists it.
export async function checkReviewedTarballs(db) {
  const users = {}
  for (const [i, [login, role]] of [['admin', 'admin'], ['author', 'triage']].entries()) {
    const session = await createSession(config, db, { githubUserId: i + 300, login, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    users[login] = { ...session, sid: hashToken(session.setCookie.split(';')[0].slice(4)) }
  }
  for (const id of ['first', 'second']) {
    await db.createTeam(id, id, Date.now())
    await db.setTeamMember(id, users.author.userId, { dependencies: true, security: false })
    await db.setTeamDependencyReview(users.admin.sid, id, true)
  }
  const later = { shasum: 'c'.repeat(40), baseShasum: 'd'.repeat(40) }, told = { shasum: 'a'.repeat(40), baseShasum: 'b'.repeat(40) }
  const shasums = review => ({ shasum: review.shasum, baseShasum: review.baseShasum })
  const change = (action, now, tarballs, at = reviewContext) => db.changeDependencyReview(at, users.author.sid, action, now, tarballs)
  let review = await change({ action: 'start', reviewId: null, revision: null }, 100, later)
  assert.deepEqual(shasums(review), later)
  review = await change({ action: 'save', reviewId: review.id, revision: review.revision, entryId: null, entry: { file: 'index.js', status: 'accept', comment: '' } }, 200, told)
  assert.deepEqual(shasums(review), told, 'a draft keeps those it was last saved with')
  const publish = (teamIds, final, tarballs) => change({ action: 'publish', reviewId: review.id, revision: review.revision, teamIds, files: ['index.js'], nonTextFiles: [], final },
    300, tarballs)
  review = await publish(['first'], { status: 'accept', comment: '' }, told)
  assert.deepEqual(shasums(review), told, 'and those it was published with')
  review = await publish(['second'], null, later)
  assert.deepEqual(shasums(review), told, 'published to more teams, it keeps its own')
  for (const [read, listed] of [['team', (await db.listTeamDependencyReviews('second', users.author.userId, null)).reviews],
    ['own', (await db.listOwnDependencyReviews(users.author.userId, null)).reviews], ['by id', await db.listOwnDependencyReviewsById(users.author.userId, [review.id])],
    ['of its version', await db.listDependencyReviews(reviewContext, users.author.userId)]]) {
    assert.deepEqual(listed.map(shasums), [told], read)
  }
  const continued = await change({ action: 'continue', reviewId: review.id, revision: review.revision }, 400, later)
  assert.deepEqual(shasums(continued), later, 'continued, with those it was continued with')
  assert.deepEqual(shasums(await change({ action: 'revoke', reviewId: review.id, revision: review.revision }, 500)), told, 'revoked, it keeps them')
  const whole = { ...reviewContext, basePackage: null, baseVersion: null, baseIntegrity: null }
  assert.deepEqual(shasums(await change({ action: 'start', reviewId: null, revision: null }, 600, { shasum: told.shasum, baseShasum: null }, whole)),
    { shasum: told.shasum, baseShasum: null }, 'of no base where it has none')
  assert.deepEqual(shasums(await change({ action: 'start', reviewId: null, revision: null }, 700, undefined, { ...whole, version: '3.0.0' })),
    { shasum: null, baseShasum: null }, 'none where none is told')
}
