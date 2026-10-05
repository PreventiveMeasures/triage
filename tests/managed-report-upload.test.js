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
  async function send(body, filename = 'report.json', path = '/api/admin/reports', headers = {}) {
    const req = Readable.from([Buffer.from(body)])
    Object.assign(req, { url: path, method: 'POST', headers: {
      cookie: session.setCookie.split(';')[0], 'x-csrf-token': session.csrfToken,
      'x-report-filename': encodeURIComponent(filename), ...headers,
    } })
    const res = { status: 200, headersSent: false,
      writeHead(status) { this.status = status }, end(bytes) { this.body = JSON.parse(bytes); this.headersSent = true },
    }
    await handler(req, res)
    return { status: res.status, ...res.body }
  }
  return { db, objects, stores, send }
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
    ['links.json', '[[{"id":"first"},{"id":"second"}]]'],
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
