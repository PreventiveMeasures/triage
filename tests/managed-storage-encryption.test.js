import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, open as openFile, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliDecompressSync } from 'node:zlib'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createDiskObjectStorage } from '../server-managed/object-storage-disk.ts'
import { openVercelObjectStorage } from '../server-managed/object-storage-vercel.ts'
import { STORAGE_DISABLED_TTL_MS, STORAGE_UPLOAD_TTL_MS, createEncryptedObjectStorage } from '../server-managed/storage-encryption.ts'
import { migrateStorage, reapStorageUploads } from '../server-managed/storage-maintenance.ts'
import { createManagedStores } from '../server-managed/storage-stores.ts'
import { openManagedStorage } from '../server-managed/storage.ts'
import { unwrapDataKey } from '../server-managed/storage-db.ts'
import { verifyStoragePayload } from '../server-managed/storage-payload.ts'
import { sdkFixture } from './_managed-vercel.js'
import { checkStorageDb, checkStorageMigrationOrder, storageTestKey as key } from './_managed-storage-db.js'

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

test('SQLite per-row keys, activation, and migration state', async t => {
  const f = await fixture(t)
  await checkStorageDb(f.db)
})

test('SQLite migration orders reports before bundles, smallest first, and resumes old cursors', async t => {
  const f = await fixture(t)
  await checkStorageMigrationOrder(f.db)
})

test('startup with a key encrypts new writes before legacy migration and requires the same key on restart', async t => {
  const f = await fixture(t)
  const stale = await openManagedStorage({ dbPath: f.dbPath })
  let enabled, reopened
  try {
    assert.equal(await stale.db.getStorageEncryption(), null)
    const legacy = await report({ db: stale.db, stores: stale })
    const config = { dbPath: f.dbPath, storageEncryptionKey: key.bytes.toString('base64') }
    enabled = await openManagedStorage(config)
    const state = await enabled.db.getStorageEncryption()
    assert.equal(state.complete, 0)
    assert.equal(state.migrated, 0)
    assert.equal((await bytes(f.raw, `reports/${legacy}`)).toString(), 'private report', 'startup does not migrate legacy bytes')

    const current = { db: enabled.db, stores: enabled }
    const b = await bundle(current), r = await report(current, Buffer.from('new report'))
    for (const [type, id] of [['report', r], ['bundle', b]]) {
      const row = await enabled.db.getStorageRow(type, id)
      assert.equal(row.encrypted, 1)
      assert.ok(row.dataKey)
      assert.equal((await bytes(f.raw, `${type}s/${id}`)).subarray(0, 16).toString(), 'DeepView.storage')
    }
    const user = await enabled.db.upsertUser({ githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
    const tokens = { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: null }
    await enabled.db.setUserTokens(user, tokens)
    const sql = new DatabaseSync(f.dbPath)
    try {
      const row = sql.prepare('SELECT gh_access_token, gh_refresh_token, gh_tokens_encrypted FROM managed_user WHERE id = ?').get(user)
      assert.equal(row.gh_tokens_encrypted, 1)
      assert.notEqual(row.gh_access_token, tokens.accessToken)
      assert.notEqual(row.gh_refresh_token, tokens.refreshToken)
    } finally { sql.close() }

    reopened = await openManagedStorage(config)
    assert.deepEqual(await reopened.db.getStorageEncryption(), state, 'restarts preserve activation and migration progress')
    assert.equal((await reopened.reportStore.get(r)).toString(), 'new report')
    assert.equal((await reopened.bundleStore.get(b, null)).toString(), 'bundle sources')
    assert.deepEqual(await reopened.db.getUserTokens(user), tokens)
    const now = Date.now()
    const clock = t.mock.method(Date, 'now', () => now + STORAGE_DISABLED_TTL_MS)
    await assert.rejects(stale.reportStore.get(legacy), /encryption key/u)
    clock.mock.restore()
    await assert.rejects(stale.reportStore.put(randomUUID(), Buffer.from('plain')), /encryption key/u)
    await assert.rejects(stale.db.setUserTokens(user, tokens), /encryption key/u)
    for (const storageEncryptionKey of [null, randomBytes(32).toString('base64')]) {
      await assert.rejects(openManagedStorage({ dbPath: f.dbPath, storageEncryptionKey }), /encryption key/u)
    }
    await enabled.reapStorage()
    assert.equal((await enabled.db.getStorageEncryption()).migrated, 0, 'maintenance leaves legacy data alone without the migration switch')
    await reopened.db.close()
    reopened = await openManagedStorage({ ...config, storageEncryptionMigrate: true })
    await reopened.reapStorage()
    assert.equal((await enabled.db.getStorageEncryption()).complete, 1)
    assert.equal((await enabled.db.getStorageEncryption()).migrated, 1, 'maintenance only migrates the legacy upload')
    assert.equal((await bytes(f.raw, `reports/${legacy}`)).subarray(0, 16).toString(), 'DeepView.storage')
    assert.equal((await enabled.reportStore.get(legacy)).toString(), 'private report')
  } finally { await reopened?.db.close(); await enabled?.db.close(); await stale.db.close() }
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
    assert.equal(await f.raw.head(orphan) !== null, false)
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
    assert.equal(await f.raw.head(`reports/${a}`) !== null, true, 'test deliberately leaves ciphertext behind')
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
    // Migrate one row while leaving another pending.
    const migrated = (await f.db.getStorageRow('report', id)).encrypted ? id : pending
    await f.raw.put(`reports/${migrated}`, Buffer.from(migrated === id ? 'private report' : 'other legacy report'))
    assert.equal((await f.db.getStorageEncryption()).complete, 0)
    await assert.rejects(f.stores.reportStore.get(migrated), /encrypted storage envelope/u)
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
    const result = await migrateStorage(f.raw, f.db, key)
    assert.deepEqual(result.failures, [{ type: 'report', id: ids[0], message: 'Migration payload unavailable' }])
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
    assert.equal(await f.raw.head(`reports/${id}`) !== null, false)
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

test('repository App tokens keep their own slot, migrate with login tokens, and stay bound to their column', async t => {
  const f = await fixture(t)
  const admin = await f.db.upsertUser({ githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
  const other = await f.db.upsertUser({ githubUserId: 2, login: 'other', name: null, avatarUrl: null }, Date.now())
  const login = { accessToken: 'login-access', refreshToken: 'login-refresh', expiresAt: 1234 }
  const app = { accessToken: 'app-access', refreshToken: 'app-refresh', expiresAt: 5678 }
  await f.db.setUserTokens(admin, login)
  await f.db.setUserTokens(admin, app, 'app')
  // Only a plaintext repository App token still makes the account pending.
  await f.db.setUserTokens(other, app, 'app')
  assert.deepEqual(await f.db.getUserTokens(admin), login)
  assert.deepEqual(await f.db.getUserTokens(admin, 'app'), app)
  await assert.rejects(f.db.getUserTokens(admin, 'other'), /Invalid GitHub token slot/u)
  await f.db.enableStorageEncryption()
  await finish(f)
  const sql = new DatabaseSync(f.dbPath)
  try {
    for (const id of [admin, other]) {
      const row = sql.prepare('SELECT gh_app_access_token AS access, gh_app_refresh_token AS refresh, gh_app_tokens_encrypted AS encrypted FROM managed_user WHERE id = ?').get(id)
      assert.equal(row.encrypted, 1)
      assert.notEqual(row.access, app.accessToken)
      assert.notEqual(row.refresh, app.refreshToken)
      assert.deepEqual(await f.db.getUserTokens(id, 'app'), app)
    }
    assert.deepEqual(await f.db.getUserTokens(admin), login)
    assert.equal(await f.db.getUserTokens(other), null)
    // A login ciphertext cannot pass as the repository App's token, or back.
    sql.prepare('UPDATE managed_user SET gh_app_access_token = gh_access_token, gh_refresh_token = gh_app_refresh_token WHERE id = ?').run(admin)
    await assert.rejects(f.db.getUserTokens(admin, 'app'), /authenticat/u)
    await assert.rejects(f.db.getUserTokens(admin), /authenticat/u)
  } finally { sql.close() }
})

test('legacy cache cleanup survives offset pagination and ignores unrelated namespaces', async t => {
  const f = await fixture(t, true)
  for (let i = 0; i < 7; i++) await f.raw.put(`cache/bundles/11111111-1111-4111-8111-111111111111/${i}`, Buffer.from('private cache'))
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

for (const remote of [false, true]) {
  test(`${remote ? 'Vercel' : 'disk'}: migration cleanup recognizes managed paths and expires ciphertext temp files`, async t => {
    const f = await fixture(t, remote), id = randomUUID()
    const unrelated = ['cache/webpack/build.json', 'reports/q3-summary.pdf', 'bundles/readme.txt',
      `reports/${id}.map.br`, `reports/${id}.backup.tmp`, `bundles/${id}.zip`,
      `cache/other/${id}/metadata.json`, 'cache/bundles/not-a-uuid/metadata.json',
      'reports/111111111111111111111111111111111111', `reports/nested/${id}`,
      `cache-encrypted-v1/webpack/build.json.${randomUUID()}.tmp`]
    const legacy = [`reports/${randomUUID()}`, `bundles/${randomUUID()}`, `bundles/${randomUUID()}.map.br`,
      `cache/bundles/${id}/old/metadata.json`, `cache/report-sources/${id}/v1-hash/sources.json.gz`]
    for (const path of [...unrelated, ...legacy]) await f.raw.put(path, Buffer.from(path))
    await f.db.enableStorageEncryption()
    const b = await bundle(f), live = await report(f)
    await f.stores.cacheStorage.put(b, 'metadata.json', Buffer.from('live cache'))
    const ciphertext = await bytes(f.raw, `reports/${live}`)
    const stale = [`reports/${live}.${randomUUID()}.tmp`, `bundles/${b}.map.br.${randomUUID()}.tmp`,
      `cache/bundles/${b}/metadata.json.${randomUUID()}.tmp`,
      `cache-encrypted-v1/bundles/${b}/metadata.json.${randomUUID()}.tmp`,
      `cache-encrypted-v1/report-sources/${b}/v1-hash/sources.gz.${randomUUID()}.tmp`]
    async function age(path) {
      if (remote) f.objects.get(`.managed/${path}`).uploadedAt = new Date(0)
      else await utimes(join(f.dir, path), new Date(0), new Date(0))
    }
    for (const path of stale) { await f.raw.put(path, ciphertext); await age(path) }
    const recent = `reports/${live}.${randomUUID()}.tmp`
    await f.raw.put(recent, ciphertext)
    const progress = await migrateStorage(f.raw, f.db, key, { maxObjects: 100 })
    assert.equal(progress.cleanupComplete, 0)
    assert.ok(progress.retryAt > Date.now(), 'recent ciphertext temps retain the staging grace period')
    assert.deepEqual(await bytes(f.raw, recent), ciphertext)
    await age(recent)
    await finish(f)
    for (const path of [...legacy, ...stale, recent]) assert.equal(await f.raw.head(path), null, path)
    for (const path of unrelated) assert.equal((await bytes(f.raw, path)).toString(), path)
    assert.equal((await f.stores.reportStore.get(live)).toString(), 'private report')
    assert.equal((await consume((await f.stores.cacheStorage.open(b, 'metadata.json')).stream)).toString(), 'live cache')
  })
}

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

test('CLI reports status while environment-enabled maintenance resumes deferred cleanup', async t => {
  const f = await fixture(t), id = await report(f)
  const abandoned = `reports/${id}.${randomUUID()}.tmp`
  await f.raw.put(abandoned, Buffer.from('unfinished plaintext write'))
  const run = async (flag, storageEncryptionKey = key.bytes.toString('base64'), mode = 'managed', extra = {}) => {
    const { stdout } = await promisify(execFile)(process.execPath, [join(process.cwd(), 'server-managed/cli.js'), flag, ...(mode ? [mode] : [])], {
      cwd: f.dir, timeout: 10_000, env: { ...process.env, MANAGED_DB_PATH: f.dbPath, MANAGED_STORAGE_ENCRYPTION_KEY: storageEncryptionKey,
        MANAGED_STORAGE_ENCRYPTION_MIGRATE: '', VERCEL_ENV: '',
        DATABASE_URL: '', MANAGED_DATABASE_URL: '', E2E_DATABASE_URL: '', VERCEL: '',
        GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', OAUTH_CALLBACK_URL: 'https://app.example/api/oauth/github/callback', ...extra },
    })
    return JSON.parse(stdout.trim().split('\n').at(-1))
  }
  assert.deepEqual(await run('--storage-encryption-status', ''), { encryption: 'disabled' })
  await assert.rejects(run('--migrate-storage'), /Unknown command/u)
  await assert.rejects(run('--unsupported'), /Unknown command/u)
  await assert.rejects(run('--storage-encryption-status', '', null), /requires a deployment mode/u)
  assert.deepEqual(await run('--storage-encryption-status'), { encryption: 'disabled' })
  assert.equal(await f.db.getStorageEncryption(), null, 'status never activates encryption')
  // The combined deployment default must not inspect or initialize DB_PATH.
  const e2ePath = join(f.dir, 'e2e.db')
  await writeFile(e2ePath, 'not a managed database')
  assert.deepEqual(await run('--storage-encryption-status', key.bytes.toString('base64'), 'managed-e2e', { DB_PATH: e2ePath, MANAGED_DB_PATH: undefined }), { encryption: 'disabled' })
  assert.equal(await readFile(e2ePath, 'utf8'), 'not a managed database')
  await f.db.enableStorageEncryption()
  assert.equal((await run('--storage-encryption-status')).complete, false)
  await assert.rejects(run('--storage-encryption-status', ''), /encryption key/u)
  const logs = []
  t.mock.method(console, 'info', (_label, result) => logs.push(JSON.parse(result)))
  const storage = await openManagedStorage({ dbPath: f.dbPath, storageEncryptionKey: key.bytes.toString('base64'), storageEncryptionMigrate: true })
  try {
    await storage.reapStorage()
    const paused = logs.at(-1)
    assert.equal(paused.complete, true)
    assert.equal(paused.cleanupComplete, false)
    assert.ok(paused.retryAt > Date.now(), 'deferred cleanup exits with a retry time instead of busy-looping')
    await utimes(join(f.dir, abandoned), new Date(0), new Date(0))
    await storage.reapStorage()
    const final = logs.at(-1)
    assert.equal(final.complete, true); assert.equal(final.cleanupComplete, true)
    assert.equal(await f.raw.head(abandoned) !== null, false)
    assert.equal((await readFile(join(f.dir, 'reports', id))).subarray(0, 16).toString(), 'DeepView.storage')
  } finally { await storage.db.close() }
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
  assert.equal(await f.raw.head(`reports/${id}`) !== null, false)
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

for (const remote of [false, true]) {
  test(`${remote ? 'Vercel' : 'disk'}: failed writes clean up only their own plaintext after activation`, async t => {
    const f = await fixture(t, remote), id = randomUUID()
    const body = Buffer.from('DeepView.storage is also a valid plaintext prefix')
    const put = f.raw.put.bind(f.raw)
    t.mock.method(f.raw, 'put', async (...args) => {
      await put(...args)
      await f.db.enableStorageEncryption()
      throw new Error('lost plaintext PUT acknowledgement')
    })
    await assert.rejects(f.stores.reportStore.put(id, body), /lost plaintext PUT acknowledgement/u)
    assert.equal(await f.raw.head(`reports/${id}`) !== null, false)
  })

  test(`${remote ? 'Vercel' : 'disk'}: legacy cleanup does not mistake orphan plaintext for ciphertext`, async t => {
    const f = await fixture(t, remote), path = `reports/${randomUUID()}`
    await f.raw.put(path, Buffer.from('DeepView.storage orphan plaintext'))
    if (remote) f.objects.get(`.managed/${path}`).uploadedAt = new Date(0)
    else await utimes(join(f.dir, path), new Date(0), new Date(0))
    await f.db.enableStorageEncryption()
    await finish(f)
    assert.equal(await f.raw.head(path) !== null, false)
  })
}

test('failed plaintext cleanup preserves a concurrent encrypted replacement', async t => {
  const f = await fixture(t, true)
  const body = Buffer.from('private report'), id = randomUUID()
  const put = f.raw.put.bind(f.raw)
  t.mock.method(f.raw, 'put', async (...args) => {
    await put(...args)
    await f.db.insertReport({ id, filename: 'report', contentType: 'text/plain', byteSize: body.length,
      sha256: createHash('sha256').update(body).digest('base64url'), uploadedBy: null, repoId: null }, Date.now())
    t.mock.restoreAll()
    await f.db.enableStorageEncryption()
    await finish(f)
    throw new Error('lost acknowledgement after migration')
  })
  await assert.rejects(f.stores.reportStore.put(id, body), /lost acknowledgement/u)
  assert.deepEqual(await f.stores.reportStore.get(id), body)
})

test('an encrypted row with a missing key fails without allocating a replacement key', async t => {
  const f = await fixture(t)
  await f.db.enableStorageEncryption()
  const id = await bundle(f)
  const sql = new DatabaseSync(f.dbPath)
  try {
    sql.prepare('UPDATE managed_bundle SET data_key = NULL WHERE id = ?').run(id)
    await assert.rejects(f.db.ensureStorageDataKey('bundle', id), /data key/u)
    assert.equal(sql.prepare('SELECT data_key FROM managed_bundle WHERE id = ?').get(id).data_key, null)
  } finally { sql.close() }
})

test('migration deadline aborts a stalled Vercel inventory request without completing cleanup', async t => {
  const f = await fixture(t, true)
  await f.db.enableStorageEncryption()
  t.mock.method(f.sdk, 'list', async options => {
    assert.ok(options.abortSignal, 'inventory must receive the migration signal')
    await new Promise((resolve, reject) => {
      const fallback = setTimeout(() => reject(new Error('inventory was not aborted')), 1000)
      options.abortSignal.addEventListener('abort', () => { clearTimeout(fallback); resolve() }, { once: true })
    })
    options.abortSignal.throwIfAborted()
  })
  assert.equal((await migrateStorage(f.raw, f.db, key, { maxMs: 100 })).cleanupComplete, 0)
  assert.equal((await f.db.getStorageEncryption()).cleanupComplete, 0)
})

test('payload verification cancels decompression and its input when aborted', async () => {
  const controller = new AbortController()
  // A blocked input also exercises cancellation independently of raw adapters.
  const source = new Readable({ read() {} })
  const job = verifyStoragePayload('bundle', { kind: 'sourcemap', hash: 'unused' }, source, controller.signal)
  controller.abort()
  await assert.rejects(job, { name: 'AbortError' })
  assert.equal(source.destroyed, true)
})

test('corrupt sourcemaps remain pending without turning format errors into cleanup failures', async t => {
  const f = await fixture(t)
  const ids = [await bundle(f, Buffer.from('first'), 'sourcemap'), await bundle(f, Buffer.from('second'), 'sourcemap')]
  await f.raw.put(`bundles/${ids[0]}.map.br`, Buffer.from('broken'))
  await f.raw.put(`bundles/${ids[1]}.map.br`, Buffer.alloc(0))
  await f.db.enableStorageEncryption()
  const result = await migrateStorage(f.raw, f.db, key)
  assert.equal(result.complete, 0)
  assert.deepEqual(result.failures.map(failure => failure.id).toSorted(), ids.toSorted())
  assert.ok(result.failures.every(failure => failure.message === 'Stored sourcemap cannot be decompressed'))
})

test('shutdown cancels a Vercel response body after the request has returned headers', async t => {
  const controller = new AbortController(), f = await fixture(t, true)
  let cancelled = false
  t.mock.method(f.sdk, 'get', () => Promise.resolve({
    statusCode: 200, blob: { size: 100, etag: 'body-version' },
    stream: new ReadableStream({ cancel() { cancelled = true } }),
  }))
  const opened = await f.raw.open(`reports/${randomUUID()}`, controller.signal)
  const reading = consume(opened.stream)
  controller.abort()
  await assert.rejects(reading, { name: 'AbortError' })
  assert.equal(cancelled, true)
  assert.equal(opened.stream.destroyed, true)
})

test('migration deadline aborts Vercel cleanup deletion without completing the inventory', async t => {
  const f = await fixture(t, true)
  await f.raw.put('cache/bundles/11111111-1111-4111-8111-111111111111/value', Buffer.from('private legacy cache'))
  await f.db.enableStorageEncryption()
  t.mock.method(f.sdk, 'del', async (_path, options) => {
    assert.ok(options.abortSignal, 'deletion must receive the migration signal')
    await new Promise((resolve, reject) => {
      const fallback = setTimeout(() => reject(new Error('deletion was not aborted')), 1000)
      options.abortSignal.addEventListener('abort', () => { clearTimeout(fallback); resolve() }, { once: true })
    })
    options.abortSignal.throwIfAborted()
  })
  assert.equal((await migrateStorage(f.raw, f.db, key, { maxMs: 100 })).cleanupComplete, 0)
  assert.equal((await f.db.getStorageEncryption()).cleanupComplete, 0)
  t.mock.restoreAll()
  await finish(f)
  assert.equal(await f.raw.head('cache/bundles/11111111-1111-4111-8111-111111111111/value') !== null, false)
})

test('Vercel cleanup preserves an encrypted upload awaiting SQL despite rounded Last-Modified', async t => {
  const f = await fixture(t, true), id = randomUUID()
  const state = await f.db.enableStorageEncryption()
  const body = Buffer.from('new upload'), dataKey = await f.stores.reportStore.put(id, body)
  f.objects.get(`.managed/reports/${id}`).uploadedAt = new Date(Math.floor(state.enabledAt / 1000) * 1000)
  await finish(f)
  assert.equal(await f.raw.head(`reports/${id}`) !== null, true)
  await f.db.insertReport({ id, filename: 'report', contentType: 'text/plain', byteSize: body.length,
    sha256: createHash('sha256').update(body).digest('base64url'), dataKey, uploadedBy: null, repoId: null }, Date.now())
  assert.deepEqual(await f.stores.reportStore.get(id), body)
})

test('Vercel open cancels a response rejected for a missing object version', async t => {
  const f = await fixture(t, true)
  let cancelled = false
  t.mock.method(f.sdk, 'get', () => Promise.resolve({ statusCode: 200, blob: { size: 1 },
    stream: new ReadableStream({ cancel() { cancelled = true } }),
  }))
  await assert.rejects(f.raw.open(`reports/${randomUUID()}`), /missing object version/u)
  assert.equal(cancelled, true)
})

test('disk cleanup skips stray names and symlinks while removing supported plaintext', async t => {
  const f = await fixture(t)
  const warnings = []
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')))
  await f.raw.put('cache/bundles/11111111-1111-4111-8111-111111111111/value', Buffer.from('legacy source code'))
  await mkdir(join(f.dir, 'cache', '.hidden'))
  await writeFile(join(f.dir, 'cache', '.DS_Store'), 'stray metadata')
  await writeFile(join(f.dir, 'outside'), 'must survive')
  await symlink(join(f.dir, 'outside'), join(f.dir, 'cache', 'linked-source'))
  const id = await report(f)
  await f.db.enableStorageEncryption()
  const result = await finish(f)
  assert.equal(result.complete, 1)
  assert.equal(result.cleanupComplete, 1)
  assert.equal(await f.raw.head('cache/bundles/11111111-1111-4111-8111-111111111111/value') !== null, false)
  assert.equal((await f.stores.reportStore.get(id)).toString(), 'private report')
  assert.equal(await readFile(join(f.dir, 'outside'), 'utf8'), 'must survive')
  for (const name of ['.DS_Store', '.hidden', 'linked-source']) assert.ok(warnings.some(line => line.includes(name)))
})

test('unsupported directory fsync permits disk writes, cleanup and migration; real I/O failures still fail', async t => {
  const f = await fixture(t)
  const directory = await openFile(f.dir, 'r'), prototype = Object.getPrototypeOf(directory)
  await directory.close()
  const sync = prototype.sync
  let code = 'EINVAL'
  t.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).isDirectory()) throw Object.assign(new Error('directory fsync failed'), { code })
    return sync.call(this)
  })
  const id = await report(f)
  await f.raw.put('cache/bundles/11111111-1111-4111-8111-111111111111/value', Buffer.from('source'))
  await f.db.enableStorageEncryption()
  assert.equal((await finish(f)).cleanupComplete, 1)
  assert.equal((await f.stores.reportStore.get(id)).toString(), 'private report')
  await f.stores.reportStore.delete(id)
  code = 'EIO'
  await assert.rejects(f.raw.put(`reports/${randomUUID()}`, Buffer.from('new')), { code: 'EIO' })
})

test('encrypted reads reuse the enabled policy and cache existence/deletion use HEAD without downloading contents', async t => {
  const f = await fixture(t, true)
  await f.db.enableStorageEncryption()
  const b = await bundle(f), r = await report(f)
  await f.stores.cacheStorage.put(b, 'metadata.json', Buffer.from('cached sources'))
  const policy = t.mock.method(f.db, 'getStorageEncryption')
  assert.equal((await f.stores.reportStore.get(r)).toString(), 'private report')
  assert.equal(policy.mock.callCount(), 0)
  f.calls.length = 0
  assert.equal(await f.stores.cacheStorage.exists(b, 'metadata.json'), true)
  await f.stores.cacheStorage.delete(b)
  assert.equal(f.calls.some(call => call.op === 'get'), false)
  assert.ok(f.calls.some(call => call.op === 'head'))
  assert.equal(policy.mock.callCount(), 0)
  await f.db.deleteBundle(b)
  assert.equal(await f.stores.cacheStorage.exists(b, 'metadata.json'), false)
})

test('disk cache prefix deletion prunes empty folders without deleting other bundles', async t => {
  const f = await fixture(t)
  const a = await bundle(f, Buffer.from('a')), b = await bundle(f, Buffer.from('b'))
  await f.stores.cacheStorage.put(a, 'nested/value', Buffer.from('a'))
  await f.stores.cacheStorage.put(b, 'metadata.json', Buffer.from('b'))
  await f.stores.cacheStorage.delete(a)
  await assert.rejects(stat(join(f.dir, 'cache', 'bundles', a)), { code: 'ENOENT' })
  assert.equal(await f.stores.cacheStorage.exists(b, 'metadata.json'), true)
})

test('Vercel uses single PUTs for small encrypted writes and multipart for large writes', async t => {
  const f = await fixture(t, true)
  await f.db.enableStorageEncryption()
  await report(f, Buffer.from('small'))
  assert.equal(f.calls.findLast(call => call.op === 'put').options.multipart, false)
  await report(f, Buffer.alloc(6 * 1024 * 1024, 42))
  assert.equal(f.calls.findLast(call => call.op === 'put').options.multipart, true)
})

test('an oversized first report advances the cursor so bundles and GitHub tokens can migrate', async t => {
  const f = await fixture(t), id = await report(f, Buffer.alloc(1024 * 1024, 1))
  const bundles = await Promise.all([bundle(f, Buffer.from('one')), bundle(f, Buffer.from('two')), bundle(f, Buffer.from('three'))])
  const user = await f.db.upsertUser({ githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
  await f.db.setUserTokens(user, { accessToken: 'secret', refreshToken: null, expiresAt: null })
  await f.db.enableStorageEncryption()
  const [first] = await f.db.listStorageMigrationRows(null, 1)
  const open = f.raw.open.bind(f.raw)
  const stalled = t.mock.method(f.raw, 'open', async (path, signal) => {
    if (path !== `reports/${id}`) return open(path, signal)
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1000)
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
    signal.throwIfAborted()
  })
  const interrupted = await migrateStorage(f.raw, f.db, key, { maxMs: 25 })
  assert.equal(interrupted.failures.length, 1)
  assert.match(interrupted.failures[0].message, new RegExp(`report ${id}.*MANAGED_STORAGE_ENCRYPTION_MIGRATE_MAX_MS=25`, 'u'))
  assert.equal((await f.db.getStorageEncryption()).cursor, first.position)
  const next = await migrateStorage(f.raw, f.db, key)
  assert.equal(next.complete, 0, 'the skipped report still prevents completion')
  assert.equal(next.migrated, 4, 'three bundles and tokens advance past the large report')
  for (const bundleId of bundles) assert.equal((await f.db.getStorageRow('bundle', bundleId)).encrypted, 1)
  const sql = new DatabaseSync(f.dbPath)
  try { assert.equal(sql.prepare('SELECT gh_tokens_encrypted FROM managed_user WHERE id = ?').get(user).gh_tokens_encrypted, 1) }
  finally { sql.close() }
  stalled.mock.restore()
  assert.equal((await finish(f)).complete, 1)
  assert.equal((await f.stores.reportStore.get(id)).length, 1024 * 1024)
})

test('Vercel previews cannot activate encryption but can validate an already enabled database', async t => {
  const f = await fixture(t)
  const config = { dbPath: f.dbPath, storageEncryptionKey: key.bytes.toString('base64') }
  await assert.rejects(openManagedStorage({ ...config, vercelPreview: true }), /outside a Vercel preview/u)
  assert.equal(await f.db.getStorageEncryption(), null)
  const production = await openManagedStorage(config)
  await production.db.close()
  const preview = await openManagedStorage({ ...config, vercelPreview: true })
  try { assert.ok(await preview.db.getStorageEncryption()) } finally { await preview.db.close() }
  await assert.rejects(openManagedStorage({ ...config, vercelPreview: true, storageEncryptionKey: randomBytes(32).toString('base64') }), /encryption key/u)
})

test('keyless reads cache disabled policy briefly; ciphertext and writes force a fresh activation check', async t => {
  const f = await fixture(t, true)
  const keyless = await createEncryptedObjectStorage(f.raw, f.db, null)
  const path = `reports/${await report(f)}`
  const policy = t.mock.method(f.db, 'getStorageEncryption')
  for (let i = 0; i < 3; i++) {
    assert.equal((await keyless.get(path)).toString(), 'private report')
    assert.equal(await keyless.exists(path), true)
    await keyless.delete(`reports/${randomUUID()}`)
  }
  assert.equal(policy.mock.callCount(), 0)
  const now = Date.now()
  const clock = t.mock.method(Date, 'now', () => now + STORAGE_DISABLED_TTL_MS)
  await keyless.exists(path)
  assert.equal(policy.mock.callCount(), 1)
  clock.mock.restore()
  await f.db.enableStorageEncryption()
  const encrypted = await report(f, Buffer.from('new secret'))
  await assert.rejects(keyless.get(`reports/${encrypted}`), /encryption key/u)
  const stale = await createEncryptedObjectStorage(f.raw, f.db, key)
  assert.equal((await stale.get(`reports/${encrypted}`)).toString(), 'new secret')
})

for (const remote of [false, true]) {
  test(`${remote ? 'Vercel' : 'disk'} deletion removes both generations of caches without migration`, async t => {
    const f = await fixture(t, remote), id = await bundle(f)
    await f.stores.cacheStorage.put(id, 'metadata.br', Buffer.from('old metadata'))
    await f.stores.reportSourcesStorage.put(`${id}/sources.gz`, Buffer.from('old source'))
    await f.db.enableStorageEncryption()
    await f.stores.cacheStorage.put(id, 'metadata.br', Buffer.from('new metadata'))
    await f.stores.reportSourcesStorage.put(`${id}/sources.gz`, Buffer.from('new source'))
    await f.db.deleteBundle(id)
    await f.stores.cacheStorage.delete(id)
    await f.stores.reportSourcesStorage.delete(id)
    assert.deepEqual((await f.raw.list('cache/', null, 100)).objects, [])
    assert.deepEqual((await f.raw.list('cache-encrypted-v1/', null, 100)).objects, [])
  })
  test(`${remote ? 'Vercel' : 'disk'} missing encrypted payloads return null while storage errors propagate`, async t => {
    const f = await fixture(t, remote)
    await f.db.enableStorageEncryption()
    const b = await bundle(f), r = await report(f)
    await f.raw.delete(`reports/${r}`)
    await f.raw.delete(`bundles/${b}`)
    assert.equal(await f.stores.reportStore.get(r), null)
    assert.equal(await f.stores.bundleStore.open(b, null), null)
    const config = { sessionCookieName: 'sid', sessionTtlMs: 3600_000, cookieSecure: false }
    const session = await createSession(config, f.db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
    await f.db.setUserRole(session.userId, 'admin')
    const handler = createManagedRequestHandler({ config, db: f.db, ...f.stores,
      originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {},
    })
    for (const path of [`/api/admin/reports/${r}`, `/api/admin/bundles/${b}`]) {
      const res = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
      await handler({ url: path, method: 'GET', headers: { cookie: session.setCookie.split(';')[0] } }, res)
      assert.equal(res.status, 503)
      assert.deepEqual(res.body, { error: 'unavailable' })
    }
    t.mock.method(f.raw, 'open', () => { throw new Error('storage unavailable') })
    await assert.rejects(f.stores.reportStore.get(r), /storage unavailable/u)
  })
}

test('prefix deletion finishes past stale listings and preserves concurrent replacements', async t => {
  const f = await fixture(t, true), id = randomUUID(), prefix = `cache/bundles/${id}/`
  const changed = `${prefix}changed`, gone = `${prefix}gone`, live = `${prefix}live`
  for (const path of [changed, live]) await f.raw.put(path, Buffer.from('old'))
  const list = t.mock.method(f.raw, 'list', (path, cursor) => Promise.resolve(path === prefix
    ? cursor ? { objects: [{ key: live }], cursor: null } : { objects: [{ key: gone }, { key: changed }], cursor: 'next' }
    : { objects: [], cursor: null }))
  const remove = f.raw.delete.bind(f.raw)
  t.mock.method(f.raw, 'delete', async (path, version, signal) => {
    if (path === changed) await f.raw.put(path, Buffer.from('replacement'))
    return remove(path, version, signal)
  })
  await f.storage.deletePrefix(prefix)
  assert.equal(list.mock.callCount(), 3, 'one traversal of each cache generation')
  assert.equal(await f.raw.head(live) !== null, false)
  assert.equal((await bytes(f.raw, changed)).toString(), 'replacement')
})

test('a row interrupted after earlier progress gets one full-budget retry before being skipped', async t => {
  const f = await fixture(t)
  const first = await report(f, Buffer.from('first'), '00000000-0000-0000-0000-000000000001')
  const second = await report(f, Buffer.from('second'), '00000000-0000-0000-0000-000000000002')
  await f.db.enableStorageEncryption()
  const pending = await f.db.listStorageMigrationRows(null, 2)
  const open = f.raw.open.bind(f.raw)
  t.mock.method(f.raw, 'open', async (path, signal) => {
    if (path !== `reports/${second}`) return open(path, signal)
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1000)
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
    signal.throwIfAborted()
  })
  const result = await migrateStorage(f.raw, f.db, key, { maxMs: 100 })
  assert.equal(result.cursor, pending[0].position)
  assert.equal(pending[0].id, first)
  assert.equal(result.complete, 0)
  const retry = await migrateStorage(f.raw, f.db, key, { maxMs: 25 })
  assert.equal(retry.failures[0].id, second)
  assert.equal((await f.db.getStorageEncryption()).cursor, pending[1].position)
})

test('a delayed disabled policy response cannot undo a concurrently observed activation', async t => {
  const f = await fixture(t), id = await report(f)
  await f.db.enableStorageEncryption()
  const state = await f.db.getStorageEncryption(), waiting = Promise.withResolvers()
  let calls = 0
  t.mock.method(f.db, 'getStorageEncryption', () => ++calls === 1 ? waiting.promise : Promise.resolve(state))
  const first = f.storage.exists(`reports/${id}`)
  assert.equal(await f.storage.exists(`reports/${id}`), true)
  waiting.resolve(null)
  assert.equal(await first, true)
  assert.equal(await f.storage.exists(`reports/${id}`), true)
  assert.equal(calls, 2)
})
