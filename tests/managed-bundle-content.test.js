import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { Bundle } from '@exodus/stasis-core/bundle'
import { MAX_PACKAGE_INVENTORY_BYTES, createBundleCache } from '../server-managed/bundle-cache.ts'
import { diskStores } from './_managed-storage.js'
import { bundleIntegrity } from '../server-managed/bundle.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'
import { parseBundleMetadata } from '../common/bundle-metadata.js'

const config = {
  port: 0, host: '127.0.0.1', dbPath: ':memory:', debug: false,
  githubClientId: 'cid', githubClientSecret: 'secret', oauthCallbackUrl: 'http://localhost/api/oauth/github/callback',
  cookieSecure: false, sessionCookieName: 'sid', sessionTtlMs: 3_600_000,
  maxReportBytes: 10_485_760, maxBundleBytes: 104_857_600,
  allowShare: true,
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
  const { bundleStore: store, reportStore, cacheStorage } = await diskStores(t, dir, db)
  const cacheDir = join(dir, 'cache', 'bundles')
  const cache = createBundleCache(cacheStorage, db, store)
  const pending = new Set()
  const server = createServer(createManagedRequestHandler({
    config, db, bundleStore: store, bundleCache: cache, reportStore,
    avatarStore: { get: () => Promise.resolve(null) }, originGate: { isOriginAllowed: () => true },
    isShuttingDown: () => false, track: promise => { pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}) },
  }))
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => {
    const stopping = new Promise(resolve => { server.close(resolve) })
    // Completed streaming responses can leave sockets waiting for keep-alive
    // expiry. The assertions are finished; teardown must not wait for clients.
    server.closeAllConnections()
    await stopping
    await Promise.allSettled([...pending])
    await db.close()
    await rm(dir, { recursive: true, force: true })
  })
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
            json: () => JSON.parse((res.headers['content-encoding'] === 'br' ? brotliDecompressSync(bytes) : bytes).toString()) })
        })
      })
      req.on('error', reject)
      req.end(body)
    })
  }
  async function seed({ kind = 'stasis', owner = 'owner', repoId = null, repoDirectory = '', bytes: suppliedBytes } = {}) {
    const bytes = suppliedBytes ?? (kind === 'stasis' ? brotliCompressSync(Buffer.from(stasis)) : Buffer.from(map)), id = randomUUID()
    const record = { id, integrity: bundleIntegrity(bytes), filename: kind === 'stasis' ? 'test.stasis.code.br' : 'test.map', kind, byteSize: bytes.length, uploadedBy: users[owner].userId, uploadedByLogin: owner, repoId, repoDirectory }
    await store.put(id, bytes, kind); await db.insertBundle(record, Date.now())
    return await db.getBundle(id)
  }
  return { db, store, reportStore, cache, cacheDir, cacheStorage, users, send, seed, team, pending, bundleDir: join(dir, 'bundles'), baseUrl: `http://127.0.0.1:${server.address().port}` }
}

test('catalog summaries reuse one cached count per hash across teams, uploads and cold starts', async t => {
  const h = await setup(t)
  const archive = await h.seed({ repoId: 1 }), sourcemap = await h.seed({ kind: 'sourcemap', repoId: 2 })
  const extraTeam = randomUUID()
  await h.db.createTeam(extraTeam, 'Second team', Date.now())
  await h.db.setTeamRepo(extraTeam, 1, '')
  await h.db.setTeamMember(extraTeam, h.users.viewer.userId, { dependencies: true, security: true })
  const reads = t.mock.method(h.store, 'get')
  const coldCatalog = (await h.send('/api/teams', 'viewer')).json()
  assert.ok(coldCatalog.teams.every(team => team.bundles.every(bundle => bundle.summary === null)))
  await Promise.all([...h.pending])
  assert.deepEqual(await readdir(join(h.cacheDir, archive.id)), ['v2-summary.json'], 'backfill does not generate or hash full metadata')
  const teamCatalog = (await h.send('/api/teams', 'viewer')).json()
  const listed = teamCatalog.teams.flatMap(team => team.bundles)
  assert.equal(listed.length, 2)
  for (const bundle of listed) {
    assert.equal(bundle.kind, 'stasis')
    assert.deepEqual(bundle.summary, { files: 3, codeFiles: 2, lines: 2 })
  }
  assert.equal(reads.mock.callCount(), 1, 'shared bundles are decoded once')
  await h.send('/api/admin/bundles')
  await Promise.all([...h.pending])
  const admin = (await h.send('/api/admin/bundles')).json().bundles
  assert.deepEqual(admin.find(bundle => bundle.id === sourcemap.id).summary, { files: 1, codeFiles: 1, lines: 1 })
  assert.equal(reads.mock.callCount(), 2)
  const duplicate = await h.send('/api/admin/bundles', 'admin', 'POST', brotliCompressSync(Buffer.from(stasis)), { 'x-bundle-filename': 'renamed.stasis.code.br' })
  assert.equal(duplicate.json().id, archive.id)
  await Promise.all([...h.pending])
  await h.send('/api/teams', 'viewer')
  await h.send('/api/admin/bundles')
  assert.equal(reads.mock.callCount(), 3, 'the upload builds full metadata once; repeat catalogs only read counts')
  const cold = createBundleCache(h.cacheStorage, h.db, { ...h.store, get() { throw new Error('must use summary cache') } })
  await writeFile(join(h.cacheDir, archive.id, 'v2-metadata.json.br'), 'summary must not decode the full metadata')
  assert.deepEqual(await cold.summary(archive), { files: 3, codeFiles: 2, lines: 2 })
  await h.db.deleteBundle(archive.id)
  await cold.delete(archive.id)
  await assert.rejects(readdir(join(h.cacheDir, archive.id)), { code: 'ENOENT' })
})

test('unavailable bundle summaries do not hide valid catalog entries or fabricate zero counts', async t => {
  const h = await setup(t)
  const broken = await h.seed({ repoId: 1, kind: 'sourcemap', bytes: Buffer.from('not json') })
  const empty = await h.seed({ repoId: 1, kind: 'sourcemap', bytes: Buffer.from('{"version":3,"sources":[],"sourcesContent":[]}') })
  await h.send('/api/teams', 'viewer')
  await Promise.all([...h.pending])
  const bundles = (await h.send('/api/teams', 'viewer')).json().teams[0].bundles
  assert.equal(bundles.find(bundle => bundle.id === broken.id).summary, null)
  const retryAt = bundles.find(bundle => bundle.id === broken.id).summaryRetryAt
  assert.ok(retryAt > Date.now(), 'the client can distinguish retry backoff from pending work')
  assert.deepEqual(bundles.find(bundle => bundle.id === empty.id).summary, { files: 0, codeFiles: 0, lines: 0 })
  assert.equal(bundles.find(bundle => bundle.id === empty.id).summaryRetryAt, null)
  const admin = (await h.send('/api/admin/bundles')).json().bundles
  assert.equal(admin.find(bundle => bundle.id === broken.id).summaryRetryAt, retryAt)
  const share = (await h.send(`/api/teams/${h.team}/share`, 'admin', 'POST', '{}')).json()
  const shared = (await h.send(`/api/teams/${h.team}/shared`, 'viewer', 'GET', undefined, { 'x-deepview-share': share.path.split('.').at(-1) })).json().team.bundles
  assert.equal(shared.find(bundle => bundle.id === broken.id).summaryRetryAt, retryAt)
})

test('deleting an unrelated bundle completes and removes bytes while a catalog backfill is stalled', async t => {
  const h = await setup(t)
  const blocked = await h.seed({ repoId: 1 }), victim = await h.seed({ kind: 'sourcemap', repoId: 2 })
  await h.cache.prebuild(victim)
  const gate = Promise.withResolvers(), get = h.store.get, started = Promise.withResolvers()
  t.mock.method(h.store, 'get', async (id, kind) => {
    if (id === blocked.id) { started.resolve(); await gate.promise }
    return get(id, kind)
  })
  let timeout
  try {
    await h.send('/api/teams', 'viewer')
    await started.promise
    const response = await Promise.race([
      h.send(`/api/admin/bundles/${victim.id}`, 'admin', 'DELETE'),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('delete waited for another bundle')), 2_000) }),
    ])
    assert.equal(response.status, 200)
    assert.equal(await h.db.getBundle(victim.id), null)
    assert.equal(await h.store.get(victim.id, victim.kind), null)
    await assert.rejects(readdir(join(h.cacheDir, victim.id)), { code: 'ENOENT' })
  } finally { clearTimeout(timeout); gate.resolve(); await Promise.all([...h.pending]) }
})

test('catalog responses recheck membership and repository scope after cached summary reads', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  const summary = h.cache.summaryStatus
  let changeAccess = () => h.db.removeTeamMember(h.team, h.users.viewer.userId)
  t.mock.method(h.cache, 'summaryStatus', async bundle => {
    const value = await summary(bundle)
    await changeAccess()
    return value
  })
  assert.deepEqual((await h.send('/api/teams', 'viewer')).json().teams, [])
  changeAccess = () => h.db.setBundleRepo(record.id, 2, '')
  assert.deepEqual((await h.send('/api/admin/bundles', 'manager')).json().bundles, [])
})

test('catalogs sharing a cold summary still recheck each caller independently', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  await h.cache.prebuild(record)
  const cold = createBundleCache(h.cacheStorage, h.db, h.store)
  const gate = Promise.withResolvers(), started = Promise.withResolvers()
  const open = h.cacheStorage.open
  let callers = 0, reads = 0
  t.mock.method(h.cacheStorage, 'open', async (...args) => {
    reads++
    await gate.promise
    return open(...args)
  })
  t.mock.method(h.cache, 'summaryStatus', bundle => {
    if (++callers === 2) started.resolve()
    return cold.summaryStatus(bundle)
  })
  const viewer = h.send('/api/teams', 'viewer')
  const manager = h.send('/api/admin/bundles', 'manager')
  try {
    await started.promise
    assert.equal(reads, 1)
    await h.db.removeTeamMember(h.team, h.users.viewer.userId)
  } finally { gate.resolve() }
  assert.deepEqual((await viewer).json().teams, [])
  const bundles = (await manager).json().bundles
  assert.deepEqual(bundles.map(bundle => bundle.id), [record.id])
  assert.deepEqual(bundles[0].summary, { files: 3, codeFiles: 2, lines: 2 })
  assert.equal(reads, 1)
})

for (const catalog of ['teams', 'admin', 'shared']) {
  test(`${catalog} catalogs respond while a cold summary backfill is stalled`, async t => {
    const h = await setup(t)
    await h.seed({ repoId: 1 })
    const gate = Promise.withResolvers(), started = Promise.withResolvers()
    const get = h.store.get
    t.mock.method(h.store, 'get', async (...args) => { started.resolve(); await gate.promise; return get(...args) })
    let headers = {}
    if (catalog === 'shared') {
      const share = (await h.send(`/api/teams/${h.team}/share`, 'admin', 'POST', '{}')).json()
      headers = { 'x-deepview-share': share.path.split('.').at(-1) }
    }
    const path = catalog === 'teams' ? '/api/teams' : catalog === 'admin' ? '/api/admin/bundles' : `/api/teams/${h.team}/shared`
    let timeout
    try {
      const response = await Promise.race([
        h.send(path, catalog === 'admin' ? 'admin' : 'viewer', 'GET', undefined, headers),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('catalog waited for backfill')), 2_000) }),
      ])
      assert.equal(response.status, 200)
      const data = response.json()
      assert.equal((data.teams?.[0] ?? data.team ?? data).bundles[0].summary, null)
      await started.promise
    } finally { clearTimeout(timeout); gate.resolve(); await Promise.all([...h.pending]) }
  })
}

test('bundle locations enforce source and destination scopes on upload, edit, download, and delete', async t => {
  const h = await setup(t)
  await h.db.removeTeamRepo(h.team, 1, null)
  await h.db.setTeamRepo(h.team, 1, 'foo')
  const headers = { 'x-bundle-filename': 'source.map', 'x-repo-id': '1', 'x-repo-directory': encodeURIComponent('/foo/./sub/') }
  const upload = await h.send('/api/admin/bundles', 'manager', 'POST', map, headers)
  assert.equal(upload.status, 201)
  const id = upload.json().id
  assert.equal(upload.json().repoDirectory, 'foo/sub')
  const url = `/api/bundles/${id}`
  assert.equal((await h.send(`${url}/metadata`, 'viewer')).status, 200)
  const edit = (who, directory, repoId = 1) => h.send('/api/admin/bundles/set-repo', who, 'POST', JSON.stringify({ bundleId: id, repoId, directory }))
  const listing = async () => (await h.send('/api/admin/bundles', 'manager')).json().bundles.find(b => b.id === id)
  assert.equal((await listing()).repoDirectory, 'foo/sub')
  assert.equal((await listing()).canChangeRepo, true)
  for (const path of ['/', '/foobar']) {
    assert.equal((await edit('manager', path)).status, 403, 'cannot move outside your granted directory')
    assert.equal((await h.send('/api/admin/bundles', 'manager', 'POST', map, { ...headers, 'x-repo-directory': path })).status, 403)
  }
  for (const path of ['../foo', 'foo/../bar', 'foo\\bar']) {
    assert.equal((await edit('admin', path)).status, 400)
    assert.equal((await h.send('/api/admin/bundles', 'admin', 'POST', map, { ...headers, 'x-repo-directory': encodeURIComponent(path) })).status, 400)
  }
  assert.equal((await h.send('/api/admin/bundles', 'admin', 'POST', map, { ...headers, 'x-repo-directory': '%' })).status, 400)
  assert.equal((await edit('manager', '/foo')).status, 200)
  const duplicate = await h.send('/api/admin/bundles', 'manager', 'POST', map, headers)
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.json().repoDirectory, 'foo', 'deduplication never changes the stored location')
  assert.equal((await edit('admin', '/foobar')).status, 200)
  for (const part of ['metadata', 'contents', 'download']) {
    for (const method of ['GET', 'HEAD']) assert.equal((await h.send(`${url}/${part}`, 'viewer', method)).status, 404, 'even cached bytes require current directory access')
  }
  assert.equal((await listing()).canChangeRepo, false, 'the uploader can retain its own bundle but cannot change a foreign location')
  assert.equal((await edit('manager', '/foo')).status, 403)
  assert.equal((await h.send(`/api/admin/bundles/${id}`, 'manager', 'DELETE')).status, 403)
  assert.equal((await edit('admin', '/foo')).status, 200)
  assert.equal((await h.send(`${url}/contents`, 'viewer')).status, 200)
  assert.equal((await edit('manager', '/foo', null)).status, 200)
  assert.equal((await h.db.getBundle(id)).repoDirectory, '')
  assert.equal((await h.send(`${url}/contents`, 'viewer')).status, 404)
  assert.equal((await h.send(`/api/admin/bundles/${id}`, 'manager', 'DELETE')).status, 200)
})

for (const kind of ['stasis', 'sourcemap']) {
  test(`${kind}: invalid UTF-8 cannot generate derivatives`, async t => {
    const h = await setup(t)
    const decoded = Buffer.from(kind === 'stasis' ? stasis : map)
    const position = decoded.indexOf('€')
    assert.notEqual(position, -1)
    decoded[position] = 0xff // Inside a JSON source string: replacement decoding still parses.
    assert.doesNotThrow(() => JSON.parse(decoded.toString('utf8')))
    const bytes = kind === 'stasis' ? brotliCompressSync(decoded) : decoded
    const record = await h.seed({ kind, bytes })
    await assert.rejects(h.cache.prebuild(record), { name: 'TypeError' })
    const metadata = await h.send(`/api/bundles/${record.id}/metadata`, 'owner')
    assert.equal(metadata.status, 422)
    assert.deepEqual(metadata.json(), { error: 'bundle-unavailable' })
    assert.equal(metadata.headers['content-encoding'], undefined)
    const contents = await h.send(`/api/bundles/${record.id}/contents`, 'owner')
    assert.equal(contents.status, 200, 'Contents bypass parsing even when metadata cannot be generated')
    assert.equal(contents.headers['content-encoding'], 'br')
    assert.deepEqual(brotliDecompressSync(contents.bytes), decoded)
    await assert.rejects(readdir(join(h.cacheDir, record.id)), { code: 'ENOENT' })
    // A failed cache build must not poison the serialized build queue.
    const valid = await h.seed({ kind })
    assert.equal((await h.send(`/api/bundles/${valid.id}/contents`, 'owner')).status, 200)
  })

  test(`${kind}: encoded delivery preserves contents, metadata and HEAD headers`, async t => {
  const h = await setup(t), record = await h.seed({ kind, repoId: 1 })
  const url = `/api/bundles/${record.id}`
  const [metadata, contents] = await Promise.all([h.send(`${url}/metadata`, 'viewer'), h.send(`${url}/contents`, 'viewer')])
  assert.equal(metadata.status, 200); assert.equal(contents.status, 200)
  assert.equal(metadata.headers['content-encoding'], 'br')
  assert.equal(contents.headers['content-encoding'], 'br')
  for (const res of [metadata, contents]) {
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
  assert.equal(brotliDecompressSync(contents.bytes).toString(), kind === 'stasis' ? stasis : map)
  assert.deepEqual(contents.bytes, await h.store.get(record.id, record.kind), 'serve the stored compressed bytes')
  const decodedResponse = await fetch(`${h.baseUrl}${url}/contents`, { headers: { cookie: h.users.viewer.cookie } })
  assert.equal(await decodedResponse.text(), kind === 'stasis' ? stasis : map, 'HTTP fetch decodes the response without client-side codecs')
  const restarted = createBundleCache(h.cacheStorage, h.db, { ...h.store, get: () => { throw new Error('must use disk cache') } })
  const cached = await restarted.open(record, 'metadata')
  const chunks = []; for await (const chunk of cached.stream) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), metadata.bytes)
  const head = await h.send(`${url}/contents`, 'viewer', 'HEAD')
  assert.equal(head.status, 200); assert.equal(head.bytes.length, 0)
  assert.equal(head.headers['content-encoding'], contents.headers['content-encoding'])
  assert.equal(head.headers['content-length'], contents.headers['content-length'])
  const download = await h.send(`${url}/download`, 'viewer')
  assert.equal(download.headers['content-encoding'], kind === 'sourcemap' ? 'br' : undefined)
  assert.deepEqual(download.bytes, contents.bytes)
  const decodedDownload = await fetch(`${h.baseUrl}${url}/download`, { headers: { cookie: h.users.viewer.cookie } })
  assert.deepEqual(Buffer.from(await decodedDownload.arrayBuffer()), kind === 'sourcemap' ? Buffer.from(map) : contents.bytes)
})

  test(`${kind}: GET and HEAD stream stored files without buffered reads`, async t => {
    const h = await setup(t), record = await h.seed({ kind, repoId: 1 })
    const bytes = await h.store.get(record.id, kind)
    t.mock.method(h.store, 'get', () => { throw new Error('must not buffer contents or downloads') })
    const open = h.store.open, streams = []
    t.mock.method(h.store, 'open', async (...args) => {
      const stored = await open(...args)
      streams.push(stored.stream)
      return stored
    })
    for (const part of ['contents', 'download']) {
      const url = `/api/bundles/${record.id}/${part}`
      const heads = await Promise.all(Array.from({ length: 4 }, () => h.send(url, 'viewer', 'HEAD')))
      for (const head of heads) {
        assert.equal(head.status, 200)
        assert.equal(Number(head.headers['content-length']), bytes.length)
        assert.equal(head.bytes.length, 0)
      }
      for (const stream of streams.splice(0)) {
        if (!stream.closed) await once(stream, 'close')
        assert.equal(stream.readableDidRead, false, 'HEAD closes the stream without consuming its body')
      }
      const response = await h.send(url, 'viewer')
      assert.equal(response.status, 200)
      assert.deepEqual(response.bytes, bytes)
      const stream = streams.shift()
      if (!stream.closed) await once(stream, 'close')
      assert.equal(stream.readableDidRead, true, 'GET consumes the body')
    }
  })
}

test('Stasis contents bypass a pending metadata build', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  const bytes = await h.store.get(record.id, record.kind)
  const gate = Promise.withResolvers(), get = h.store.get, started = Promise.withResolvers()
  t.after(() => { gate.resolve() })
  let reads = 0
  h.store.get = async (id, kind) => {
    if (++reads === 1) { started.resolve(); await gate.promise }
    return get(id, kind)
  }
  const build = h.cache.prebuild(record)
  await started.promise
  const response = await h.send(`/api/bundles/${record.id}/contents`, 'viewer')
  assert.equal(response.status, 200)
  assert.equal(response.headers['content-encoding'], 'br')
  assert.deepEqual(response.bytes, bytes)
  await assert.rejects(readdir(join(h.cacheDir, record.id)), { code: 'ENOENT' })
  gate.resolve()
  await build
  assert.deepEqual(await readdir(join(h.cacheDir, record.id)), ['v2-metadata.json.br', 'v2-package-versions.json', 'v2-summary.json'])
  assert.deepEqual((await h.send(`/api/bundles/${record.id}/contents`, 'viewer')).bytes, bytes)
  await h.store.delete(record.id)
  assert.equal((await h.send(`/api/bundles/${record.id}/contents`, 'viewer')).status, 422, 'missing source bytes are unavailable')
})

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
  assert.deepEqual(await readdir(join(h.cacheDir, id)), ['v2-metadata.json.br', 'v2-package-versions.json', 'v2-summary.json'])
  assert.equal((await h.send('/api/admin/bundles', 'manager', 'POST', bytes, headers)).status, 409)
  assert.equal((await h.send('/api/admin/bundles', 'owner', 'POST', bytes, headers)).status, 200)
  assert.equal((await h.send(`/api/admin/bundles/${id}`, 'owner', 'DELETE')).status, 200)
  await assert.rejects(readdir(join(h.cacheDir, id)), { code: 'ENOENT' })
  assert.equal((await h.send(`/api/bundles/${id}/metadata`, 'owner')).status, 404)
})

test('sourcemap uploads retain their identity while storing and serving only Brotli bytes', async t => {
  const h = await setup(t)
  const bytes = Buffer.from(map), headers = { 'x-bundle-filename': 'test.map' }
  const uploaded = await h.send('/api/admin/bundles', 'owner', 'POST', bytes, headers)
  assert.equal(uploaded.status, 201)
  const { id, integrity } = uploaded.json()
  assert.equal(integrity, bundleIntegrity(bytes))
  assert.equal(uploaded.json().byteSize, bytes.length)
  assert.deepEqual(await readdir(h.bundleDir), [`${id}.map.br`])
  const encoded = await readFile(join(h.bundleDir, `${id}.map.br`))
  assert.deepEqual(brotliDecompressSync(encoded), bytes)
  const contents = await h.send(`/api/bundles/${id}/contents`, 'owner')
  assert.equal(contents.headers['content-encoding'], 'br')
  assert.deepEqual(contents.bytes, encoded)
  await Promise.allSettled([...h.pending])
  assert.deepEqual(await readdir(join(h.cacheDir, id)), ['v2-metadata.json.br', 'v2-summary.json'])
  const duplicate = await h.send('/api/admin/bundles', 'owner', 'POST', bytes, headers)
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.json().id, id)
  assert.deepEqual(await readFile(join(h.bundleDir, `${id}.map.br`)), encoded)
  assert.equal((await h.send(`/api/admin/bundles/${id}`, 'owner', 'DELETE')).status, 200)
  assert.deepEqual(await readdir(h.bundleDir), [])
})

test('authorized duplicate uploads repair reports uploaded before bundle access was granted', async t => {
  const h = await setup(t), record = await h.seed({ owner: 'admin', repoId: 1 })
  const uploaded = await h.send('/api/admin/reports', 'owner', 'POST', JSON.stringify({ bundleHashes: [record.integrity], findings: [] }))
  assert.equal(uploaded.status, 201)
  const reportId = uploaded.json().id
  const report = async () => (await h.db.listReports()).find(item => item.id === reportId)
  assert.equal((await report()).bundleId, null)
  assert.equal((await report()).bundleIntegrity, record.integrity)
  const bytes = await h.store.get(record.id, record.kind)
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
  const cache = createBundleCache(h.cacheStorage, h.db, { ...h.store, get: async (id, kind) => { started.resolve(); await gate.promise; return h.store.get(id, kind) } })
  const build = cache.prebuild(record)
  await started.promise
  await h.db.deleteBundle(record.id)
  const deleted = cache.delete(record.id)
  gate.resolve()
  await assert.rejects(build, /deleted/u)
  await deleted
  await assert.rejects(readdir(join(h.cacheDir, record.id)), { code: 'ENOENT' })
})

for (const part of ['metadata', 'contents', 'download']) {
  for (const change of ['membership', 'directory', 'role', 'session']) {
    test(`a revoked ${change} grant while loading ${part} prevents serving it`, async t => {
      const h = await setup(t), record = await h.seed({ repoId: 1, repoDirectory: 'foo' })
      await h.db.removeTeamRepo(h.team, 1, null)
      await h.db.setTeamRepo(h.team, 1, 'foo')
      const method = part === 'metadata' ? 'get' : 'open'
      const gate = Promise.withResolvers(), read = h.store[method], started = Promise.withResolvers()
      h.store[method] = async (id, kind) => { started.resolve(); await gate.promise; return read(id, kind) }
      const response = h.send(`/api/bundles/${record.id}/${part}`, 'viewer')
      await started.promise
      if (change === 'membership') await h.db.removeTeamMember(h.team, h.users.viewer.userId)
      if (change === 'directory') await h.db.setBundleRepo(record.id, 1, 'foobar')
      if (change === 'role') await h.db.setUserRole(h.users.viewer.userId, 'none')
      if (change === 'session') await h.db.deleteSession(hashToken(h.users.viewer.cookie.slice(4)))
      gate.resolve()
      assert.equal((await response).status, change === 'session' ? 401 : 404)
    })
  }
}

test('permanent repository removal deletes bundle derivatives too', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  await h.cache.prebuild(record)
  const removed = await h.send('/api/admin/repositories/remove', 'admin', 'POST', JSON.stringify({ repoId: 1, fullName: 'org/repo1', acknowledge: true, deleteTriage: false }))
  assert.equal(removed.status, 200)
  assert.equal(removed.json().deletedBundles, 1)
  await assert.rejects(readdir(join(h.cacheDir, record.id)), { code: 'ENOENT' })
  assert.equal(await h.store.get(record.id, record.kind), null)
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
    assert.equal(await h.store.get(record.id, record.kind), null)
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
  assert.equal(await h.store.get(record.id, record.kind), null)
  assert.equal((await h.send(`/api/bundles/${record.id}/contents`, 'owner')).status, 404)
})

// The upstream HTTP call is the only mock: routing, sessions, permissions,
// package extraction and cached bundle metadata use the real implementations.
test('bundle advisories require security, independently of dependency findings', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  const path = `/api/bundles/${record.id}/advisories`
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    calls.push({ url, init })
    return Promise.resolve(Response.json({ dep: [{ title: 'Published vulnerability', severity: 'high' }] }))
  })
  assert.equal((await h.send(path, 'anonymous')).status, 401)
  assert.equal((await h.send(path, 'none')).status, 403)
  assert.equal((await h.send(path, 'viewer', 'POST')).status, 405)
  for (const dependencies of [false, true]) {
    await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies, security: false })
    assert.equal((await h.send(path, 'viewer')).status, 403)
    assert.equal(calls.length, 0)
  }
  for (const dependencies of [false, true]) {
    await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies, security: true })
    const response = await h.send(`${path}?team=${h.team}`, 'viewer')
    assert.equal(response.status, 200)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.deepEqual(response.json(), { packages: { dep: ['2.0.0'] }, advisories: { dep: [{ title: 'Published vulnerability', severity: 'high' }] } })
    assert.equal(calls.at(-1).url, 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk')
    assert.deepEqual(JSON.parse(Buffer.from(calls.at(-1).init.body)), { dep: ['2.0.0'] })
    assert.deepEqual(calls.at(-1).init.headers, { 'content-type': 'application/json', accept: 'application/json' })
    assert.equal(response.bytes.includes(Buffer.from(source)), false)
  }
  const otherTeam = randomUUID()
  await h.db.createTeam(otherTeam, 'Other team', Date.now())
  await h.db.setTeamRepo(otherTeam, 1, null)
  await h.db.setTeamMember(otherTeam, h.users.viewer.userId, { dependencies: true, security: false })
  assert.equal((await h.send(`${path}?team=${otherTeam}`, 'viewer')).status, 403, 'a grant in another team does not authorize this team')
  assert.equal((await h.send(`${path}?team=${randomUUID()}`, 'viewer')).status, 403)
  assert.equal((await h.send(path, 'admin')).status, 200)
  assert.equal((await h.send(path, 'manager')).status, 200)
  await h.db.setBundleRepo(record.id, 2)
  assert.equal((await h.send(path, 'viewer')).status, 404)
  assert.equal((await h.send(path, 'manager')).status, 404)
})

test('advisories recheck security after cold metadata builds and upstream requests', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  const path = `/api/bundles/${record.id}/advisories`
  let calls = 0
  const original = h.cache.packageVersions.bind(h.cache)
  const cacheMock = t.mock.method(h.cache, 'packageVersions', async rec => {
    const packages = await original(rec)
    await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies: true, security: false })
    return packages
  })
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies: true, security: false })
    return Response.json({ dep: [{ title: 'Must not escape', severity: 'high' }] })
  })
  assert.equal((await h.send(path, 'viewer')).status, 403)
  assert.equal(calls, 0)
  cacheMock.mock.restore()
  await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies: false, security: true })
  const response = await h.send(path, 'viewer')
  assert.equal(response.status, 403)
  assert.deepEqual(response.json(), { error: 'security-access-required' })
  assert.equal(calls, 1)
})

test('advisories use cached inventory, handle upstream failures, and reject unsupported bundles', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  await h.cache.prebuild(record)
  t.mock.method(h.store, 'get', () => { throw new Error('Warm metadata must not reread bundle contents') })
  const fetchMock = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('upstream offline', { status: 503 })))
  const path = `/api/bundles/${record.id}/advisories`
  const response = await h.send(path, 'viewer')
  assert.equal(response.status, 502)
  assert.equal(response.json().error, 'upstream-not-json')
  fetchMock.mock.mockImplementation(() => Promise.reject(new Error('network')))
  assert.equal((await h.send(path, 'viewer')).json().error, 'upstream-unreachable')
  const mapRecord = await h.seed({ kind: 'sourcemap', repoId: 1 })
  assert.equal((await h.send(`/api/bundles/${mapRecord.id}/advisories`, 'viewer')).status, 422)
})


test('package inventories persist separately; concurrent cache upgrades build once', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  await h.cache.prebuild(record)
  const inventory = join(h.cacheDir, record.id, 'v2-package-versions.json')
  assert.deepEqual(JSON.parse(await readFile(inventory, 'utf8')), { all: { dep: ['2.0.0'] }, reasons: {} })
  // A metadata-only cache is upgraded once, even with simultaneous requests.
  await rm(inventory)
  const gate = Promise.withResolvers(), read = h.store.get, started = Promise.withResolvers()
  let builds = 0
  h.store.get = async (...args) => { builds++; started.resolve(); await gate.promise; return read(...args) }
  const queries = Array.from({ length: 8 }, () => h.cache.packageVersions(record))
  await started.promise
  gate.resolve()
  for (const packages of await Promise.all(queries)) assert.deepEqual(packages, { dep: ['2.0.0'] })
  assert.equal(builds, 1)
  // A fresh instance needs neither the full metadata nor original bundle bytes.
  await writeFile(join(h.cacheDir, record.id, 'v2-metadata.json.br'), 'not compressed metadata')
  const restarted = createBundleCache(h.cacheStorage, h.db, { ...h.store, get() { throw new Error('must use inventory') } })
  assert.deepEqual(await restarted.packageVersions(record), { dep: ['2.0.0'] })
})

test('oversized inventories persist a rejection marker and return 413 without contacting npm', async t => {
  const h = await setup(t)
  const large = stasis.replace('2.0.0', '1'.repeat(MAX_PACKAGE_INVENTORY_BYTES))
  const record = await h.seed({ repoId: 1, bytes: brotliCompressSync(Buffer.from(large)) })
  await h.cache.prebuild(record)
  assert.equal(await readFile(join(h.cacheDir, record.id, 'v2-package-versions.json'), 'utf8'), 'null')
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must reject before contacting npm') })
  t.mock.method(h.store, 'get', () => { throw new Error('must not rebuild rejected inventories') })
  const response = await h.send(`/api/bundles/${record.id}/advisories`, 'viewer')
  assert.equal(response.status, 413)
  assert.deepEqual(response.json(), { error: 'payload-too-large' })
  assert.equal((await h.send(`/api/bundles/${record.id}/metadata`, 'viewer')).status, 200, 'other metadata remains usable')
})

for (const reportedSize of [MAX_PACKAGE_INVENTORY_BYTES + 1, null, 1]) {
  test(`inventory reads enforce the byte limit before parsing (reported size: ${reportedSize})`, async () => {
    let reads = 0
    const stream = Readable.from((function* () {
      reads++; yield Buffer.alloc(MAX_PACKAGE_INVENTORY_BYTES, ' ')
      reads++; yield Buffer.from('x')
      reads++; yield Buffer.alloc(MAX_PACKAGE_INVENTORY_BYTES)
    })(), { highWaterMark: 0 })
    const cache = createBundleCache({
      exists: () => Promise.resolve(true),
      open: (_id, name) => {
        assert.equal(name, 'v2-package-versions.json')
        return Promise.resolve({ size: reportedSize, stream })
      },
    }, {}, { get() { throw new Error('must use inventory') } })
    assert.equal(await cache.packageVersions({ id: 'id', kind: 'stasis' }), null)
    assert.equal(stream.destroyed, true)
    assert.ok(reads < 3, 'stop the stream as soon as its bound is exceeded')
    if (reportedSize > MAX_PACKAGE_INVENTORY_BYTES) assert.equal(reads, 0)
  })
}


test('advisory reasons select exact package versions from persisted inventory', async t => {
  const h = await setup(t)
  const bundled = new Bundle({
    modules: new Map([
      ['.', { name: 'app', version: '1', files: { 'app.js': 'app' } }],
      ['node_modules/dep', { name: 'dep', version: '1.0.0', files: { 'index.js': 'one' } }],
      ['node_modules/tool/node_modules/dep', { name: 'dep', version: '2.0.0', files: { 'index.js': 'two' } }],
    ]),
    reason: { metro: ['node_modules/dep/index.js'], run: ['node_modules/tool/node_modules/dep/index.js'], add: ['app.js'] },
  }).serialize()
  const record = await h.seed({ repoId: 1, bytes: brotliCompressSync(Buffer.from(bundled)) })
  await h.cache.prebuild(record)
  // Scope switches must not read full bundle contents or decode full metadata.
  t.mock.method(h.store, 'get', () => { throw new Error('must use bounded inventory') })
  await writeFile(join(h.cacheDir, record.id, 'v2-metadata.json.br'), 'not compressed metadata')
  await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies: false, security: true })
  const calls = []
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    const packages = JSON.parse(Buffer.from(init.body))
    calls.push(packages)
    return Promise.resolve(Response.json({ dep: [{ title: packages.dep.join(', '), severity: 'high' }] }))
  })
  const path = `/api/bundles/${record.id}/advisories?team=${h.team}`
  for (const [reason, versions] of [['', ['1.0.0', '2.0.0']], ['metro', ['1.0.0']], ['run', ['2.0.0']]]) {
    const response = await h.send(`${path}&reason=${reason}`, 'viewer')
    assert.equal(response.status, 200)
    assert.deepEqual(response.json().packages, { dep: versions })
    assert.equal(response.json().advisories.dep[0].title, versions.join(', '))
    assert.deepEqual(calls.at(-1), { dep: versions })
  }
  assert.deepEqual((await h.send(`${path}&reason=add`, 'viewer')).json(), { packages: {}, advisories: {} })
  for (const reason of ['missing', '__proto__', 'constructor']) {
    const response = await h.send(`${path}&reason=${reason}`, 'viewer')
    assert.equal(response.status, 400)
    assert.deepEqual(response.json(), { error: 'unknown-reason' })
  }
  assert.equal(calls.length, 3, 'empty and unknown scopes never contact npm')
  await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies: true, security: false })
  assert.equal((await h.send(`${path}&reason=metro`, 'viewer')).status, 403)
})
