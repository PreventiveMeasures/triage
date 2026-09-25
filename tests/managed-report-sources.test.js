import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gunzipSync } from 'node:zlib'
import { Bundle } from '@exodus/stasis-core/bundle'
import { createDiskBlobStore } from '../server-managed/blob-store.ts'
import { createDiskBundleStore } from '../server-managed/bundle-store.ts'
import { bundleIntegrity } from '../server-managed/bundle.ts'
import { createReportSourcesCache } from '../server-managed/report-sources.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'

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
async function setup(t, kind = 'sourcemap') {
  const dir = await mkdtemp(join(tmpdir(), 'triage-report-sources-'))
  const db = openSqliteManagedDb(':memory:')
  const reports = createDiskBlobStore(join(dir, 'reports'))
  const bundles = createDiskBundleStore(join(dir, 'bundles'))
  const cache = createReportSourcesCache(join(dir, 'cache'), db, reports, bundles)
  const pending = new Set()
  const server = createServer(createManagedRequestHandler({
    config, db, reportStore: reports, bundleStore: bundles, reportSourcesCache: cache,
    avatarStore: { get: () => Promise.resolve(null) }, originGate: { isOriginAllowed: () => true },
    isShuttingDown: () => false, track: job => { pending.add(job); job.finally(() => pending.delete(job)).catch(() => {}) },
  }))
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { await new Promise(resolve => { server.close(resolve) }); await Promise.allSettled([...pending]); await db.close(); await rm(dir, { recursive: true, force: true }) })
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
    modules: new Map([['.', { name: 'app', version: '1', files: { ...files, 'image.png': 'AP8=' } }]]),
    formats: new Map([['image.png', 'resource:base64']]), entries: new Set(), executable: new Set(), imports: new Map(),
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
  function send(id = report.id, role = 'admin', method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path: `/api/reports/${id}/sources`, method, headers: users[role] ? { cookie: users[role].cookie } : {} }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => { const body = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, bytes: body, json: () => JSON.parse(gunzipSync(body)) }) })
      })
      req.on('error', reject); req.end()
    })
  }
  return { db, reports, bundles, cache, bundle, report, seed, send, users, team }
}

for (const kind of ['stasis', 'sourcemap']) {
  test(`${kind}: gzip includes location and evidence files only, with safe suffix matching`, async t => {
    const h = await setup(t, kind)
    const res = await h.send()
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], 'gzip')
    assert.equal(Number(res.headers['content-length']), res.bytes.length)
    assert.match(res.headers['cache-control'], /no-store/u)
    const data = res.json()
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

test('cached report hashes share gzip bytes without reparsing; warm responses use file streams', async t => {
  const h = await setup(t)
  const original = await h.send()
  const duplicate = await h.seed()
  t.mock.method(h.reports, 'get', () => { throw new Error('warm cache must not read report') })
  t.mock.method(h.bundles, 'get', () => { throw new Error('warm cache must not read bundle') })
  assert.deepEqual((await h.send(duplicate.id)).bytes, original.bytes)
  const opened = await h.cache.open(duplicate, await h.db.getBundle(h.bundle.id), { dependencies: true, security: true })
  assert.equal(opened.stream.readableFlowing, null)
  assert.equal(opened.stream.bytesRead, 0)
  opened.stream.destroy()
})

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
