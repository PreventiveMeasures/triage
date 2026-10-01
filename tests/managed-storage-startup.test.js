import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { sdkFixture } from './_managed-vercel.js'
import * as blobSdk from '../server-common/vercel-blob.ts'

// Exercise production startup and request-driven maintenance. Only the
// external providers are replaced; PostgreSQL semantics have separate tests.
let databasePath, sdk
mock.module('../server-managed/db-neon.ts', { namedExports: {
  openNeonManagedDb: (_url, options) => Promise.resolve(openSqliteManagedDb(databasePath, options)),
} })
mock.module('../server-common/vercel-blob.ts', { namedExports: { ...blobSdk, loadVercelBlobSdk: () => Promise.resolve(sdk) } })
mock.module('../server-managed/static.ts', { namedExports: { loadManagedStatic: () => () => false } })
const { openManagedStorage } = await import('../server-managed/storage.ts')
const { createManagedApp } = await import('../server-managed/index.ts')

test('Vercel first requests resume bounded migration only when enabled, including across cold starts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-startup-migration-'))
  databasePath = join(dir, 'managed.db')
  const fixture = sdkFixture()
  sdk = fixture.sdk
  const logs = []
  t.mock.method(console, 'info', (...args) => logs.push(args))
  t.mock.method(globalThis, 'setInterval', () => { throw new Error('serverless migration must not install timers') })
  const config = { dbPath: databasePath, neonUrl: 'postgres://fixture', blobToken: 'fixture', serverless: true, host: 'localhost' }
  const legacy = await openManagedStorage(config)
  let app, legacyOpen = true
  async function request() {
    const res = { status: null, writeHead(status) { this.status = status }, end() {} }
    await app.handleRequest({ url: '/api/config', method: 'GET', headers: {} }, res)
    assert.equal(res.status, 200)
  }
  try {
    for (let i = 0; i < 66; i++) {
      const body = Buffer.from(`report ${i}`), id = randomUUID()
      await legacy.reportStore.put(id, body)
      await legacy.db.insertReport({ id, filename: 'report', contentType: 'text/plain', byteSize: body.length,
        sha256: createHash('sha256').update(body).digest('base64url'), uploadedBy: null, repoId: null }, Date.now())
    }
    await legacy.db.close()
    legacyOpen = false
    config.storageEncryptionKey = Buffer.alloc(32, 123).toString('base64')
    app = await createManagedApp(config)
    await request()
    await app.close(); app = null
    let status = await openManagedStorage(config)
    assert.equal((await status.storageEncryptionStatus()).migrated, 0)
    await status.db.close()

    config.storageEncryptionMigrate = true
    app = await createManagedApp(config)
    await request()
    await app.close(); app = null
    status = await openManagedStorage(config)
    const first = await status.storageEncryptionStatus()
    assert.equal(first.migrated, 64, 'one request never loops through all batches')
    assert.equal(first.complete, 0)
    await status.db.close()

    config.storageEncryptionMigrate = false
    app = await createManagedApp(config)
    await request()
    await app.close(); app = null
    status = await openManagedStorage(config)
    assert.deepEqual(await status.storageEncryptionStatus(), first, 'the switch pauses migration without losing progress')
    await status.db.close()

    config.storageEncryptionMigrate = true
    app = await createManagedApp(config)
    await request()
    status = await openManagedStorage(config)
    try {
      for (let i = 0; i < 10 && !(await status.storageEncryptionStatus()).cleanupComplete; i++) await app.reap()
      const final = await status.storageEncryptionStatus()
      assert.equal(final.complete, 1)
      assert.equal(final.cleanupComplete, 1)
      assert.equal(final.migrated, 66)
      const count = logs.filter(([label]) => label === 'managed-storage-migration:').length
      await app.reap()
      assert.equal(logs.filter(([label]) => label === 'managed-storage-migration:').length, count, 'completed migration is a no-op')
    } finally { await status.db.close() }
    for (const [path, object] of fixture.objects) {
      if (path.startsWith('.managed/reports/')) assert.equal(object.bytes.subarray(0, 16).toString(), 'DeepView.storage')
    }
  } finally {
    await app?.close()
    if (legacyOpen) await legacy.db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
