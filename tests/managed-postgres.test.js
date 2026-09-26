import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { openPostgresManagedDb } from '../server-managed/db-neon.ts'

async function database(t) {
  const pg = new PGlite()
  // PGlite has one connection. A lease covers the complete transaction, just
  // like distinct connections do in production; never interleave BEGINs.
  let tail = Promise.resolve()
  const connect = async () => {
    const previous = tail
    let release
    tail = new Promise(resolve => { release = resolve })
    await previous
    return {
      async query(sql, params) {
        if (!params && sql.includes(';')) { await pg.exec(sql); return { rows: [] } }
        const result = await pg.query(sql, params)
        return { ...result, rowCount: result.affectedRows }
      },
      release: () => { release(); return Promise.resolve() },
    }
  }
  const db = await openPostgresManagedDb(connect, { triageHistoryLimit: 2 })
  t.after(async () => { await db.close(); await pg.close() })
  return { db, connect }
}
const identity = i => ({ githubUserId: i, login: `user${i}`, name: null, avatarUrl: null })

test('Postgres managed store: auth, scopes, uploads, history, comments, and restart', async t => {
  const { db, connect } = await database(t)
  const [admin, user] = await Promise.all([db.upsertUser(identity(1), 10), db.upsertUser(identity(2), 11)])
  assert.deepEqual((await db.listUsers()).map(u => u.role), ['admin', 'none'])
  assert.equal(await db.upsertUser(identity(1), 12), admin)
  await db.setUserRole(user, 'manage')
  await db.createSession({ id: 's', userId: user, csrfToken: 'csrf', expiresAt: 1000 }, 20)
  assert.equal((await db.sessionWithUser('s', 21)).user.id, user)
  assert.equal(await db.sessionWithUser('s', 1001), null)
  await db.setUserTokens(user, { accessToken: 'token', refreshToken: null, expiresAt: 500 })
  assert.equal((await db.getUserTokens(user)).accessToken, 'token')
  await db.selectRepo({ repoId: 1, fullName: 'Owner/Repo', private: true, installationId: 2, defaultBranch: 'main', htmlUrl: 'https://github.com/Owner/Repo', addedBy: admin }, 30)
  const team = randomUUID()
  assert.equal(await db.createTeam(team, 'team', 30), true)
  assert.equal(await db.createTeam(randomUUID(), 'team', 30), false)
  await db.setTeamMember(team, user, { dependencies: true, security: true })
  await db.setTeamRepo(team, 1, 'src')
  assert.equal(await db.userCanReadRepoPath(user, 1, 'src/sub'), true)
  assert.equal(await db.userCanReadRepoPath(user, 1, 'src-other'), false)
  const bundle = randomUUID(), report = randomUUID()
  await db.insertBundle({ id: bundle, integrity: 'sha512-abc', filename: 'source.map', kind: 'sourcemap', byteSize: 20, uploadedBy: admin, uploadedByLogin: 'user1', repoId: 1 }, 40)
  await db.insertReport({ id: report, filename: 'report.json', contentType: 'application/json', byteSize: 30, sha256: 'hash', uploadedBy: admin, uploadedByLogin: 'user1', repoId: 1, repoDirectory: 'src', analyzer: null, visible: true, bundleId: null, bundleIntegrity: 'sha512-abc' }, 41)
  await db.linkReportsToBundle('sha512-abc', bundle, user)
  assert.equal((await db.listReports(user))[0].bundleId, bundle)
  assert.equal((await db.getReport(report)).bundleId, bundle)
  assert.deepEqual(await db.listReportFilenamesWithBundleHash(bundle, 'hash'), ['report.json'])
  assert.deepEqual(await db.listReportFilenamesWithBundleHash(bundle, 'other'), [])
  assert.deepEqual(await db.listReportsForRepo(1), [{ id: report, filename: 'report.json', sha256: 'hash', bundleId: bundle }])
  assert.equal((await db.listReports())[0].id, report)
  assert.equal((await db.listBundles(user))[0].byteSize, 20)
  assert.equal((await db.getBundleByIntegrity('sha512-abc')).id, bundle)
  assert.equal(await db.userCanReadBundle(user, bundle), true)
  assert.equal(await db.userCanReadReport(user, report), true)
  assert.deepEqual(await db.reportPermissionsFor(user, report), { dependencies: true, security: true })
  assert.equal((await db.listTeamsForUser(user))[0].reports[0].id, report)
  assert.equal((await db.listTeams())[0].members[0].userId, user)
  assert.equal((await db.listActivityReports(user))[0].reportId, report)
  assert.equal((await db.listRepoScopesForUser(user))[0].repoId, 1)
  await db.setTriageEntries([['f', { color: 'red' }]], user, 'user2', 50, report)
  await db.setTriage('f', { color: 'blue' }, user, 'user2', 51)
  await db.setTriage('f', null, user, 'user2', 52)
  assert.equal((await db.listTriageHistory('f', 10)).length, 2)
  assert.equal((await db.listTriage(['f']))[0].color, null)
  const comment = await db.createComment({ findingId: 'f', body: 'hello', authorId: user, authorLogin: 'user2', reportId: report }, 60)
  const edits = await Promise.all(['one', 'two'].map(body => db.editComment(comment.id, user, 'user2', body, 1, report, 61)))
  assert.equal(edits.filter(e => e === 'conflict').length, 1)
  assert.equal((await db.getComment(comment.id)).version, 2)
  await db.recordActivity({ kind: 'visibility', actor: 'user2', actorId: user, action: 'published', reportId: report }, 70)
  const query = { page: 1, limit: 20, kind: 'all', query: '', contexts: null }
  assert.equal((await db.listActivity(query)).total, 7)
  const scoped = await db.listActivity({ ...query, query: 'hello', userId: user, contexts: [{ finding: 'f', reportId: report, report: 'report.json', repo: 'Owner/Repo' }] })
  assert.equal(scoped.total, 0, 'comment bodies do not leak to history')
  assert.equal((await db.listActivity({ ...query, userId: user, contexts: [] })).total, 3)
  assert.equal((await db.listUsers()).find(u => u.id === user).lastActivityAt, 70)
  const restarted = await openPostgresManagedDb(connect)
  assert.equal((await restarted.sessionWithUser('s', 80)).user.id, user)
  await restarted.close()
  assert.equal(await db.deleteTriage(['f']), 1)
  assert.deepEqual(await db.listComments(['f']), [])
  assert.equal(await db.renameTeam(team, 'renamed', 80), 'ok')
  await db.setTeamRepo(team, 1, null)
  assert.equal((await db.listTeams())[0].repos.length, 1)
  assert.equal(await db.deleteExpiredSessions(1001), 1)
  assert.equal(await db.deleteBundle(bundle), true)
  assert.equal((await db.listReports())[0].bundleId, null)
  assert.equal(await db.deleteReport(report), true)
  assert.equal(await db.deleteTeam(team), true)
  assert.equal(await db.deleteRepo(1), true)
})

test('Postgres batch rollback preserves current triage and history', async t => {
  const { db } = await database(t)
  const user = await db.upsertUser(identity(1), 1)
  await assert.rejects(db.setTriageEntries([['f', { color: 'red' }]], 'missing-user', null, 2))
  assert.deepEqual(await db.listTriage(['f']), [])
  assert.deepEqual(await db.listTriageHistory('f', 10), [])
  await db.setTriage('f', { color: 'green' }, user, 'user1', 3)
  assert.equal((await db.listTriageHistory('f', 10)).length, 1)
})

test('Postgres preserves undated comments, deletion history, and user filters', async t => {
  const { db } = await database(t)
  const author = await db.upsertUser(identity(1), 1)
  const other = await db.upsertUser(identity(2), 2)
  const dated = await db.createComment({ findingId: 'f', body: 'dated', authorId: author, authorLogin: 'user1' }, 10)
  const undated = await db.createComment({ findingId: 'f', body: 'undated', authorId: other, authorLogin: 'user2', createdAt: null }, 20)
  assert.equal(undated.createdAt, null)
  assert.equal(undated.updatedAt, null)
  assert.deepEqual((await db.listComments(['f'])).map(c => c.id), [undated.id, dated.id])
  const query = { page: 1, limit: 20, kind: 'all', query: '', contexts: null, actor: `user:${other}` }
  const filtered = await db.listActivity(query)
  assert.equal(filtered.total, 1)
  assert.equal(filtered.history[0].actor, 'user2')
  assert.deepEqual(filtered.filters.users.map(u => u.login), ['user1', 'user2'])
  assert.equal(await db.deleteComment(undated.id, author, 'user1', 1, '', 30), 'forbidden')
  assert.equal(await db.deleteComment(undated.id, other, 'user2', 2, '', 30), 'conflict')
  assert.equal(await db.deleteComment(undated.id, other, 'user2', 1, '', 30), 'deleted')
  assert.equal((await db.listActivity(query)).history[0].action, 'deleted a comment')
  assert.equal(await db.deleteComment(dated.id, author, 'user1', 1, '', 31), 'deleted')
  assert.deepEqual(await db.listComments(['f']), [])
  assert.deepEqual(await db.listCommentedFindingIds(['f']), ['f'])
  assert.equal(await db.deleteTriage(['f']), 1, 'purge includes findings with only comment audit events')
  assert.deepEqual(await db.listCommentedFindingIds(['f']), [])
})

test('Postgres admins can delete unattributed comments with version checks and their own audit identity', async t => {
  const { db, connect } = await database(t)
  const admin = await db.upsertUser(identity(1), 1), user = await db.upsertUser(identity(2), 2)
  await db.setUserRole(user, 'manage')
  const input = { findingId: 'f', body: 'imported', authorId: null, authorLogin: null }
  const imported = await db.createComment(input, 10)
  assert.equal(await db.deleteComment(imported.id, user, 'user2', 1, '', 20), 'forbidden')
  assert.equal(await db.deleteComment(imported.id, admin, 'user1', 2, '', 20), 'conflict')
  assert.equal(await db.editComment(imported.id, admin, 'user1', 'claimed', 1, '', 20), 'forbidden')
  assert.equal(await db.deleteComment(imported.id, admin, 'user1', 1, '', 20), 'deleted')
  assert.equal(await db.getComment(imported.id), null)
  const history = await db.listActivity({ page: 1, limit: 20, kind: 'all', query: '', contexts: null })
  assert.equal(history.total, 2, 'forbidden and conflicting changes add no events')
  assert.equal(history.history[0].actor, 'user1')
  assert.equal(history.history[0].action, 'deleted a comment')
  const orphan = await db.createComment({ ...input, authorId: user, authorLogin: 'user2' }, 21)
  assert.equal(await db.deleteComment(orphan.id, admin, 'user1', 1, '', 22), 'forbidden')
  const connection = await connect()
  try { await connection.query('DELETE FROM managed_user WHERE id = $1', [user]) } finally { await connection.release() }
  assert.equal(await db.deleteComment(orphan.id, admin, 'user1', 1, '', 23), 'deleted')
  const next = await db.createComment(input, 24)
  await db.setUserRole(admin, 'manage')
  assert.equal(await db.deleteComment(next.id, admin, 'user1', 1, '', 25), 'forbidden', 'role comes from the current database row')
})

test('Postgres upgrades existing managed databases for report-source lookup without losing data', async t => {
  const { db, connect } = await database(t)
  const user = await db.upsertUser(identity(1), 1)
  const previous = await connect()
  try {
    await previous.query('DROP INDEX managed_report_bundle_hash_idx; DELETE FROM managed_schema_version WHERE version = 2;')
  } finally { await previous.release() }
  for (let i = 0; i < 2; i++) {
    const reopened = await openPostgresManagedDb(connect)
    assert.equal((await reopened.listUsers()).find(row => row.id === user).login, 'user1')
    await reopened.close()
  }
  const upgraded = await connect()
  try {
    assert.equal((await upgraded.query("SELECT indexname FROM pg_indexes WHERE indexname = 'managed_report_bundle_hash_idx'")).rows.length, 1)
    assert.equal((await upgraded.query('SELECT version FROM managed_schema_version WHERE version = 2')).rows.length, 1)
  } finally { await upgraded.release() }
})
