import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createServer, request } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gunzipSync } from 'node:zlib'
import { Bundle } from '@exodus/stasis-core/bundle'
import { sdkFixture } from './_managed-vercel.js'
import { diskStores, vercelStores } from './_managed-storage.js'
import { bundleIntegrity } from '../server-managed/bundle.ts'
import { createReportSourcesCache } from '../server-managed/report-sources.ts'
import { sourceLinkResolver } from '../common/bundle-source-links.js'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { prepareWorkspaceImport, runWorkspaceImport } from '../client/managed/workspace-import.js'

const config = {
  port: 0, host: '127.0.0.1', dbPath: ':memory:', debug: false,
  githubClientId: 'cid', githubClientSecret: 'secret', oauthCallbackUrl: 'http://localhost/api/oauth/github/callback',
  cookieSecure: false, sessionCookieName: 'sid', sessionTtlMs: 3_600_000,
  maxReportBytes: 10_485_760, maxBundleBytes: 104_857_600,
}
const files = {
  'src/main.js': 'export default "main €😀"', 'src/evidence.js': 'export const proof = true',
  'a/shared.js': 'ambiguous a', 'b/shared.js': 'ambiguous b', 'unrelated.js': 'not cited',
  'node_modules/dep/index.js': 'dependency', 'secret.js': 'security', 'secret-evidence.js': 'security proof',
}
const findings = [
  [{ id: 'f1', file: 'src/main.js', line: 1, description: 'Main', evidence: [{ file: 'evidence.js', line: 1 }, { file: 'missing.js' }, { file: 'shared.js' }] }],
  { id: 'f2', file: 'node_modules/dep/index.js', description: 'Dependency' },
  { id: 'f3', file: 'secret.js', security: true, description: 'Secret', evidence: [{ file: 'secret-evidence.js' }] },
]
async function setupBackend(t, kind = 'sourcemap', backend = 'disk', stasisModules = null) {
  const dir = await mkdtemp(join(tmpdir(), 'triage-report-sources-'))
  const db = openSqliteManagedDb(':memory:')
  const fixture = backend === 'vercel' ? sdkFixture() : null
  const storage = fixture ? await vercelStores(t, 'secret', fixture.sdk, db)
    : await diskStores(t, dir, db)
  const { reportStore: reports, bundleStore: bundles, reportSourcesStorage: cacheStorage } = storage
  const cache = createReportSourcesCache(cacheStorage, db, reports, bundles)
  const pending = new Set()
  const server = createServer(createManagedRequestHandler({
    config, db, reportStore: reports, bundleStore: bundles, reportSourcesCache: cache,
    avatarStore: { get: () => Promise.resolve(null) }, originGate: { isOriginAllowed: () => true },
    isShuttingDown: () => false, track: job => { pending.add(job); job.finally(() => pending.delete(job)).catch(() => {}) },
  }))
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => {
    const stopping = new Promise(resolve => { server.close(resolve) })
    server.closeAllConnections()
    await stopping
    await Promise.allSettled([...pending])
    await db.close()
    await rm(dir, { recursive: true, force: true })
  })
  const users = {}
  for (const [i, role] of ['admin', 'manage', 'view', 'none'].entries()) {
    const session = await createSession(config, db, { githubUserId: i + 1, login: role, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    users[role] = { ...session, cookie: session.setCookie.split(';')[0] }
  }
  await db.selectRepo({ repoId: 1, fullName: 'org/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: users.admin.userId }, Date.now())
  const team = randomUUID()
  await db.createTeam(team, 'Team', Date.now()); await db.setTeamRepo(team, 1, null)
  for (const role of ['manage', 'view', 'none']) await db.setTeamMember(team, users[role].userId, { dependencies: true, security: true })
  const bytes = kind === 'stasis' ? brotliCompressSync(Buffer.from(new Bundle({
    modules: stasisModules ?? new Map([['.', { name: 'app', version: '1', files: { ...files, 'image.png': 'AP8=' } }]]),
    formats: new Map([...Object.keys(files).map(file => [file, 'commonjs']), ['image.png', 'resource:base64']]), entries: new Set(), executable: new Set(),
    imports: new Map([
      ['node', new Map([
        ['src/main.js', new Map([['proof', 'src/evidence.js'], ['conditional', 'src/evidence.js'], ['./evidence.js', 'src/evidence.js'], ['platform', new Map([['ios', 'src/evidence.js']])], ['hidden', 'unrelated.js'], ['security', 'secret.js']])],
        ['unrelated.js', new Map([['secret-import', 'secret.js']])],
        ['secret.js', new Map([['proof', 'secret-evidence.js']])],
      ])],
      ['browser', new Map([['src/main.js', new Map([['proof', 'src/evidence.js'], ['conditional', 'secret.js'], ['./evidence.js', 'unrelated.js']])]])],
    ]),
  }).serialize())) : Buffer.from(JSON.stringify({ version: 3, sources: [...Object.keys(files), 'missing.js'], sourcesContent: [...Object.values(files), null] }))
  const bundle = { id: randomUUID(), integrity: bundleIntegrity(bytes), filename: kind === 'stasis' ? 'app.stasis.code.br' : 'app.map', kind, byteSize: bytes.length, uploadedBy: users.admin.userId, uploadedByLogin: 'admin', repoId: 1 }
  await bundles.put(bundle.id, bytes, kind); await db.insertBundle(bundle, Date.now())
  async function seed(content = JSON.stringify({ findings }), bundleId = bundle.id, filename = 'report.json') {
    const body = Buffer.from(content), id = randomUUID()
    await reports.put(id, body)
    await db.insertReport({ id, filename, contentType: 'text/plain', byteSize: body.length, sha256: createHash('sha256').update(body).digest('base64url'), uploadedBy: users.admin.userId, uploadedByLogin: 'admin', repoId: 1, repoDirectory: '', analyzer: null, visible: true, bundleId, bundleIntegrity: bundle.integrity }, Date.now())
    return db.getReport(id)
  }
  const report = await seed()
  function send(id = report.id, role = 'admin', method = 'GET', { path, body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path: path ?? `/api/reports/${id}/sources${role === 'view' ? `?team=${team}` : ''}`, method, headers: { ...headers, ...(users[role] ? { cookie: users[role].cookie, 'x-csrf-token': users[role].csrfToken } : {}) } }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => { const bytesOut = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, bytes: bytesOut, json: () => JSON.parse(res.headers['content-encoding'] === 'gzip' ? gunzipSync(bytesOut) : bytesOut) }) })
      })
      req.on('error', reject); req.end(body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    })
  }
  return { fixture, cacheStorage, db, reports, bundles, cache, bundle, bundleBytes: bytes, report, seed, send, users, team, cacheDir: join(dir, 'cache', 'report-sources') }
}

async function cachedFiles(h) {
  if (h.fixture) return [...h.fixture.objects.keys()].filter(path => path.includes('/cache/report-sources/') && path.endsWith('.json.gz')).toSorted()
  try { return (await readdir(h.cacheDir, { recursive: true })).filter(path => path.endsWith('.json.gz')).toSorted() }
  catch (err) { if (err.code === 'ENOENT') return []; throw err }
}

function deleteReport(h, id) { return h.send(id, 'admin', 'DELETE', { path: `/api/admin/reports/${id}` }) }

function sourcesTests(backend) {
  const setup = (t, kind, modules) => setupBackend(t, kind, backend, modules)

  test('Stasis import metadata is scoped to visible files and blocks ambiguous or hidden targets', async t => {
    const h = await setup(t, 'stasis')
    const admin = (await h.send()).json()
    assert.deepEqual(new Map(new Map(admin.imports).get('src/main.js')), new Map([
      ['proof', 'src/evidence.js'], ['conditional', null], ['./evidence.js', null], ['platform', null], ['hidden', null], ['security', 'secret.js'],
    ]))
    assert.equal(new Map(admin.imports).has('unrelated.js'), false)
    assert.deepEqual(new Map(admin.formats), new Map(admin.files.map(([file]) => [file, 'commonjs'])))
    assert.deepEqual(new Map(admin.packageDirs), new Map(admin.files.map(([file]) => [file, '.'])))
    await h.db.setTeamMember(h.team, h.users.view.userId, { dependencies: false, security: false })
    const restricted = (await h.send(h.report.id, 'view')).json()
    assert.deepEqual(new Map(restricted.formats), new Map(restricted.files.map(([file]) => [file, 'commonjs'])))
    assert.deepEqual(new Map(restricted.packageDirs), new Map(restricted.files.map(([file]) => [file, '.'])))
    assert.equal(new Map(restricted.formats).has('secret.js'), false)
    assert.equal(new Map(restricted.formats).has('unrelated.js'), false)
    const imports = new Map(restricted.imports)
    assert.equal(imports.has('secret.js'), false)
    assert.equal(new Map(imports.get('src/main.js')).get('security'), null)
    assert.equal(JSON.stringify(restricted.imports).includes('secret.js'), false)
    assert.equal(JSON.stringify(restricted.imports).includes('unrelated.js'), false)
    assert.equal(new Map(imports.get('src/main.js')).get('./evidence.js'), null, 'do not restore relative fallback after omitting a hidden condition')
  })

  test('Stasis source responses retain workspace boundaries without exposing uncited paths', async t => {
    const parent = 'packages/app/src/main.js'
    const h = await setup(t, 'stasis', new Map([
      ['.', { name: 'root', version: '1', files: { ...files, 'package.json': JSON.stringify({ imports: { '#local': './src/evidence.js' } }) } }],
      ['packages/app', { name: 'app', version: '1', files: { 'src/main.js': "import x from '#local';", 'hidden.js': '' } }],
    ]))
    const report = await h.seed(JSON.stringify({ findings: [{ file: parent, evidence: [{ file: 'package.json' }, { file: 'src/evidence.js' }] }] }))
    const data = (await h.send(report.id)).json()
    assert.deepEqual(new Map(data.packageDirs), new Map([[parent, 'packages/app'], ['package.json', '.'], ['src/evidence.js', '.']]))
    const imports = new Map(data.imports.map(([file, edges]) => [file, new Map(edges)])), sources = new Map(data.files)
    assert.equal(sourceLinkResolver(sources, parent, imports, sources, new Map(data.packageDirs))('#local'), null, 'the transmitted workspace boundary blocks the root manifest')
  })

  for (const kind of ['stasis', 'sourcemap']) {
    test(`${kind}: gzip includes location and evidence files only, with safe suffix matching`, async t => {
      const h = await setup(t, kind)
      const res = await h.send()
      assert.equal(res.status, 200)
      assert.equal(res.headers['content-encoding'], 'gzip')
      assert.equal(Number(res.headers['content-length']), res.bytes.length)
      assert.match(res.headers['cache-control'], /no-store/u)
      const data = res.json()
      if (kind === 'sourcemap') { assert.deepEqual(data.formats, []); assert.deepEqual(data.packageDirs, []) }
      assert.equal(data.integrity, h.bundle.integrity)
      assert.deepEqual(Object.fromEntries(data.files), Object.fromEntries(Object.entries(files).filter(([key]) => !['a/shared.js', 'b/shared.js', 'unrelated.js'].includes(key))))
      assert.equal(new Map(data.paths).get('evidence.js'), 'src/evidence.js')
      assert.equal(new Map(data.paths).has('shared.js'), false)
      const head = await h.send(h.report.id, 'admin', 'HEAD')
      assert.equal(head.status, 200); assert.equal(head.bytes.length, 0)
      assert.equal(head.headers['content-length'], res.headers['content-length'])
      assert.equal(head.headers['content-encoding'], 'gzip')
    })
  }

  test('cached report hashes share gzip bytes without reparsing; warm responses use streams', async t => {
    const h = await setup(t)
    const original = await h.send()
    const duplicate = await h.seed()
    t.mock.method(h.cacheStorage, 'exists', () => { throw new Error('warm cache must not issue HEAD') })
    t.mock.method(h.reports, 'get', () => { throw new Error('warm cache must not read report') })
    t.mock.method(h.bundles, 'get', () => { throw new Error('warm cache must not read bundle') })
    assert.deepEqual((await h.send(duplicate.id)).bytes, original.bytes)
    const opened = await h.cache.open(duplicate, await h.db.getBundle(h.bundle.id), { dependencies: true, security: true })
    assert.equal(opened.stream.readableFlowing, null)
    opened.stream.destroy()
  })

  test('report deletion keeps shared formats and removes all permissions of each unreferenced format', async t => {
    const h = await setup(t)
    const duplicate = await h.seed(), otherFormat = await h.seed(undefined, h.bundle.id, 'same-report.md')
    const unrelated = await h.seed(JSON.stringify({ findings: findings.slice(1) }))
    await h.db.setTeamMember(h.team, h.users.view.userId, { dependencies: false, security: false })
    let originalFormat
    for (const report of [h.report, otherFormat]) {
      assert.equal((await h.send(report.id)).status, 200)
      assert.equal((await h.send(report.id, 'view')).status, 200)
      if (report === h.report) originalFormat = await cachedFiles(h)
    }
    const shared = await cachedFiles(h)
    assert.equal(shared.length, 4)
    assert.equal((await h.send(unrelated.id)).status, 200)
    const all = await cachedFiles(h)
    assert.equal(all.length, 5)
    assert.equal((await deleteReport(h, h.report.id)).status, 200)
    assert.deepEqual(await cachedFiles(h), all, 'a duplicate report still owns the hash')
    const read = t.mock.method(h.bundles, 'get', () => { throw new Error('shared derivative should stay warm') })
    assert.equal((await h.send(duplicate.id)).status, 200)
    read.mock.restore()
    assert.equal((await deleteReport(h, duplicate.id)).status, 200)
    assert.deepEqual(await cachedFiles(h), all.filter(path => !originalFormat.includes(path)))
    assert.equal((await deleteReport(h, otherFormat.id)).status, 200)
    assert.deepEqual(await cachedFiles(h), all.filter(path => !shared.includes(path)))
    assert.ok(await h.db.getBundle(h.bundle.id), 'deleting reports must keep their bundle')
    assert.equal((await deleteReport(h, unrelated.id)).status, 200)
    assert.deepEqual(await cachedFiles(h), [])
  })

  test('repeated filename variants cannot accumulate derivatives beside a surviving report', async t => {
    const h = await setup(t)
    assert.equal((await h.send()).status, 200)
    const anchor = await cachedFiles(h)
    await h.db.setTeamMember(h.team, h.users.view.userId, { dependencies: false, security: false })
    for (const extension of ['tmp0', 'tmp1', 'tmp2']) {
      const variant = await h.seed(undefined, h.bundle.id, `report.${extension}`)
      const duplicate = await h.seed(undefined, h.bundle.id, `copy.${extension.toUpperCase()}`)
      assert.equal((await h.send(variant.id)).status, 200)
      assert.equal((await h.send(variant.id, 'view')).status, 200)
      const all = await cachedFiles(h)
      assert.equal(all.length, anchor.length + 2)
      assert.equal((await deleteReport(h, variant.id)).status, 200)
      assert.deepEqual(await cachedFiles(h), all, 'extension matching is case-insensitive')
      const read = t.mock.method(h.bundles, 'get', () => { throw new Error('surviving variants should stay warm') })
      assert.equal((await h.send(duplicate.id)).status, 200)
      assert.equal((await h.send()).status, 200)
      read.mock.restore()
      assert.equal((await deleteReport(h, duplicate.id)).status, 200)
      assert.deepEqual(await cachedFiles(h), anchor, 'deleting the last owner removes every permission variant')
    }
  })

  for (const otherFormatSurvives of [false, true]) {
    test(`repository removal cleans derivatives across repositories (other format survives: ${otherFormatSurvives})`, async t => {
      const h = await setup(t)
      if (otherFormatSurvives) {
        const survivor = await h.seed(undefined, h.bundle.id, 'same-report.md')
        assert.equal((await h.send(survivor.id)).status, 200)
      }
      const retained = await cachedFiles(h)
      // Removing repo 2 deletes its reports but leaves repo 1 and its bundle alive.
      await h.db.selectRepo({ repoId: 2, fullName: 'org/other', private: true, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: h.users.admin.userId }, Date.now())
      await h.db.setReportRepo(h.report.id, 2)
      assert.equal((await h.send()).status, 200)
      assert.equal((await cachedFiles(h)).length, retained.length + 1)
      const removed = await h.send(null, 'admin', 'POST', { path: '/api/admin/repositories/remove', body: { repoId: 2, fullName: 'org/other', acknowledge: true, deleteTriage: false } })
      assert.equal(removed.status, 200)
      assert.equal(await h.db.getReport(h.report.id), null)
      assert.ok(await h.db.getBundle(h.bundle.id))
      assert.deepEqual(await cachedFiles(h), retained)
    })
  }

  for (const otherFormatSurvives of [false, true]) {
    test(`deletion waits for a cold build and stale requests cannot recreate its cache (other format survives: ${otherFormatSurvives})`, async t => {
      const h = await setup(t)
      if (otherFormatSurvives) await h.seed(undefined, h.bundle.id, 'same-report.md')
      const bundle = await h.db.getBundle(h.bundle.id), bytes = await h.reports.get(h.report.id)
      const finish = Promise.withResolvers(), reading = Promise.withResolvers(), removed = Promise.withResolvers()
      const get = h.bundles.get.bind(h.bundles), remove = h.db.mutateReport.bind(h.db)
      t.mock.method(h.bundles, 'get', async (...args) => { reading.resolve(); await finish.promise; return get(...args) })
      t.mock.method(h.db, 'mutateReport', async (...args) => { const result = await remove(...args); removed.resolve(); return result })
      const loading = h.cache.open(h.report, bundle, { dependencies: true, security: true })
      await reading.promise
      const deleting = deleteReport(h, h.report.id)
      await removed.promise
      finish.resolve()
      assert.equal(await loading, null)
      assert.equal((await deleting).status, 200)
      assert.deepEqual(await cachedFiles(h), [])
      // A delayed request may already hold the report bytes when deletion wins.
      t.mock.method(h.reports, 'get', () => Promise.resolve(bytes))
      assert.equal(await h.cache.open(h.report, bundle, { dependencies: true, security: true }), null)
      assert.deepEqual(await cachedFiles(h), [])
    })
  }

  for (const stage of ['before report bytes', 'after report bytes']) {
    test(`a surviving duplicate gets sources when the shared initiator is deleted ${stage}`, async t => {
      const h = await setup(t)
      const duplicate = await h.seed()
      const finish = Promise.withResolvers(), joined = Promise.withResolvers(), reading = Promise.withResolvers()
      const getBundle = h.bundles.get.bind(h.bundles), getReport = h.reports.get.bind(h.reports), open = h.cache.open.bind(h.cache)
      const reportReads = []
      t.mock.method(h.reports, 'get', async id => {
        reportReads.push(id)
        if (stage === 'before report bytes' && id === h.report.id) { reading.resolve(); await finish.promise }
        return getReport(id)
      })
      const bundleReads = t.mock.method(h.bundles, 'get', async (...args) => {
        if (stage === 'after report bytes') { reading.resolve(); await finish.promise }
        return getBundle(...args)
      })
      t.mock.method(h.cache, 'open', (...args) => {
        const job = open(...args)
        if (args[0].id === duplicate.id) joined.resolve()
        return job
      })
      const first = h.send()
      await reading.promise
      const second = h.send(duplicate.id)
      await joined.promise
      await h.db.deleteReport(h.report.id)
      await h.reports.delete(h.report.id)
      const cleanup = h.cache.deleteReport(h.report)
      finish.resolve()
      const [a, b] = await Promise.all([first, second])
      await cleanup
      assert.ok([204, 404].includes(a.status), 'the deleted report never discloses sources')
      assert.equal(b.status, 200, 'the same request for the surviving duplicate succeeds')
      assert.equal(new Map(b.json().files).get('src/main.js'), files['src/main.js'])
      assert.equal(bundleReads.mock.callCount(), 1)
      assert.deepEqual(reportReads, stage === 'before report bytes' ? [h.report.id, duplicate.id] : [h.report.id])
      assert.equal((await cachedFiles(h)).length, 1)
      assert.equal((await deleteReport(h, duplicate.id)).status, 200)
      assert.deepEqual(await cachedFiles(h), [], 'the last deletion still evicts the shared cache')
    })
  }

  test('visibility variants cannot reuse broader cached sources; managers still need team access', async t => {
    const h = await setup(t)
    assert.equal((await h.send()).json().files.length, 5)
    await h.db.setTeamMember(h.team, h.users.view.userId, { dependencies: false, security: false })
    assert.deepEqual((await h.send(h.report.id, 'view')).json().files.map(([file]) => file), ['src/main.js', 'src/evidence.js'])
    assert.equal((await h.send(h.report.id, 'manage')).json().files.length, 5)
    await h.db.removeTeamMember(h.team, h.users.manage.userId)
    assert.equal((await h.send(h.report.id, 'manage')).status, 404)
    assert.equal((await h.send(h.report.id, 'none')).status, 403)
    assert.equal((await h.send(h.report.id, 'anonymous')).status, 401)
  })

  test('unlinked, missing and unsupported bundle content is a quiet no-op', async t => {
    const h = await setup(t), unlinked = await h.seed(undefined, null)
    assert.equal((await h.send(unlinked.id)).status, 204)
    await h.bundles.delete(h.bundle.id)
    assert.equal((await h.send()).status, 204)
    await h.db.deleteBundle(h.bundle.id)
    assert.equal((await h.send()).status, 204)
    assert.equal((await h.send(randomUUID())).status, 404)
    assert.equal((await h.send(h.report.id, 'admin', 'POST')).status, 405)
  })

  for (const change of ['permissions', 'membership', 'logout', 'delete bundle']) {
    test(`${change} during a cold build prevents source disclosure`, async t => {
      const h = await setup(t)
      const finish = Promise.withResolvers(), started = Promise.withResolvers()
      const open = h.cache.open.bind(h.cache)
      let stream
      t.mock.method(h.cache, 'open', async (...args) => {
        const result = await open(...args)
        stream = result.stream; started.resolve(); await finish.promise
        return result
      })
      const loading = h.send(h.report.id, 'view')
      await started.promise
      if (change === 'permissions') await h.db.setTeamMember(h.team, h.users.view.userId, { dependencies: false, security: false })
      if (change === 'membership') await h.db.removeTeamMember(h.team, h.users.view.userId)
      if (change === 'logout') await h.db.setUserRole(h.users.view.userId, 'none')
      if (change === 'delete bundle') await h.db.deleteBundle(h.bundle.id)
      finish.resolve()
      const res = await loading
      assert.equal(res.status, 404); assert.equal(res.headers['content-encoding'], undefined)
      assert.equal(stream.destroyed, true)
    })
  }
}
for (const backend of ['disk', 'vercel']) describe(backend, () => sourcesTests(backend))

test('Vercel sources remain shared across cold instances and stream when Blob omits its size', async t => {
  const h = await setupBackend(t, 'sourcemap', 'vercel')
  const original = await h.send()
  const duplicate = await h.seed()
  const remote = await vercelStores(t, 'secret', h.fixture.sdk, h.db)
  const cold = createReportSourcesCache(remote.reportSourcesStorage, h.db, remote.reportStore, remote.bundleStore)
  t.mock.method(remote.reportStore, 'get', () => { throw new Error('warm cache must not reparse report') })
  t.mock.method(remote.bundleStore, 'get', () => { throw new Error('warm cache must not reparse bundle') })
  const opened = await cold.open(duplicate, h.bundle, { dependencies: true, security: true })
  assert.deepEqual(Buffer.concat(await Array.fromAsync(opened.stream)), original.bytes)
  const get = h.fixture.sdk.get
  for (const size of [0, null]) {
    t.mock.method(h.fixture.sdk, 'get', async (...args) => {
      const result = await get(...args)
      return result && { ...result, blob: { ...result.blob, size } }
    })
    for (const method of ['GET', 'HEAD']) {
      const result = await h.send(duplicate.id, 'admin', method)
      assert.equal(result.status, 200)
      assert.equal(result.headers['content-length'], undefined)
      assert.deepEqual(result.bytes, method === 'HEAD' ? Buffer.alloc(0) : original.bytes)
    }
  }
})

for (const deleted of ['report', 'bundle']) {
  for (const survivor of ['none', 'same format', 'other format']) {
    test(`Vercel late source publication reconciles ${deleted} deletion (survivor: ${survivor})`, async t => {
      const h = await setupBackend(t, 'sourcemap', 'vercel')
      if (survivor !== 'none') await h.seed(undefined, h.bundle.id, survivor === 'same format' ? 'duplicate.json' : 'duplicate.md')
      const remote = await vercelStores(t, 'secret', h.fixture.sdk, h.db)
      const cold = createReportSourcesCache(remote.reportSourcesStorage, h.db, remote.reportStore, remote.bundleStore)
      const put = h.fixture.sdk.put
      t.mock.method(h.fixture.sdk, 'put', async (...args) => {
        if (args[0].includes('/cache/report-sources/')) {
          if (deleted === 'report') {
            await h.db.deleteReport(h.report.id)
            await cold.deleteReport(h.report)
          } else {
            await h.db.deleteBundle(h.bundle.id)
            await cold.deleteBundle(h.bundle.id)
          }
        }
        return put(...args)
      })
      const opened = await h.cache.open(h.report, h.bundle, { dependencies: true, security: true })
      if (deleted === 'report' && survivor === 'same format') {
        assert.ok(opened)
        opened.stream.destroy()
        assert.equal((await cachedFiles(h)).length, 1)
      } else {
        assert.equal(opened, null)
        assert.deepEqual(await cachedFiles(h), [])
      }
      assert.ok(await h.reports.get(h.report.id), 'derived cache cleanup never removes uploads')
    })
  }
}

test('Vercel bundle deletion removes source-cache versions across pages without touching other bundles', async t => {
  const h = await setupBackend(t, 'sourcemap', 'vercel')
  await h.send()
  const prefix = `.managed/cache/report-sources/${h.bundle.id}/`
  for (let i = 0; i < 5; i++) h.fixture.objects.set(`${prefix}v${i}/old.json.gz`, { bytes: Buffer.from('old cache') })
  const other = `.managed/cache/report-sources/${randomUUID()}/v1/other.json.gz`
  h.fixture.objects.set(other, { bytes: Buffer.from('other bundle') })
  const retained = [...h.fixture.objects.keys()].filter(path => !path.startsWith(prefix)).toSorted()
  t.mock.method(h.fixture.sdk, 'list', ({ prefix: requested, cursor }) => {
    const paths = [...h.fixture.objects.keys()].filter(path => path.startsWith(requested)).toSorted()
    const start = Number(cursor ?? 0)
    const end = start + 2
    return Promise.resolve({ blobs: paths.slice(start, end).map(pathname => ({ pathname })), hasMore: end < paths.length, cursor: String(end) })
  })
  await h.db.deleteBundle(h.bundle.id)
  await h.cache.deleteBundle(h.bundle.id)
  assert.deepEqual([...h.fixture.objects.keys()].toSorted(), retained)
})

test('source files follow row security and same-organization dependency access after a repository rename', async t => {
  const h = await setupBackend(t)
  const report = await h.seed(JSON.stringify({ type: 'security', findings: [
    { id: 'org-dependency', file: 'node_modules/dep/index.js', repo: { github: 'org/dep' }, security: false },
    [{ id: 'app', file: 'src/main.js', isApp: true, security: false }, { id: 'security', file: 'secret.js' }],
  ] }))
  await h.db.setTeamMember(h.team, h.users.view.userId, { dependencies: false, security: false })
  const allowed = await h.send(report.id, 'view')
  assert.equal(allowed.status, 200)
  assert.deepEqual(allowed.json().files, [['node_modules/dep/index.js', files['node_modules/dep/index.js']]])
  const repo = (await h.db.listAllRepos()).find(entry => entry.repoId === 1)
  await h.db.selectRepo({ ...repo, fullName: 'other/repo' }, Date.now())
  const renamed = await h.send(report.id, 'view')
  assert.equal(renamed.status, 200)
  assert.deepEqual(renamed.json().files, [], 'do not reuse a source cache built under another own-source organization')
  const admin = await h.send(report.id, 'admin')
  assert.deepEqual(admin.json().files.map(([file]) => file).toSorted(), ['node_modules/dep/index.js', 'secret.js', 'src/main.js'])
})

test('team link security removes source files even after a broader source response was cached', async t => {
  const h = await setupBackend(t)
  await h.db.setTeamMember(h.team, h.users.view.userId, { dependencies: false, security: false })
  assert.ok(new Map((await h.send(h.report.id, 'view')).json().files).has('src/main.js'))
  await h.seed(JSON.stringify([[{ id: 'f1' }, { id: 'f3' }]]), null, 'links.json')
  const filtered = await h.send(h.report.id, 'view')
  assert.equal(filtered.status, 200)
  assert.deepEqual(filtered.json().files, [])
  const broad = 'other-team'
  await h.db.createTeam(broad, broad, Date.now())
  await h.db.setTeamRepo(broad, 1, null)
  await h.db.setTeamMember(broad, h.users.view.userId, { dependencies: true, security: true })
  const expanded = await h.send(h.report.id, 'view', 'GET', { path: `/api/reports/${h.report.id}/sources?team=${broad}` })
  assert.ok(new Map(expanded.json().files).has('src/main.js'))
  assert.deepEqual((await h.send(h.report.id, 'view')).json().files, [], 'another team grant cannot broaden this team source cache')
})

async function repeatedIdSourceFixture(t, backend, stacked) {
  const h = await setupBackend(t, 'sourcemap', backend)
  const members = [
    { id: 'shared', file: 'src/main.js', isApp: true, evidence: [{ file: 'src/evidence.js' }] },
    { id: 'shared', file: 'node_modules/dep/index.js', isApp: false, evidence: [{ file: 'unrelated.js' }] },
  ]
  const report = await h.seed(JSON.stringify({ findings: stacked ? [members] : members }))
  const broad = randomUUID()
  await h.db.createTeam(broad, 'Broad', Date.now())
  await h.db.setTeamRepo(broad, 1, null)
  await h.db.setTeamMember(broad, h.users.view.userId, { dependencies: true, security: true })
  return { ...h, report, broad }
}

for (const backend of ['disk', 'vercel']) {
  for (const stacked of [false, true]) {
    test(`${backend}: source visibility distinguishes repeated IDs in ${stacked ? 'one row' : 'separate rows'}`, async t => {
      const h = await repeatedIdSourceFixture(t, backend, stacked)
      const broad = await h.send(h.report.id, 'view', 'GET', { path: `/api/reports/${h.report.id}/sources?team=${h.broad}` })
      assert.equal(broad.json().files.length, 4, 'warm a broader cache first')
      await h.db.setTeamMember(h.team, h.users.view.userId, { dependencies: false, security: true })
      for (let i = 0; i < 2; i++) {
        const restricted = await h.send(h.report.id, 'view')
        assert.equal(restricted.status, 200)
        assert.deepEqual(restricted.json().files.map(([file]) => file), ['src/main.js', 'src/evidence.js'])
        assert.deepEqual(restricted.json().paths.map(([path]) => path), ['src/main.js', 'src/evidence.js'])
      }
      assert.equal((await h.send(h.report.id, 'manage')).json().files.length, 4)
    })
  }

  test(`${backend}: permission changes reject in-flight sources even when visible IDs and aggregate grants stay identical`, async t => {
    const h = await repeatedIdSourceFixture(t, backend, true)
    const finish = Promise.withResolvers(), started = Promise.withResolvers()
    const open = h.cache.open.bind(h.cache)
    let stream
    t.mock.method(h.cache, 'open', async (...args) => {
      const result = await open(...args)
      stream = result.stream; started.resolve(); await finish.promise
      return result
    })
    const loading = h.send(h.report.id, 'view')
    await started.promise
    await h.db.setTeamMember(h.team, h.users.view.userId, { dependencies: false, security: true })
    finish.resolve()
    const result = await loading
    assert.equal(result.status, 404)
    assert.equal(stream.destroyed, true)
    assert.equal(result.headers['content-encoding'], undefined)
  })
}

for (const [repoId, includeBytes] of [[1, true], [1, false], [null, true], [null, false]]) {
  test(`workspace import makes ${includeBytes ? 'deduplicated' : 'referenced'} bundles in ${repoId ?? 'no'} repository readable to its members`, async t => {
    const h = await setupBackend(t)
    await h.db.setBundleRepo(h.bundle.id, repoId)
    await h.db.selectRepo({ repoId: 2, fullName: 'org/imported', private: true, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: h.users.admin.userId }, Date.now())
    await h.db.removeTeamMember(h.team, h.users.view.userId)
    const content = JSON.stringify({ repo: { github: 'org/imported' }, bundleHashes: [h.bundle.integrity], findings: [{ id: 'imported-finding', file: 'src/main.js' }] })
    const data = { workspace: { name: 'Imported workspace' }, reports: [{ name: 'imported.json', content }], bundles: [h.bundle.integrity],
      bundleBlobs: includeBytes ? [{ name: h.bundle.filename, integrity: h.bundle.integrity, data: h.bundleBytes.toString('base64') }] : [],
    }
    const plan = await prepareWorkspaceImport(data, [{ repoId: 2, fullName: 'org/imported' }])
    const api = { async send(path, body, headers) {
      const result = await h.send(null, 'admin', body === undefined ? 'GET' : 'POST', { path, headers,
        body: body instanceof File ? Buffer.from(await body.arrayBuffer()) : body,
      })
      assert.ok(result.status >= 200 && result.status < 300, `${path}: ${result.bytes}`)
      return result.json()
    } }
    const imported = await runWorkspaceImport(plan, { api, session: { id: h.users.admin.userId, role: 'admin', csrfToken: h.users.admin.csrfToken }, defaultRepo: 2, includeTriage: false })
    assert.equal((await h.db.listBundles()).length, 1, 'identical bytes retain one stored bundle')
    assert.equal((await h.db.getBundle(h.bundle.id)).repoId, repoId ?? 2, 'assigned bundles retain their repository; unassigned bundles use the chosen repository')
    const reportId = plan.reports[0].uploaded.id
    assert.equal((await h.db.getReport(reportId)).bundleId, h.bundle.id)
    const path = `/api/reports/${reportId}/sources?team=${imported.id}`
    assert.equal((await h.send(reportId, 'view', 'GET', { path })).status, 404, 'import does not grant outsiders access')
    await h.db.setTeamMember(imported.id, h.users.view.userId, { security: true, dependencies: true })
    const sources = await h.send(reportId, 'view', 'GET', { path })
    assert.equal(sources.status, 200, 'ordinary team members receive source files, not the inaccessible-bundle 204')
    assert.deepEqual(sources.json().files, [['src/main.js', files['src/main.js']]])
    if (repoId !== null) assert.equal(await h.db.userCanReadBundle(h.users.manage.userId, h.bundle.id), true, 'existing team access is preserved')
    await h.db.removeTeamMember(imported.id, h.users.view.userId)
    assert.equal((await h.send(reportId, 'view', 'GET', { path })).status, 404, 'revocation still closes access')
  })
}

for (const repoId of [1, null]) {
  test(`bundle-reference-only import creates a usable team from a stored bundle in ${repoId ?? 'no'} repository`, async t => {
    const h = await setupBackend(t)
    await h.db.setBundleRepo(h.bundle.id, repoId)
    await h.db.removeTeamMember(h.team, h.users.view.userId)
    const plan = await prepareWorkspaceImport({ workspace: { name: 'Bundle-only workspace' }, reports: [], bundles: [h.bundle.integrity] }, [])
    const calls = []
    const api = { async send(path, body) {
      calls.push({ path, body })
      const result = await h.send(null, 'admin', body === undefined ? 'GET' : 'POST', { path, body })
      assert.ok(result.status >= 200 && result.status < 300, `${path}: ${result.bytes}`)
      return result.json()
    } }
    const imported = await runWorkspaceImport(plan, { api, session: { id: h.users.admin.userId, role: 'admin', csrfToken: h.users.admin.csrfToken },
      defaultRepo: repoId === null ? 1 : null, includeTriage: false,
    })
    assert.equal(imported.name, 'Bundle-only workspace')
    assert.equal(calls.filter(call => call.path === '/api/admin/bundles').length, 1, 'reuse the catalog from validation')
    assert.equal(calls.some(call => call.body !== undefined && ['/api/admin/bundles', '/api/admin/reports'].includes(call.path)), false, 'no file uploads')
    assert.equal((await h.db.listBundles()).length, 1)
    assert.equal((await h.db.listReports()).length, 1, 'existing report inventory is unchanged')
    const path = `/api/bundles/${h.bundle.id}/download`
    assert.equal((await h.send(null, 'view', 'GET', { path })).status, 404)
    await h.db.setTeamMember(imported.id, h.users.view.userId, { security: true, dependencies: true })
    const [team] = await h.db.listTeamsForUser(h.users.view.userId)
    assert.equal(team.id, imported.id)
    assert.deepEqual(team.bundles.map(bundle => bundle.id), [h.bundle.id])
    assert.equal((await h.send(null, 'view', 'GET', { path })).status, 200, 'ordinary team members can read the existing bundle')
  })
}
