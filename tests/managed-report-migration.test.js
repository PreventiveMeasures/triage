import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createDiskBlobStore } from '../server-managed/blob-store.ts'
import { managedCsv } from './_managed-csv.js'

async function legacyDatabase(t) {
  const dir = await mkdtemp(join(tmpdir(), 'managed-report-migration-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.sqlite')
  const store = createDiskBlobStore(join(dir, 'reports'))
  const db = openSqliteManagedDb(path)
  const userId = await db.upsertUser({ githubUserId: 1, login: 'member', name: null, avatarUrl: null }, 100)
  await db.setUserRole(userId, 'triage')
  await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: userId }, 100)
  const teamId = randomUUID()
  await db.createTeam(teamId, 'Scoped team', 100)
  await db.setTeamRepo(teamId, 7, 'packages/a')
  await db.setTeamMember(teamId, userId, { dependencies: true, security: false })
  const ids = []
  for (const directory of ['packages/a', './packages/a/sub/', 'packages/ab', 'packages/b', '']) {
    const id = randomUUID()
    const bytes = Buffer.from(JSON.stringify({ repo: { github: 'o/r', directory }, findings: [{ id: 'finding', file: 'a.js' }] }))
    await db.insertReport({ id, filename: 'report.json', contentType: 'application/json', byteSize: bytes.length, sha256: id, uploadedBy: userId, repoId: 7, visible: true }, 100)
    await store.put(id, bytes)
    ids.push(id)
  }
  await db.close()
  const legacy = new DatabaseSync(path)
  legacy.exec('ALTER TABLE managed_report DROP COLUMN repo_directory')
  legacy.exec('ALTER TABLE managed_report DROP COLUMN repo_embedded')
  legacy.close()
  return { path, store, userId, teamId, ids }
}

test('legacy report migration preserves scoped access from blob headers without admitting siblings or root reports', async (t) => {
  const { path, userId, ids } = await legacyDatabase(t)
  let db = openSqliteManagedDb(path)
  const reports = await db.listReports()
  assert.deepEqual(ids.map((id) => reports.find((r) => r.id === id).repoDirectory), ['packages/a', 'packages/a/sub', 'packages/ab', 'packages/b', ''])
  assert.ok(reports.every((r) => r.repoEmbedded))
  assert.deepEqual((await db.listTeamsForUser(userId))[0].reports.map((r) => r.id).toSorted(), ids.slice(0, 2).toSorted())
  for (const [index, id] of ids.entries()) {
    assert.equal(await db.userCanReadReport(userId, id), index < 2)
    assert.deepEqual(await db.reportPermissionsFor(userId, id), { dependencies: index < 2, security: false })
  }
  await db.setReportRepo(ids[0], 7, 'new/location')
  await db.close()
  db = openSqliteManagedDb(path)
  t.after(() => db.close())
  assert.equal((await db.getReport(ids[0])).repoDirectory, 'new/location', 'reopening never overwrites already-migrated metadata')
})

test('legacy CSV migration keeps its assigned repository and raw bytes, with no invented directory', async (t) => {
  const { path, store, userId, ids } = await legacyDatabase(t)
  const raw = new DatabaseSync(path)
  raw.prepare('UPDATE managed_report SET filename = ?, content_type = ? WHERE id = ?').run('export.CSV', 'text/csv', ids[0])
  raw.close()
  await store.put(ids[0], Buffer.from(managedCsv))
  const db = openSqliteManagedDb(path)
  t.after(() => db.close())
  const migrated = await db.getReport(ids[0])
  assert.equal(migrated.repoId, 7)
  assert.equal(migrated.repoDirectory, '')
  assert.equal(migrated.repoEmbedded, false)
  assert.equal(migrated.visible, true)
  assert.equal(await db.userCanReadReport(userId, ids[0]), false, 'root CSV does not enter a directory-scoped team')
  assert.equal((await store.get(ids[0])).toString(), managedCsv, 'migration preserves the downloadable export')
})

test('invalid legacy CSV rolls back migration and allows a repaired export to retry', async (t) => {
  const { path, store, ids } = await legacyDatabase(t)
  const raw = new DatabaseSync(path)
  raw.prepare('UPDATE managed_report SET filename = ? WHERE id = ?').run('bad.csv', ids[1])
  raw.close()
  await store.put(ids[1], Buffer.from('not,a,codex,export\na,b,c,d'))
  assert.throws(() => openSqliteManagedDb(path), /unreadable report/u)
  const rolledBack = new DatabaseSync(path)
  assert.ok(!rolledBack.prepare('PRAGMA table_info(managed_report)').all().some((column) => column.name === 'repo_directory'))
  rolledBack.close()
  await store.put(ids[1], Buffer.from(managedCsv))
  const repaired = openSqliteManagedDb(path)
  t.after(() => repaired.close())
  assert.equal((await repaired.getReport(ids[1])).repoDirectory, '')
})

for (const failure of ['missing', 'malformed', 'oversized directory', 'internal control character', 'leading control character', 'trailing control character', 'leading space', 'trailing space', 'backslash']) {
  test(`legacy report migration rolls back and retries after a ${failure} blob is repaired`, async (t) => {
    const { path, store, userId, ids } = await legacyDatabase(t)
    const bytes = await store.get(ids[1])
    if (failure === 'missing') await store.delete(ids[1])
    else if (failure === 'malformed') await store.put(ids[1], Buffer.from('not a report'))
    else {
      const directory = {
        'oversized directory': 'a/'.repeat(249) + 'aaa',
        'internal control character': 'packages/a\t/sub',
        'leading control character': '\tpackages/a/sub',
        'trailing control character': 'packages/a/sub\n',
        'leading space': ' packages/a/sub',
        'trailing space': 'packages/a/sub ',
        'backslash': 'packages\\a/sub',
      }[failure]
      await store.put(ids[1], Buffer.from(JSON.stringify({ repo: { github: 'o/r', directory }, findings: [] })))
    }
    assert.throws(() => openSqliteManagedDb(path))
    const raw = new DatabaseSync(path)
    assert.ok(!raw.prepare('PRAGMA table_info(managed_report)').all().some((c) => c.name === 'repo_directory'), 'failed migration must not be mistaken for a completed upgrade')
    raw.close()
    await store.put(ids[1], bytes)
    const db = openSqliteManagedDb(path)
    t.after(() => db.close())
    assert.equal(await db.userCanReadReport(userId, ids[0]), true)
    assert.equal(await db.userCanReadReport(userId, ids[1]), true)
    assert.equal(await db.userCanReadReport(userId, ids[2]), false)
  })
}
