import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createReapHandler } from '../server-common/reap.ts'
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
const { openVercelObjectStorage } = await import('../server-managed/object-storage-vercel.ts')

async function legacyFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'triage-maintenance-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  databasePath = join(dir, 'managed.db')
  const blobs = sdkFixture()
  sdk = blobs.sdk
  const config = { dbPath: databasePath, neonUrl: 'postgres://fixture', blobToken: 'fixture', serverless: true, host: 'localhost' }
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  const legacy = await openManagedStorage(config)
  const raw = await openVercelObjectStorage('fixture', sdk)
  try {
    for (const id of ids) {
      const body = Buffer.from(id)
      await raw.put(`reports/${id}`, body)
      await legacy.db.insertReport({ id, filename: 'report', contentType: 'text/plain', byteSize: body.length,
        sha256: createHash('sha256').update(body).digest('base64url'), uploadedBy: null, repoId: null }, Date.now())
    }
  } finally { await legacy.db.close() }
  return { blobs, ids, config: { ...config, storageEncryptionKey: Buffer.alloc(32, 123).toString('base64'), storageEncryptionMigrate: true } }
}

for (const damage of ['missing', 'hash mismatch']) {
  test(`a ${damage} row reports incomplete migration without failing reap or triggering minute retries`, async t => {
    const { blobs, config, ids } = await legacyFixture(t)
    const path = `.managed/reports/${ids[0]}`
    const original = blobs.objects.get(path)
    if (damage === 'missing') blobs.objects.delete(path)
    else blobs.objects.set(path, { ...original, bytes: Buffer.from('wrong content') })
    const upload = `.managed/uploads/${randomUUID()}`
    blobs.objects.set(upload, { bytes: Buffer.from('stale upload'), uploadedAt: new Date(0) })
    let now = Date.now()
    const logs = [], warnings = []
    t.mock.method(Date, 'now', () => now)
    t.mock.method(console, 'info', (...args) => logs.push(args))
    t.mock.method(console, 'warn', (...args) => warnings.push(args))
    const app = await createManagedApp(config), observer = await openManagedStorage(config)
    try {
      const reap = createReapHandler({ managed: app.reap }, { secret: 'test' })
      const res = { writeHead(status) { this.status = status }, end() {} }
      await reap({ method: 'GET', headers: { authorization: 'Bearer test' } }, res)
      assert.equal(res.status, 200)
      assert.equal(blobs.objects.has(upload), false, 'other cleanup completes')
      assert.equal((await observer.db.getStorageEncryption()).complete, 0)
      assert.equal((await observer.db.getStorageRow('report', ids[1])).encrypted, 1)
      assert.equal(warnings.length, 1)
      assert.equal(warnings[0][0], 'managed-storage-migration-row:')
      assert.equal(JSON.parse(warnings[0][1]).id, ids[0])
      assert.equal(JSON.parse(logs.find(([label]) => label === 'managed-storage-migration:')[1]).failed, 1)
      now += 60_000
      await app.handleRequest({ url: '/api/config', method: 'GET', headers: {} }, res)
      assert.equal(warnings.length, 1, 'row damage does not schedule a one-minute retry')
      now += 3_540_000
      await app.handleRequest({ url: '/api/config', method: 'GET', headers: {} }, res)
      assert.equal(warnings.length, 2, 'pending rows retry on the ordinary hourly cadence')
      blobs.objects.set(path, original)
      await app.reap()
      assert.equal((await observer.db.getStorageEncryption()).complete, 1)
      assert.equal((await observer.reportStore.get(ids[0])).toString(), ids[0])
    } finally { await app.close(); await observer.db.close() }
  })
}

for (const conflict of ['read version', 'conditional replacement']) {
  test(`migration diagnoses repeated ${conflict} skips without exposing storage data`, async t => {
    const { blobs, config, ids } = await legacyFixture(t)
    const seed = await openManagedStorage({ ...config, storageEncryptionKey: null, storageEncryptionMigrate: false })
    const body = Buffer.from('private bundle contents'), bundleId = randomUUID()
    try {
      await seed.bundleStore.put(bundleId, body, null)
      await seed.db.insertBundle({ id: bundleId, filename: 'private-bundle-name', kind: null, byteSize: body.length,
        integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`, uploadedBy: null, repoId: null }, Date.now())
      for (let i = 1; i <= 4; i++) {
        const user = await seed.db.upsertUser({ githubUserId: i, login: `user${i}`, name: null, avatarUrl: null }, Date.now())
        await seed.db.setUserTokens(user, { accessToken: 'private-access-token', refreshToken: 'private-refresh-token', expiresAt: null })
      }
    } finally { await seed.db.close() }
    const operation = conflict === 'read version' ? 'get' : 'put'
    const original = blobs.sdk[operation]
    let reads = 0
    const fault = t.mock.method(blobs.sdk, operation, async (...args) => {
      if (operation === 'put' && args[2].ifMatch) throw new blobs.sdk.BlobPreconditionFailedError('private-provider-error')
      const result = await original(...args)
      if (operation === 'get' && result) result.blob.etag = `private-etag-${++reads}`
      return result
    })
    const logs = [], warnings = []
    t.mock.method(console, 'info', (...args) => logs.push(args))
    t.mock.method(console, 'warn', (...args) => warnings.push(args))
    const app = await createManagedApp(config), observer = await openManagedStorage(config)
    try {
      for (let batch = 0; batch < 2; batch++) {
        await app.reap()
        const progress = JSON.parse(logs.findLast(([label]) => label === 'managed-storage-migration:')[1])
        assert.deepEqual(progress, { complete: false, cleanupComplete: true, migrated: 4, cursor: null, retryAt: null, failed: 3, cancelled: false })
        const diagnostics = warnings.slice(batch * 3).map(([label, value]) => {
          assert.equal(label, 'managed-storage-migration-row:')
          return JSON.parse(value)
        })
        const message = conflict === 'read version' ? 'Conditional replacement rejected (object version precondition failed); download=unquoted; metadata=quoted; comparison=different'
          : 'Conditional replacement rejected (object version precondition failed); download=quoted; metadata=quoted; comparison=same'
        assert.deepEqual(diagnostics, [...ids.map(id => ({ type: 'report', id, message })), { type: 'bundle', id: bundleId, message }])
        // Exact field checks above and absence of provider/payload data below
        // guard against adding ETags, paths, secrets or raw errors to warnings.
        assert.doesNotMatch(JSON.stringify(warnings), /private-|\.managed\/|dataKey|sha512-|test_value/u)
        for (const { type, id } of diagnostics) {
          const row = await observer.db.getStorageRow(type, id)
          assert.ok(row.dataKey)
          assert.equal(row.encrypted, 0)
        }
      }
      fault.mock.restore()
      await app.reap()
      assert.equal((await observer.db.getStorageEncryption()).complete, 1)
      assert.equal((await observer.db.getStorageEncryption()).migrated, 7)
      assert.deepEqual(await observer.bundleStore.get(bundleId, null), body)
    } finally { await app.close(); await observer.db.close() }
  })
}

for (const { label, download, metadata, detail } of [
  { label: 'unchanged version', download: '"private-etag"', metadata: '"private-etag"', detail: 'download=quoted; metadata=quoted; comparison=same' },
  { label: 'weak download ETag', download: 'W/"private-etag"', metadata: '"private-etag"', detail: 'download=weak; metadata=quoted; comparison=format-only' },
  { label: 'different quoting', download: '"private-etag"', metadata: 'private-etag', detail: 'download=quoted; metadata=unquoted; comparison=format-only' },
  { label: 'changed version', download: '"private-etag"', metadata: '"private-other-etag"', detail: 'download=quoted; metadata=quoted; comparison=different' },
  { label: 'missing object', download: '"private-etag"', metadata: null, detail: 'download=quoted; metadata=missing' },
  { label: 'metadata failure', download: '"private-etag"', metadata: 'error', detail: 'download=quoted; metadata=unavailable' },
]) {
  test(`rejected migration diagnoses ${label} without leaking versions or changing bytes`, async t => {
    const { blobs, config, ids } = await legacyFixture(t)
    const path = `.managed/reports/${ids[0]}`
    const originalBytes = Buffer.from(blobs.objects.get(path).bytes)
    const { get, head, put } = blobs.sdk
    const reads = t.mock.method(blobs.sdk, 'get', async (...args) => {
      const result = await get(...args)
      if (args[0] === path && result) result.blob.etag = download
      return result
    })
    const writes = t.mock.method(blobs.sdk, 'put', (...args) => {
      if (args[0] !== path) return put(...args)
      assert.equal(args[2].ifMatch, download, 'never substitute metadata or normalized ETags')
      throw new blobs.sdk.BlobPreconditionFailedError('private-provider-error')
    })
    const checks = t.mock.method(blobs.sdk, 'head', async (...args) => {
      if (args[0] !== path) return head(...args)
      assert.ok(args[1].abortSignal, 'diagnostics use the same migration deadline')
      if (metadata === 'error') throw new Error('private-provider-error')
      if (metadata === null) throw new blobs.sdk.BlobNotFoundError()
      return { ...await head(...args), etag: metadata }
    })
    const warnings = []
    t.mock.method(console, 'info', () => {})
    t.mock.method(console, 'warn', (...args) => warnings.push(args))
    const app = await createManagedApp(config), observer = await openManagedStorage(config)
    try {
      await app.reap()
      assert.deepEqual(warnings, [['managed-storage-migration-row:', JSON.stringify({ type: 'report', id: ids[0],
        message: `Conditional replacement rejected (object version precondition failed); ${detail}` })]])
      assert.doesNotMatch(JSON.stringify(warnings), /private-|\.managed\/|dataKey|test_value/u)
      assert.deepEqual(blobs.objects.get(path).bytes, originalBytes)
      assert.equal((await observer.db.getStorageRow('report', ids[0])).encrypted, 0)
      assert.equal((await observer.db.getStorageRow('report', ids[1])).encrypted, 1)
      assert.equal(checks.mock.calls.filter(call => call.arguments[0] === path).length, 1)
      assert.equal(writes.mock.calls.filter(call => call.arguments[0] === path).length, 1, 'do not retry a rejected write without verification')
      reads.mock.restore(); writes.mock.restore(); checks.mock.restore()
      await app.reap()
      assert.equal((await observer.db.getStorageEncryption()).complete, 1, 'pending row can migrate on the next pass')
      assert.equal((await observer.reportStore.get(ids[0])).toString(), ids[0])
    } finally { await app.close(); await observer.db.close() }
  })
}

test('row diagnostics precede saved progress and survive a later failed operation', async t => {
  const { blobs, config, ids } = await legacyFixture(t)
  blobs.objects.delete(`.managed/reports/${ids[0]}`)
  const blocked = Promise.withResolvers(), started = Promise.withResolvers()
  const get = blobs.sdk.get
  t.mock.method(blobs.sdk, 'get', (path, options) => {
    if (path !== `.managed/reports/${ids[1]}`) return get(path, options)
    started.resolve()
    return blocked.promise
  })
  const logs = [], warnings = []
  t.mock.method(console, 'info', (...args) => logs.push(args))
  t.mock.method(console, 'warn', (...args) => warnings.push(args))
  const app = await createManagedApp(config), observer = await openManagedStorage(config)
  const running = app.reap()
  // Attach a rejection handler immediately; the simulated provider fails later.
  const failed = assert.rejects(running, /Cleanup failed/u)
  try {
    await started.promise
    assert.ok((await observer.db.getStorageEncryption()).cursor.endsWith(ids[0]), 'cursor can advance before the batch finishes')
    assert.equal(logs.some(([label]) => label === 'managed-storage-migration:'), false)
    assert.equal(logs.some(([label]) => label === 'managed-storage-migration-start:'), true)
    assert.deepEqual(logs.filter(([label]) => label === 'managed-storage-migration-row-start:').map(([, json]) => JSON.parse(json)),
      ids.map(id => ({ type: 'report', id })))
    assert.deepEqual(warnings, [['managed-storage-migration-row:', JSON.stringify({ type: 'report', id: ids[0], message: 'Migration payload unavailable' })]])
    blocked.reject(new Error('private-provider-details'))
    await failed
    assert.deepEqual(JSON.parse(warnings[1][1]), { type: 'report', id: ids[1], message: 'Migration operation failed' })
    assert.doesNotMatch(JSON.stringify(warnings), /private-provider-details|\.managed\/|dataKey|test_value/u)
    assert.equal(logs.some(([label]) => label === 'managed-storage-migration:'), false, 'a thrown batch still has its earlier row diagnostics')
  } finally {
    blocked.reject(new Error('test cleanup'))
    await failed
    await app.close()
    await observer.db.close()
  }
})

for (const operation of ['get', 'put', 'list']) {
  test(`shutdown cancels migration ${operation} and a new instance resumes with the same data key`, { timeout: 5000 }, async t => {
    const { blobs, config, ids } = await legacyFixture(t)
    const started = Promise.withResolvers()
    const original = blobs.sdk[operation]
    let aborted = false
    const blocked = t.mock.method(blobs.sdk, operation, async (...args) => {
      const selected = operation === 'list' ? args[0].prefix === '.managed/cache/' : args[0] === `.managed/reports/${ids[0]}`
      if (!selected) return original(...args)
      const { abortSignal } = operation === 'list' ? args[0] : args[operation === 'put' ? 2 : 1]
      assert.ok(abortSignal)
      started.resolve()
      await new Promise((resolve, reject) => {
        const fallback = setTimeout(() => reject(new Error('maintenance was not cancelled')), 2000)
        abortSignal.addEventListener('abort', () => { clearTimeout(fallback); aborted = true; resolve() }, { once: true })
      })
      abortSignal.throwIfAborted()
    })
    let app = await createManagedApp(config)
    const observer = await openManagedStorage(config)
    try {
      const running = app.reap()
      await started.promise
      const row = await observer.db.getStorageRow('report', ids[0])
      assert.ok(row.dataKey)
      await Promise.all([running, app.close()])
      app = null
      assert.equal(aborted, true)
      const state = await observer.db.getStorageEncryption()
      assert.equal(state.cleanupComplete, 0, 'cancellation cannot complete the migration inventory')
      if (operation !== 'list') {
        assert.equal(state.cursor, null, 'shutdown leaves the interrupted row at the checkpoint')
        assert.equal((await observer.db.getStorageRow('report', ids[0])).encrypted, 0)
      }
      blocked.mock.restore()
      await observer.reapStorage()
      assert.equal((await observer.db.getStorageEncryption()).complete, 1)
      assert.equal((await observer.db.getStorageRow('report', ids[0])).dataKey, row.dataKey)
      assert.equal((await observer.reportStore.get(ids[0])).toString(), ids[0])
    } finally { await app?.close(); await observer.db.close() }
  })
}

for (const encrypted of [false, true]) {
  test(`disk maintenance preserves unrelated files beside a shared database (encryption: ${encrypted})`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'triage-shared-storage-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const paths = ['uploads/notes.txt', 'uploads/photos/cat.jpg', `uploads/${randomUUID()}`,
      'cache/webpack/build.json', 'reports/q3-summary.pdf', 'bundles/readme.txt',
      `reports/${randomUUID()}.map.br`, `bundles/${randomUUID()}.zip`,
      'cache/bundles/not-a-uuid/source.json', `reports/${randomUUID()}.backup.tmp`]
    for (const path of paths) {
      const file = join(dir, path)
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, path)
      await utimes(file, new Date(0), new Date(0))
    }
    const config = { dbPath: join(dir, 'managed.db'), host: 'localhost',
      storageEncryptionKey: encrypted ? Buffer.alloc(32, 123).toString('base64') : null,
      storageEncryptionMigrate: encrypted }
    const storage = await openManagedStorage(config)
    assert.equal(storage.uploadStore, undefined, 'disk deployments do not store upload parts')
    assert.equal(storage.reapUploads, undefined, 'disk deployments must not sweep uploads/')
    await storage.db.close()
    const app = await createManagedApp(config)
    try {
      const res = { writeHead() {}, end() {} }
      await app.handleRequest({ url: '/api/config', method: 'GET', headers: {} }, res)
      await app.reap()
      for (const path of paths) assert.equal(await readFile(join(dir, path), 'utf8'), path)
    } finally { await app.close() }
  })
}

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
    assert.equal((await status.db.getStorageEncryption()).migrated, 0)
    await status.db.close()

    config.storageEncryptionMigrate = true
    app = await createManagedApp(config)
    await request()
    await app.close(); app = null
    status = await openManagedStorage(config)
    const first = await status.db.getStorageEncryption()
    assert.equal(first.migrated, 64, 'one request never loops through all batches')
    assert.equal(first.complete, 0)
    await status.db.close()

    config.storageEncryptionMigrate = false
    app = await createManagedApp(config)
    await request()
    await app.close(); app = null
    status = await openManagedStorage(config)
    assert.deepEqual(await status.db.getStorageEncryption(), first, 'the switch pauses migration without losing progress')
    await status.db.close()

    config.storageEncryptionMigrate = true
    app = await createManagedApp(config)
    await request()
    status = await openManagedStorage(config)
    try {
      for (let i = 0; i < 10 && !(await status.db.getStorageEncryption()).cleanupComplete; i++) await app.reap()
      const final = await status.db.getStorageEncryption()
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
