import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { checkBundleLocations } from './_managed-bundle-location.js'
import { openPostgresManagedDb } from '../server-managed/db-neon.ts'

// Tests in this file run sequentially. Reuse the expensive WASM engine, but
// recreate the schema (including functions and triggers) so each test still
// exercises initialization and migrations against an empty database.
let sharedPg
after(async () => { await sharedPg?.close() })

async function database(t) {
  const pg = sharedPg ??= new PGlite()
  await pg.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  const queries = []
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
        queries.push(sql)
        if (!params && sql.includes(';')) { await pg.exec(sql); return { rows: [] } }
        const result = await pg.query(sql, params)
        return { ...result, rowCount: result.affectedRows }
      },
      release: () => { release(); return Promise.resolve() },
    }
  }
  const db = await openPostgresManagedDb(connect, { triageHistoryLimit: 2 })
  t.after(() => db.close())
  return { db, connect, queries }
}
const identity = i => ({ githubUserId: i, login: `user${i}`, name: null, avatarUrl: null })

test('Postgres bundle slugs migrate deterministically, persist, and resolve upload collisions', async t => {
  const { db, connect } = await database(t)
  const ids = ['11111111-1111-4111-8111-123456789abc', '22222222-2222-4222-8222-123456789abc']
  for (const id of ids) await db.insertBundle({ id, integrity: id, filename: `${id}.map`, kind: 'sourcemap', byteSize: 1, repoId: null, uploadedBy: null }, 100)
  assert.deepEqual((await db.listBundles()).map(bundle => bundle.slug), ['123456789abc', ids[1]])
  const old = await connect()
  try { await old.query('ALTER TABLE managed_bundle DROP COLUMN slug; DELETE FROM managed_schema_version WHERE version = 6;') }
  finally { await old.release() }
  const upgraded = await openPostgresManagedDb(connect)
  try {
    assert.deepEqual((await upgraded.listBundles()).map(bundle => bundle.slug), ['123456789abc', ids[1]])
    await upgraded.deleteBundle(ids[0])
  } finally { await upgraded.close() }
  const reopened = await openPostgresManagedDb(connect)
  try { assert.equal((await reopened.getBundle(ids[1])).slug, ids[1]) }
  finally { await reopened.close() }
})

test('Postgres upgrades existing databases for durable, revocable workspace shares', async t => {
  const { db, connect } = await database(t)
  const userId = await db.upsertUser(identity(1), 1)
  await db.setUserRole(userId, 'manage')
  await db.createSession({ id: 'session', userId, csrfToken: 'csrf', expiresAt: 100 }, 1)
  await db.createTeam('team', 'Team', 1)
  await db.setTeamMember('team', userId, { security: true, dependencies: true })
  // Simulate an existing installation predating the share table migration.
  const old = await connect()
  try {
    await old.query('DROP TABLE managed_workspace_share; DELETE FROM managed_schema_version WHERE version = 4;')
  } finally { await old.release() }
  const upgraded = await openPostgresManagedDb(connect)
  try {
    assert.equal(await upgraded.createWorkspaceShare('session', 2, 'team', 'token-hash'), true)
    assert.equal(await upgraded.createWorkspaceShare('session', 100, 'team', 'expired-session-token'), false)
    assert.equal(await upgraded.createWorkspaceShare('session', 2, 'missing', 'foreign-token'), false)
    const snapshot = await upgraded.getWorkspaceShare('token-hash')
    assert.equal(snapshot.team.id, 'team')
    assert.equal(snapshot.user.role, 'view')
    await db.deleteSession('session')
    assert.ok(await upgraded.getWorkspaceShare('token-hash'), 'public link survives issuer logout')
    await db.setUserRole(userId, 'view')
    assert.equal(await upgraded.getWorkspaceShare('token-hash'), null)
    await db.setUserRole(userId, 'manage')
    await db.createSession({ id: 'session', userId, csrfToken: 'csrf', expiresAt: 100 }, 3)
    assert.equal(await upgraded.revokeWorkspaceShares('session', 4, 'team'), true)
    assert.equal(await upgraded.getWorkspaceShare('token-hash'), null)
    assert.equal((await db.listUsers()).length, 1, 'sharing never creates a login identity')
  } finally { await upgraded.close() }
})

test('Postgres initial admin is restricted to the allowlisted first identity and never re-promotes existing users', async t => {
  const { db, connect } = await database(t)
  const [first] = await Promise.all([
    db.upsertUser(identity(7), 1, 7), db.upsertUser(identity(8), 2, 8), db.upsertUser(identity(7), 3, 7),
  ])
  assert.deepEqual((await db.listUsers()).map(user => user.role), ['admin', 'none'])
  await db.setUserRole(first, 'none')
  const reopened = await openPostgresManagedDb(connect)
  try {
    await reopened.upsertUser(identity(7), 4, 7)
    await reopened.upsertUser(identity(9), 5, 9)
    assert.deepEqual((await reopened.listUsers()).map(user => user.role), ['none', 'none', 'none'])
  } finally { await reopened.close() }
})

test('Postgres rejects initial-admin promotion once a nonmatching user has registered', async t => {
  const { db } = await database(t)
  await Promise.all([db.upsertUser(identity(1), 1, 7), db.upsertUser(identity(7), 2, 7)])
  assert.deepEqual((await db.listUsers()).map(user => user.role), ['none', 'none'])
})

test('Postgres report batches snapshot sessions, scoped grants, and metadata with constant SQL round trips', async t => {
  const { db, queries } = await database(t)
  const admin = await db.upsertUser(identity(1), 1), viewer = await db.upsertUser(identity(2), 2)
  await db.setUserRole(viewer, 'view')
  await db.createSession({ id: 'session', userId: viewer, csrfToken: 'csrf', expiresAt: 1000 }, 2)
  await db.selectRepo({ repoId: 7, fullName: 'org/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: admin }, 3)
  for (const [team, path, permissions] of [
    ['app', 'packages/app', { dependencies: false, security: true }],
    ['sub', 'packages/app/sub', { dependencies: true, security: false }],
  ]) {
    await db.createTeam(team, team, 3)
    await db.setTeamRepo(team, 7, path)
    await db.setTeamMember(team, viewer, permissions)
  }
  const ids = []
  for (let i = 0; i < 32; i++) {
    const id = `r-${i}`
    await db.insertReport({ id, filename: `${id}.json`, contentType: 'application/json', byteSize: 100, sha256: id,
      uploadedBy: admin, uploadedByLogin: 'user1', repoId: 7, repoDirectory: i % 2 === 0 ? 'packages/app' : 'packages/app/sub',
      analyzer: null, visible: true, bundleId: null, bundleIntegrity: null }, 4)
    ids.push(id)
  }
  queries.length = 0
  const single = await db.getReportAccessSnapshot('session', 10, ids.slice(0, 1))
  const count = queries.length
  assert.equal(single.reports.length, 1)
  assert.equal(count, 4, 'BEGIN, session SELECT, bulk report SELECT, COMMIT')
  queries.length = 0
  const batch = await db.getReportAccessSnapshot('session', 10, [...ids, ids[0], 'missing'])
  assert.equal(queries.length, count)
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(batch.reports.length, ids.length)
  for (const [index, id] of ids.entries()) {
    const report = batch.reports.find(entry => entry.id === id)
    assert.deepEqual(report.permissions, { dependencies: index % 2 !== 0, security: true })
    assert.equal(report.repo.github, 'org/repo')
  }
  queries.length = 0
  const app = await db.getTeamReportAccessSnapshot('session', 10, 'app')
  assert.equal(queries.length, 6, 'one transaction: session, membership, reports and repository scopes')
  assert.deepEqual(app.repositories, [{ repoId: 7, github: 'org/repo', path: 'packages/app' }])
  assert.equal(app.reports.length, 32)
  assert.ok(app.reports.every(report => !report.permissions.dependencies && report.permissions.security))
  const sub = await db.getTeamReportAccessSnapshot('session', 10, 'sub')
  assert.equal(sub.reports.length, 16)
  assert.ok(sub.reports.every(report => report.permissions.dependencies && !report.permissions.security))
  assert.equal((await db.getTeamReportAccessSnapshot('session', 10, 'missing')).teamId, null)
  await db.setTeamRepo('app', 7, 'elsewhere')
  await db.removeTeamRepo('app', 7, 'packages/app')
  await db.removeTeamMember('sub', viewer)
  assert.deepEqual((await db.getReportAccessSnapshot('session', 10, ids)).reports, [])
  await db.setUserRole(viewer, 'admin')
  assert.equal((await db.getReportAccessSnapshot('session', 10, ids)).reports.length, ids.length)
  assert.equal(await db.getReportAccessSnapshot('session', 1000, ids), null)
  await db.deleteSession('session')
  assert.equal(await db.getReportAccessSnapshot('session', 10, ids), null)
})

test('Postgres managed store: auth, scopes, uploads, history, comments, and restart', async t => {
  const { db, connect } = await database(t)
  const [admin, user] = await Promise.all([db.upsertUser(identity(1), 10), db.upsertUser(identity(2), 11)])
  assert.deepEqual((await db.listUsers()).map(u => u.role), ['none', 'none'])
  await db.setUserRole(admin, 'admin')
  assert.equal(await db.upsertUser(identity(1), 12), admin)
  await db.setUserRole(user, 'manage')
  await db.createSession({ id: 's', userId: user, csrfToken: 'csrf', expiresAt: 1000 }, 20)
  assert.equal((await db.sessionWithUser('s', 21)).user.id, user)
  assert.equal(await db.sessionWithUser('s', 1001), null)
  await db.setUserTokens(user, { accessToken: 'token', refreshToken: null, expiresAt: 500 })
  assert.equal((await db.getUserTokens(user)).accessToken, 'token')
  assert.equal(await db.getUserGithubId(admin), 1)
  assert.equal(await db.getUserGithubId(user), 2)
  assert.equal(await db.getUserGithubId('missing'), null)
  await db.selectRepo({ repoId: 1, fullName: 'Owner/Repo', private: true, installationId: 2, defaultBranch: 'main', htmlUrl: 'https://github.com/Owner/Repo', addedBy: admin }, 30)
  const team = randomUUID()
  assert.equal(await db.createTeam(team, 'team', 30), true)
  assert.equal(await db.createTeam(randomUUID(), 'team', 30), false)
  await db.setTeamMember(team, user, { dependencies: true, security: true })
  await db.setTeamRepo(team, 1, 'src')
  assert.equal(await db.userCanReadRepoPath(user, 1, 'src/sub'), true)
  assert.equal(await db.userCanReadRepoPath(user, 1, 'src-other'), false)
  const bundle = randomUUID(), report = randomUUID()
  await db.insertBundle({ id: bundle, integrity: 'sha512-abc', filename: 'source.map', kind: 'sourcemap', byteSize: 20, uploadedBy: admin, uploadedByLogin: 'user1', repoId: 1, repoDirectory: 'src' }, 40)
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
  const teamReport = (await db.listTeamsForUser(user))[0].reports[0]
  assert.equal(teamReport.id, report)
  assert.equal(teamReport.repoFullName, 'Owner/Repo')
  assert.equal(teamReport.repoDirectory, 'src')
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
  await db.setUserRole(admin, 'admin')
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

test('Postgres bundle advisories use only security grants on the bundle repository', async t => {
  const { db } = await database(t)
  const user = await db.upsertUser(identity(1), 1)
  await db.setUserRole(user, 'view')
  await db.selectRepo({ repoId: 7, fullName: 'org/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: user }, 2)
  await db.insertBundle({ id: 'bundle', integrity: 'sha512-test', filename: 'test.stasis.code.br', kind: 'stasis', byteSize: 12, uploadedBy: user, uploadedByLogin: 'user1', repoId: 7 }, 2)
  for (const team of ['security', 'dependencies']) {
    await db.createTeam(team, team, 2)
    await db.setTeamRepo(team, 7, null)
    await db.setTeamMember(team, user, { dependencies: team === 'dependencies', security: team === 'security' })
  }
  assert.equal(await db.userCanReadBundleAdvisories(user, 'bundle', null), true)
  assert.equal(await db.userCanReadBundleAdvisories(user, 'bundle', 'security'), true)
  assert.equal(await db.userCanReadBundleAdvisories(user, 'bundle', 'dependencies'), false)
  assert.equal(await db.userCanReadBundleAdvisories(user, 'missing', null), false)
  await db.removeTeamRepo('security', 7)
  assert.equal(await db.userCanReadBundleAdvisories(user, 'bundle', null), false)
})

test('Postgres upgrades existing databases and retains GitHub metadata across restarts without eviction', async t => {
  const { connect, db } = await database(t)
  await db.close()
  const connection = await connect()
  try { await connection.query('DROP TABLE managed_github_metadata') } finally { await connection.release() }
  const upgraded = await openPostgresManagedDb(connect)
  const { checkGithubMetadataStore } = await import('./_managed-github-metadata.js')
  const merged = await checkGithubMetadataStore(upgraded)
  await upgraded.close()
  const reopened = await openPostgresManagedDb(connect)
  try { assert.deepEqual(await reopened.listGithubMetadata([merged.key]), [merged]) }
  finally { await reopened.close() }
})

test('Postgres adds closure reasons and attempts to an existing metadata table without discarding its cache', async t => {
  const { connect, db } = await database(t)
  const cached = { key: '7:issue:9', title: 'Legacy issue', description: 'Retained body', status: 'closed', stateReason: null, fetchedAt: 1, attemptedAt: null }
  await db.setGithubMetadata([cached])
  await db.close()
  const connection = await connect()
  try { await connection.query('ALTER TABLE managed_github_metadata DROP COLUMN state_reason, DROP COLUMN attempted_at') }
  finally { await connection.release() }
  for (let i = 0; i < 2; i++) {
    const upgraded = await openPostgresManagedDb(connect)
    try {
      assert.deepEqual(await upgraded.listGithubMetadata([cached.key]), [cached])
      cached.stateReason = 'completed'
      cached.fetchedAt++
      await upgraded.setGithubMetadata([cached])
      cached.attemptedAt = 100 + i
      await upgraded.recordGithubMetadataAttempts([cached.key], cached.attemptedAt)
    } finally { await upgraded.close() }
  }
})

test('Postgres annotation revisions track visible changes across connections, trimming and purges', async t => {
  const { db, connect } = await database(t)
  const peer = await openPostgresManagedDb(connect, { triageHistoryLimit: 1 })
  t.after(() => peer.close())
  const initial = await db.getAnnotationRevision(['finding'])
  await peer.setTriage('hidden', { color: 'red' }, null, null, 1)
  assert.equal(await db.getAnnotationRevision(['finding']), initial)
  await peer.setTriage('finding', { color: 'red' }, null, null, 1)
  const red = await db.getAnnotationRevision(['finding'])
  assert.notEqual(red, initial)
  await peer.setTriage('finding', { color: 'blue' }, null, null, 1)
  assert.notEqual(await db.getAnnotationRevision(['finding']), red)
  const blue = await db.getAnnotationRevision(['finding'])
  await peer.setTriage('finding', { color: 'blue' }, null, null, 2)
  assert.equal(await db.getAnnotationRevision(['finding']), blue)
  await peer.createComment({ findingId: 'finding', body: 'note', authorId: null, authorLogin: null }, 3)
  assert.notEqual(await db.getAnnotationRevision(['finding']), blue)
  await peer.deleteTriage(['finding'])
  assert.equal(await db.getAnnotationRevision(['finding']), initial)
  await peer.setTriage('finding', { color: 'red' }, null, null, 1)
  assert.notEqual(await db.getAnnotationRevision(['finding']), red)
})

test('Postgres workspace triage imports compare and write atomically with other triage writers', async t => {
  const { db, queries } = await database(t)
  const id = await db.upsertUser(identity(1), 1)
  const actor = { id, login: 'user1' }
  const initial = await db.getImportTriage(['f'])
  const expected = { f: initial.f.version }
  const results = await Promise.all([
    db.importTriage([['f', { color: 'red', comment: 'Imported' }]], expected, actor, null, 2),
    db.importTriage([['f', { color: 'blue', comment: 'Other import' }]], expected, actor, null, 3),
  ])
  assert.deepEqual(results, [true, false])
  assert.equal((await db.listTriage(['f']))[0].color, 'red')
  assert.equal((await db.listComments(['f'])).length, 1)
  assert.equal((await db.listComments(['f']))[0].authorId, null)
  assert.ok(queries.some(query => query.includes('pg_advisory_xact_lock')))
  const snapshot = await db.getImportTriage(['f'])
  await db.setTriage('f', { color: 'green' }, id, 'user1', 4)
  assert.equal(await db.importTriage([['f', { color: 'blue' }]], { f: snapshot.f.version }, actor, null, 5), false)
  assert.equal((await db.listTriage(['f']))[0].color, 'green')
})

test('Postgres feed snapshots scope catalogs to the session and release read-only transactions', async t => {
  const { db, connect, queries } = await database(t)
  const peer = await openPostgresManagedDb(connect)
  t.after(() => peer.close())
  const user = await db.upsertUser(identity(1), 1)
  await db.setUserRole(user, 'view')
  await db.createSession({ id: 'feed-session', userId: user, csrfToken: 'csrf', expiresAt: 1000 }, 1)
  const read = () => db.getUserTeamFeedSnapshot('feed-session', 10)
  const initial = await read()
  assert.deepEqual(initial.user, { id: user, role: 'view' })
  await peer.createTeam('team', 'Team', 1)
  assert.equal((await read()).revision, initial.revision, 'nonmember teams do not notify')
  await peer.setTeamMember('team', user, { security: false, dependencies: false })
  const member = await read()
  assert.notEqual(member.revision, initial.revision)
  await peer.setTeamMember('team', user, { security: true, dependencies: false })
  assert.notEqual((await read()).revision, member.revision, 'empty-team grants notify')
  await peer.selectRepo({ repoId: 7, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: user }, 1)
  await peer.setTeamRepo('team', 7, 'app')
  const scoped = await read()
  await peer.insertReport({ id: 'hidden', filename: 'report.json', contentType: 'application/json', byteSize: 1,
    sha256: 'hidden', uploadedBy: user, repoId: 7, repoDirectory: 'outside', visible: true }, 1)
  assert.equal((await read()).revision, scoped.revision)
  await peer.insertReport({ id: 'report', filename: 'report.json', contentType: 'application/json', byteSize: 1,
    sha256: 'hash', uploadedBy: user, repoId: 7, repoDirectory: 'app', visible: true, bundleIntegrity: 'bundle-hash' }, 1)
  const content = await read()
  assert.notEqual(content.revision, scoped.revision)
  await peer.insertBundle({ id: 'bundle', integrity: 'bundle-hash', filename: 'bundle.stasis', kind: 'stasis', byteSize: 1, uploadedBy: user, repoId: 7, repoDirectory: 'app' }, 1)
  const bundled = await read()
  assert.notEqual(bundled.revision, content.revision)
  const beforeRepair = await db.listTeamsForUser(user)
  await peer.linkReportsToBundle('bundle-hash', 'bundle', user)
  const repaired = await read()
  const afterRepair = await db.listTeamsForUser(user)
  assert.notEqual(repaired.revision, bundled.revision, 'report-to-bundle repairs notify without changing the bundle catalog')
  assert.deepEqual(afterRepair[0].bundles, beforeRepair[0].bundles)
  assert.notEqual(afterRepair[0].reports[0].cacheKey, beforeRepair[0].reports[0].cacheKey)
  await peer.setTriage('finding', { color: 'red' }, user, 'user1', 1)
  queries.length = 0
  assert.equal((await read()).revision, repaired.revision, 'catalogs exclude annotations')
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(queries.at(-1), 'COMMIT')
  assert.equal(queries.some(sql => /UPDATE|INSERT|DELETE/u.test(sql)), false)
  await peer.removeTeamMember('team', user)
  assert.equal((await read()).revision, initial.revision)
  await peer.deleteSession('feed-session')
  assert.equal(await read(), null)
})


test('Postgres bundle directories scope catalogs, access, advisories, public links, and activity', async t => {
  const { db } = await database(t)
  await checkBundleLocations(db)
})

test('Postgres migrates bundle locations to root and preserves directory edits on restart', async t => {
  const { db, connect } = await database(t)
  await db.selectRepo({ repoId: 1, fullName: 'org/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }, 1)
  await db.insertBundle({ id: 'bundle', integrity: 'hash', filename: 'source.map', kind: 'sourcemap', byteSize: 1, repoId: 1, uploadedBy: null }, 1)
  const legacy = await connect()
  try { await legacy.query('ALTER TABLE managed_bundle DROP COLUMN repo_directory; DELETE FROM managed_schema_version WHERE version = 7;') }
  finally { await legacy.release() }
  const upgraded = await openPostgresManagedDb(connect)
  try {
    assert.equal((await upgraded.getBundle('bundle')).repoDirectory, '')
    await upgraded.setBundleRepo('bundle', 1, 'foo/sub')
  } finally { await upgraded.close() }
  const reopened = await openPostgresManagedDb(connect)
  try { assert.equal((await reopened.getBundleByIntegrity('hash')).repoDirectory, 'foo/sub') }
  finally { await reopened.close() }
})
