import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'

const identity = (githubUserId, login) => ({ githubUserId, login, name: null, avatarUrl: null })
const report = (id, userId) => ({ id, filename: 'scan.json', contentType: 'application/json', byteSize: 2, sha256: id, uploadedBy: userId, uploadedByLogin: 'alice', repoId: null, bundleId: null, bundleIntegrity: null })
const bundle = (id, userId) => ({ id, integrity: id, filename: 'source.zip', kind: null, byteSize: 2, uploadedBy: userId, uploadedByLogin: 'alice', repoId: null })
const lastActivity = async (db, userId) => (await db.listUsers()).find(user => user.id === userId).lastActivityAt

test('Last Activity selects the latest triage, upload or management history for the stable actor ID', async (t) => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const alice = await db.upsertUser(identity(1, 'alice'), 100)
  const bob = await db.upsertUser(identity(2, 'bob'), 100)
  assert.equal(await lastActivity(db, alice), null)
  await db.insertReport(report('r', alice), 200)
  assert.equal(await lastActivity(db, alice), 200)
  await db.insertBundle(bundle('b', alice), 300)
  assert.equal(await lastActivity(db, alice), 300)
  await db.setTriage('finding', { color: 'red' }, alice, 'alice', 400)
  assert.equal(await lastActivity(db, alice), 400)
  await db.recordActivity({ kind: 'access', actor: 'alice', actorId: alice, action: "changed bob's role" }, 500)
  assert.equal(await lastActivity(db, alice), 500)
  assert.equal(await lastActivity(db, bob), null, 'the target of a management action is not its actor')
  await db.recordActivity({ kind: 'repository', actor: 'alice', actorId: alice, action: 'connected a repository' }, 450)
  assert.equal(await lastActivity(db, alice), 500, 'event order cannot move the latest timestamp backwards')
  await db.upsertUser(identity(1, 'renamed'), 600)
  const recycled = await db.upsertUser(identity(3, 'alice'), 600)
  assert.equal(await lastActivity(db, alice), 500, 'renaming retains attribution')
  assert.equal(await lastActivity(db, recycled), null, 'reusing a login never inherits its former owner’s activity')
  await db.recordActivity({ kind: 'delete', actor: 'bob', action: 'legacy action without an identity' }, 700)
  assert.equal(await lastActivity(db, bob), null, 'historical display names alone do not establish identity')
})

test('upload activity survives content deletion and restart without changing the user row', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-user-activity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(file)
  const userId = await db.upsertUser(identity(1, 'alice'), 100)
  await db.insertReport(report('r', userId), 200)
  await db.insertBundle(bundle('b', userId), 300)
  await db.deleteReport('r')
  await db.deleteBundle('b')
  await db.close()
  db = openSqliteManagedDb(file)
  t.after(() => db.close())
  assert.equal(await lastActivity(db, userId), 300)
  const sql = new DatabaseSync(file)
  t.after(() => sql.close())
  const user = sql.prepare('SELECT updated_at, last_seen_at FROM managed_user WHERE id = ?').get(userId)
  assert.equal(user.updated_at, 100)
  assert.equal(user.last_seen_at, null)
})

test('Last Activity migration recovers known upload IDs, retains triage activity, and replaces legacy upload triggers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-user-activity-migration-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(file)
  const uploader = await db.upsertUser(identity(1, 'alice'), 100)
  const reviewer = await db.upsertUser(identity(2, 'reviewer'), 100)
  const unknown = await db.upsertUser(identity(3, 'unknown'), 100)
  await db.insertReport(report('r', uploader), 200)
  await db.insertBundle(bundle('b', uploader), 300)
  await db.setTriage('f', { color: 'red' }, reviewer, 'reviewer', 350)
  await db.recordActivity({ kind: 'access', actor: 'unknown', action: 'old action without stable attribution' }, 400)
  await db.close()
  const legacy = new DatabaseSync(file)
  legacy.exec(`DROP TRIGGER managed_report_activity; DROP TRIGGER managed_bundle_activity;
    DROP INDEX managed_activity_actor_at_idx; ALTER TABLE managed_activity DROP COLUMN actor_id;
    CREATE TRIGGER managed_report_activity AFTER INSERT ON managed_report BEGIN SELECT 1; END;
    CREATE TRIGGER managed_bundle_activity AFTER INSERT ON managed_bundle BEGIN SELECT 1; END;`)
  legacy.close()
  db = openSqliteManagedDb(file)
  assert.equal(await lastActivity(db, uploader), 300)
  assert.equal(await lastActivity(db, reviewer), 350)
  assert.equal(await lastActivity(db, unknown), null)
  await db.insertReport(report('new-r', uploader), 500)
  assert.equal(await lastActivity(db, uploader), 500)
  await db.insertBundle(bundle('new-b', uploader), 600)
  assert.equal(await lastActivity(db, uploader), 600)
  await db.close()
  db = openSqliteManagedDb(file)
  t.after(() => db.close())
  assert.equal(await lastActivity(db, uploader), 600)
  assert.equal(await lastActivity(db, reviewer), 350)
  assert.equal(await lastActivity(db, unknown), null)
})
