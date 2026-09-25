import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gunzipSync } from 'node:zlib'
import { Bundle } from '@exodus/stasis-core/bundle'
import { createDiskBundleCache } from '../server-managed/bundle-cache.ts'
import { createDiskBlobStore } from '../server-managed/blob-store.ts'
import { bundleIntegrity } from '../server-managed/bundle.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { parseBundleMetadata } from '../common/bundle-metadata.js'

const config = {
  port: 0, host: '127.0.0.1', dbPath: ':memory:', debug: false,
  githubClientId: 'cid', githubClientSecret: 'secret', oauthCallbackUrl: 'http://localhost/api/oauth/github/callback',
  cookieSecure: false, sessionCookieName: 'sid', sessionTtlMs: 3_600_000,
  maxReportBytes: 10_485_760, maxBundleBytes: 104_857_600,
}
const source = 'export default "private source €😀"\n'
const stasis = new Bundle({
  entries: new Set(['src/main.js']), executable: new Set(['src/main.js']),
  modules: new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': source, 'icon.png': 'AP8=' } }],
    ['node_modules/dep', { name: 'dep', version: '2.0.0', files: { 'index.js': 'export default 2\n' } }],
  ]),
  formats: new Map([['src/main.js', 'module'], ['icon.png', 'resource:base64']]),
  imports: new Map([['node,import', new Map([['src/main.js', new Map([['dep', 'node_modules/dep/index.js']])]])]]),
}).serialize()
const map = JSON.stringify({ version: 3, sources: ['src/main.js', 'missing.js'], sourcesContent: [source, null], names: ['secretName'], mappings: 'AAAA' })

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'triage-bundle-'))
  const db = openSqliteManagedDb(':memory:')
  const store = createDiskBlobStore(join(dir, 'bundles'))
  const reportStore = createDiskBlobStore(join(dir, 'reports'))
  const cacheDir = join(dir, 'cache')
  const cache = createDiskBundleCache(cacheDir, db, store)
  const pending = new Set()
  const server = createServer(createManagedRequestHandler({
    config, db, bundleStore: store, bundleCache: cache, reportStore,
    avatarStore: { get: () => Promise.resolve(null) }, originGate: { isOriginAllowed: () => true },
    isShuttingDown: () => false, track: promise => { pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}) },
  }))
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { await new Promise(resolve => { server.close(resolve) }); await Promise.allSettled([...pending]); await db.close(); await rm(dir, { recursive: true, force: true }) })
  const users = {}
  for (const [i, role] of ['admin', 'manage', 'manage', 'view', 'none'].entries()) {
    const session = await createSession(config, db, { githubUserId: i + 1, login: `user${i}`, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    users[['admin', 'owner', 'manager', 'viewer', 'none'][i]] = { ...session, cookie: session.setCookie.split(';')[0] }
  }
  for (const repoId of [1, 2]) await db.selectRepo({ repoId, fullName: `org/repo${repoId}`, private: true, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: users.admin.userId }, Date.now())
  const team = randomUUID()
  await db.createTeam(team, 'Team', Date.now())
  await db.setTeamRepo(team, 1, null)
  for (const key of ['manager', 'viewer', 'none']) await db.setTeamMember(team, users[key].userId, { dependencies: true, security: true })
  function send(path, who = 'admin', method = 'GET', body, headers = {}) {
    const user = users[who]
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: {
        ...(user ? { cookie: user.cookie, 'x-csrf-token': user.csrfToken } : {}), ...headers,
      } }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          resolve({ status: res.statusCode, headers: res.headers, bytes,
            json: () => JSON.parse((res.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString()) })
        })
      })
      req.on('error', reject)
      req.end(body)
    })
  }
  async function seed({ kind = 'stasis', owner = 'owner', repoId = null } = {}) {
    const bytes = kind === 'stasis' ? brotliCompressSync(Buffer.from(stasis)) : Buffer.from(map), id = randomUUID()
    const record = { id, integrity: bundleIntegrity(bytes), filename: kind === 'stasis' ? 'test.stasis.code.br' : 'test.map', kind, byteSize: bytes.length, uploadedBy: users[owner].userId, uploadedByLogin: owner, repoId }
    await store.put(id, bytes); await db.insertBundle(record, Date.now())
    return await db.getBundle(id)
  }
  return { db, store, reportStore, cache, cacheDir, users, send, seed, team, pending }
}

for (const kind of ['stasis', 'sourcemap']) {
  test(`${kind}: gzip cache preserves contents and metadata, and reopens without source reads`, async t => {
  const h = await setup(t), record = await h.seed({ kind, repoId: 1 })
  const url = `/api/bundles/${record.id}`
  const [metadata, contents] = await Promise.all([h.send(`${url}/metadata`, 'viewer'), h.send(`${url}/contents`, 'viewer')])
  assert.equal(metadata.status, 200); assert.equal(contents.status, 200)
  for (const res of [metadata, contents]) {
    assert.equal(res.headers['content-encoding'], 'gzip')
    assert.equal(Number(res.headers['content-length']), res.bytes.length)
    assert.match(res.headers['cache-control'], /no-store/u)
  }
  const data = metadata.json(), parsed = parseBundleMetadata(data, record.integrity)
  assert.ok(!JSON.stringify(data).includes('private source'))
  assert.ok(!JSON.stringify(data).includes('secretName'))
  assert.equal(data.codeStats.lines, kind === 'stasis' ? 2 : 1)
  assert.equal(parsed.codeStats, data.codeStats, 'precomputed stats are consumed directly')
  assert.equal(parsed.fileSizes.get('src/main.js'), Buffer.byteLength(source))
  if (kind === 'stasis') {
    assert.deepEqual(parsed.bundle.executable, new Set(['src/main.js']))
    assert.equal(parsed.bundle.imports.get('node,import').get('src/main.js').get('dep'), 'node_modules/dep/index.js')
    assert.equal(parsed.fileSizes.get('icon.png'), 2)
  }
  assert.equal(gunzipSync(contents.bytes).toString(), kind === 'stasis' ? stasis : map)
  const restarted = createDiskBundleCache(h.cacheDir, h.db, { ...h.store, get: () => { throw new Error('must use disk cache') } })
  const cached = await restarted.open(record, 'metadata')
  const chunks = []; for await (const chunk of cached.stream) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), metadata.bytes)
  const head = await h.send(`${url}/contents`, 'viewer', 'HEAD')
  assert.equal(head.status, 200); assert.equal(head.bytes.length, 0)
})

}

test('cached reads and manager inventory require ownership or team access; revocation applies on cache hits', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  const unrelated = await h.seed({ kind: 'sourcemap', owner: 'admin', repoId: 2 })
  assert.equal((await h.send('/api/admin/bundles')).json().bundles.length, 2)
  assert.deepEqual((await h.send('/api/admin/bundles', 'manager')).json().bundles.map(b => b.id), [record.id])
  assert.equal((await h.send(`/api/bundles/${unrelated.id}/contents`, 'owner')).status, 404)
  const base = `/api/bundles/${record.id}`
  for (const part of ['metadata', 'contents', 'download']) {
    for (const who of ['admin', 'owner', 'manager', 'viewer']) assert.equal((await h.send(`${base}/${part}`, who)).status, 200, `${who} ${part}`)
    assert.equal((await h.send(`${base}/${part}`, 'none')).status, 403)
    assert.equal((await h.send(`${base}/${part}`, 'logged-out')).status, 401)
  }
  const list = await h.send('/api/admin/bundles', 'owner')
  assert.equal(list.json().bundles[0].canChangeRepo, false)
  assert.deepEqual(list.json().repos, [])
  await h.db.removeTeamMember(h.team, h.users.manager.userId)
  assert.deepEqual((await h.send('/api/admin/bundles', 'manager')).json().bundles, [])
  for (const path of [`${base}/metadata`, `${base}/contents`, `${base}/download`, `/api/admin/bundles/${record.id}`]) assert.equal((await h.send(path, 'manager')).status, 404)
  assert.equal((await h.send(`${base}/metadata`, 'owner')).status, 200, 'owner retains read access after attachment')
  await h.db.setUserRole(h.users.owner.userId, 'view')
  assert.equal((await h.send(`${base}/metadata`, 'owner')).status, 404, 'ownership exception only applies to managers')
})

test('moving, detaching and deleting bundles check both bundle and repository authority', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  const move = (who, repoId) => h.send('/api/admin/bundles/set-repo', who, 'POST', JSON.stringify({ bundleId: record.id, repoId }))
  const del = who => h.send(`/api/admin/bundles/${record.id}`, who, 'DELETE')
  assert.equal((await del('owner')).status, 403)
  assert.equal((await move('owner', null)).status, 403)
  assert.equal((await move('owner', 2)).status, 403)
  assert.equal((await move('manager', 2)).status, 403, 'cannot add a link to an inaccessible destination')
  assert.equal((await move('viewer', null)).status, 403)
  assert.equal((await move('manager', null)).status, 200)
  assert.equal((await del('manager')).status, 404, 'detaching removes access for non-owner manager')
  assert.equal((await move('owner', 1)).status, 403)
  assert.equal((await move('admin', 2)).status, 200)
  assert.equal((await del('owner')).status, 403)
  assert.equal((await move('admin', null)).status, 200)
  await h.db.setTeamMember(h.team, h.users.owner.userId, { dependencies: true, security: true })
  assert.equal((await move('owner', 1)).status, 200, 'owner with destination repo access can attach')
  assert.equal((await del('owner')).status, 200)
})

test('upload prebuilds, deduplicates and deletes cached files; unauthorized upload destinations are refused', async t => {
  const h = await setup(t)
  const bytes = brotliCompressSync(Buffer.from(stasis)), headers = { 'x-bundle-filename': 'test.stasis.code.br' }
  assert.equal((await h.send('/api/admin/bundles', 'owner', 'POST', bytes, { ...headers, 'x-repo-id': '1' })).status, 403)
  const uploaded = await h.send('/api/admin/bundles', 'owner', 'POST', bytes, headers)
  assert.equal(uploaded.status, 201)
  await Promise.allSettled([...h.pending])
  const id = uploaded.json().id
  assert.deepEqual((await readdir(join(h.cacheDir, id))).toSorted(), ['v2-contents.json.gz', 'v2-metadata.json.gz'])
  assert.equal((await h.send('/api/admin/bundles', 'manager', 'POST', bytes, headers)).status, 409)
  assert.equal((await h.send('/api/admin/bundles', 'owner', 'POST', bytes, headers)).status, 200)
  assert.equal((await h.send(`/api/admin/bundles/${id}`, 'owner', 'DELETE')).status, 200)
  await assert.rejects(readdir(join(h.cacheDir, id)), { code: 'ENOENT' })
  assert.equal((await h.send(`/api/bundles/${id}/metadata`, 'owner')).status, 404)
})

test('authorized duplicate uploads repair reports uploaded before bundle access was granted', async t => {
  const h = await setup(t), record = await h.seed({ owner: 'admin', repoId: 1 })
  const uploaded = await h.send('/api/admin/reports', 'owner', 'POST', JSON.stringify({ bundleHashes: [record.integrity], findings: [] }))
  assert.equal(uploaded.status, 201)
  const reportId = uploaded.json().id
  const report = async () => (await h.db.listReports()).find(item => item.id === reportId)
  assert.equal((await report()).bundleId, null)
  assert.equal((await report()).bundleIntegrity, record.integrity)
  const bytes = await h.store.get(record.id)
  const upload = () => h.send('/api/admin/bundles', 'owner', 'POST', bytes, { 'x-bundle-filename': record.filename })
  assert.equal((await upload()).status, 409)
  assert.equal((await report()).bundleId, null, 'unauthorized dedup cannot change report links')
  await h.db.setTeamMember(h.team, h.users.owner.userId, { dependencies: true, security: true })
  const duplicate = await upload()
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.json().deduped, true)
  assert.equal((await report()).bundleId, record.id)
  assert.equal((await h.db.listBundles()).length, 1)
})

test('deletion during a cold build cannot leave cache files behind or serve deleted data', async t => {
  const h = await setup(t), record = await h.seed()
  const gate = Promise.withResolvers(), started = Promise.withResolvers()
  const cache = createDiskBundleCache(h.cacheDir, h.db, { ...h.store, get: async id => { started.resolve(); await gate.promise; return h.store.get(id) } })
  const build = cache.prebuild(record)
  await started.promise
  await h.db.deleteBundle(record.id)
  const deleted = cache.delete(record.id)
  gate.resolve()
  await assert.rejects(build, /deleted/u)
  await deleted
  await assert.rejects(readdir(join(h.cacheDir, record.id)), { code: 'ENOENT' })
})

test('a membership revoked during generation prevents the response from serving its cache', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  const gate = Promise.withResolvers(), get = h.store.get, started = Promise.withResolvers()
  h.store.get = async id => { started.resolve(); await gate.promise; return get(id) }
  const response = h.send(`/api/bundles/${record.id}/metadata`, 'viewer')
  await started.promise
  await h.db.removeTeamMember(h.team, h.users.viewer.userId)
  gate.resolve()
  assert.equal((await response).status, 404)
})

test('permanent repository removal deletes bundle derivatives too', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  await h.cache.prebuild(record)
  const removed = await h.send('/api/admin/repositories/remove', 'admin', 'POST', JSON.stringify({ repoId: 1, fullName: 'org/repo1', acknowledge: true, deleteTriage: false }))
  assert.equal(removed.status, 200)
  assert.equal(removed.json().deletedBundles, 1)
  await assert.rejects(readdir(join(h.cacheDir, record.id)), { code: 'ENOENT' })
  assert.equal(await h.store.get(record.id), null)
})

test('repository removal completes triage and blob cleanup when a bundle cache deletion fails', async t => {
  const h = await setup(t)
  const records = [await h.seed({ repoId: 1 }), await h.seed({ kind: 'sourcemap', repoId: 1 })]
  for (const record of records) await h.cache.prebuild(record)
  const findingId = randomUUID()
  const uploaded = await h.send('/api/admin/reports', 'admin', 'POST', JSON.stringify({
    findings: [{ id: findingId, file: 'index.js', description: 'Test finding' }],
  }), { 'x-repo-id': '1', 'x-filename': 'scan.json' })
  assert.equal(uploaded.status, 201)
  const reportId = uploaded.json().id
  await h.db.setTriage(findingId, { comment: 'Private discussion' }, h.users.admin.userId, 'admin', Date.now())
  const deleteCache = h.cache.delete, deletedCaches = []
  h.cache.delete = id => {
    deletedCaches.push(id)
    if (id === records[0].id) return Promise.reject(new Error('cache filesystem unavailable'))
    return deleteCache(id)
  }
  const warnings = t.mock.method(console, 'warn', () => {})
  const removed = await h.send('/api/admin/repositories/remove', 'admin', 'POST', JSON.stringify({
    repoId: 1, fullName: 'org/repo1', acknowledge: true, deleteTriage: true,
  }))
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.json(), { ok: true, deletedReports: 1, deletedBundles: 2, deletedTriage: 1 })
  assert.deepEqual(new Set(deletedCaches), new Set(records.map(record => record.id)))
  assert.equal(warnings.mock.callCount(), 1)
  assert.equal(await h.db.getReport(reportId), null)
  assert.equal(await h.reportStore.get(reportId), null)
  for (const record of records) {
    assert.equal(await h.db.getBundle(record.id), null)
    assert.equal(await h.store.get(record.id), null)
    assert.equal((await h.send(`/api/bundles/${record.id}/metadata`)).status, 404, 'orphaned cache cannot be served')
  }
  await assert.rejects(readdir(join(h.cacheDir, records[1].id)), { code: 'ENOENT' })
  assert.deepEqual(await h.db.listTriage([findingId]), [])
  assert.deepEqual(await h.db.listTriageHistory(findingId, 10), [])
  assert.deepEqual((await h.db.listAllRepos()).map(repo => repo.repoId), [2])
})

test('individual bundle removal still deletes source bytes when cache cleanup fails', async t => {
  const h = await setup(t), record = await h.seed()
  await h.cache.prebuild(record)
  h.cache.delete = () => Promise.reject(new Error('cache filesystem unavailable'))
  const warnings = t.mock.method(console, 'warn', () => {})
  const removed = await h.send(`/api/admin/bundles/${record.id}`, 'owner', 'DELETE')
  assert.equal(removed.status, 200)
  assert.equal(warnings.mock.callCount(), 1)
  assert.equal(await h.db.getBundle(record.id), null)
  assert.equal(await h.store.get(record.id), null)
  assert.equal((await h.send(`/api/bundles/${record.id}/contents`, 'owner')).status, 404)
})
