import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { brotliCompressSync } from 'node:zlib'
import { Bundle } from '@exodus/stasis-core/bundle'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { UPLOAD_CHUNK_BYTES } from '../server-managed/uploads.ts'
import { managedFetch } from '../client/managed/request.js'
import { sealUpload } from '../common/managed/upload-seal.ts'
import { splitMarkdownImport } from '../common/markdown-import.js'
import { genericMarkdown } from './_generic-markdown.js'
import { managedCsv } from './_managed-csv.js'
import { vercelStores } from './_managed-storage.js'
import { sdkFixture } from './_managed-vercel.js'

const stasis = new Bundle({
  entries: new Set(['index.js']), executable: new Set(['index.js']),
  modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'index.js': 'export default 42\n' } }]]),
  formats: new Map([['index.js', 'module']]), imports: new Map(),
}).serialize()
const sourceMap = source => JSON.stringify({ version: 3, sources: ['index.js'], sourcesContent: [source], names: [], mappings: '' })

async function fixture(t) {
  const config = { sessionCookieName: 'sid', sessionTtlMs: 3_600_000, cookieSecure: false,
    maxReportBytes: 2 * UPLOAD_CHUNK_BYTES, maxBundleBytes: 2 * UPLOAD_CHUNK_BYTES }
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, 'admin')
  const { sdk, objects } = sdkFixture()
  const stores = await vercelStores(t, 'test', sdk, db)
  const handler = createManagedRequestHandler({ config, db, ...stores,
    originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {},
  })
  async function send(body, filename = 'report.json', path = '/api/admin/reports', headers = {}, method = 'POST', cookie = session.setCookie) {
    const req = Readable.from([Buffer.from(body)])
    Object.assign(req, { url: path, method, headers: {
      cookie: cookie.split(';')[0], 'x-csrf-token': session.csrfToken,
      'x-report-filename': encodeURIComponent(filename), ...headers,
    } })
    const res = { status: 200, headersSent: false,
      writeHead(status) { this.status = status }, end(bytes) { this.body = JSON.parse(bytes); this.headersSent = true },
    }
    await handler(req, res)
    return { status: res.status, ...res.body }
  }
  return { db, objects, stores, send, session }
}

test('report uploads reject code bundles and unrecognized content before storing bytes or metadata', async t => {
  const { db, objects, send } = await fixture(t)
  const cases = [
    ['app.stasis', stasis],
    ['app.stasis.code.br', brotliCompressSync(Buffer.from(stasis))],
    ['source.map', sourceMap('export default 42')],
    ['renamed-report.json', stasis],
    ['package.json', '{"name":"app","version":"1.0.0"}'],
    ['truncated.json', '{"findings": ['],
    ['export.csv', 'finding_url,repository\nx,o/r'],
    ['notes.txt', 'This is not a report.'],
  ]
  for (const [filename, body] of cases) {
    const result = await send(body, filename)
    assert.equal(result.status, 400, filename)
    assert.equal(result.error, 'invalid-report', filename)
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0, filename)
    assert.deepEqual(await db.listReports(), [], filename)
    assert.equal(objects.size, 0, `${filename}: no stored report or upload parts`)
  }
})

test('invalid multipart report finalization rejects the file and removes every staged part', async t => {
  const { db, objects, send } = await fixture(t)
  const body = Buffer.from(sourceMap('x'.repeat(UPLOAD_CHUNK_BYTES))), id = randomUUID()
  for (let index = 0; index < 2; index++) {
    const part = body.subarray(index * UPLOAD_CHUNK_BYTES, (index + 1) * UPLOAD_CHUNK_BYTES)
    assert.equal((await send(part, 'source.map', `/api/admin/uploads/reports/${id}/${index}`)).status, 200)
  }
  assert.equal(objects.size, 2)
  const result = await send('', 'source.map', '/api/admin/reports', {
    'x-upload-id': id, 'x-upload-parts': '2', 'x-upload-size': String(body.length),
  })
  assert.equal(result.status, 400)
  assert.equal(result.error, 'invalid-report')
  assert.deepEqual(await db.listReports(), [])
  assert.equal(objects.size, 0, 'neither staging nor a report blob survives rejection')
})

test('report uploads preserve supported formats, empty findings and original bytes', async t => {
  const { db, stores, send } = await fixture(t)
  const cases = [
    ['report.json', '{"findings":[{"id":"finding","severity":"high","description":"Example"}]}'],
    ['empty.json', '{"findings":[]}'],
    ['groups.json', '{"groups":[]}'],
    ['report.md', '# Security finding\n\n---\n**Severity:** high\n'],
    ['export.CSV', managedCsv],
    ['content-detection.txt', '{"source":"test","findings":[]}'],
  ]
  for (const [filename, body] of cases) {
    const result = await send(body, filename)
    assert.equal(result.status, 201, filename)
    assert.equal((await db.getReport(result.id)).filename, filename)
    assert.deepEqual(await stores.reportStore.get(result.id), Buffer.from(body), filename)
  }
  assert.equal((await db.listReports()).length, cases.length)
})

test('managed API rejects unsplit multi-product Markdown before repository assignment or storage', async t => {
  const { db, objects, send } = await fixture(t)
  for (const headers of [{}, { 'x-repo-id': '11' }, { 'x-repo-id': '12' }]) {
    const result = await send(genericMarkdown, 'audit.md', '/api/admin/reports', headers)
    assert.equal(result.status, 400)
    assert.equal(result.error, 'invalid-report')
    assert.match(result.reason, /one report per product/u)
    assert.deepEqual(await db.listReports(), [])
    assert.equal(objects.size, 0)
  }
})

test('managed API accepts split products and single-product Markdown under their embedded repositories', async t => {
  const { db, send, session } = await fixture(t)
  for (const [i, repo] of ['a/a', 'a/b'].entries()) {
    await db.selectRepo({ repoId: 11 + i, fullName: repo, private: false, installationId: null,
      defaultBranch: 'main', htmlUrl: `https://github.com/${repo}`, addedBy: session.userId }, Date.now())
  }
  for (const [i, product] of splitMarkdownImport(genericMarkdown, 'audit.md').entries()) {
    const result = await send(product.content, product.name)
    assert.equal(result.status, 201)
    assert.equal((await db.getReport(result.id)).filename, ['audit: Product A.generic-md', 'audit: Product B.generic-md'][i])
    assert.equal((await db.getReport(result.id)).repoId, 11 + i)
    assert.equal((await db.getReport(result.id)).repoEmbedded, true)
  }
  const single = genericMarkdown.replace('| 8 | BBB-05 | Product B | P2 | Title B. |\n', '').split('\n## 2.')[0]
  const result = await send(single, 'single.md', '/api/admin/reports', { 'x-repo-id': '12' })
  assert.equal(result.status, 201)
  assert.equal((await db.getReport(result.id)).repoId, 11, 'embedded product repository wins over caller assignment')
})

// The browser client against the real handler, as a proxy would see it.
function serveFetch(t, send) {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const body = init.body instanceof Blob ? Buffer.from(await init.body.arrayBuffer()) : Buffer.from(init.body ?? '')
    const headers = Object.fromEntries(new Headers(init.headers))
    seen.push({ url, headers, body })
    const result = await send(body, decodeURIComponent(headers['x-report-filename'] ?? 'report.json'), url, headers, init.method ?? 'GET')
    const { status, ...json } = result
    return Response.json(json, { status })
  })
  return seen
}

test('browser uploads cross the wire sealed, in one request or in parts, and store their original bytes', async t => {
  const { db, stores, send } = await fixture(t)
  const seen = serveFetch(t, send)
  const report = JSON.stringify({ findings: [{ id: 'sealed-finding', severity: 'high', description: 'secret '.repeat(UPLOAD_CHUNK_BYTES / 4) }] })
  const uploaded = await (await managedFetch('/api/admin/reports', { method: 'POST', headers: { 'x-report-filename': 'r.json' }, body: new File([report], 'r.json') })).json()
  assert.ok(uploaded.id)
  assert.deepEqual(await stores.reportStore.get(uploaded.id), Buffer.from(report))
  const binary = Buffer.alloc(UPLOAD_CHUNK_BYTES + 100, 0)
  binary.write('secret binary', UPLOAD_CHUNK_BYTES)
  const bundle = await (await managedFetch('/api/admin/bundles', { method: 'POST', headers: { 'x-bundle-filename': 'app.bin' }, body: new Blob([binary]) })).json()
  const row = await db.getBundle(bundle.id)
  assert.deepEqual(await stores.bundleStore.get(bundle.id, row.kind), binary)
  const uploads = seen.filter(request => request.body.length > 0)
  assert.deepEqual(uploads.map(request => request.url.replace(/[a-f\d-]{36}/u, 'id')),
    ['/api/admin/reports', '/api/admin/uploads/bundles/id/0', '/api/admin/uploads/bundles/id/1'])
  for (const request of uploads) {
    assert.equal(request.body.includes('secret'), false, `${request.url} carries no plaintext`)
  }
  assert.ok(uploads[0].body.length < 64 * 1024, 'text is compressed before sealing')
})

test('sealed uploads need the key of the session that sends them and reject altered or oversized content', async t => {
  const { db, send, objects } = await fixture(t)
  const keyOf = async cookie => Uint8Array.fromBase64((await send('', undefined, '/api/admin/uploads/key', {}, 'GET', cookie)).key, { alphabet: 'base64url' })
  const sealed = async (content, key) => Buffer.from(await (await sealUpload(new Blob([content]), key)).arrayBuffer())
  const report = '{"findings":[{"id":"a","severity":"high","description":"Example"}]}'
  const key = await keyOf()
  assert.deepEqual(await keyOf(), key, 'the session keeps one key')
  const header = { 'x-upload-encryption': '1' }

  const other = await createSession({ sessionCookieName: 'sid', sessionTtlMs: 3_600_000, cookieSecure: false }, db,
    { githubUserId: 2, login: 'other', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(other.userId, 'triage')
  assert.deepEqual(await send('', undefined, '/api/admin/uploads/key', {}, 'GET', other.setCookie), { status: 403, error: 'forbidden' })
  await db.setUserRole(other.userId, 'manage')
  const otherKey = await keyOf(other.setCookie)
  assert.notDeepEqual(otherKey, key)

  const tampered = await sealed(report, key)
  tampered[tampered.length - 1] ^= 1
  for (const body of [tampered, await sealed(report, otherKey), Buffer.from(report)]) {
    assert.deepEqual(await send(body, 'r.json', '/api/admin/reports', header), { status: 400, error: 'bad-body' })
  }
  for (const path of ['/api/admin/reports', '/api/admin/bundles', '/api/admin/deduplication']) {
    // Highly compressible content expands past the limit only once opened.
    assert.deepEqual(await send(await sealed(' '.repeat(2 * UPLOAD_CHUNK_BYTES + 1), key), 'r.json', path, header), { status: 413, error: 'too-large' })
  }
  assert.equal(objects.size, 0)
  const stored = await send(await sealed(report, key), 'r.json', '/api/admin/reports', header)
  assert.equal(stored.status, 201)
  // Opened; link reports are then refused without storage encryption.
  assert.deepEqual(await send(await sealed('[["a", "b"]]', key), 'links.json', '/api/admin/deduplication', header),
    { status: 503, error: 'storage-encryption-required' })
})
