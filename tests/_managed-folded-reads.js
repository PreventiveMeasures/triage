// Reads folded into one statement answer as the reads they fold did, on
// either database: getAnnotations as listTriage, listComments and
// listManagedIssues; getReportView as getReport and userCanReadReport;
// getUserTokens as the tokens set; sessionWithUser as getSessionWithUser,
// recording presence; getUserTeamFeedSnapshot as getFeedState and
// listTeamsForUser.
import assert from 'node:assert/strict'

// SQLite rows have no prototype; rows read out of JSON have the plain one.
const plain = value => structuredClone(value)
const identity = n => ({ githubUserId: n, login: `user${n}`, name: n === 1 ? null : `User ${n}`, avatarUrl: null })

export async function checkFoldedReads(db) {
  const admin = await db.upsertUser(identity(1), 1), member = await db.upsertUser(identity(2), 2), outsider = await db.upsertUser(identity(3), 3)
  await db.setUserRole(admin, 'admin')
  await db.setUserRole(member, 'triage')
  await db.setUserRole(outsider, 'manage')
  await db.selectRepo({ repoId: 7, fullName: 'org/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: admin }, 3)
  await db.createTeam('team', 'Team', 3)
  await db.setTeamRepo('team', 7, 'app')
  await db.setTeamMember('team', member, { dependencies: true, security: false })
  for (const [id, directory, visible, uploadedBy] of [['published', 'app', true, admin], ['draft', 'app/sub', false, outsider], ['outside', 'other', true, admin]]) {
    await db.insertReport({ id, filename: `${id}.json`, contentType: 'application/json', byteSize: 10, sha256: id, uploadedBy, uploadedByLogin: null,
      repoId: 7, repoDirectory: directory, analyzer: null, visible, bundleId: null, bundleIntegrity: null }, 4)
  }

  // Annotations: rows with every kind of value, read for ids with and without rows.
  await db.setTriage('a', { color: 'red', flagged: true }, member, 'user2', 5)
  await db.setTriage('b', { triage: 'done', flagged: false, fix: 'https://github.com/org/repo/pull/1' }, null, 'gone', 6)
  await db.setTriage('c', { comment: 'note' }, admin, 'user1', 7)
  await db.createComment({ findingId: 'b', body: 'second', authorId: member, authorLogin: 'user2', reportId: 'published' }, 9)
  await db.createComment({ findingId: 'a', body: 'first', authorId: admin, authorLogin: 'user1', reportId: 'published' }, 8)
  await db.createComment({ findingId: 'a', body: 'third', authorId: null, authorLogin: 'bot', reportId: 'published' }, 10)
  assert.equal(await db.claimManagedIssue({ findingId: 'b', repoId: 7, repository: 'org/repo', requestId: 'request', createdBy: member, createdAt: 11 }), true)
  assert.equal(await db.finishManagedIssue('b', 'request', 'https://github.com/org/repo/issues/2'), true)
  assert.equal(await db.claimManagedIssue({ findingId: 'a', repoId: 7, repository: 'org/repo', requestId: 'pending', createdBy: admin, createdAt: 12 }), true)
  for (const ids of [['a', 'b', 'c', 'missing'], ['c', 'a'], ['missing'], []]) {
    assert.deepEqual(plain(await db.getAnnotations(ids)),
      plain({ triage: await db.listTriage(ids), comments: await db.listComments(ids), issues: await db.listManagedIssues(ids) }), JSON.stringify(ids))
  }
  assert.deepEqual((await db.getAnnotations(['a'])).comments.map(comment => comment.body), ['first', 'third'])
  assert.deepEqual((await db.getAnnotations(['a', 'b'])).triage.map(row => row.flagged), [true, false])

  // Report views, for each user and report, a missing one included.
  for (const user of [admin, member, outsider, 'nobody']) {
    for (const id of ['published', 'draft', 'outside', 'missing']) {
      const report = await db.getReport(id)
      assert.deepEqual(await db.getReportView(user, id),
        report && { uploadedBy: report.uploadedBy, visible: report.visible, readable: await db.userCanReadReport(user, id) }, `${user} ${id}`)
    }
  }

  // Tokens: none kept, kept, a missing user.
  assert.equal(await db.getUserTokens(member), null)
  await db.setUserTokens(member, { accessToken: 'access', refreshToken: 'refresh', expiresAt: 99 })
  assert.deepEqual(await db.getUserTokens(member), { accessToken: 'access', refreshToken: 'refresh', expiresAt: 99 })
  assert.equal(await db.getUserTokens('nobody'), null)

  // Sessions: the own session read, and presence recorded, never moved back.
  await db.createSession({ id: 'own', userId: member, csrfToken: 'csrf', expiresAt: 1000 }, 20)
  const seenAt = async () => (await db.listUsers()).find(user => user.id === member).lastSeenAt
  assert.deepEqual(plain(await db.sessionWithUser('own', 30)), plain(await db.getSessionWithUser('own', 30)))
  assert.equal(await seenAt(), 30)
  assert.ok(await db.sessionWithUser('own', 25))
  assert.equal(await seenAt(), 30, 'an earlier read leaves the later presence')
  assert.equal(await db.sessionWithUser('own', 1000), null, 'expired')
  assert.equal(await db.sessionWithUser('missing', 30), null)
  assert.equal(await seenAt(), 30)

  // Feed catalogs.
  const feed = await db.getUserTeamFeedSnapshot('own', 40), state = await db.getFeedState('own', 40)
  assert.deepEqual(feed.user, state.user)
  assert.equal(feed.catalog, state.catalog)
  assert.deepEqual(plain(feed.teams), plain(await db.listTeamsForUser(member)))
  assert.deepEqual(feed.teams.map(team => team.reports.map(report => report.id)), [['published']])
  assert.equal(await db.getUserTeamFeedSnapshot('own', 1000), null)
}
