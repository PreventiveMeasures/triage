// Async test doubles preserve the network API contract.
/* eslint-disable require-await */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { createServer, request as httpRequest } from 'node:http'
import { Bundle } from '@exodus/stasis-core/bundle'
import { openManagedVercelStorage } from '../server-managed/blob-vercel.ts'
import { createBundleCache } from '../server-managed/bundle-cache.ts'
import { bundleIntegrity } from '../server-managed/bundle.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'
import { UPLOAD_CHUNK_BYTES, putUploadPart, readUpload, validUploadPart } from '../server-managed/uploads.ts'

function sdkFixture() {
  const calls = [], objects = new Map()
  const missing = () => Object.assign(new Error('missing'), { name: 'BlobNotFoundError' })
  const sdk = {
    async put(path, bytes, options) {
      calls.push({ op: 'put', path, options })
      objects.set(path, { bytes, uploadedAt: new Date() })
      return { pathname: path, url: `https://private.invalid/${path}` }
    },
    async get(path, options) {
      calls.push({ op: 'get', path, options })
      const object = objects.get(path)
      if (!object) return null
      return { statusCode: 200, blob: { size: object.bytes.length }, stream: new ReadableStream({ start(controller) { controller.enqueue(object.bytes); controller.close() } }) }
    },
    async head(path) { if (!objects.has(path)) throw missing(); return { size: objects.get(path).bytes.length } },
    async del(path) { objects.delete(path) },
    async list({ prefix }) { return { blobs: [...objects].filter(([path]) => path.startsWith(prefix)).map(([pathname, { uploadedAt }]) => ({ pathname, uploadedAt })), hasMore: false } },
  }
  return { sdk, objects, calls }
}

test('private managed blobs and avatars survive independent instances without namespace collisions', async () => {
  const { sdk, objects, calls } = sdkFixture()
  const a = await openManagedVercelStorage('secret', sdk), b = await openManagedVercelStorage('secret', sdk)
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
  await assert.rejects(b.reportStore.get('../outside'), /Invalid/u)
  await b.reportStore.delete(id)
  assert.equal(await a.reportStore.get(id), null)
  const outage = await openManagedVercelStorage('secret', { ...sdk, get: () => Promise.reject(Object.assign(new Error('store gone'), { name: 'BlobStoreNotFoundError' })) })
  await assert.rejects(outage.reportStore.get(id), /store gone/u)
})

test('Brotli metadata persists across cold starts while contents use stored bundles directly', async () => {
  const { sdk, objects } = sdkFixture()
  const storage = await openManagedVercelStorage('secret', sdk)
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
  assert.deepEqual([...objects.keys()].filter(path => path.includes('/cache/')), [`.managed/cache/bundles/${id}/v2-metadata.json.br`])
  await cold.delete(id)
  assert.deepEqual(brotliDecompressSync(await consume(await cold.open(record, 'contents'))), body, 'contents work without metadata')
  await cache.prebuild(record)
  assert.ok((await consume(await cache.open(record, 'metadata'))).length > 0)
})

test('cache deletion removes every version across pages without touching other stored data', async () => {
  const { sdk, objects } = sdkFixture()
  const id = randomUUID(), other = randomUUID(), prefix = `.managed/cache/bundles/${id}/`
  const versions = ['v1-metadata.json.gz', 'v1-contents.json.gz', 'v2-metadata.json.br', 'v3-metadata.json.br', 'old/metadata.json.br']
  const retained = [`.managed/cache/bundles/${other}/v1-metadata.json.br`, `.managed/cache/bundles/${id}-other/metadata.json.br`,
    `.managed/bundles/${id}`, `.managed/bundles/${id}.map.br`, `.managed/reports/${id}`, `.managed/uploads/${id}`]
  for (const path of [...versions.map(file => prefix + file), ...retained]) objects.set(path, { bytes: Buffer.from('stored') })
  let pages = 0
  sdk.list = async options => {
    assert.equal(options.token, 'secret')
    assert.equal(options.prefix, prefix)
    pages++
    const paths = [...objects.keys()].filter(path => path.startsWith(options.prefix)).toSorted()
    const start = Number(options.cursor ?? 0)
    const end = start + 2
    return { blobs: paths.slice(start, end).map(pathname => ({ pathname })), hasMore: end < paths.length, cursor: String(end) }
  }
  const storage = await openManagedVercelStorage('secret', sdk)
  const cache = createBundleCache(storage.cacheStorage, {}, storage.bundleStore)
  await cache.delete(id)
  assert.deepEqual([...objects.keys()].toSorted(), retained.toSorted())
  assert.equal(pages, 3)
  await cache.delete(id)
  assert.deepEqual([...objects.keys()].toSorted(), retained.toSorted(), 'repeated deletion is harmless')
  await assert.rejects(cache.delete('../outside'), /Invalid/u)
})

test('cache deletion reports incomplete listings and can retry all versions', async () => {
  const { sdk, objects } = sdkFixture()
  const id = randomUUID(), prefix = `.managed/cache/bundles/${id}/`
  const paths = ['v1-metadata.json.br', 'v2-metadata.json.br'].map(file => prefix + file)
  for (const path of paths) objects.set(path, { bytes: Buffer.from('stored') })
  const list = sdk.list
  sdk.list = async ({ cursor }) => {
    if (cursor) throw new Error('listing unavailable')
    return { blobs: [{ pathname: paths[0] }], hasMore: true, cursor: 'next' }
  }
  const storage = await openManagedVercelStorage('secret', sdk)
  const cache = createBundleCache(storage.cacheStorage, {}, storage.bundleStore)
  await assert.rejects(cache.delete(id), /listing unavailable/u)
  assert.equal(objects.size, 2, 'enumeration finishes before deletion changes the listed set')
  sdk.list = list
  await cache.delete(id)
  assert.equal(objects.size, 0)
})

test('multipart upload isolation, byte limits, cleanup and orphan expiry', async () => {
  const { sdk, objects } = sdkFixture()
  const { uploadStore, reapUploads } = await openManagedVercelStorage('secret', sdk)
  const id = randomUUID(), session = 'session-one'
  const first = Buffer.alloc(UPLOAD_CHUNK_BYTES, 7), last = Buffer.from('last')
  const request = { headers: { 'x-upload-id': id, 'x-upload-parts': '2', 'x-upload-size': String(first.length + last.length) } }
  await putUploadPart(uploadStore, session, 'bundles', id, 0, first)
  await putUploadPart(uploadStore, session, 'bundles', id, 1, last)
  await assert.rejects(readUpload(uploadStore, request, 'other-session', 'bundles', 10e6), /bad-upload/u)
  await assert.rejects(readUpload(uploadStore, request, session, 'reports', 10e6), /bad-upload/u)
  await assert.rejects(readUpload(uploadStore, request, session, 'bundles', 1), /too-large/u)
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
  await reapUploads(2 * 86_400_000)
  assert.equal(objects.size, 1, 'staging GC never deletes published content')
})

test('a cache builder does not leave derivatives after another instance deletes the bundle', async () => {
  const { sdk, objects } = sdkFixture()
  let exists = true
  const upload = sdk.put
  sdk.put = async (...args) => {
    if (args[0].includes('/cache/')) exists = false
    return upload(...args)
  }
  const storage = await openManagedVercelStorage('secret', sdk)
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
  test(`private Blob ${kind} uploads preserve identity and stream Brotli contents and downloads`, async t => {
    const { sdk, objects } = sdkFixture()
    const storage = await openManagedVercelStorage('secret', sdk)
    const db = openSqliteManagedDb(':memory:')
    const config = { serverless: true, sessionCookieName: 'sid', sessionTtlMs: 3_600_000, cookieSecure: false, maxBundleBytes: 104_857_600 }
    const cache = createBundleCache(storage.cacheStorage, db, storage.bundleStore)
    const server = createServer(createManagedRequestHandler({
      config, db, ...storage, bundleCache: cache, originGate: { isOriginAllowed: () => true },
      isShuttingDown: () => false, track() {},
    }))
    await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
    t.after(async () => { await new Promise(resolve => { server.close(resolve) }); await db.close() })
    const session = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
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
    const path = `.managed/bundles/${id}${kind === 'sourcemap' ? '.map.br' : ''}`
    assert.deepEqual([...objects.keys()], [path], 'only the stored archive exists before metadata is requested')
    const encoded = objects.get(path).bytes
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
      sdk.get = async (...args) => { const result = await get(...args); return { ...result, blob: { size } } }
      for (const part of ['metadata', 'contents', 'download']) {
        for (const method of ['GET', 'HEAD']) {
          const unknownSize = await send(`/api/bundles/${id}/${part}`, method)
          assert.equal(unknownSize.status, 200)
          assert.equal(unknownSize.headers['content-length'], undefined)
          assert.deepEqual(unknownSize.bytes, method === 'HEAD' ? Buffer.alloc(0) : part === 'metadata' ? metadata.bytes : encoded)
        }
      }
    }
    assert.equal((await send(`/api/admin/bundles/${id}`, 'DELETE')).status, 200)
    assert.equal(objects.size, 0, 'deletion removes the archive and cached metadata')
  })
}
