import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { openPostgresManagedDb } from '../server-managed/db-neon.ts'
import { storageTestKey } from './_managed-storage-db.js'

// Explicit expected names, independent of the migration's rename map.
const renamed = ['selected_repo', 'team_repo', 'team_user', 'finding_triage',
  'finding_triage_event', 'finding_comment', 'finding_comment_event']
const tables = ['managed_user', 'managed_session', 'managed_bundle', 'managed_report',
  'managed_storage_encryption',
  'managed_team', 'managed_activity', 'managed_github_metadata', 'managed_workspace_share', 'managed_finding_issue', ...renamed.map(name => `managed_${name}`)]

// These tests run sequentially; only the engine is shared, never the schema.
let sharedPg
after(async () => { await sharedPg?.close() })

async function database(t, backend) {
  if (backend === 'sqlite') {
    const dir = await mkdtemp(join(tmpdir(), 'managed-prefix-'))
    const path = join(dir, 'data.db'), raw = new DatabaseSync(path)
    t.after(async () => { raw.close(); await rm(dir, { recursive: true, force: true }) })
    return {
      open: options => openSqliteManagedDb(path, options), exec: sql => raw.exec(sql),
      query: sql => raw.prepare(sql).all().map(row => ({ ...row })),
      names: () => raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name),
    }
  }
  const pg = sharedPg ??= new PGlite()
  await pg.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
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
  return {
    open: options => openPostgresManagedDb(connect, options), exec: sql => pg.exec(sql),
    query: async sql => (await pg.query(sql)).rows,
    names: async () => (await pg.query("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'")).rows.map(row => row.name),
  }
}

async function seed(db) {
  const user = await db.upsertUser({ githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, 1)
  await db.setUserRole(user, 'admin')
  await db.createSession({ id: 'session', userId: user, csrfToken: 'csrf', expiresAt: 1000 }, 1)
  await db.selectRepo({ repoId: 7, fullName: 'org/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: user }, 2)
  await db.createTeam('team', 'team', 3)
  await db.setTeamMember('team', user, { dependencies: false, security: true })
  await db.setTeamRepo('team', 7, 'src')
  const bundle = { id: 'bundle', integrity: 'sha512-test', filename: 'source.map', kind: 'sourcemap', byteSize: 2, uploadedBy: user, repoId: 7 }
  const report = { id: 'report', filename: 'report.json', contentType: 'application/json', byteSize: 2, sha256: 'report-hash', uploadedBy: user,
    repoId: 7, repoDirectory: 'src', visible: true, bundleId: bundle.id, bundleIntegrity: bundle.integrity }
  await db.insertBundle(bundle, 4)
  await db.insertReport(report, 5)
  await db.setTriageEntries([['finding', { color: 'red' }]], user, 'admin', 6, report.id)
  const comment = await db.createComment({ findingId: 'finding', body: 'comment', authorId: user, authorLogin: 'admin', reportId: report.id }, 7)
  return { bundle, comment, report, user }
}

async function makeLegacy(fixture, backend) {
  await fixture.exec('DELETE FROM managed_schema_version WHERE version = 3')
  for (const name of renamed) await fixture.exec(`ALTER TABLE managed_${name} RENAME TO ${name}`)
  if (backend === 'postgres') {
    const functions = await fixture.query("SELECT pg_get_functiondef(oid) AS sql FROM pg_proc WHERE proname IN ('managed_report_activity_insert', 'managed_bundle_activity_insert')")
    for (const { sql } of functions) await fixture.exec(sql.replaceAll('managed_selected_repo', 'selected_repo'))
  } else {
    // SQLite deployments before table prefixes have no schema-version table.
    await fixture.exec('DROP TABLE managed_schema_version')
  }
}

for (const backend of ['sqlite', 'postgres']) {
  test(`${backend}: existing public links migrate to opt-in permissions and edits survive restart`, async t => {
    const fixture = await database(t, backend)
    let db = await fixture.open()
    const { user } = await seed(db)
    assert.equal(await db.createWorkspaceShare('session', 10, 'team', 'existing-link', { dependencies: true, security: true }), true)
    await db.close()
    await fixture.exec('ALTER TABLE managed_workspace_share DROP COLUMN dependencies; ALTER TABLE managed_workspace_share DROP COLUMN security; DELETE FROM managed_schema_version WHERE version = 5;')
    db = await fixture.open()
    try {
      assert.deepEqual((await db.getWorkspaceShare('existing-link')).permissions, { dependencies: false, security: false })
      const links = await db.listManagedWorkspaceShares('session', 11)
      assert.equal(links.length, 1)
      assert.equal(links[0].createdBy, 'admin')
      assert.equal(links[0].id, 'existing-link')
      await db.removeTeamMember('team', user)
      assert.equal(await db.updateWorkspaceShare('session', 12, 'team', 'existing-link', { dependencies: true, security: false }), true, 'admins can edit links outside their memberships')
      const manager = await db.upsertUser({ githubUserId: 2, login: 'manager', name: null, avatarUrl: null }, 12)
      await db.setUserRole(manager, 'manage')
      await db.createSession({ id: 'manager-session', userId: manager, csrfToken: 'csrf', expiresAt: 1000 }, 12)
      assert.deepEqual(await db.listManagedWorkspaceShares('manager-session', 13), [])
      assert.equal(await db.updateWorkspaceShare('manager-session', 13, 'team', 'existing-link', { dependencies: false, security: true }), false)
      await db.setTeamMember('team', manager, { dependencies: false, security: false })
      assert.equal((await db.listManagedWorkspaceShares('manager-session', 13)).length, 1)
    } finally { await db.close() }
    db = await fixture.open()
    try {
      assert.deepEqual((await db.getWorkspaceShare('existing-link')).permissions, { dependencies: true, security: false })
      assert.equal(await db.createWorkspaceShare('session', 14, 'team', 'new-link'), true)
      assert.deepEqual((await db.getWorkspaceShare('new-link')).permissions, { dependencies: false, security: false })
      assert.equal(await db.revokeWorkspaceShares('session', 15, 'team', 'existing-link'), true)
      assert.equal(await db.getWorkspaceShare('existing-link'), null)
      assert.ok(await db.getWorkspaceShare('new-link'))
      assert.equal(await db.revokeWorkspaceShares('session', 16, 'team'), true)
      assert.deepEqual(await db.listWorkspaceShares('session', 17, 'team'), [])
    } finally { await db.close() }
  })

  test(`${backend}: storage columns upgrade existing plaintext rows and OAuth tokens`, async t => {
    const fixture = await database(t, backend)
    let db = await fixture.open()
    const { bundle, report, user } = await seed(db)
    const tokens = { accessToken: 'legacy-access', refreshToken: 'legacy-refresh', expiresAt: 2000 }
    await db.setUserTokens(user, tokens)
    await db.close()
    for (const table of ['managed_report', 'managed_bundle']) {
      await fixture.exec(`ALTER TABLE ${table} DROP COLUMN data_key; ALTER TABLE ${table} DROP COLUMN storage_encrypted`)
    }
    await fixture.exec('ALTER TABLE managed_user DROP COLUMN gh_tokens_encrypted; DROP TABLE managed_storage_encryption;')
    if (backend === 'postgres') await fixture.exec('DELETE FROM managed_schema_version WHERE version = 9')
    db = await fixture.open({ storageEncryptionKey: storageTestKey })
    try {
      assert.equal(await db.getStorageEncryption(), null)
      for (const [type, id] of [['report', report.id], ['bundle', bundle.id]]) {
        const row = await db.getStorageRow(type, id)
        assert.equal(row.encrypted, 0)
        assert.equal(row.dataKey, null)
      }
      await db.enableStorageEncryption()
      assert.deepEqual(await db.getUserTokens(user), tokens)
      await db.migrateStorageUserTokens(user)
      assert.deepEqual(await db.getUserTokens(user), tokens)
      const row = (await fixture.query('SELECT gh_access_token AS access FROM managed_user'))[0]
      assert.notEqual(row.access, tokens.accessToken)
    } finally { await db.close() }
  })

  test(`${backend}: table-prefix migration retains data, grants, references, triggers and e2e tables`, async t => {
    const fixture = await database(t, backend)
    let db = await fixture.open()
    const { bundle, comment, report, user } = await seed(db)
    await db.close()
    await fixture.exec("CREATE TABLE workspace_revision (id TEXT PRIMARY KEY); INSERT INTO workspace_revision VALUES ('e2e')")
    const snapshots = new Map()
    for (const table of tables) snapshots.set(table, await fixture.query(`SELECT * FROM ${table} ORDER BY 1`))
    await makeLegacy(fixture, backend)
    // PGlite leases serialize transactions; this checks repeated replica
    // initialization, not PostgreSQL's cross-connection locking implementation.
    const replicas = await Promise.all([fixture.open(), fixture.open()])
    await Promise.all(replicas.map(replica => replica.close()))
    for (let pass = 0; pass < 2; pass++) {
      db = await fixture.open()
      try {
        assert.deepEqual(new Set(await fixture.names()), new Set([...tables, 'managed_schema_version', 'workspace_revision']))
        for (const [table, rows] of snapshots) assert.deepEqual(await fixture.query(`SELECT * FROM ${table} ORDER BY 1`), rows, table)
        assert.deepEqual(await fixture.query('SELECT * FROM workspace_revision'), [{ id: 'e2e' }])
        const session = await db.sessionWithUser('session', 1)
        assert.equal(session.user.id, user)
        assert.equal(session.user.role, 'admin', 'table renames preserve approved roles')
        assert.equal(await db.userCanReadRepoPath(user, 7, 'src/file'), true)
        assert.equal(await db.userCanReadRepoPath(user, 7, 'outside'), false)
        assert.equal((await db.getComment(comment.id)).body, 'comment')
        assert.equal((await db.listTriageHistory('finding', 10)).length, 1)
        assert.equal((await db.listTriage(['finding']))[0].color, 'red')
      } finally { await db.close() }
    }
    db = await fixture.open()
    try {
      await db.insertBundle({ ...bundle, id: 'next-bundle', integrity: 'sha512-next' }, 8)
      await db.insertReport({ ...report, id: 'next-report' }, 9)
      const events = await fixture.query("SELECT repo FROM managed_activity WHERE id IN ('report-upload:next-report', 'bundle-upload:next-bundle')")
      assert.deepEqual(events, [{ repo: 'org/repo' }, { repo: 'org/repo' }], 'upload triggers reference the renamed repository table')
      await db.deleteRepo(7)
      assert.equal((await db.getReport(report.id)).repoId, null, 'renamed foreign keys retain ON DELETE behavior')
      assert.deepEqual(await fixture.query('SELECT * FROM managed_team_repo'), [])
    } finally { await db.close() }
  })

  test(`${backend}: ambiguous legacy/prefixed tables reject atomically`, async t => {
    const fixture = await database(t, backend)
    const db = await fixture.open()
    await db.close()
    await makeLegacy(fixture, backend)
    await fixture.exec('CREATE TABLE managed_team_repo (marker TEXT)')
    await assert.rejects(async () => { await fixture.open() }, /both team_repo and managed_team_repo exist/u)
    const names = new Set(await fixture.names())
    for (const name of renamed) assert.ok(names.has(name), `${name} survives rollback`)
    assert.equal(names.has('managed_selected_repo'), false, 'no partial renames')
    if (backend === 'postgres') assert.deepEqual(await fixture.query('SELECT version FROM managed_schema_version WHERE version = 3'), [])
    else assert.equal(names.has('managed_schema_version'), false)
  })

  test(`${backend}: fresh and repeated initialization leave unrelated unprefixed tables alone`, async t => {
    const fixture = await database(t, backend)
    await fixture.exec("CREATE TABLE selected_repo (marker TEXT); INSERT INTO selected_repo VALUES ('unrelated')")
    for (let pass = 0; pass < 2; pass++) {
      const db = await fixture.open()
      await db.close()
      assert.deepEqual(await fixture.query('SELECT * FROM selected_repo'), [{ marker: 'unrelated' }])
      assert.deepEqual(await fixture.query('SELECT * FROM managed_selected_repo'), [])
    }
  })
}
