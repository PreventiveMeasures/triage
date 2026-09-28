import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { parseStorageKey } from '../server-common/storage-crypto.ts'
import { createDiskObjectStorage } from '../server-managed/object-storage-disk.ts'
import { openVercelObjectStorage } from '../server-managed/object-storage-vercel.ts'
import { STORAGE_GC_MS, createEncryptedObjectStorage, stageEncrypted } from '../server-managed/storage-encryption.ts'
import { migrateStorage, reapEncryptedStorage, reapStorageUploads } from '../server-managed/storage-maintenance.ts'
import { createManagedStores } from '../server-managed/storage-stores.ts'
import { openManagedStorage } from '../server-managed/storage.ts'
import { sdkFixture } from './_managed-vercel.js'
import { checkStorageDb } from './_managed-storage-db.js'

const key = parseStorageKey(Buffer.alloc(32, 123).toString('base64'))
const id = 'f8885bac-f7ab-4db2-bd31-fb8618f4f96c'
const report = `reports/${id}`
test('SQLite encryption references, deletion fences, and migration progress', async t => {
  const { db } = await fixture(t)
  await checkStorageDb(db)
})
async function fixture(t, remote = false) {
  const dir = await mkdtemp(join(tmpdir(), 'triage-storage-encryption-'))
  const db = openSqliteManagedDb(join(dir, 'managed.db'))
  const sdk = sdkFixture()
  t.after(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })
  const raw = remote ? await openVercelObjectStorage('token', sdk.sdk) : createDiskObjectStorage(dir)
  return { dir, db, raw, ...sdk }
}
async function bytes(raw, path) {
  const opened = await raw.open(path)
  if (!opened) return null
  const parts = []; for await (const part of opened.stream) parts.push(part)
  return Buffer.concat(parts)
}
async function finish(raw, db, cryptoKey = key) {
  for (let i = 0; i < 100; i++) { const status = await migrateStorage(raw, db, cryptoKey, { maxObjects: 2 }); if (status.complete) return status }
  throw new Error('Migration did not finish')
}

test('disk keyset pages order directories and similarly named files consistently', async t => {
  const { raw } = await fixture(t)
  const paths = ['cache/a/file', 'cache/a.json', 'cache/b/file', 'cache/b.json']
  for (const path of paths) await raw.put(path, Buffer.from(path))
  let cursor = null
  const found = []
  do {
    const page = await raw.list('cache/', cursor, 1)
    found.push(...page.objects.map(object => object.key))
    cursor = page.cursor
  } while (cursor !== null)
  assert.deepEqual(found, paths.toSorted())
})

for (const remote of [false, true]) {
  test(`${remote ? 'Vercel' : 'disk'} encrypts every payload category, migrates legacy data, and survives reopening`, { timeout: 20_000 }, async t => {
    const { raw, db } = await fixture(t, remote)
    const original = Buffer.from('private report and source contents')
    const old = await createEncryptedObjectStorage(raw, db, null)
    const oldStores = createManagedStores(old, !remote)
    await oldStores.reportStore.put(id, original)
    await oldStores.bundleStore.put(id, original, 'sourcemap')
    await oldStores.uploadStore.put(id, original)
    await oldStores.avatarStore.put(id, 'image/png', original)
    await oldStores.cacheStorage.put(id, 'v2-metadata.json.br', original)
    await oldStores.reportSourcesStorage.put(`${id}/v1.json.gz`, original)
    const storedBundle = await oldStores.bundleStore.get(id, 'sourcemap')
    const encrypted = await createEncryptedObjectStorage(raw, db, key)
    const stores = createManagedStores(encrypted, !remote)
    assert.deepEqual(await stores.reportStore.get(id), original)
    assert.deepEqual(await stores.bundleStore.get(id, 'sourcemap'), storedBundle)
    await assert.rejects(old.put(`reports/${randomUUID()}`, original), /requires its configured encryption key/u)
    await stores.reportStore.put(randomUUID(), original)
    await stores.uploadStore.put(randomUUID(), original)
    const status = await finish(raw, db)
    assert.equal(status.complete, 1)
    assert.equal(status.migrated, remote ? 6 : 7)
    for (const prefix of ['reports/', 'bundles/', 'uploads/', 'avatars/', 'cache/']) assert.equal((await raw.list(prefix, null, 100)).objects.length, 0)
    for (const object of (await raw.list('encrypted-v1/', null, 100)).objects) {
      const contents = await bytes(raw, object.key)
      assert.equal(contents.subarray(0, 16).toString(), 'DeepView.storage')
      assert.equal(contents.includes(original), false)
    }
    const reopened = createManagedStores(await createEncryptedObjectStorage(raw, db, key), !remote)
    assert.deepEqual(await reopened.reportStore.get(id), original)
    assert.deepEqual(await reopened.bundleStore.get(id, 'sourcemap'), storedBundle)
    assert.deepEqual(await reopened.uploadStore.get(id), original)
    assert.deepEqual(await reopened.avatarStore.get(id), { bytes: original, contentType: 'image/png' })
    assert.equal(await reopened.cacheStorage.exists(id, 'v2-metadata.json.br'), true)
    await assert.rejects(createEncryptedObjectStorage(raw, db, null), /encryption key/u)
    await assert.rejects(createEncryptedObjectStorage(raw, db, parseStorageKey(randomBytes(32).toString('base64'))), /encryption key/u)
    const unexpected = `reports/${randomUUID()}`
    await raw.put(unexpected, original)
    assert.equal(await encrypted.get(unexpected), null)
  })

  test(`${remote ? 'Vercel' : 'disk'} migration respects concurrent overwrite, exact delete, and prefix delete`, async t => {
    const { raw, db } = await fixture(t, remote)
    for (const action of ['overwrite', 'delete', 'prefix']) {
      const logical = action === 'prefix' ? `cache/bundles/${randomUUID()}/v2.json` : `reports/${randomUUID()}`
      await raw.put(logical, Buffer.from('legacy'))
      const store = await createEncryptedObjectStorage(raw, db, key)
      const put = raw.put.bind(raw)
      let injected = false
      t.mock.method(raw, 'put', async (...args) => {
        await put(...args)
        if (injected || !args[0].startsWith('encrypted-v1/')) return
        injected = true
        if (action === 'overwrite') await store.put(logical, Buffer.from('new version'))
        else if (action === 'delete') await store.delete(logical)
        else await store.deletePrefix(logical.slice(0, logical.lastIndexOf('/') + 1))
      })
      // Run a full pass, but do not complete the global migration until all
      // scenarios have populated their legacy fixtures.
      await migrateStorage(raw, db, key, { maxObjects: 1 })
      assert.equal(injected, true)
      assert.deepEqual(await store.get(logical), action === 'overwrite' ? Buffer.from('new version') : null)
      assert.equal(await raw.exists(logical), false)
      t.mock.restoreAll()
    }
  })
}

test('a read racing migration retries the published encrypted reference', async t => {
  const { raw, db } = await fixture(t, true)
  await raw.put(report, Buffer.from('legacy'))
  const store = await createEncryptedObjectStorage(raw, db, key)
  const open = raw.open.bind(raw)
  let raced = false
  t.mock.method(raw, 'open', async (...args) => {
    if (!raced && args[0] === report) { raced = true; await finish(raw, db) }
    return open(...args)
  })
  assert.deepEqual(await store.get(report), Buffer.from('legacy'))
})

test('interrupted migration retains the original; verification failure never publishes; uncertain commits retain ciphertext', async t => {
  const { raw, db } = await fixture(t, true)
  await raw.put(report, Buffer.from('legacy'))
  const store = await createEncryptedObjectStorage(raw, db, key)
  const put = raw.put.bind(raw)
  t.mock.method(raw, 'put', async (path, contents, signal) => {
    await put(path, contents, signal)
    throw new Error('transfer interrupted')
  })
  await assert.rejects(migrateStorage(raw, db, key), /transfer interrupted/u)
  assert.deepEqual(await store.get(report), Buffer.from('legacy'))
  t.mock.restoreAll()
  t.mock.method(raw, 'put', async (path, contents, signal) => {
    await put(path, contents, signal)
    if (path.startsWith('encrypted-v1/')) await put(path, Buffer.from('corrupted'), signal)
  })
  await assert.rejects(migrateStorage(raw, db, key), /envelope/u)
  assert.deepEqual(await store.get(report), Buffer.from('legacy'))
  t.mock.restoreAll()
  const publish = db.publishStorageObject.bind(db)
  t.mock.method(db, 'publishStorageObject', async (...args) => { await publish(...args); throw new Error('commit acknowledgement lost') })
  await assert.rejects(migrateStorage(raw, db, key), /acknowledgement lost/u)
  assert.deepEqual(await store.get(report), Buffer.from('legacy'))
  assert.ok((await db.getStorageReference(key.id, report)).objectKey)
  t.mock.restoreAll()
  await finish(raw, db)
  assert.equal(await raw.exists(report), false)
  assert.deepEqual(await store.get(report), Buffer.from('legacy'))
})

for (const damage of ['missing', 'corrupt']) {
  test(`resuming a committed migration preserves plaintext when the encrypted copy is ${damage}`, async t => {
    const { raw, db } = await fixture(t, true)
    await raw.put(report, Buffer.from('legacy'))
    await createEncryptedObjectStorage(raw, db, key)
    const publish = db.publishStorageObject.bind(db)
    t.mock.method(db, 'publishStorageObject', async (...args) => { await publish(...args); throw new Error('commit acknowledgement lost') })
    await assert.rejects(migrateStorage(raw, db, key), /acknowledgement lost/u)
    t.mock.restoreAll()
    const reference = await db.getStorageReference(key.id, report)
    const encrypted = await bytes(raw, reference.objectKey)
    if (damage === 'missing') await raw.delete(reference.objectKey)
    else await raw.put(reference.objectKey, Buffer.from('damaged'))
    await assert.rejects(migrateStorage(raw, db, key))
    assert.deepEqual(await bytes(raw, report), Buffer.from('legacy'), 'keep the recovery copy')
    assert.equal((await db.getStorageEncryption(key.id)).complete, 0)
    await raw.put(reference.objectKey, encrypted)
    await finish(raw, db)
    assert.equal(await raw.exists(report), false)
  })
}

test('missing or corrupt encrypted objects never fall back to a legacy copy', async t => {
  const { raw, db } = await fixture(t, true)
  await raw.put(report, Buffer.from('legacy'))
  const store = await createEncryptedObjectStorage(raw, db, key)
  await store.put(report, Buffer.from('new'))
  const ref = await db.getStorageReference(key.id, report)
  await raw.put(ref.objectKey, Buffer.from('damaged'))
  await assert.rejects(store.get(report), /envelope/u)
  await raw.delete(ref.objectKey)
  await assert.rejects(store.get(report), /unavailable/u)
  await assert.rejects(store.exists(report), /unavailable/u)
})

test('replaying an older ciphertext at a newer generation cannot roll an object back', async t => {
  const { raw, db } = await fixture(t, true)
  const store = await createEncryptedObjectStorage(raw, db, key)
  await store.put(report, Buffer.from('old'))
  const old = await bytes(raw, (await db.getStorageReference(key.id, report)).objectKey)
  await store.put(report, Buffer.from('new'))
  await raw.put((await db.getStorageReference(key.id, report)).objectKey, old)
  await assert.rejects(store.get(report))
})

test('migration resumes across budgets and offset pagination while replicas share one store', async t => {
  const { raw, db, objects } = await fixture(t, true)
  const store = await createEncryptedObjectStorage(raw, db, key)
  const identities = Array.from({ length: 80 }, () => `reports/${randomUUID()}`)
  for (const identity of identities) await raw.put(identity, Buffer.from(identity))
  // Some providers advance opaque cursors by offset. Deleting earlier pages
  // must not make migration report completion while skipped plaintext remains.
  t.mock.method(raw, 'list', (prefix, cursor, limit) => {
    const all = [...objects].filter(([name]) => name.startsWith(`.managed/${prefix}`)).toSorted()
    const offset = Number(cursor ?? 0), page = all.slice(offset, offset + limit)
    return Promise.resolve({ objects: page.map(([name, value]) => ({ key: name.slice(9), modifiedAt: +value.uploadedAt })),
      cursor: offset + limit < all.length ? String(offset + limit) : null })
  })
  const first = await migrateStorage(raw, db, key, { maxObjects: 7 })
  assert.equal(first.complete, 0)
  assert.equal(first.migrated, 7)
  await Promise.all([finish(raw, db), finish(raw, db)])
  assert.equal((await db.getStorageEncryption(key.id)).migrated, 80)
  assert.equal((await raw.list('reports/', null, 100)).objects.length, 0)
  for (const identity of identities) assert.deepEqual(await store.get(identity), Buffer.from(identity))
})

test('an aborted streaming write closes its source and never publishes a partial object', async t => {
  const { raw, db } = await fixture(t)
  await createEncryptedObjectStorage(raw, db, key)
  const controller = new AbortController()
  const source = Readable.from((async function* () {
    yield Buffer.alloc(65_536)
    controller.abort()
    yield Buffer.alloc(65_536)
  })(), { objectMode: false })
  await assert.rejects(stageEncrypted(raw, key, report, source, null, controller.signal), /abort/iu)
  assert.equal(source.destroyed, true)
  assert.equal((await db.getStorageReference(key.id, report)).objectKey, null)
  assert.deepEqual((await raw.list('encrypted-v1/', null, 100)).objects, [])
})

test('a 115 MiB bundle migrates and decrypts as a stream', { timeout: 30_000 }, async t => {
  const { raw, db } = await fixture(t)
  const block = randomBytes(65_536), expected = createHash('sha256'), identity = `bundles/${id}`, size = 115 * 1024 * 1024
  const source = Readable.from((async function* () {
    for (let written = 0; written < size; written += block.length) { expected.update(block); yield block }
  })(), { objectMode: false })
  await raw.put(identity, source)
  const store = await createEncryptedObjectStorage(raw, db, key)
  await migrateStorage(raw, db, key, { maxObjects: 1 })
  const actual = createHash('sha256'), opened = await store.open(identity)
  assert.equal(opened.size, size)
  let length = 0
  for await (const chunk of opened.stream) { actual.update(chunk); length += chunk.length }
  assert.equal(length, size)
  assert.equal(actual.digest('hex'), expected.digest('hex'))
  assert.equal(await raw.exists(identity), false)
})

test('concurrent identical writes converge; garbage collection retains live and recent candidates', async t => {
  const { raw, db, objects } = await fixture(t, true)
  const store = await createEncryptedObjectStorage(raw, db, key)
  const second = await createEncryptedObjectStorage(raw, db, key)
  await Promise.all([store.put(report, Buffer.from('content')), second.put(report, Buffer.from('content'))])
  assert.deepEqual(await store.get(report), Buffer.from('content'))
  const obsolete = (await db.getStorageReference(key.id, report)).objectKey
  await store.put(report, Buffer.from('replacement'))
  const orphan = `encrypted-v1/${randomUUID()}`
  await raw.put(orphan, Buffer.from('orphan'))
  const now = Date.now()
  for (const [name, value] of objects) if (name !== `.managed/${orphan}`) value.uploadedAt = new Date(now - STORAGE_GC_MS - 1)
  await reapEncryptedStorage(raw, db, key, now)
  assert.equal(await raw.exists(obsolete), false)
  assert.equal(await raw.exists(orphan), true)
  assert.deepEqual(await store.get(report), Buffer.from('replacement'))
})

test('production disk storage enables encryption and rejects a missing key after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-managed-encrypted-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const config = { dbPath: join(dir, 'managed.db'), storageEncryptionKey: key.bytes.toString('base64') }
  const storage = await openManagedStorage(config)
  try {
    await storage.reportStore.put(id, Buffer.from('report'))
    await storage.avatarStore.put(id, 'image/png', Buffer.from('avatar'))
    const ref = await storage.db.getStorageReference(key.id, report)
    assert.equal((await readFile(join(dir, ref.objectKey))).includes(Buffer.from('report')), false)
    assert.deepEqual(await storage.reportStore.get(id), Buffer.from('report'))
    await storage.reapStorage()
    assert.equal((await storage.storageEncryptionStatus()).complete, 1)
  } finally { await storage.db.close() }
  await assert.rejects(openManagedStorage({ dbPath: config.dbPath }), /encryption key/u)
})

test('ciphertext collection still runs when a migration batch fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-managed-encrypted-reap-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storage = await openManagedStorage({ dbPath: join(dir, 'managed.db'), storageEncryptionKey: key.bytes.toString('base64') })
  try {
    const orphan = `encrypted-v1/${randomUUID()}`, raw = createDiskObjectStorage(dir)
    await raw.put(orphan, Buffer.from('abandoned candidate'))
    const old = new Date(Date.now() - STORAGE_GC_MS - 1000)
    await utimes(join(dir, orphan), old, old)
    t.mock.method(storage.db, 'advanceStorageMigration', () => Promise.reject(new Error('migration unavailable')))
    await assert.rejects(storage.reapStorage())
    assert.equal(await raw.exists(orphan), false)
  } finally { await storage.db.close() }
})

test('expired upload cleanup does not remove a concurrently retried encrypted part', async t => {
  const { raw, db } = await fixture(t, true)
  const store = await createEncryptedObjectStorage(raw, db, key)
  const upload = `uploads/${id}`
  await store.put(upload, Buffer.from('old'))
  const now = Date.now() + STORAGE_GC_MS + 1000
  const list = db.listExpiredStorageUploads.bind(db)
  t.mock.method(db, 'listExpiredStorageUploads', async (...args) => {
    const result = await list(...args)
    // The test clock only moves maintenance's cutoff; a successful retry
    // changes the reference generation before its conditional deletion.
    const get = db.getStorageReference.bind(db)
    let injected = false
    t.mock.method(db, 'getStorageReference', async (...params) => {
      const snapshot = await get(...params)
      if (!injected) { injected = true; await store.put(upload, Buffer.from('retry')) }
      return snapshot
    })
    return result
  })
  await reapStorageUploads(raw, db, key, now)
  assert.deepEqual(await store.get(upload), Buffer.from('retry'))
})

test('legacy staging cleanup reaches later pages and preserves a part retried after listing', async t => {
  const { raw, db, objects } = await fixture(t, true)
  const old = Date.now() - STORAGE_GC_MS - 1000
  for (let i = 0; i < 205; i++) {
    const identity = `uploads/${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`
    await raw.put(identity, Buffer.from('part'))
    if (i >= 200) objects.get(`.managed/${identity}`).uploadedAt = new Date(old)
  }
  const retry = 'uploads/00000200-0000-0000-0000-000000000000'
  const open = raw.open.bind(raw)
  t.mock.method(raw, 'open', async (...args) => {
    if (args[0] === retry) await raw.put(retry, Buffer.from('retry'))
    return open(...args)
  })
  await reapStorageUploads(raw, db, null)
  assert.equal(objects.size, 201)
  assert.deepEqual(await bytes(raw, retry), Buffer.from('retry'))
})

test('the managed CLI reports status and completes a resumable disk migration without starting HTTP', async t => {
  const { dir, raw } = await fixture(t)
  await raw.put(report, Buffer.from('legacy'))
  const env = { MANAGED_DB_PATH: join(dir, 'managed.db'), MANAGED_STORAGE_ENCRYPTION_KEY: key.bytes.toString('base64'),
    GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', OAUTH_CALLBACK_URL: 'https://app.example/api/oauth/github/callback' }
  const run = async flag => {
    const result = await promisify(execFile)(process.execPath, ['server-managed/cli.js', flag], { env, timeout: 15_000 })
    return result.stdout.trim().split('\n').map(line => JSON.parse(line)).at(-1)
  }
  assert.equal((await run('--storage-encryption-status')).complete, false)
  assert.deepEqual(await run('--migrate-storage'), { encryption: 'chacha20-poly1305', complete: true, migrated: 1, cursor: null })
  assert.equal((await run('--storage-encryption-status')).complete, true)
})
