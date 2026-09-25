import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'

const query = { page: 1, limit: 100, kind: 'all', query: '', contexts: null }
const report = { id: 'r', filename: 'scan.json', contentType: 'application/json', byteSize: 2, sha256: 'x', uploadedBy: null, uploadedByLogin: 'alice', repoId: null, bundleId: null, bundleIntegrity: null }

test('activity migrates existing uploads and triage, persists snapshots after deletion and restart, and does not duplicate backfill', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-activity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(file)
  await db.insertReport(report, 100)
  await db.insertBundle({ id: 'b', integrity: 'hash', filename: 'source.zip', kind: null, byteSize: 4, uploadedBy: null, uploadedByLogin: 'bob', repoId: null }, 200)
  await db.setTriage('finding', { comment: 'annotation body is not in the activity feed' }, null, 'alice', 300)
  await db.close()

  // Recreate the pre-feature schema with existing records, then migrate it.
  const legacy = new DatabaseSync(file)
  legacy.exec(`DROP TRIGGER managed_report_activity; DROP TRIGGER managed_bundle_activity; DROP TABLE managed_activity;
    ALTER TABLE finding_triage_event DROP COLUMN report_id;
    ALTER TABLE finding_triage_event DROP COLUMN report;
    ALTER TABLE finding_triage_event DROP COLUMN repo;`)
  legacy.close()
  db = openSqliteManagedDb(file)
  const first = await db.listActivity(query)
  assert.deepEqual(first.history.map(entry => [entry.kind, entry.actor, entry.at]), [
    ['triage', 'alice', 300], ['upload', 'bob', 200], ['upload', 'alice', 100],
  ])
  assert.equal(first.history[0].report, null, 'legacy triage never invents missing report context')
  assert.doesNotMatch(JSON.stringify(first), /annotation body/u)
  await db.recordActivity({ kind: 'delete', actor: 'alice', action: 'deleted a report', reportId: 'r', report: 'scan.json' }, 400)
  await db.deleteReport('r')
  await db.deleteBundle('b')
  await db.close()
  db = openSqliteManagedDb(file)
  t.after(() => db.close())
  const reopened = await db.listActivity(query)
  assert.equal(reopened.total, 4)
  assert.equal(reopened.history[0].kind, 'delete')
  assert.deepEqual(reopened.history.slice(1), first.history, 'original times and filenames survive deletion')
})

test('activity search and type filters run before pagination; ties, empty pages, and manager context are deterministic', async (t) => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await db.insertReport(report, 1)
  for (let i = 1; i <= 12; i++) await db.setTriageEntries([['shared', { comment: String(i) }]], null, 'alice', 100, 'r')
  await db.setTriage('private', { color: 'red' }, null, 'bob', 200)
  await db.recordActivity({ kind: 'access', actor: 'admin', action: 'changed a private team' }, 300)
  const first = await db.listActivity({ ...query, kind: 'triage', limit: 5 })
  const second = await db.listActivity({ ...query, kind: 'triage', limit: 5, page: 2 })
  assert.equal(first.total, 13)
  assert.equal(first.history[1].id, 'triage:12', 'numeric event order wins timestamp ties')
  assert.equal(new Set([...first.history, ...second.history].map(entry => entry.id)).size, 10)
  assert.equal((await db.listActivity({ ...query, limit: 5, page: 999 })).page, 3)
  const searched = await db.listActivity({ ...query, query: 'ALICE', limit: 5, page: 2 })
  assert.equal(searched.total, 13)
  assert.ok(searched.history.every(entry => entry.actor === 'alice'))
  assert.equal((await db.listActivity({ ...query, query: '%' })).total, 0, 'search is literal, not SQL LIKE syntax')
  assert.deepEqual((await db.listActivity({ ...query, contexts: [] })).history, [])
  const contexts = [{ finding: 'shared', reportId: 'visible', report: 'allowed.json', repo: 'allowed/repo' }]
  const manager = await db.listActivity({ ...query, contexts, limit: 5 })
  assert.equal(manager.total, 12)
  assert.ok(manager.history.every(entry => entry.reportId === 'visible' && entry.report === 'allowed.json' && entry.repo === 'allowed/repo'))
  assert.equal((await db.listActivity({ ...query, contexts, query: 'scan.json' })).total, 0, 'search cannot probe the original private context')
  assert.equal((await db.listActivity({ ...query, contexts, query: 'allowed.json' })).total, 12)
  await db.deleteTriage(['shared'])
  assert.equal((await db.listActivity({ ...query, contexts })).total, 0, 'explicit triage deletion removes its activity too')
})

test('existing activity upgrades bundle identities without trusting filenames, and repeated migrations preserve scope', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-activity-scope-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(file)
  const userId = await db.upsertUser({ githubUserId: 1, login: 'manager', name: null, avatarUrl: null }, 1)
  await db.selectRepo({ repoId: 7, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: userId }, 1)
  await db.createTeam('t', 'Team', 1)
  await db.setTeamRepo('t', 7, null)
  await db.setTeamMember('t', userId, { dependencies: false, security: false })
  await db.insertBundle({ id: 'b', integrity: 'hash', filename: 'same.zip', kind: null, byteSize: 1, uploadedBy: userId, uploadedByLogin: 'manager', repoId: 7 }, 1)
  await db.recordActivity({ kind: 'delete', actor: 'admin', action: 'deleted a private bundle', report: 'same.zip' }, 2)
  await db.close()
  const legacy = new DatabaseSync(file)
  legacy.exec(`DROP TRIGGER managed_report_activity; DROP TRIGGER managed_bundle_activity;
    ALTER TABLE managed_activity DROP COLUMN bundle_id;
    ALTER TABLE managed_activity DROP COLUMN repo_id;
    ALTER TABLE managed_activity DROP COLUMN repo_directory;`)
  legacy.close()
  for (let i = 0; i < 2; i++) {
    db = openSqliteManagedDb(file)
    const manager = await db.listActivity({ ...query, contexts: [], userId: userId })
    assert.equal(manager.total, 1)
    assert.equal(manager.history[0].id, 'bundle-upload:b')
    assert.equal((await db.listActivity(query)).total, 2)
    await db.close()
  }
})
