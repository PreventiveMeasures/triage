// Async test doubles preserve the network API contract.
/* eslint-disable require-await */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { createServer, request as httpRequest } from 'node:http'
import { Bundle } from '@exodus/stasis-core/bundle'
import { vercelStores } from './_managed-storage.js'
import { createBundleCache } from '../server-managed/bundle-cache.ts'
import { bundleIntegrity } from '../server-managed/bundle.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'
import { MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES, deleteUpload, putUploadPart, readUpload, validUploadPart } from '../server-managed/uploads.ts'
import { parseStorageKey } from '../server-common/storage-crypto.ts'
import { openVercelObjectStorage } from '../server-managed/object-storage-vercel.ts'
import { createEncryptedObjectStorage } from '../server-managed/storage-encryption.ts'
import { createManagedStores } from '../server-managed/storage-stores.ts'

import { BlobStoreNotFoundError, sdkFixture } from './_managed-vercel.js'

test('private managed blobs and avatars survive independent instances without namespace collisions', async t => {
  const { sdk, objects, calls } = sdkFixture()
  const a = await vercelStores(t, 'secret', sdk), b = await vercelStores(t, 'secret', sdk)
  const id = randomUUID()
  await a.reportStore.put(id, Buffer.from('report'))
  await a.bundleStore.put(id, Buffer.from('bundle'), null)
  await a.avatarStore.put(id, 'image/png', Buffer.from('avatar'))
  assert.equal((await b.reportStore.get(id)).toString(), 'report')
  assert.equal((await b.bundleStore.get(id, null)).toString(), 'bundle')
  assert.deepEqual(await b.avatarStore.get(id), { contentType: 'image/png', bytes: Buffer.from('avatar') })
  assert.equal(objects.size, 3)
  for (const { op, options } of calls) {
    assert.equal(options.access, 'private')
    assert.equal(options.token, 'secret')
    if (op === 'put') assert.equal(options.addRandomSuffix, false)
    else assert.equal(options.useCache, false)
  }
  await assert.rejects(async () => b.reportStore.get('../outside'), /Invalid/u)
  await b.reportStore.delete(id)
  assert.equal(await a.reportStore.get(id), null)
  const outage = await vercelStores(t, 'secret', { ...sdk, get: () => Promise.reject(new BlobStoreNotFoundError()) })
  await assert.rejects(outage.reportStore.get(id), BlobStoreNotFoundError)
})

test('cache misses recover while Blob store and access failures remain errors', async t => {
  const { sdk } = sdkFixture(), id = randomUUID()
  const missing = new sdk.BlobNotFoundError()
  assert.equal(missing.name, 'Error', 'the real SDK does not set error.name to its class name')
  const storage = await vercelStores(t, 'secret', {
    ...sdk, get: async () => { throw missing }, del: async () => { throw missing },
  })
  assert.equal(await storage.cacheStorage.exists(id, 'v2-metadata.json.br'), false)
  assert.equal(await storage.reportSourcesStorage.exists(`${id}/sources.json.gz`), false)
  assert.equal(await storage.bundleStore.get(id, 'stasis'), null)
  await storage.bundleStore.delete(id)

  for (const error of [new BlobStoreNotFoundError(), new Error('Access denied'),
    Object.assign(new Error('unrelated'), { name: 'BlobNotFoundError' })]) {
    const failed = await vercelStores(t, 'secret', {
      ...sdk, head: async () => { throw error }, get: async () => { throw error }, del: async () => { throw error },
    })
    for (const attempt of [() => failed.cacheStorage.exists(id, 'v2-metadata.json.br'),
      () => failed.reportSourcesStorage.exists(`${id}/sources.json.gz`),
      () => failed.bundleStore.get(id, 'stasis'), () => failed.bundleStore.delete(id)]) {
      await assert.rejects(attempt, err => err === error)
    }
  }
})

test('Brotli metadata persists across cold starts while contents use stored bundles directly', async t => {
  const { sdk, objects } = sdkFixture()
  const storage = await vercelStores(t, 'secret', sdk)
  const body = Buffer.from(JSON.stringify({ version: 3, sources: ['hello.js'], sourcesContent: ['hello'], mappings: '' })), id = randomUUID()
  const record = { id, integrity: 'sha512-test', filename: 'sources.map', kind: 'sourcemap', byteSize: body.length }
  const db = { getBundle: async () => record }
  await storage.bundleStore.put(id, body, record.kind)
  const cache = createBundleCache(storage.cacheStorage, db, storage.bundleStore)
  await cache.prebuild(record)
  const cold = createBundleCache(storage.cacheStorage, db, { ...storage.bundleStore, get() { throw new Error('must hit shared cache') } })
  const cached = await cold.open(record, 'metadata')
  assert.equal(JSON.parse(brotliDecompressSync(await consume(cached))).id, id)
  assert.deepEqual(brotliDecompressSync(await consume(await cold.open(record, 'contents'))), body)
  assert.deepEqual(await cold.summary(record), { files: 1, codeFiles: 1, lines: 1 })
  assert.deepEqual([...objects.keys()].filter(path => path.includes('/cache/')), [`.managed/cache/bundles/${id}/v3-metadata.json.br`, `.managed/cache/bundles/${id}/v3-summary.json`])
  await cold.delete(id)
  assert.deepEqual(brotliDecompressSync(await consume(await cold.open(record, 'contents'))), body, 'contents work without metadata')
  await cache.prebuild(record)
  assert.ok((await consume(await cache.open(record, 'metadata'))).length > 0)
})

test('cache deletion removes every version across pages without touching other stored data', async t => {
  const { sdk, objects } = sdkFixture()
  const id = randomUUID(), other = randomUUID(), prefix = `.managed/cache/bundles/${id}/`
  const versions = ['v1-metadata.json.gz', 'v1-contents.json.gz', 'v2-metadata.json.br', 'v3-metadata.json.br', 'old/metadata.json.br']
  const retained = [`.managed/cache/bundles/${other}/v1-metadata.json.br`, `.managed/cache/bundles/${id}-other/metadata.json.br`,
    `.managed/bundles/${id}`, `.managed/bundles/${id}.map.br`, `.managed/reports/${id}`, `.managed/uploads/${id}`]
  for (const path of [...versions.map(file => prefix + file), ...retained]) objects.set(path, { bytes: Buffer.from('stored') })
  let pages = 0
  sdk.list = async options => {
    assert.equal(options.token, 'secret')
    assert.ok([prefix, prefix.replace('/cache/', '/cache-encrypted-v1/')].includes(options.prefix))
    pages++
    const paths = [...objects.keys()].filter(path => path.startsWith(options.prefix)).toSorted()
    const start = Number(options.cursor ?? 0)
    const end = start + 2
    return { blobs: paths.slice(start, end).map(pathname => ({ pathname })), hasMore: end < paths.length, cursor: String(end) }
  }
  const storage = await vercelStores(t, 'secret', sdk)
  const cache = createBundleCache(storage.cacheStorage, {}, storage.bundleStore)
  await cache.delete(id)
  assert.deepEqual([...objects.keys()].toSorted(), retained.toSorted())
  assert.equal(pages, 4)
  await cache.delete(id)
  assert.deepEqual([...objects.keys()].toSorted(), retained.toSorted(), 'repeated deletion is harmless')
  await assert.rejects(cache.delete('../outside'), /Invalid/u)
})

test('cache deletion reports incomplete listings and can retry all versions', async t => {
  const { sdk, objects } = sdkFixture()
  const id = randomUUID(), prefix = `.managed/cache/bundles/${id}/`
  const paths = ['v1-metadata.json.br', 'v2-metadata.json.br'].map(file => prefix + file)
  for (const path of paths) objects.set(path, { bytes: Buffer.from('stored') })
  const list = sdk.list
  sdk.list = async ({ cursor }) => {
    if (cursor) throw new Error('listing unavailable')
    return { blobs: [{ pathname: paths[0] }], hasMore: true, cursor: 'next' }
  }
  const storage = await vercelStores(t, 'secret', sdk)
  const cache = createBundleCache(storage.cacheStorage, {}, storage.bundleStore)
  await assert.rejects(cache.delete(id), /listing unavailable/u)
  assert.equal(objects.size, 2, 'enumeration finishes before deletion changes the listed set')
  sdk.list = list
  await cache.delete(id)
  assert.equal(objects.size, 0)
})

test('multipart upload isolation, byte limits, cleanup and orphan expiry', async t => {
  const { sdk, objects } = sdkFixture()
  const { uploadStore, reapUploads } = await vercelStores(t, 'secret', sdk)
  const id = randomUUID(), session = 'session-one'
  const first = Buffer.alloc(UPLOAD_CHUNK_BYTES, 7), last = Buffer.from('last')
  const request = { headers: { 'x-upload-id': id, 'x-upload-parts': '2', 'x-upload-size': String(first.length + last.length) } }
  await putUploadPart(uploadStore, session, 'bundles', id, 0, first)
  await putUploadPart(uploadStore, session, 'bundles', id, 1, last)
  await assert.rejects(readUpload(uploadStore, request, 'other-session', 'bundles', 10e6), /bad-upload/u)
  await assert.rejects(readUpload(uploadStore, request, session, 'reports', 10e6), /bad-upload/u)
  await assert.rejects(readUpload(uploadStore, request, session, 'bundles', 1), /too-large/u)
  assert.equal(objects.size, 0, 'size rejection cleans all parts even if the configured limit was lowered')
  await putUploadPart(uploadStore, session, 'bundles', id, 0, first)
  await putUploadPart(uploadStore, session, 'bundles', id, 1, last)
  assert.deepEqual(await readUpload(uploadStore, request, session, 'bundles', 10e6), Buffer.concat([first, last]))
  assert.equal(objects.size, 0)
  await assert.rejects(readUpload(uploadStore, request, session, 'bundles', 10e6), /bad-upload/u)
  assert.equal(validUploadPart(id, -1, 10e6), false)
  assert.equal(validUploadPart(id, 4, 10e6), false)
  await putUploadPart(uploadStore, session, 'bundles', id, 0, last)
  await assert.rejects(readUpload(uploadStore, request, session, 'bundles', 10e6), /bad-upload/u)
  assert.equal(objects.size, 0, 'malformed finalizations also clean staged parts')
  objects.set(`.managed/uploads/${id}`, { bytes: last, uploadedAt: new Date(0) })
  objects.set(`.managed/reports/${id}`, { bytes: last, uploadedAt: new Date(0) })
  await reapUploads()
  assert.equal(objects.size, 1, 'staging GC never deletes published content')
})

test('upload cleanup is session/kind scoped, bounded for forged counts, and continues after a delete failure', async t => {
  const { sdk, objects } = sdkFixture()
  const { uploadStore } = await vercelStores(t, 'secret', sdk)
  const bytes = Buffer.from('part'), id = randomUUID()
  for (const index of [0, 1, 2]) await putUploadPart(uploadStore, 'owner', 'reports', id, index, bytes)
  const own = [...objects.keys()]
  await putUploadPart(uploadStore, 'other', 'reports', id, 0, bytes)
  await putUploadPart(uploadStore, 'owner', 'bundles', id, 0, bytes)
  const retained = [...objects.keys()].filter(key => !own.includes(key))
  const remove = sdk.del
  let deletes = 0
  sdk.del = async path => {
    deletes++
    if (path === own[0]) throw new Error('temporary outage')
    await remove(path)
  }
  await assert.rejects(deleteUpload(uploadStore, 'owner', 'reports', id, Number.MAX_SAFE_INTEGER), /Upload cleanup failed/u)
  assert.equal(deletes, Math.ceil(MAX_UPLOAD_BYTES / UPLOAD_CHUNK_BYTES))
  assert.deepEqual([...objects.keys()], [own[0], ...retained], 'one failed delete does not stop the others')
  sdk.del = remove
  await deleteUpload(uploadStore, 'owner', 'reports', id, 3)
  await deleteUpload(uploadStore, 'owner', 'reports', id, 3)
  assert.deepEqual([...objects.keys()], retained, 'repeated cleanup never crosses the session or kind boundary')
  await putUploadPart(uploadStore, 'owner', 'reports', id, 0, bytes)
  await assert.rejects(readUpload(uploadStore, { headers: {
    'x-upload-id': id, 'x-upload-parts': String(Number.MAX_SAFE_INTEGER), 'x-upload-size': '1',
  } }, 'owner', 'reports', 1), /bad-upload/u)
  assert.deepEqual([...objects.keys()], retained, 'invalid finalization also runs bounded cleanup')
})

test('a cache builder does not leave derivatives after another instance deletes the bundle', async t => {
  const { sdk, objects } = sdkFixture()
  let exists = true
  const upload = sdk.put
  sdk.put = async (...args) => {
    if (args[0].includes('/cache/')) exists = false
    return upload(...args)
  }
  const storage = await vercelStores(t, 'secret', sdk)
  const bytes = Buffer.from(JSON.stringify({ version: 3, sources: [], sourcesContent: [], mappings: '' })), id = randomUUID()
  const record = { id, kind: 'sourcemap', filename: 'source.map', byteSize: bytes.length, integrity: 'hash' }
  objects.set(`.managed/cache/bundles/${id}/v1-metadata.json.gz`, { bytes: Buffer.from('old cache') })
  await storage.bundleStore.put(id, bytes, record.kind)
  const cache = createBundleCache(storage.cacheStorage, { getBundle: async () => exists ? record : null }, storage.bundleStore)
  await assert.rejects(cache.prebuild(record), /Bundle deleted/u)
  assert.equal([...objects.keys()].some(key => key.includes('/cache/')), false)
})

async function consume(opened) {
  const chunks = []
  for await (const bytes of opened.stream) chunks.push(bytes)
  return Buffer.concat(chunks)
}

for (const kind of ['sourcemap', 'stasis']) {
  for (const encrypted of [false, true]) {
  test(`private Blob ${kind} (encrypted=${encrypted}) uploads preserve identity and stream Brotli contents and downloads`, async t => {
    const { sdk, objects } = sdkFixture()
    const key = parseStorageKey(Buffer.alloc(32, 123).toString('base64'))
    const db = openSqliteManagedDb(':memory:', { storageEncryptionKey: key })
    if (encrypted) await db.enableStorageEncryption()
    const storage = createManagedStores(await createEncryptedObjectStorage(await openVercelObjectStorage('secret', sdk), db, key), false)
    const config = { serverless: true, sessionCookieName: 'sid', sessionTtlMs: 3_600_000, cookieSecure: false, maxBundleBytes: 104_857_600 }
    const cache = createBundleCache(storage.cacheStorage, db, storage.bundleStore)
    const server = createServer(createManagedRequestHandler({
      config, db, ...storage, bundleCache: cache, originGate: { isOriginAllowed: () => true },
      isShuttingDown: () => false, track() {},
    }))
    await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
    t.after(async () => { await new Promise(resolve => { server.close(resolve) }); await db.close() })
    const session = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, 'admin')
    async function send(path, method = 'GET', body, headers = {}) {
      return new Promise((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: {
          cookie: session.setCookie.split(';')[0], 'x-csrf-token': session.csrfToken, ...headers,
        } }, res => {
          const chunks = []
          res.on('data', bytes => chunks.push(bytes))
          res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }) })
          res.on('error', reject)
        })
        req.on('error', reject)
        req.end(body)
      })
    }
    const source = 'export default "private €😀"\n'
    const decoded = Buffer.from(kind === 'sourcemap'
      ? JSON.stringify({ version: 3, sources: ['hello.js'], sourcesContent: [source], mappings: '' })
      : new Bundle({ entries: new Set(['hello.js']), modules: new Map([['.', { name: 'app', version: '1', files: { 'hello.js': source } }]]), formats: new Map(), imports: new Map() }).serialize())
    const body = kind === 'sourcemap' ? decoded : brotliCompressSync(decoded)
    const filename = kind === 'sourcemap' ? 'source.map' : 'source.stasis.code.br'
    const upload = await send('/api/admin/bundles', 'POST', body, { 'x-bundle-filename': filename })
    assert.equal(upload.status, 201)
    const { id, integrity, byteSize } = JSON.parse(upload.bytes)
    assert.equal(integrity, bundleIntegrity(body))
    assert.equal(byteSize, body.length)
    const logical = `bundles/${id}${kind === 'sourcemap' ? '.map.br' : ''}`
    const path = `.managed/${logical}`
    assert.deepEqual([...objects.keys()], [path], 'only the stored archive exists before metadata is requested')
    const encoded = await consume(await storage.bundleStore.open(id, kind))
    if (encrypted) assert.notDeepEqual(objects.get(path).bytes, encoded)
    assert.deepEqual(brotliDecompressSync(encoded), decoded)
    if (kind === 'stasis') assert.deepEqual(encoded, body)
    const duplicate = await send('/api/admin/bundles', 'POST', body, { 'x-bundle-filename': filename })
    assert.equal(duplicate.status, 200)
    assert.equal(JSON.parse(duplicate.bytes).id, id)
    t.mock.method(storage.bundleStore, 'get', () => { throw new Error('contents/downloads must stream, not buffer') })
    for (const part of ['contents', 'download']) {
      const url = `/api/bundles/${id}/${part}`
      for (const method of ['GET', 'HEAD']) {
        const response = await send(url, method)
        assert.equal(response.status, 200)
        assert.equal(response.headers['content-encoding'], part === 'contents' || kind === 'sourcemap' ? 'br' : undefined)
        assert.equal(Number(response.headers['content-length']), encoded.length)
        assert.deepEqual(response.bytes, method === 'HEAD' ? Buffer.alloc(0) : encoded)
      }
    }
    assert.deepEqual([...objects.keys()], [path], 'contents never build a metadata cache')
    t.mock.restoreAll()
    const metadata = await send(`/api/bundles/${id}/metadata`)
    assert.equal(metadata.status, 200)
    assert.equal(metadata.headers['content-encoding'], 'br')
    assert.equal(JSON.parse(brotliDecompressSync(metadata.bytes)).id, id)
    const get = sdk.get
    for (const size of [0, null]) {
      // Private SDK GET responses can return zero even with a nonempty body.
      sdk.get = async (...args) => { const result = await get(...args); return result ? { ...result, blob: { ...result.blob, size } } : null }
      for (const part of ['metadata', 'contents', 'download']) {
        for (const method of ['GET', 'HEAD']) {
          const unknownSize = await send(`/api/bundles/${id}/${part}`, method)
          assert.equal(unknownSize.status, 200)
          const expected = part === 'metadata' ? metadata.bytes : encoded
          assert.equal(unknownSize.headers['content-length'], encrypted ? String(expected.length) : undefined)
          assert.deepEqual(unknownSize.bytes, method === 'HEAD' ? Buffer.alloc(0) : part === 'metadata' ? metadata.bytes : encoded)
        }
      }
    }
    assert.equal((await send(`/api/admin/bundles/${id}`, 'DELETE')).status, 200)
    if (encrypted) {
      assert.equal(await storage.bundleStore.open(id, kind), null, 'deletion revokes the reference immediately')
      assert.equal(await storage.cacheStorage.exists(id, 'v2-metadata.json.br'), false)
      assert.equal(objects.size, 0)
    } else assert.equal(objects.size, 0, 'deletion removes the archive and cached metadata')
  })
  }
}

test('upload reaping lists all pages before deleting stale parts and preserves recent uploads', async t => {
  const { sdk, objects } = sdkFixture()
  const now = 2 * 86_400_000, prefix = '.managed/uploads/'
  t.mock.method(Date, 'now', () => now)
  for (let i = 0; i < 8; i++) objects.set(`${prefix}${i}`, { bytes: Buffer.from('part'), uploadedAt: new Date(i % 3 === 0 ? now : 0) })
  const preserved = [...objects.keys()].filter((_, i) => i % 3 === 0)
  for (const [suffix, uploadedAt] of [['unknown', undefined], ['invalid', 'invalid'], ['boundary', new Date(now - 86_400_000)]]) {
    objects.set(`${prefix}${suffix}`, { bytes: Buffer.from('part'), uploadedAt }); preserved.push(`${prefix}${suffix}`)
  }
  const report = `.managed/reports/${randomUUID()}`
  objects.set(report, { bytes: Buffer.from('report'), uploadedAt: new Date(0) }); preserved.push(report)
  let pages = 0
  sdk.list = async ({ cursor, prefix: requested }) => {
    assert.equal(requested, prefix)
    const paths = [...objects.keys()].filter(path => path.startsWith(prefix)).toSorted()
    const start = Number(cursor ?? 0)
    const end = start + 2
    pages++
    return { blobs: paths.slice(start, end).map(pathname => ({ pathname, uploadedAt: objects.get(pathname).uploadedAt })), hasMore: end < paths.length, cursor: String(end) }
  }
  const { reapUploads } = await vercelStores(t, 'secret', sdk)
  await reapUploads()
  assert.equal(pages, 6)
  assert.deepEqual([...objects.keys()].toSorted(), preserved.toSorted())
  await reapUploads()
  assert.deepEqual([...objects.keys()].toSorted(), preserved.toSorted())
})

for (const failure of ['network', 'missing cursor', 'cyclic cursor']) {
  test(`upload reaping leaves all parts intact after ${failure} and retries successfully`, async t => {
    const { sdk, objects } = sdkFixture()
    const paths = ['a', 'b', 'c'].map(id => `.managed/uploads/${id}`)
    for (const path of paths) objects.set(path, { bytes: Buffer.from('part'), uploadedAt: new Date(0) })
    const list = sdk.list
    sdk.list = async ({ cursor }) => {
      if (cursor && failure === 'network') throw new Error('listing unavailable')
      return { blobs: [{ pathname: paths[0], uploadedAt: new Date(0) }], hasMore: true,
        cursor: failure === 'missing cursor' ? undefined : cursor === 'first' ? 'second' : 'first' }
    }
    const { reapUploads } = await vercelStores(t, 'secret', sdk)
    await assert.rejects(reapUploads(), /listing unavailable|Invalid blob pagination/u)
    assert.deepEqual([...objects.keys()], paths)
    sdk.list = list
    await reapUploads()
    assert.equal(objects.size, 0)
  })
}


test('a second Blob-backed instance reads the bounded package inventory without fetching full metadata', async t => {
  const { sdk, calls, objects } = sdkFixture()
  const storage = await vercelStores(t, 'secret', sdk)
  const serialized = new Bundle({
    entries: new Set(), executable: new Set(), formats: new Map(), imports: new Map(),
    modules: new Map([['node_modules/dep', { name: 'dep', version: '1.2.3', files: { 'index.js': 'export default 1' } }]]),
  }).serialize()
  const bytes = brotliCompressSync(Buffer.from(serialized)), id = randomUUID()
  const record = { id, integrity: 'sha512-test', filename: 'bundle.stasis.code.br', kind: 'stasis', byteSize: bytes.length }
  const db = { getBundle: async () => record }
  await storage.bundleStore.put(id, bytes, record.kind)
  const cache = createBundleCache(storage.cacheStorage, db, storage.bundleStore)
  await cache.prebuild(record)
  calls.length = 0
  const cold = createBundleCache(storage.cacheStorage, db, { get() { throw new Error('must use persisted inventory') } })
  assert.deepEqual(await cold.advisoryInventory(record), { packages: [{ ecosystem: 'npm', name: 'dep', versions: ['1.2.3'] }], skipped: [] })
  assert.equal(calls.filter(call => call.op === 'get').length, 1)
  const inventory = objects.get(`.managed/cache/bundles/${id}/v4-advisory-inventory.json`)
  assert.deepEqual(JSON.parse(inventory.bytes), { all: { packages: [{ ecosystem: 'npm', name: 'dep', versions: ['1.2.3'] }], skipped: [] }, reasons: {} })
  await cold.delete(id)
  assert.equal([...objects.keys()].some(key => key.includes('/cache/')), false)
})

test('encrypted metadata hits need one row lookup and GET, without HEADs or an unrelated inventory', async t => {
  const { sdk, calls } = sdkFixture()
  const key = parseStorageKey(Buffer.alloc(32, 123).toString('base64'))
  const db = openSqliteManagedDb(':memory:', { storageEncryptionKey: key })
  t.after(() => db.close())
  await db.enableStorageEncryption()
  const raw = await openVercelObjectStorage('secret', sdk)
  const objects = await createEncryptedObjectStorage(raw, db, key), storage = createManagedStores(objects, false)
  const bytes = Buffer.from('source bytes'), id = randomUUID()
  const dataKey = await storage.bundleStore.put(id, bytes, 'stasis')
  await db.insertBundle({ id, filename: 'bundle.stasis', integrity: 'sha512-test', kind: 'stasis', byteSize: bytes.length,
    uploadedBy: null, repoId: null, dataKey }, 1)
  await storage.cacheStorage.put(id, 'v3-metadata.json.br', Buffer.from('already cached'))
  const record = await db.getBundle(id)
  const cache = createBundleCache(storage.cacheStorage, db, {
    get() { throw new Error('metadata hits must not decode the bundle to create package inventory') },
  })
  const original = db.getStorageRow
  let rowReads = 0
  db.getStorageRow = (...args) => { rowReads++; return original(...args) }
  calls.length = 0
  assert.equal((await consume(await cache.open(record, 'metadata'))).toString(), 'already cached')
  assert.equal(rowReads, 1)
  assert.deepEqual(calls.map(call => call.op), ['get'])
  const get = sdk.get
  sdk.get = () => { throw new Error('storage outage') }
  await assert.rejects(cache.open(record, 'metadata'), /storage outage/u)
  sdk.get = get
})
