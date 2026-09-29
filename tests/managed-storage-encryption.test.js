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
import { DatabaseSync } from 'node:sqlite'
import { brotliDecompressSync } from 'node:zlib'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createDiskObjectStorage } from '../server-managed/object-storage-disk.ts'
import { openVercelObjectStorage } from '../server-managed/object-storage-vercel.ts'
import { STORAGE_UPLOAD_TTL_MS, createEncryptedObjectStorage } from '../server-managed/storage-encryption.ts'
import { migrateStorage, reapStorageUploads } from '../server-managed/storage-maintenance.ts'
import { createManagedStores } from '../server-managed/storage-stores.ts'
import { openManagedStorage } from '../server-managed/storage.ts'
import { unwrapDataKey } from '../server-managed/storage-db.ts'
import { sdkFixture } from './_managed-vercel.js'
import { checkStorageDb, storageTestKey as key } from './_managed-storage-db.js'

async function fixture(t, remote = false) {
  const dir = await mkdtemp(join(tmpdir(), 'triage-storage-encryption-'))
  const dbPath = join(dir, 'managed.db')
  const db = openSqliteManagedDb(dbPath, { storageEncryptionKey: key })
  const sdk = sdkFixture()
  t.after(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })
  const raw = remote ? await openVercelObjectStorage('token', sdk.sdk) : createDiskObjectStorage(dir)
  const objects = await createEncryptedObjectStorage(raw, db, key), stores = createManagedStores(objects, !remote)
  return { dir, dbPath, db, raw, stores, storage: objects, ...sdk }
}
async function consume(stream) { const parts = []; for await (const part of stream) parts.push(part); return Buffer.concat(parts) }
async function bytes(raw, path) { const opened = await raw.open(path); return opened ? consume(opened.stream) : null }
async function finish(f, options) {
  for (let i = 0; i < 100; i++) {
    const status = await migrateStorage(f.raw, f.db, key, options ?? { maxObjects: 2 })
    if (status.complete && status.cleanupComplete) return status
  }
  throw new Error('Migration did not finish')
}
async function report(f, body = Buffer.from('private report'), id = randomUUID()) {
  const dataKey = await f.stores.reportStore.put(id, body)
  await f.db.insertReport({ id, filename: 'report.json', contentType: 'application/json', byteSize: body.length,
    sha256: createHash('sha256').update(body).digest('base64url'), dataKey, uploadedBy: null, repoId: null }, Date.now())
  return id
}
async function bundle(f, body = Buffer.from('bundle sources'), kind = null) {
  const id = randomUUID()
  const dataKey = await f.stores.bundleStore.put(id, body, kind)
  await f.db.insertBundle({ id, integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`, filename: 'bundle', kind,
    byteSize: body.length, dataKey, uploadedBy: null, repoId: null }, Date.now())
  return id
}

test('SQLite per-row keys, explicit activation, and migration state', async t => {
  const f = await fixture(t)
  await checkStorageDb(f.db)
})

test('a configured key and read-only status do not enable encryption; missing/wrong keys fail after explicit enable', async t => {
  const f = await fixture(t)
  assert.equal(await f.db.getStorageEncryption(), null)
  const id = await report(f)
  assert.equal((await bytes(f.raw, `reports/${id}`)).toString(), 'private report')
  const stale = openSqliteManagedDb(f.dbPath)
  const staleObjects = await createEncryptedObjectStorage(f.raw, stale, null)
  try {
    await f.db.enableStorageEncryption()
    await assert.rejects(staleObjects.get(`reports/${id}`), /encryption key/u)
    await assert.rejects(staleObjects.put(`reports/${randomUUID()}`, Buffer.from('plain')), /encryption key/u)
    await assert.rejects(stale.setUserTokens('no-user', { accessToken: 'token', refreshToken: null, expiresAt: null }), /encryption key/u)
    for (const storageEncryptionKey of [null, randomBytes(32).toString('base64')]) {
      await assert.rejects(openManagedStorage({ dbPath: f.dbPath, storageEncryptionKey }), /encryption key/u)
    }
  } finally { await stale.close() }
})

for (const remote of [false, true]) {
  const backend = remote ? 'Vercel' : 'disk'
  test(`${backend}: migrates reports and compressed bundles in place, invalidates caches, and resumes across instances`, async t => {
    const f = await fixture(t, remote)
    const body = randomBytes(90_000)
    const r = await report(f, body)
    const b = await bundle(f, body, 'sourcemap')
    await f.stores.cacheStorage.put(b, 'metadata.br', Buffer.from('legacy metadata'))
    await f.stores.reportSourcesStorage.put(`${b}/sources.gz`, Buffer.from('legacy sources'))
    await f.stores.avatarStore.put(r, 'image/png', Buffer.from('public avatar'))
    const orphan = `reports/${randomUUID()}`
    await f.raw.put(orphan, Buffer.from('orphan plaintext'))
    await f.db.enableStorageEncryption()
    assert.equal(await f.stores.cacheStorage.exists(b, 'metadata.br'), false)
    assert.equal(await f.stores.reportSourcesStorage.exists(`${b}/sources.gz`), false)
    assert.deepEqual(await f.stores.reportStore.get(r), body)
    assert.deepEqual(brotliDecompressSync(await f.stores.bundleStore.get(b, 'sourcemap')), body)
    // A cache can be built even before its bundle's payload has migrated.
    await f.stores.cacheStorage.put(b, 'metadata.br', Buffer.from('fresh metadata'))
    assert.ok((await f.db.getStorageRow('bundle', b)).dataKey)
    assert.equal((await f.db.getStorageRow('bundle', b)).encrypted, 0)
    const status = await finish(f)
    assert.equal(status.migrated, 2)
    assert.equal(await f.raw.exists(orphan), false)
    assert.equal((await f.raw.list('cache/', null, 100)).objects.length, 0)
    for (const path of [`reports/${r}`, `bundles/${b}.map.br`, `cache-encrypted-v1/bundles/${b}/metadata.br`]) {
      const data = await bytes(f.raw, path)
      assert.equal(data.subarray(0, 16).toString(), 'DeepView.storage')
      assert.equal(data.includes(body.subarray(0, 32)), false)
    }
    const other = openSqliteManagedDb(f.dbPath, { storageEncryptionKey: key })
    try {
      const reopened = createManagedStores(await createEncryptedObjectStorage(f.raw, other, key), !remote)
      assert.deepEqual(await reopened.reportStore.get(r), body)
      assert.deepEqual(brotliDecompressSync(await reopened.bundleStore.get(b, 'sourcemap')), body)
      assert.equal((await consume((await reopened.cacheStorage.open(b, 'metadata.br')).stream)).toString(), 'fresh metadata')
      assert.equal((await reopened.avatarStore.get(r)).bytes.toString(), 'public avatar')
    } finally { await other.close() }
    if (remote) assert.ok(f.calls.some(call => call.op === 'put' && call.options.ifMatch), 'migration uses conditional PUT')
  })

  test(`${backend}: each upload owns a distinct key; deletion removes access even if physical cleanup fails`, async t => {
    const f = await fixture(t, remote)
    await f.db.enableStorageEncryption()
    const a = await report(f, Buffer.from('a')), b = await report(f, Buffer.from('b')), dep = await bundle(f)
    const aRow = await f.db.getStorageRow('report', a), bRow = await f.db.getStorageRow('report', b)
    assert.notDeepEqual(unwrapDataKey(key, 'report', aRow), unwrapDataKey(key, 'report', bRow))
    assert.equal(aRow.encrypted, 1)
    assert.equal((await f.db.getReport(a)).dataKey, undefined)
    await assert.rejects(f.stores.reportStore.put(a, Buffer.from('overwrite')), /immutable/u)
    const original = await bytes(f.raw, `reports/${a}`)
    await f.raw.put(`reports/${a}`, await bytes(f.raw, `reports/${b}`))
    await assert.rejects(f.stores.reportStore.get(a), /authenticat/u)
    await f.raw.put(`reports/${a}`, original)
    await f.stores.cacheStorage.put(dep, 'metadata.json', Buffer.from('cached'))
    await f.stores.reportSourcesStorage.put(`${dep}/sources.json`, Buffer.from('sources'))
    await f.db.deleteReport(a)
    await f.db.deleteBundle(dep)
    assert.equal(await f.stores.reportStore.get(a), null)
    assert.equal(await f.stores.bundleStore.get(dep, null), null)
    assert.equal(await f.stores.cacheStorage.exists(dep, 'metadata.json'), false)
    assert.equal(await f.stores.reportSourcesStorage.exists(`${dep}/sources.json`), false)
    assert.equal(await f.raw.exists(`reports/${a}`), true, 'test deliberately leaves ciphertext behind')
    assert.equal((await f.stores.reportStore.get(b)).toString(), 'b')
  })

  test(`${backend}: plaintext fallback is restricted to pending rows and validates the original hash`, async t => {
    const f = await fixture(t, remote), id = await report(f), pending = await report(f, Buffer.from('other legacy report'))
    await f.db.enableStorageEncryption()
    await f.db.ensureStorageDataKey('report', id)
    assert.equal((await f.stores.reportStore.get(id)).toString(), 'private report')
    await f.raw.put(`reports/${id}`, Buffer.from('replacement'))
    await assert.rejects(f.stores.reportStore.get(id), /upload hash/u)
    await f.raw.put(`reports/${id}`, Buffer.from('private report'))
    await migrateStorage(f.raw, f.db, key, { maxObjects: 1 })
    // Migrate whichever UUID sorted first, while leaving another row pending.
    const migrated = (await f.db.getStorageRow('report', id)).encrypted ? id : pending
    await f.raw.put(`reports/${migrated}`, Buffer.from(migrated === id ? 'private report' : 'other legacy report'))
    assert.equal((await f.db.getStorageEncryption()).complete, 0)
    await assert.rejects(f.stores.reportStore.get(migrated), /plaintext/u)
  })

  test(`${backend}: interrupted PUT and lost SQL acknowledgement resume with the same persisted key`, async t => {
    const f = await fixture(t, remote), id = await report(f)
    await f.db.enableStorageEncryption()
    const put = f.raw.put.bind(f.raw)
    t.mock.method(f.raw, 'put', async (...args) => { await put(...args); throw new Error('lost PUT acknowledgement') })
    await assert.rejects(migrateStorage(f.raw, f.db, key), /pending failures/u)
    const pending = await f.db.getStorageRow('report', id)
    assert.ok(pending.dataKey); assert.equal(pending.encrypted, 0)
    assert.equal((await f.stores.reportStore.get(id)).toString(), 'private report')
    t.mock.restoreAll()
    const mark = f.db.markStorageEncrypted.bind(f.db)
    t.mock.method(f.db, 'markStorageEncrypted', async (...args) => { await mark(...args); throw new Error('lost COMMIT acknowledgement') })
    await assert.rejects(migrateStorage(f.raw, f.db, key), /pending failures/u)
    t.mock.restoreAll()
    await finish(f)
    assert.equal((await f.db.getStorageRow('report', id)).dataKey, pending.dataKey)
    assert.equal((await f.stores.reportStore.get(id)).toString(), 'private report')
  })

  test(`${backend}: failed rows do not lose progress or allow premature completion`, async t => {
    const f = await fixture(t, remote)
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    for (const id of ids) await report(f, Buffer.from(id), id)
    await f.db.enableStorageEncryption()
    await f.raw.delete(`reports/${ids[0]}`)
    await assert.rejects(migrateStorage(f.raw, f.db, key), /pending failures/u)
    assert.equal((await f.db.getStorageRow('report', ids[1])).encrypted, 1)
    assert.equal((await f.db.getStorageEncryption()).complete, 0)
    await f.raw.put(`reports/${ids[0]}`, Buffer.from(ids[0]))
    await finish(f)
    assert.equal((await f.db.getStorageEncryption()).migrated, 2)
  })

  test(`${backend}: concurrent migration and deletion cannot publish a key for a deleted row`, async t => {
    const f = await fixture(t, remote), id = await report(f)
    await f.db.enableStorageEncryption()
    const put = f.raw.put.bind(f.raw)
    t.mock.method(f.raw, 'put', async (...args) => {
      await f.db.deleteReport(id)
      await f.raw.delete(`reports/${id}`)
      return put(...args)
    })
    await finish(f)
    assert.equal(await f.raw.exists(`reports/${id}`), false)
    assert.equal(await f.stores.reportStore.get(id), null)
    assert.equal(await f.db.getStorageRow('report', id), null)
  })

  test(`${backend}: upload parts use fresh ciphertext on retry and expire with legacy parts`, async t => {
    const f = await fixture(t, remote), legacy = randomUUID(), recent = randomUUID()
    await f.stores.uploadStore.put(legacy, Buffer.from('legacy part'))
    if (remote) f.objects.get(`.managed/uploads/${legacy}`).uploadedAt = new Date(0)
    else await utimes(join(f.dir, 'uploads', legacy), new Date(0), new Date(0))
    await f.db.enableStorageEncryption()
    assert.equal((await f.stores.uploadStore.get(legacy)).toString(), 'legacy part')
    await f.stores.uploadStore.put(recent, Buffer.from('new part'))
    const first = await bytes(f.raw, `uploads/${recent}`)
    await f.stores.uploadStore.put(recent, Buffer.from('new part'))
    assert.notDeepEqual(await bytes(f.raw, `uploads/${recent}`), first)
    assert.equal((await f.stores.uploadStore.get(recent)).toString(), 'new part')
    await reapStorageUploads(f.raw, f.db)
    assert.equal(await f.stores.uploadStore.get(legacy), null)
    assert.equal((await f.stores.uploadStore.get(recent)).toString(), 'new part')
    await reapStorageUploads(f.raw, f.db, Date.now() + STORAGE_UPLOAD_TTL_MS + 1000)
    assert.equal(await f.stores.uploadStore.get(recent), null)
  })
}

test('OAuth tokens migrate and remain transparent to refresh; plaintext writes are fenced after activation', async t => {
  const f = await fixture(t)
  const admin = await f.db.upsertUser({ githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
  const tokens = { accessToken: 'github-access-secret', refreshToken: 'github-refresh-secret', expiresAt: 1234 }
  await f.db.setUserTokens(admin, tokens)
  await f.db.enableStorageEncryption()
  assert.deepEqual(await f.db.getUserTokens(admin), tokens)
  await finish(f)
  const sql = new DatabaseSync(f.dbPath)
  try {
    const row = sql.prepare('SELECT gh_access_token AS access, gh_refresh_token AS refresh, gh_tokens_encrypted AS encrypted FROM managed_user WHERE id = ?').get(admin)
    assert.equal(row.encrypted, 1)
    assert.notEqual(row.access, tokens.accessToken)
    assert.notEqual(row.refresh, tokens.refreshToken)
    assert.deepEqual(await f.db.getUserTokens(admin), tokens)
    const renewed = { accessToken: 'renewed-access', refreshToken: null, expiresAt: null }
    await f.db.setUserTokens(admin, renewed)
    await f.db.migrateStorageUserTokens(admin)
    assert.deepEqual(await f.db.getUserTokens(admin), renewed)
    sql.prepare('UPDATE managed_user SET gh_refresh_token = gh_access_token WHERE id = ?').run(admin)
    await assert.rejects(f.db.getUserTokens(admin), /authenticat/u)
  } finally { sql.close() }
})

test('legacy cache cleanup survives offset pagination and ignores unrelated namespaces', async t => {
  const f = await fixture(t, true)
  for (let i = 0; i < 7; i++) await f.raw.put(`cache/old/${i}`, Buffer.from('private cache'))
  f.objects.set('.e2e/keep', { bytes: Buffer.from('other mode') })
  t.mock.method(f.sdk, 'list', ({ prefix, cursor }) => {
    const keys = [...f.objects.keys()].filter(path => path.startsWith(prefix)).toSorted()
    const start = Number(cursor ?? 0)
    const end = start + 2
    return Promise.resolve({ blobs: keys.slice(start, end).map(pathname => ({ pathname })), hasMore: end < keys.length, cursor: String(end) })
  })
  await f.db.enableStorageEncryption()
  await finish(f)
  assert.deepEqual([...f.objects.keys()], ['.e2e/keep'])
})

test('encryption streams a generated 115 MiB payload with bounded input read-ahead', async t => {
  const f = await fixture(t), id = randomUUID()
  const block = randomBytes(65_536), size = 115 * 1024 * 1024
  const hash = createHash('sha256')
  async function* input() { for (let i = 0; i < size / block.length; i++) { hash.update(block); yield block } }
  await f.raw.put(`reports/${id}`, Readable.from(input(), { objectMode: false }))
  await f.db.insertReport({ id, filename: 'large', contentType: 'application/octet-stream', byteSize: size,
    sha256: hash.digest('base64url'), uploadedBy: null, repoId: null }, Date.now())
  await f.db.enableStorageEncryption()
  await finish(f, { maxObjects: 64 })
  let length = 0
  const opened = await f.stores.reportStore.open(id)
  for await (const chunk of opened.stream) length += chunk.length
  assert.equal(length, size)
  assert.equal(opened.size, size)
})

test('CLI status is read-only, enable is explicit, and migration is restartable without a listener', async t => {
  const f = await fixture(t), id = await report(f)
  const run = async flag => {
    const { stdout } = await promisify(execFile)(process.execPath, ['server-managed/cli.js', flag], {
      cwd: process.cwd(), env: { ...process.env, MANAGED_DB_PATH: f.dbPath, MANAGED_STORAGE_ENCRYPTION_KEY: key.bytes.toString('base64'),
        DATABASE_URL: '', MANAGED_DATABASE_URL: '', E2E_DATABASE_URL: '', VERCEL: '',
        GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', OAUTH_CALLBACK_URL: 'https://app.example/api/oauth/github/callback' },
    })
    return JSON.parse(stdout.trim().split('\n').at(-1))
  }
  assert.deepEqual(await run('--storage-encryption-status'), { encryption: 'disabled' })
  await assert.rejects(run('--migrate-storage'), /enable-storage-encryption/u)
  assert.equal((await run('--enable-storage-encryption')).complete, false)
  const final = await run('--migrate-storage')
  assert.equal(final.complete, true); assert.equal(final.cleanupComplete, true)
  assert.equal((await readFile(join(f.dir, 'reports', id))).subarray(0, 16).toString(), 'DeepView.storage')
})

test('a reader that loaded a legacy row retries if migration replaces its file before open', async t => {
  const f = await fixture(t, true), id = await report(f)
  await f.db.enableStorageEncryption()
  const open = f.raw.open.bind(f.raw)
  let first = true
  t.mock.method(f.raw, 'open', async (...args) => {
    if (first && args[0] === `reports/${id}`) { first = false; await finish(f) }
    return open(...args)
  })
  assert.equal((await f.stores.reportStore.get(id)).toString(), 'private report')
})

test('pre-activation writes finishing after enable cannot leave new plaintext behind', async t => {
  const f = await fixture(t, true), id = randomUUID()
  const put = f.raw.put.bind(f.raw)
  t.mock.method(f.raw, 'put', async (...args) => { const result = await put(...args); await f.db.enableStorageEncryption(); return result })
  await assert.rejects(f.stores.reportStore.put(id, Buffer.from('racing plaintext')), /enabled during upload/u)
  assert.equal(await f.raw.exists(`reports/${id}`), false)
})

for (const remote of [false, true]) {
  test(`${remote ? 'Vercel' : 'disk'} concurrent migration workers retain one key and resume safely`, async t => {
    const f = await fixture(t, remote), id = await report(f)
    await f.db.enableStorageEncryption()
    await Promise.all([migrateStorage(f.raw, f.db, key), migrateStorage(f.raw, f.db, key)])
    await finish(f)
    assert.equal((await f.stores.reportStore.get(id)).toString(), 'private report')
    assert.equal((await f.db.getStorageEncryption()).migrated, 1)
  })
}

test('a legacy arbitrary bundle beginning with encryption magic still migrates using its original hash', async t => {
  const f = await fixture(t), original = Buffer.from('DeepView.storagelegacy bundle bytes')
  const id = await bundle(f, original)
  await f.db.enableStorageEncryption()
  await f.db.ensureStorageDataKey('bundle', id)
  assert.deepEqual(await f.stores.bundleStore.get(id, null), original)
  await finish(f)
  assert.deepEqual(await f.stores.bundleStore.get(id, null), original)
})

test('activation racing an unencrypted read does not expose the new ciphertext as plaintext', async t => {
  const f = await fixture(t, true), id = await report(f)
  const open = f.raw.open.bind(f.raw)
  let first = true
  t.mock.method(f.raw, 'open', async (...args) => {
    if (first && args[0] === `reports/${id}`) { first = false; await f.db.enableStorageEncryption(); await finish(f) }
    return open(...args)
  })
  assert.equal((await f.stores.reportStore.get(id)).toString(), 'private report')
})

test('resuming a disk replacement persists the rename before marking the row encrypted', async t => {
  const f = await fixture(t), id = await report(f)
  await f.db.enableStorageEncryption()
  t.mock.method(f.raw, 'sync', () => { throw new Error('directory sync failed') })
  await assert.rejects(migrateStorage(f.raw, f.db, key), /pending failures/u)
  assert.equal((await f.db.getStorageRow('report', id)).encrypted, 0)
  assert.equal((await bytes(f.raw, `reports/${id}`)).subarray(0, 16).toString(), 'DeepView.storage')
  // The retry observes existing ciphertext: it must sync on this path too.
  await assert.rejects(migrateStorage(f.raw, f.db, key), /pending failures/u)
  assert.equal((await f.db.getStorageRow('report', id)).encrypted, 0)
  t.mock.restoreAll()
  await finish(f)
  assert.equal((await f.db.getStorageRow('report', id)).encrypted, 1)
})
