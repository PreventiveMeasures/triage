import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { parseStorageKey, unwrapStorageValue } from '../server-common/storage-crypto.ts'

export const storageTestKey = parseStorageKey(Buffer.alloc(32, 123).toString('base64'))
export async function checkStorageDb(db, other = db) {
  assert.equal(await db.getStorageEncryption(), null)
  const id = randomUUID()
  await db.insertBundle({ id, integrity: 'sha512-test', filename: 'b.zip', kind: null, byteSize: 1, uploadedBy: null, repoId: null }, Date.now())
  const before = await db.getStorageRow('bundle', id)
  assert.equal(before.dataKey, null)
  const [state, concurrent] = await Promise.all([db.enableStorageEncryption(), other.enableStorageEncryption()])
  assert.deepEqual(concurrent, state, 'concurrent activation is idempotent across instances')
  const rows = await Promise.all([db, other].map(store => store.ensureStorageDataKey('bundle', id)))
  assert.equal(rows[0].dataKey, rows[1].dataKey, 'both workers use the persisted key')
  const bytes = unwrapStorageValue(storageTestKey, `managed_bundle:${id}`, rows[0].dataKey)
  assert.equal(bytes.length, 32)
  assert.throws(() => unwrapStorageValue(storageTestKey, `managed_report:${id}`, rows[0].dataKey))
  assert.equal((await db.getBundle(id)).dataKey, undefined)
  assert.equal((await db.listBundles())[0].dataKey, undefined)
  await assert.rejects(db.insertBundle({ id: randomUUID(), integrity: 'another', filename: 'a', kind: null, byteSize: 1, uploadedBy: null, repoId: null }), /data key/u)
  const pending = await db.listStorageMigrationRows(null, 10)
  assert.deepEqual(pending.map(row => ({ ...row })), [{ position: `1:0000000000000001:${id}`, id, type: 'bundle' }])
  await db.advanceStorageMigration(null, null)
  assert.equal((await db.getStorageEncryption()).complete, 0, 'one pass cannot skip pending rows')
  await other.markStorageEncrypted('bundle', id, rows[0].dataKey)
  await db.markStorageEncrypted('bundle', id, rows[0].dataKey)
  assert.equal((await db.getStorageRow('bundle', id)).encrypted, 1)
  await db.advanceStorageMigration(null, null)
  assert.equal((await db.getStorageEncryption()).complete, 1)
  assert.equal((await db.getStorageEncryption()).migrated, 1, 'concurrent completion counts once')
  await other.deleteBundle(id)
  assert.equal(await db.getStorageRow('bundle', id), null)
  assert.equal(await db.ensureStorageDataKey('bundle', id), null)
  await db.markStorageEncrypted('bundle', id, rows[0].dataKey)
  assert.equal(await db.getStorageRow('bundle', id), null, 'completion cannot recreate a deleted row')
  assert.equal((await db.getStorageEncryption()).migrated, 1)
}

export async function checkStorageMigrationOrder(db) {
  const bundles = [], reports = []
  for (const [type, rows] of [['report', reports], ['bundle', bundles]]) {
    // Deliberately insert out of order, including ties and decimal boundaries.
    for (const [suffix, byteSize] of [[1, 100], [3, 2], [2, 2], [4, 10], [5, 0], [6, Number.MAX_SAFE_INTEGER]]) {
      const id = `${type === 'report' ? '11111111' : '22222222'}-1111-4111-8111-${String(suffix).padStart(12, '0')}`
      const common = { id, filename: id, byteSize, uploadedBy: null, repoId: null }
      if (type === 'report') await db.insertReport({ ...common, contentType: 'text/plain', sha256: id }, Date.now())
      else await db.insertBundle({ ...common, kind: null, integrity: id }, Date.now())
      rows.push({ id, type, byteSize })
    }
  }
  const user = await db.upsertUser({ githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
  await db.setUserTokens(user, { accessToken: 'test-access-token', refreshToken: null, expiresAt: null })
  await db.enableStorageEncryption()
  const sorted = rows => rows.toSorted((a, b) => a.byteSize - b.byteSize || (a.id < b.id ? -1 : 1))
  const expected = [...sorted(reports), ...sorted(bundles), { id: user, type: 'user' }].map(({ id, type }) => ({ id, type }))
  const pending = await db.listStorageMigrationRows(null, 100)
  assert.deepEqual(pending.map(({ id, type }) => ({ id, type })), expected)

  // An existing deployment may have a cursor from the old bundle-first order.
  const legacy = `bundle:${bundles[0].id}`
  await db.advanceStorageMigration(null, legacy)
  assert.deepEqual(await db.listStorageMigrationRows(legacy, 100), pending)
  let cursor = legacy
  for (const row of pending) {
    assert.deepEqual(await db.listStorageMigrationRows(cursor, 1), [row], 'bounded batches resume in size order')
    await db.advanceStorageMigration(cursor, row.position)
    cursor = row.position
    assert.equal((await db.getStorageEncryption()).cursor, cursor, 'legacy cursor transitions to the new ordering')
  }
  assert.deepEqual(await db.listStorageMigrationRows(cursor, 1), [])
  await db.advanceStorageMigration(cursor, pending[0].position)
  assert.equal((await db.getStorageEncryption()).cursor, cursor, 'a worker cannot move the cursor backwards')
  await db.advanceStorageMigration(cursor, null)
  assert.equal((await db.getStorageEncryption()).complete, 0, 'deferred rows still prevent completion')
  const first = pending[0], keyed = await db.ensureStorageDataKey(first.type, first.id)
  await db.markStorageEncrypted(first.type, first.id, keyed.dataKey)
  assert.deepEqual(await db.listStorageMigrationRows(null, 100), pending.slice(1), 'completed rows are not retried')
}
