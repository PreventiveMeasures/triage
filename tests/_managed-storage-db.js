import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function checkStorageDb(db, other = db) {
  const keyId = 'a'.repeat(32), path = 'cache/bundles/id/v2.json'
  assert.equal(await db.initializeStorageEncryption(null), null)
  await db.initializeStorageEncryption(keyId)
  await other.initializeStorageEncryption(keyId)
  await assert.rejects(other.initializeStorageEncryption(null), /encryption key/u)
  await assert.rejects(other.initializeStorageEncryption('b'.repeat(32)), /encryption key/u)
  const old = await db.getStorageReference(keyId, path)
  assert.equal(old.legacy, true)
  const deadline = Date.now() + 60_000
  await other.deleteStorageObject(keyId, 'cache/bundles/id/', true)
  assert.equal(await db.publishStorageObject(keyId, path, old.revision, 'encrypted-v1/old', 'old', deadline, true), false)
  const deleted = await db.getStorageReference(keyId, path)
  assert.equal(deleted.legacy, false)
  assert.equal(await db.publishStorageObject(keyId, path, deleted.revision, 'encrypted-v1/migrated', 'migration', deadline, true), false)
  assert.equal(await db.publishStorageObject(keyId, path, deleted.revision, 'encrypted-v1/new', 'new', deadline, false), true)
  assert.equal((await other.getStorageReference(keyId, path)).objectKey, 'encrypted-v1/new')
  assert.equal(await db.canCollectStorageObject(keyId, 'encrypted-v1/new'), false)
  const current = await db.getStorageReference(keyId, path)
  await other.deleteStorageObject(keyId, path, false)
  assert.equal(await db.publishStorageObject(keyId, path, current.revision, 'encrypted-v1/stale', 'stale', deadline, false), false)
  assert.equal(await db.canCollectStorageObject(keyId, 'encrypted-v1/new'), true)
  const gone = await db.getStorageReference(keyId, path)
  assert.equal(await db.publishStorageObject(keyId, path, gone.revision, 'encrypted-v1/expired', 'expired', 0, false), false)
  const sharedPath = `reports/${randomUUID()}`, snapshot = await db.getStorageReference(keyId, sharedPath)
  assert.deepEqual((await Promise.all([db, other].map((store, i) => store.publishStorageObject(keyId, sharedPath,
    snapshot.revision, `encrypted-v1/writer-${i}`, 'digest', deadline, false)))).toSorted(), [false, true])
  const before = await db.getStorageEncryption(keyId)
  assert.equal(await db.advanceStorageMigration(keyId, before.revision, null, 1), true)
  assert.equal(await other.advanceStorageMigration(keyId, before.revision, 'stale', 0), false)
  const next = await other.getStorageEncryption(keyId)
  assert.equal(next.complete, 0)
  await other.advanceStorageMigration(keyId, next.revision, null, 0)
  assert.equal((await db.getStorageEncryption(keyId)).complete, 1)
  assert.equal((await db.getStorageReference(keyId, 'reports/unexpected')).legacy, false)
}
