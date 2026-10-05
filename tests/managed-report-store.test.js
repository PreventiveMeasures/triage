import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { STORAGE_MAGIC, decryptStorageStream } from '../server-common/storage-crypto.ts'
import { loadManagedConfig } from '../server-managed/config.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createDiskObjectStorage } from '../server-managed/object-storage-disk.ts'
import { openVercelObjectStorage } from '../server-managed/object-storage-vercel.ts'
import { createReportStore } from '../server-managed/report-store.ts'
import { createSession } from '../server-managed/session.ts'
import { unwrapDataKey } from '../server-managed/storage-db.ts'
import { createEncryptedObjectStorage } from '../server-managed/storage-encryption.ts'
import { migrateStorage } from '../server-managed/storage-maintenance.ts'
import { createManagedStores } from '../server-managed/storage-stores.ts'
import { UPLOAD_CHUNK_BYTES } from '../server-managed/uploads.ts'
import { storageTestKey as key } from './_managed-storage-db.js'
import { sdkFixture } from './_managed-vercel.js'

const MiB = 1024 * 1024
const reportBody = Buffer.from(JSON.stringify({ findings: Array.from({ length: 500 }, (_, i) => ({
  id: `finding-${i}`, file: `src/file-${i}.js`, line: i + 1, severity: 'high',
  description: 'Validate the input before storing this record. Private report €😀.\n'.repeat(10),
})) }))

async function consume(stream) {
  const parts = []
  for await (const part of stream) parts.push(part)
  return Buffer.concat(parts)
}

async function fixture(t, remote, encrypted = false) {
  t.mock.method(console, 'info', () => {})
  const dir = await mkdtemp(join(tmpdir(), 'triage-report-compression-'))
  const db = openSqliteManagedDb(join(dir, 'db'), { storageEncryptionKey: key })
  t.after(async () => { await db.close(); await rm(dir, { recursive: true, force: true }) })
  if (encrypted) await db.enableStorageEncryption()
  const blobs = sdkFixture()
  const raw = remote ? await openVercelObjectStorage('token', blobs.sdk) : createDiskObjectStorage(dir)
  const storage = await createEncryptedObjectStorage(raw, db, key)
  const stores = createManagedStores(storage, !remote)
  return { db, raw, storage, stores, ...blobs }
}

async function insert(f, body, id = randomUUID(), dataKey) {
  await f.db.insertReport({ id, filename: 'report.json', contentType: 'application/json', byteSize: body.length,
    sha256: createHash('sha256').update(body).digest('base64url'), dataKey, uploadedBy: null, repoId: null }, Date.now())
  return id
}

async function decodedStorage(f, identity, id) {
  const stored = await f.raw.open(identity)
  const row = await f.db.getStorageRow('report', id)
  if (!row.encrypted) return consume(stored.stream)
  const dataKey = unwrapDataKey(key, 'report', row)
  try { return consume((await decryptStorageStream(stored.stream, dataKey, identity)).stream) }
  finally { dataKey.fill(0) }
}

for (const remote of [false, true]) {
  const backend = remote ? 'Vercel' : 'disk'
  for (const encrypted of [false, true]) {
    test(`${backend}: reports compress before encryption=${encrypted} and retain original bytes across instances`, async t => {
      const f = await fixture(t, remote, encrypted), id = randomUUID()
      const dataKey = await f.stores.reportStore.put(id, reportBody)
      await insert(f, reportBody, id, dataKey)
      const path = `reports/${id}.br`
      const physical = await consume((await f.raw.open(path)).stream)
      const encoded = await decodedStorage(f, path, id)
      assert.deepEqual(encoded, brotliCompressSync(reportBody, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }))
      assert.ok(encoded.length < reportBody.length / 5, 'representative report storage is at least 5x smaller')
      assert.deepEqual(brotliDecompressSync(encoded), reportBody, 'decryption yields Brotli bytes, then decompression yields the upload')
      if (encrypted) {
        assert.ok(physical.subarray(0, STORAGE_MAGIC.length).equals(STORAGE_MAGIC))
        assert.notDeepEqual(physical, encoded)
        assert.equal(physical.includes(Buffer.from('Private report')), false)
      } else assert.deepEqual(physical, encoded)
      assert.equal(await f.raw.head(`reports/${id}`), null)
      const row = await f.db.getReport(id)
      assert.equal(row.byteSize, reportBody.length)
      assert.equal(row.sha256, createHash('sha256').update(reportBody).digest('base64url'))
      const cold = createManagedStores(await createEncryptedObjectStorage(f.raw, f.db, key), !remote)
      assert.deepEqual(await cold.reportStore.get(id), reportBody)
      assert.deepEqual(await consume((await cold.reportStore.open(id)).stream), reportBody)
      await cold.reportStore.delete(id)
      assert.equal(await f.stores.reportStore.get(id), null)
      assert.equal(await f.raw.head(path), null)
    })

    test(`${backend}: the first legacy read compresses encrypted=${encrypted} reports in place using the same key`, async t => {
      const f = await fixture(t, remote, encrypted), id = randomUUID()
      const dataKey = await f.storage.put(`reports/${id}`, reportBody)
      await insert(f, reportBody, id, dataKey)
      const before = await f.db.getStorageRow('report', id)
      assert.equal(await f.raw.head(`reports/${id}.br`), null)
      assert.deepEqual(await f.stores.reportStore.get(id), reportBody)
      assert.equal(await f.raw.head(`reports/${id}`), null)
      const encoded = await decodedStorage(f, `reports/${id}.br`, id)
      assert.ok(encoded.length < reportBody.length / 5)
      assert.deepEqual(brotliDecompressSync(encoded), reportBody)
      const after = await f.db.getStorageRow('report', id)
      assert.equal(after.dataKey, before.dataKey)
      assert.equal(after.hash, before.hash)
      assert.equal(after.encrypted, before.encrypted)
      const cold = createManagedStores(await createEncryptedObjectStorage(f.raw, f.db, key), !remote)
      assert.deepEqual(await cold.reportStore.get(id), reportBody)
    })
  }

  test(`${backend}: opening a pre-encryption legacy report compresses and encrypts it without running maintenance`, async t => {
    const f = await fixture(t, remote), id = randomUUID()
    const body = brotliCompressSync(Buffer.from('legacy arbitrary bytes are preserved, including Brotli input'))
    await f.storage.put(`reports/${id}`, body)
    await insert(f, body, id)
    await f.db.enableStorageEncryption()
    assert.deepEqual(await f.stores.reportStore.get(id), body)
    assert.equal(await f.raw.head(`reports/${id}`), null)
    assert.equal((await f.db.getStorageRow('report', id)).encrypted, 1)
    const encoded = await decodedStorage(f, `reports/${id}.br`, id)
    assert.deepEqual(brotliDecompressSync(encoded), body)
    assert.equal((await f.db.getStorageEncryption()).migrated, 1)
  })

  test(`${backend}: concurrent first reads retain the report's identity and encryption key`, async t => {
    const f = await fixture(t, remote, true), id = randomUUID()
    const dataKey = await f.storage.put(`reports/${id}`, reportBody)
    await insert(f, reportBody, id, dataKey)
    const results = await Promise.all([f.stores.reportStore.get(id), f.stores.reportStore.get(id)])
    assert.deepEqual(results, [reportBody, reportBody])
    assert.equal((await f.db.getStorageRow('report', id)).dataKey, dataKey)
    assert.equal(await f.raw.head(`reports/${id}`), null)
    assert.deepEqual(brotliDecompressSync(await decodedStorage(f, `reports/${id}.br`, id)), reportBody)
  })

  test(`${backend}: a conversion started before activation preserves another reader's completed encrypted copy`, async t => {
    const f = await fixture(t, remote), id = randomUUID()
    await f.storage.put(`reports/${id}`, reportBody)
    await insert(f, reportBody, id)
    const stale = createManagedStores(await createEncryptedObjectStorage(f.raw, f.db, null), !remote)
    const put = f.raw.put.bind(f.raw)
    let first = true
    t.mock.method(f.raw, 'put', async (...args) => {
      if (first && args[0] === `reports/${id}.br`) {
        first = false
        await f.db.enableStorageEncryption()
        const fresh = createManagedStores(await createEncryptedObjectStorage(f.raw, f.db, key), !remote)
        assert.deepEqual(await fresh.reportStore.get(id), reportBody)
        assert.equal(await f.raw.head(`reports/${id}`), null)
      }
      return put(...args)
    })
    await assert.rejects(stale.reportStore.get(id), /requires its configured encryption key/u)
    assert.deepEqual(await f.stores.reportStore.get(id), reportBody)
    assert.deepEqual(brotliDecompressSync(await decodedStorage(f, `reports/${id}.br`, id)), reportBody)
  })

  test(`${backend}: encryption activated during a plaintext conversion upgrades the compressed copy before removing the original`, async t => {
    const f = await fixture(t, remote), id = randomUUID()
    await f.storage.put(`reports/${id}`, reportBody)
    await insert(f, reportBody, id)
    const put = f.raw.put.bind(f.raw)
    let first = true
    t.mock.method(f.raw, 'put', async (...args) => {
      const result = await put(...args)
      if (first && args[0] === `reports/${id}.br`) { first = false; await f.db.enableStorageEncryption() }
      return result
    })
    assert.deepEqual(await f.stores.reportStore.get(id), reportBody)
    assert.equal((await f.db.getStorageRow('report', id)).encrypted, 1)
    assert.equal(await f.raw.head(`reports/${id}`), null)
    assert.deepEqual(brotliDecompressSync(await decodedStorage(f, `reports/${id}.br`, id)), reportBody)
  })

  for (const encrypted of [false, true]) {
    test(`${backend}: a lost compression-write acknowledgement retains the original and retries safely (encrypted=${encrypted})`, async t => {
      const f = await fixture(t, remote, encrypted), id = randomUUID()
      const dataKey = await f.storage.put(`reports/${id}`, reportBody)
      await insert(f, reportBody, id, dataKey)
      const put = f.raw.put.bind(f.raw)
      let first = true
      t.mock.method(f.raw, 'put', async (...args) => {
        const result = await put(...args)
        if (first && args[0] === `reports/${id}.br`) { first = false; throw new Error('lost compression write acknowledgement') }
        return result
      })
      await assert.rejects(f.stores.reportStore.get(id), /lost compression write acknowledgement/u)
      assert.notEqual(await f.raw.head(`reports/${id}`), null)
      assert.deepEqual(await f.stores.reportStore.get(id), reportBody)
      assert.equal(await f.raw.head(`reports/${id}`), null)
      assert.equal((await f.db.getStorageRow('report', id)).dataKey, dataKey)
    })
  }

  test(`${backend}: deleting a report during conversion cannot leave an accessible compressed copy`, async t => {
    const f = await fixture(t, remote, true), id = randomUUID()
    const dataKey = await f.storage.put(`reports/${id}`, reportBody)
    await insert(f, reportBody, id, dataKey)
    const put = f.raw.put.bind(f.raw)
    t.mock.method(f.raw, 'put', async (...args) => {
      const result = await put(...args)
      if (args[0] === `reports/${id}.br`) await f.db.deleteReport(id)
      return result
    })
    await assert.rejects(f.stores.reportStore.get(id), /deleted during compression/u)
    assert.equal(await f.raw.head(`reports/${id}.br`), null)
    assert.equal(await f.stores.reportStore.get(id), null)
  })

  test(`${backend}: migration verifies original report hashes for compressed and legacy representations before marking encrypted`, async t => {
    const f = await fixture(t, remote), id = randomUUID()
    await f.stores.reportStore.put(id, reportBody)
    await insert(f, reportBody, id)
    const before = await decodedStorage(f, `reports/${id}.br`, id)
    // Both formats can coexist without allowing migration completion to leave
    // a referenced plaintext representation behind.
    await f.storage.put(`reports/${id}`, reportBody)
    const legacyBody = brotliCompressSync(Buffer.from('legacy bytes that happen to be Brotli'))
    const legacy = randomUUID()
    await f.storage.put(`reports/${legacy}`, legacyBody)
    await insert(f, legacyBody, legacy)
    await f.db.enableStorageEncryption()
    assert.deepEqual(brotliDecompressSync(await consume((await f.storage.open(`reports/${id}.br`)).stream)), reportBody)
    assert.deepEqual(await consume((await f.storage.open(`reports/${legacy}`)).stream), legacyBody)
    let result
    for (let i = 0; i < 20; i++) {
      result = await migrateStorage(f.raw, f.db, key)
      if (result.complete && result.cleanupComplete) break
    }
    assert.equal(result.complete, 1)
    assert.equal(result.cleanupComplete, 1)
    assert.equal(result.migrated, 2)
    for (const path of [`reports/${id}.br`, `reports/${id}`, `reports/${legacy}`]) {
      const physical = await consume((await f.raw.open(path)).stream)
      assert.ok(physical.subarray(0, STORAGE_MAGIC.length).equals(STORAGE_MAGIC))
    }
    assert.deepEqual(await decodedStorage(f, `reports/${id}.br`, id), before)
    assert.deepEqual(await f.stores.reportStore.get(id), reportBody)
    assert.deepEqual(await f.stores.reportStore.get(legacy), legacyBody)
    await f.stores.reportStore.delete(id)
    assert.equal(await f.raw.head(`reports/${id}.br`), null)
    assert.equal(await f.raw.head(`reports/${id}`), null)
  })

  test(`${backend}: damaged compressed reports fail without falling back or committing an encryption migration`, async t => {
    for (const [label, encoded] of [['invalid Brotli', Buffer.from('not Brotli')], ['wrong report hash', brotliCompressSync(Buffer.from('wrong report'))]]) {
      await t.test(label, async st => {
        const f = await fixture(st, remote), id = randomUUID(), path = `reports/${id}.br`
        await f.raw.put(path, encoded)
        await insert(f, reportBody, id)
        await f.db.enableStorageEncryption()
        await assert.rejects(f.stores.reportStore.get(id))
        st.mock.method(console, 'warn', () => {})
        const result = await migrateStorage(f.raw, f.db, key)
        assert.equal(result.complete, 0)
        assert.equal(result.failures.length, 1)
        assert.equal((await f.db.getStorageRow('report', id)).encrypted, 0)
        assert.deepEqual(await consume((await f.raw.open(path)).stream), encoded)
      })
    }
  })
}

test('closing a compressed report reader also closes its stored source without an unhandled rejection', async () => {
  const source = new Readable({ read() {} })
  const store = createReportStore({ open: () => null }, { open: () => ({ stream: source }) }, () => { throw new Error('no legacy conversion') })
  const opened = await store.open('report')
  opened.stream.destroy()
  await setImmediate()
  assert.equal(source.destroyed, true)
})

test('the 25 MiB default accepts an 11 MiB report and preserves downloads and deduplication after encrypted compression', async t => {
  const previous = { ...process.env }
  t.after(() => {
    for (const name of Object.keys(process.env)) delete process.env[name]
    Object.assign(process.env, previous)
  })
  for (const name of Object.keys(process.env)) delete process.env[name]
  Object.assign(process.env, {
    GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', SESSION_COOKIE_NAME: 'sid',
    OAUTH_CALLBACK_URL: 'http://localhost/api/oauth/github/callback',
  })
  const config = { ...loadManagedConfig(), serverless: true }
  const f = await fixture(t, true, true)
  const server = createServer(createManagedRequestHandler({
    config, db: f.db, ...f.stores, originGate: { isOriginAllowed: () => true },
    isShuttingDown: () => false, track() {},
  }))
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => { server.close(resolve) }))
  const session = await createSession(config, f.db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
  await f.db.setUserRole(session.userId, 'admin')
  function send(path, method = 'GET', body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: {
        cookie: session.setCookie.split(';')[0], 'x-csrf-token': session.csrfToken, ...headers,
      } }, res => {
        void consume(res).then(bytes => resolve({ status: res.statusCode, headers: res.headers, bytes }), reject)
      })
      req.on('error', reject)
      req.end(body)
    })
  }
  const advertised = JSON.parse((await send('/api/config')).bytes)
  assert.equal(advertised.managed.uploadMaxBytes.reports, 25 * MiB)
  const body = Buffer.from(JSON.stringify({ findings: [], padding: 'report content '.repeat(Math.ceil(11 * MiB / 15)) }))
  const count = Math.ceil(body.length / UPLOAD_CHUNK_BYTES), uploadId = randomUUID()
  for (let i = 0; i < count; i++) {
    assert.equal((await send(`/api/admin/uploads/reports/${uploadId}/${i}`, 'POST', body.subarray(i * UPLOAD_CHUNK_BYTES, (i + 1) * UPLOAD_CHUNK_BYTES))).status, 200)
  }
  const upload = await send('/api/admin/reports', 'POST', '', {
    'content-type': 'application/json', 'x-report-filename': 'large.json',
    'x-upload-id': uploadId, 'x-upload-parts': String(count), 'x-upload-size': String(body.length),
  })
  assert.equal(upload.status, 201)
  const record = JSON.parse(upload.bytes)
  assert.equal(record.byteSize, body.length)
  assert.equal(record.sha256, createHash('sha256').update(body).digest('base64url'))
  const encoded = await decodedStorage(f, `reports/${record.id}.br`, record.id)
  assert.ok(encoded.length < body.length / 5)
  const download = await send(`/api/admin/reports/${record.id}`)
  assert.equal(download.status, 200)
  assert.equal(Number(download.headers['content-length']), body.length)
  assert.deepEqual(download.bytes, body)
  const duplicate = await send('/api/admin/reports', 'POST', body, { 'x-report-filename': 'renamed.json' })
  assert.equal(duplicate.status, 200)
  assert.equal(JSON.parse(duplicate.bytes).id, record.id)
  assert.equal(JSON.parse(duplicate.bytes).deduped, true)
  const oversizedBytes = 26 * MiB, oversizedId = randomUUID()
  assert.equal((await send(`/api/admin/uploads/reports/${oversizedId}/0`, 'POST', Buffer.alloc(UPLOAD_CHUNK_BYTES, 42))).status, 200)
  const oversized = await send('/api/admin/reports', 'POST', '', {
    'x-upload-id': oversizedId, 'x-upload-parts': String(Math.ceil(oversizedBytes / UPLOAD_CHUNK_BYTES)), 'x-upload-size': String(oversizedBytes),
  })
  assert.equal(oversized.status, 413)
  assert.equal(JSON.parse(oversized.bytes).error, 'too-large')
  assert.equal((await f.raw.list('uploads/', null, 100)).objects.length, 0)
  assert.equal((await f.db.listReports()).length, 1)
})
