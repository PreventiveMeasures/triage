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
  assert.deepEqual(await readdir(join(h.cacheDir, archive.id)), ['v5-summary.json'], 'backfill does not generate or hash full metadata')
  const teamCatalog = (await h.send('/api/teams', 'viewer')).json()
  const listed = teamCatalog.teams.flatMap(team => team.bundles)
  assert.equal(listed.length, 2)
  for (const bundle of listed) {
    assert.equal(bundle.kind, 'stasis')
    assert.deepEqual(bundle.summary, { files: 3, codeFiles: 2, lines: 2, stasisVersion: 1, versionedPackages: 1 })
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
  await writeFile(join(h.cacheDir, archive.id, 'v6-metadata.json.br'), 'summary must not decode the full metadata')
  assert.deepEqual(await cold.summary(archive), { files: 3, codeFiles: 2, lines: 2, stasisVersion: 1, versionedPackages: 1 })
  await h.db.deleteBundle(archive.id)
  await cold.delete(archive.id)
  await assert.rejects(readdir(join(h.cacheDir, archive.id)), { code: 'ENOENT' })
})

test('catalogs send cached commit details and tags, and read missing details with the viewer access after responding', async t => {
  const h = await setup(t)
  const sha = 'c'.repeat(40)
  const bytes = brotliCompressSync(Buffer.from(new Bundle({ repo: { github: 'org/repo1', commit: sha },
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': source } }]]) }).serialize()))
  const bundle = await h.seed({ repoId: 1, bytes })
  await h.cache.prebuild(bundle)
  await h.db.refreshGithubTags(1, [{ name: 'v1.0.0', sha }, { name: 'v0.9.0', sha: 'd'.repeat(40) }], true, Date.now())
  const requests = []
  t.mock.method(globalThis, 'fetch', url => {
    const { pathname, search } = new URL(url)
    requests.push(pathname + search)
    if (pathname === '/repos/org/repo1') return Promise.resolve(Response.json({ id: 1, full_name: 'org/repo1', private: false, visibility: 'public', default_branch: 'main' }))
    if (pathname === '/repos/org/repo1/commits') {
      return Promise.resolve(Response.json([{ sha, author: { login: 'alice' }, commit: { message: 'Release 1.0.0\n\nPrivate notes\n\nClaude-Session: https://claude.ai/code/session_1',
        author: { name: 'Alice', date: '2026-10-01T10:00:00Z' }, committer: { date: '2026-10-01T12:00:00Z' } } }]))
    }
    return Promise.resolve(Response.json({}, { status: 404 }))
  })
  const listed = async () => (await h.send('/api/teams', 'viewer')).json().teams.flatMap(team => team.bundles).find(entry => entry.id === bundle.id)
  const first = await listed()
  assert.equal(first.summary.commit, sha)
  assert.deepEqual(first.commitInfo, { sha, github: 'org/repo1', tags: ['v1.0.0'], details: null }, 'the first catalog sends cached tags without waiting for GitHub')
  await Promise.all([...h.pending])
  assert.deepEqual(requests, ['/repos/org/repo1', `/repos/org/repo1/commits?sha=${sha}&per_page=1`])
  const details = { subject: 'Release 1.0.0', authorName: 'Alice', authorLogin: 'alice',
    authoredAt: Date.parse('2026-10-01T10:00:00Z'), committedAt: Date.parse('2026-10-01T12:00:00Z') }
  assert.deepEqual((await listed()).commitInfo, { sha, github: 'org/repo1', tags: ['v1.0.0'], details })
  const catalog = JSON.stringify((await h.send('/api/teams', 'viewer')).json())
  assert.ok(!catalog.includes('Private notes') && !catalog.includes('Claude-Session'), 'only the subject is sent')
  assert.equal((await h.db.listGithubCommits([`1:${sha}`]))[0].message, 'Release 1.0.0\n\nPrivate notes\n\nClaude-Session: https://claude.ai/code/session_1',
    'the cache keeps the whole message')
  const managed = (await h.send('/api/admin/bundles')).json().bundles.find(entry => entry.id === bundle.id)
  assert.deepEqual(managed.commitInfo, { sha, github: 'org/repo1', tags: ['v1.0.0'], details })
  await Promise.all([...h.pending])
  assert.equal(requests.length, 2, 'cached commits are never read again, and catalogs never request tags')
  await h.db.setBundleRepo(bundle.id, 2)
  assert.equal((await h.send('/api/admin/bundles')).json().bundles.find(entry => entry.id === bundle.id).commitInfo, null,
    'details and tags belong to the repository a bundle is stored at')
})

test('unavailable bundle summaries do not hide valid catalog entries or fabricate zero counts', async t => {
  const h = await setup(t)
  const broken = await h.seed({ repoId: 1, kind: 'sourcemap', bytes: Buffer.from('not json') })
  const empty = await h.seed({ repoId: 1, kind: 'sourcemap', bytes: Buffer.from('{"version":3,"sources":[],"sourcesContent":[],"mappings":""}') })
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

test('catalog responses recheck membership and repository scope after commit cache reads', async t => {
  const h = await setup(t)
  const sha = 'c'.repeat(40)
  const bytes = brotliCompressSync(Buffer.from(new Bundle({ repo: { github: 'org/repo1', commit: sha },
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': source } }]]) }).serialize()))
  const record = await h.seed({ repoId: 1, bytes })
  await h.cache.prebuild(record)
  await h.db.refreshGithubTags(1, [{ name: 'v1.0.0', sha }], true, Date.now())
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({}, { status: 404 })))
  const tags = h.db.listGithubCommitTags
  let changeAccess = () => h.db.removeTeamMember(h.team, h.users.viewer.userId)
  t.mock.method(h.db, 'listGithubCommitTags', async keys => {
    const value = await tags(keys)
    await changeAccess()
    return value
  })
  assert.deepEqual((await h.send('/api/teams', 'viewer')).json().teams, [])
  changeAccess = () => h.db.setBundleRepo(record.id, 2, '')
  assert.deepEqual((await h.send('/api/admin/bundles', 'manager')).json().bundles, [])
  changeAccess = () => Promise.resolve()
  const moved = (await h.send('/api/admin/bundles')).json().bundles.find(entry => entry.id === record.id)
  assert.equal(moved.repoId, 2)
  assert.equal(moved.commitInfo, null, 'a bundle moved during the read sends nothing for its new repository')
  await Promise.all([...h.pending])
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
  assert.deepEqual(bundles[0].summary, { files: 3, codeFiles: 2, lines: 2, stasisVersion: 1, versionedPackages: 1 })
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

test('new Stasis uploads default to connected header repositories and retain origins in metadata', async t => {
  const h = await setup(t)
  const bundle = Bundle.parse(stasis)
  bundle.repo = { github: 'ORG/Repo1', directory: 'packages/app', commit: 'a'.repeat(40) }
  bundle.package = { npm: { name: '@org/app', version: '1.2.3' } }
  const bytes = brotliCompressSync(Buffer.from(bundle.serialize()))
  const response = await h.send('/api/admin/bundles', 'manager', 'POST', bytes, { 'x-bundle-filename': 'app.stasis.code.br' })
  assert.equal(response.status, 201)
  const { id } = response.json()
  assert.equal(response.json().repoId, 1)
  assert.equal(response.json().repoDirectory, 'packages/app')
  const stored = await h.db.getBundle(id)
  assert.equal(stored.repoId, 1)
  assert.equal(stored.repoDirectory, 'packages/app')
  await Promise.all([...h.pending])
  const catalog = (await h.send('/api/teams', 'viewer')).json()
  assert.equal(catalog.teams.flatMap(team => team.bundles).find(item => item.id === id).summary.commit, bundle.repo.commit)
  const metadata = (await h.send(`/api/bundles/${id}/metadata`, 'viewer')).json()
  assert.deepEqual(metadata.bundle.repo, JSON.parse(JSON.stringify(bundle.repo)))
  assert.deepEqual(metadata.bundle.package, JSON.parse(JSON.stringify(bundle.package)))
  assert.equal(metadata.version, 6)
  assert.deepEqual(parseBundleMetadata(metadata, stored.integrity).bundle.repo, bundle.repo)
  // Location edits and future uploads keep the original row's assignment.
  await h.send('/api/admin/bundles/set-repo', 'admin', 'POST', JSON.stringify({ bundleId: id, repoId: 2, directory: 'moved' }))
  const duplicate = await h.send('/api/admin/bundles', 'admin', 'POST', bytes, { 'x-bundle-filename': 'again.stasis.code.br' })
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.json().repoId, 2)
  assert.equal(duplicate.json().repoDirectory, 'moved')
})

test('bundle upload origin defaults allow unmatched repos and honor explicit locations', async t => {
  const h = await setup(t)
  const upload = (repo, headers = {}) => {
    const bundle = Bundle.parse(stasis)
    bundle.repo = repo
    return h.send('/api/admin/bundles', 'admin', 'POST', brotliCompressSync(Buffer.from(bundle.serialize())),
      { 'x-bundle-filename': 'app.stasis.code.br', ...headers })
  }
  const unmatched = await upload({ github: 'other/repo', directory: 'app' })
  assert.equal(unmatched.status, 201)
  assert.equal(unmatched.json().repoId, null)
  assert.equal(unmatched.json().repoDirectory, '')
  const explicit = await upload({ github: 'org/repo1', directory: 'embedded' }, { 'x-repo-id': '2', 'x-repo-directory': 'chosen' })
  assert.equal(explicit.status, 201)
  assert.equal(explicit.json().repoId, 2)
  assert.equal(explicit.json().repoDirectory, 'chosen')
  const directory = await upload({ github: 'org/repo1', directory: 'original' }, { 'x-repo-directory': 'override' })
  assert.equal(directory.status, 201)
  assert.equal(directory.json().repoId, 1)
  assert.equal(directory.json().repoDirectory, 'override')
  const root = await upload({ github: 'org/repo1', directory: '' })
  assert.equal(root.status, 201)
  assert.equal(root.json().repoId, 1)
  assert.equal(root.json().repoDirectory, '')
  const absent = await upload(undefined)
  assert.equal(absent.status, 201)
  assert.equal(absent.json().repoId, null)
})

test('browser-renamed Stasis uploads still infer their repository and directory', async t => {
  const h = await setup(t)
  const bundle = Bundle.parse(stasis)
  bundle.repo = { github: 'org/repo1', directory: 'packages/app' }
  const bytes = brotliCompressSync(Buffer.from(bundle.serialize()))
  const response = await h.send('/api/admin/bundles', 'manager', 'POST', bytes,
    { 'x-bundle-filename': encodeURIComponent('app.stasis.code (1).br') })
  assert.equal(response.status, 201)
  const stored = await h.db.getBundle(response.json().id)
  assert.equal(stored.filename, 'app.stasis.code (1).br')
  assert.equal(stored.kind, 'stasis')
  assert.equal(stored.repoId, 1)
  assert.equal(stored.repoDirectory, 'packages/app')
})

test('automatic bundle locations use allowed stamps and leave inaccessible stamps unattached', async t => {
  const h = await setup(t)
  await h.db.removeTeamRepo(h.team, 1, null)
  await h.db.setTeamRepo(h.team, 1, 'allowed')
  const upload = (directory, who = 'manager') => {
    // Uploads need only the header; background metadata parsing may fail.
    const text = `{"version":1,"config":{"scope":"full"},"repo":{"github":"org/repo1","directory":${JSON.stringify(directory)}},"sources":invalid}`
    return h.send('/api/admin/bundles', who, 'POST', brotliCompressSync(Buffer.from(text)), { 'x-bundle-filename': 'app.stasis.code.br' })
  }
  assert.equal((await upload('allowed/sub')).status, 201)
  const unassigned = await upload('forbidden')
  assert.equal(unassigned.status, 201)
  assert.equal(unassigned.json().repoId, null)
  assert.equal(unassigned.json().repoDirectory, '')
  assert.equal((await upload('allowed/sub', 'owner')).status, 409, 'deduped rows retain their access checks')
  assert.equal((await upload('allowed/other', 'owner')).status, 201)
  assert.equal((await upload('../allowed', 'admin')).status, 400)
  assert.equal((await upload('allowed\\sub', 'admin')).status, 400)
})

test('scoped managers can import an unattached stamped bundle and assign an authorized location afterward', async t => {
  const h = await setup(t)
  await h.db.removeTeamRepo(h.team, 1, null)
  await h.db.setTeamRepo(h.team, 1, 'allowed')
  const bundle = Bundle.parse(stasis)
  bundle.repo = { github: 'org/repo1', directory: 'outside' }
  const bytes = brotliCompressSync(Buffer.from(bundle.serialize()))
  const headers = { 'x-bundle-filename': 'app.stasis.code.br' }
  const upload = extra => h.send('/api/admin/bundles', 'manager', 'POST', bytes, { ...headers, ...extra })
  // Explicit destinations still require authorization, even with an inferred repo.
  assert.equal((await upload({ 'x-repo-directory': 'outside' })).status, 403)
  assert.equal((await upload({ 'x-repo-id': '1', 'x-repo-directory': 'outside' })).status, 403)
  const response = await upload()
  assert.equal(response.status, 201)
  const { id, repoId, repoDirectory } = response.json()
  assert.equal(repoId, null)
  assert.equal(repoDirectory, '')
  const row = (await h.send('/api/admin/bundles', 'manager')).json().bundles.find(item => item.id === id)
  assert.equal(row.canChangeRepo, true)
  const metadata = await h.send(`/api/bundles/${id}/metadata`, 'manager')
  assert.equal(metadata.status, 200)
  assert.deepEqual(metadata.json().bundle.repo, { ...bundle.repo })
  for (const who of ['viewer', 'owner']) assert.equal((await h.send(`/api/bundles/${id}/metadata`, who)).status, 404)
  const duplicate = await upload()
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.json().repoId, null)
  const assign = directory => h.send('/api/admin/bundles/set-repo', 'manager', 'POST', JSON.stringify({ bundleId: id, repoId: 1, directory }))
  assert.equal((await assign('outside')).status, 403)
  assert.equal((await assign('allowed/sub')).status, 200)
  const stored = await h.db.getBundle(id)
  assert.equal(stored.repoId, 1)
  assert.equal(stored.repoDirectory, 'allowed/sub')
  const reassigned = await upload()
  assert.equal(reassigned.status, 200)
  assert.equal(reassigned.json().repoDirectory, 'allowed/sub')
  const visible = await h.send(`/api/bundles/${id}/metadata`, 'viewer')
  assert.equal(visible.status, 200)
  assert.deepEqual(visible.json().bundle.repo, { ...bundle.repo }, 'assignment does not change the self-reported origin')
})

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
  assert.deepEqual(await readdir(join(h.cacheDir, record.id)), ['v5-summary.json', 'v6-advisory-inventory.json', 'v6-metadata.json.br'])
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
  assert.deepEqual(await readdir(join(h.cacheDir, id)), ['v5-summary.json', 'v6-advisory-inventory.json', 'v6-metadata.json.br'])
  assert.equal((await h.send('/api/admin/bundles', 'manager', 'POST', bytes, headers)).status, 409)
  assert.equal((await h.send('/api/admin/bundles', 'owner', 'POST', bytes, headers)).status, 200)
  assert.equal((await h.send(`/api/admin/bundles/${id}`, 'owner', 'DELETE')).status, 200)
  await assert.rejects(readdir(join(h.cacheDir, id)), { code: 'ENOENT' })
  assert.equal((await h.send(`/api/bundles/${id}/metadata`, 'owner')).status, 404)
})

test('sourcemap metadata carries the edges the server reads with the parser', async t => {
  const h = await setup(t)
  const bytes = Buffer.from(JSON.stringify({ version: 3, sources: ['src/main.ts', 'src/dep.ts'], names: [], mappings: '',
    sourcesContent: ["import { dep } from './dep'\nimport 'left-out'\nexport default dep\n", 'export const dep: number = 1\n'] }))
  const record = await h.seed({ kind: 'sourcemap', repoId: 1, bytes })
  const metadata = await h.send(`/api/bundles/${record.id}/metadata`, 'viewer')
  assert.equal(metadata.status, 200)
  assert.deepEqual(parseBundleMetadata(metadata.json(), record.integrity).edges, [['src/main.ts', 'src/dep.ts', './dep']])
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
  assert.deepEqual(await readdir(join(h.cacheDir, id)), ['v5-summary.json', 'v6-metadata.json.br'])
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

const npmAdvisory = title => ({ id: 1, title, severity: 'high', url: 'https://github.com/advisories/GHSA-2345-6789-cfgh', vulnerable_versions: '*' })

// The upstream HTTP call is the only mock: routing, sessions, permissions,
// package extraction and cached bundle metadata use the real implementations.
test('bundle advisories require security, independently of dependency findings', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  const path = `/api/bundles/${record.id}/advisories`
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    calls.push({ url, init })
    return Promise.resolve(Response.json({ dep: [npmAdvisory('Published vulnerability')] }))
  })
  assert.equal((await h.send(path, 'anonymous')).status, 401)
  assert.equal((await h.send(path, 'none')).status, 403)
  assert.equal((await h.send(path, 'viewer', 'POST')).status, 405)
  for (const dependencies of [false, true]) {
    await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies, security: false })
    assert.deepEqual((await h.send('/api/teams', 'viewer')).json().teams[0].permissions, { dependencies, security: false })
    assert.equal((await h.send(path, 'viewer')).status, 403)
    assert.equal(calls.length, 0)
  }
  for (const dependencies of [false, true]) {
    await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies, security: true })
    assert.deepEqual((await h.send('/api/teams', 'viewer')).json().teams[0].permissions, { dependencies, security: true })
    const response = await h.send(`${path}?team=${h.team}`, 'viewer')
    assert.equal(response.status, 200)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.deepEqual(response.json().packages, [{ ecosystem: 'npm', name: 'dep', versions: ['2.0.0'] }])
    assert.equal(response.json().advisories[0].title, 'Published vulnerability')
    assert.deepEqual(response.json().advisories[0].versions, ['2.0.0'])
    assert.equal(calls.at(-1).url, 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk')
    assert.deepEqual(JSON.parse(Buffer.from(calls.at(-1).init.body)), { dep: ['2.0.0'] })
    assert.equal(new Headers(calls.at(-1).init.headers).get('content-type'), 'application/json')
    assert.equal(new Headers(calls.at(-1).init.headers).get('authorization'), null)
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
  const original = h.cache.advisoryInventory.bind(h.cache)
  const cacheMock = t.mock.method(h.cache, 'advisoryInventory', async rec => {
    const packages = await original(rec)
    await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies: true, security: false })
    return packages
  })
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies: true, security: false })
    return Response.json({ dep: [npmAdvisory('Must not escape')] })
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
  assert.equal(response.json().error, 'upstream-unavailable')
  fetchMock.mock.mockImplementation(() => Promise.reject(new Error('network')))
  assert.equal((await h.send(path, 'viewer')).json().error, 'upstream-unavailable')
  const mapRecord = await h.seed({ kind: 'sourcemap', repoId: 1 })
  assert.equal((await h.send(`/api/bundles/${mapRecord.id}/advisories`, 'viewer')).status, 422)
})


test('package inventories persist separately; concurrent cache upgrades build once', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  await h.cache.prebuild(record)
  const inventory = join(h.cacheDir, record.id, 'v6-advisory-inventory.json')
  assert.deepEqual(JSON.parse(await readFile(inventory, 'utf8')), { all: { packages: [{ ecosystem: 'npm', name: 'dep', versions: ['2.0.0'] }], skipped: [] }, reasons: {} })
  // Both older npm-only and unfiltered inventories must rebuild, once even with simultaneous requests.
  await rm(inventory)
  await writeFile(join(h.cacheDir, record.id, 'v3-advisory-packages.json'), JSON.stringify({ all: [{ ecosystem: 'npm', name: 'wrong', versions: ['1.0.0'] }], reasons: {} }))
  await writeFile(join(h.cacheDir, record.id, 'v2-package-versions.json'), JSON.stringify({ all: { wrong: ['1.0.0'] }, reasons: {} }))
  const gate = Promise.withResolvers(), read = h.store.get, started = Promise.withResolvers()
  let builds = 0
  h.store.get = async (...args) => { builds++; started.resolve(); await gate.promise; return read(...args) }
  const queries = Array.from({ length: 8 }, () => h.cache.advisoryInventory(record))
  await started.promise
  gate.resolve()
  for (const packages of await Promise.all(queries)) assert.deepEqual(packages, { packages: [{ ecosystem: 'npm', name: 'dep', versions: ['2.0.0'] }], skipped: [] })
  assert.equal(builds, 1)
  // A fresh instance needs neither the full metadata nor original bundle bytes.
  await writeFile(join(h.cacheDir, record.id, 'v6-metadata.json.br'), 'not compressed metadata')
  const restarted = createBundleCache(h.cacheStorage, h.db, { ...h.store, get() { throw new Error('must use inventory') } })
  assert.deepEqual(await restarted.advisoryInventory(record), { packages: [{ ecosystem: 'npm', name: 'dep', versions: ['2.0.0'] }], skipped: [] })
})

test('oversized inventories persist a rejection marker and return 413 without contacting npm', async t => {
  const h = await setup(t)
  const large = stasis.replace('2.0.0', '1'.repeat(MAX_PACKAGE_INVENTORY_BYTES))
  const record = await h.seed({ repoId: 1, bytes: brotliCompressSync(Buffer.from(large)) })
  await h.cache.prebuild(record)
  assert.equal(await readFile(join(h.cacheDir, record.id, 'v6-advisory-inventory.json'), 'utf8'), 'null')
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
        assert.equal(name, 'v6-advisory-inventory.json')
        return Promise.resolve({ size: reportedSize, stream })
      },
    }, {}, { get() { throw new Error('must use inventory') } })
    assert.equal(await cache.advisoryInventory({ id: 'id', kind: 'stasis' }), null)
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
  await writeFile(join(h.cacheDir, record.id, 'v6-metadata.json.br'), 'not compressed metadata')
  await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies: false, security: true })
  const calls = []
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    const packages = JSON.parse(Buffer.from(init.body))
    calls.push(packages)
    return Promise.resolve(Response.json({ dep: [npmAdvisory(packages.dep.join(', '))] }))
  })
  const path = `/api/bundles/${record.id}/advisories?team=${h.team}`
  for (const [reason, versions] of [['', ['1.0.0', '2.0.0']], ['metro', ['1.0.0']], ['run', ['2.0.0']]]) {
    const response = await h.send(`${path}&reason=${reason}`, 'viewer')
    assert.equal(response.status, 200)
    assert.deepEqual(response.json().packages, [{ ecosystem: 'npm', name: 'dep', versions }])
    assert.equal(response.json().advisories[0].title, versions.join(', '))
    assert.deepEqual(calls.at(-1), { dep: versions })
  }
  assert.deepEqual((await h.send(`${path}&reason=add`, 'viewer')).json(), { packages: [], skipped: [], advisories: [] })
  for (const reason of ['missing', '__proto__', 'constructor']) {
    const response = await h.send(`${path}&reason=${reason}`, 'viewer')
    assert.equal(response.status, 400)
    assert.deepEqual(response.json(), { error: 'unknown-reason' })
  }
  assert.equal(calls.length, 3, 'empty and unknown scopes never contact npm')
  await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies: true, security: false })
  assert.equal((await h.send(`${path}&reason=metro`, 'viewer')).status, 403)
})

test('managed non-npm advisories use persisted ecosystem inventory and respect reason scopes', async t => {
  const h = await setup(t)
  const bundle = new Bundle({ modules: new Map([
    ['.', { name: 'app', version: '1', files: { 'main.rs': 'private source' } }],
    ['vendor/log', { ecosystem: 'cargo', name: 'log', version: '0.4.22', files: { 'src/lib.rs': 'crate source' } }],
    ['node_modules/log', { name: 'log', version: '1.0.0', files: { 'index.js': 'npm source' } }],
  ]), reason: { cargo: ['vendor/log/src/lib.rs'], own: ['main.rs'] } }).serialize()
  const record = await h.seed({ repoId: 1, bytes: brotliCompressSync(Buffer.from(bundle)) })
  await h.cache.prebuild(record)
  t.mock.method(h.store, 'get', () => { throw new Error('must use persisted inventory') })
  await writeFile(join(h.cacheDir, record.id, 'v6-metadata.json.br'), 'not compressed metadata')
  const queries = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url, 'https://api.osv.dev/v1/querybatch')
    queries.push(JSON.parse(options.body).queries)
    return Promise.resolve(Response.json({ results: [{}] }))
  })
  const path = `/api/bundles/${record.id}/advisories?reason=`
  const response = await h.send(path + 'cargo', 'viewer')
  assert.equal(response.status, 200)
  assert.deepEqual(response.json(), { packages: [{ ecosystem: 'cargo', name: 'log', versions: ['0.4.22'] }], skipped: [], advisories: [] })
  assert.deepEqual(queries, [[{ package: { name: 'log', ecosystem: 'crates.io' }, version: '0.4.22' }]])
  assert.deepEqual((await h.send(path + 'own', 'viewer')).json(), { packages: [], skipped: [], advisories: [] })
  assert.equal(queries.length, 1, 'first-party scope does not contact upstream')
})

test('persisted inventories exclude stubs per reason and retain scoped skipped dependencies', async t => {
  const h = await setup(t)
  const bundled = new Bundle({ modules: new Map([
    ['.', { name: 'app', version: '1', files: { 'app.js': 'app' } }],
    ['node_modules/ws', { name: 'ws', version: '8.21.1', files: { 'package.json': '{}', 'browser.js': 'stub', 'lib/websocket.js': 'code' } }],
    ['vendor/vendor/pkg', { ecosystem: 'composer', name: 'vendor/pkg', version: 'dev-main', files: { 'src/file.php': 'private source' } }],
    ['lib/dep', { ecosystem: 'github', name: 'org/dep', version: '.', files: { 'src/File.sol': 'code' } }],
  ]), reason: {
    browser: ['node_modules/ws/package.json', 'node_modules/ws/browser.js'],
    run: ['node_modules/ws/lib/websocket.js'], dev: ['vendor/vendor/pkg/src/file.php'], git: ['lib/dep/src/File.sol'],
  } }).serialize()
  const record = await h.seed({ repoId: 1, bytes: brotliCompressSync(Buffer.from(bundled)) })
  await h.cache.prebuild(record)
  t.mock.method(h.store, 'get', () => { throw new Error('must use persisted inventory') })
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push({ url, body: options.body })
    if (url.includes('registry.npmjs.org')) return Promise.resolve(Response.json({}))
    assert.match(url, /\/repos\/org\/dep\/security-advisories/u)
    return Promise.resolve(Response.json([]))
  })
  const path = `/api/bundles/${record.id}/advisories`
  const all = await h.send(path, 'viewer')
  assert.equal(all.status, 200, 'Composer dev and branch dot do not fail the audit')
  assert.deepEqual(all.json().packages, [
    { ecosystem: 'github', name: 'org/dep', versions: ['0.0.0'] }, { ecosystem: 'npm', name: 'ws', versions: ['8.21.1'] },
  ])
  const { skipped } = all.json()
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].version, 'dev-main')
  assert.match(skipped[0].because, /Composer dev versions/u)
  assert.equal(calls.length, 2)
  assert.deepEqual((await h.send(`${path}?reason=browser`, 'viewer')).json(), { packages: [], skipped: [], advisories: [] })
  assert.deepEqual((await h.send(`${path}?reason=dev`, 'viewer')).json(), { packages: [], skipped, advisories: [] })
  assert.equal(calls.length, 2, 'stub-only and skipped-only scopes never reach upstream')
  assert.deepEqual((await h.send(`${path}?reason=run`, 'viewer')).json(), {
    packages: [{ ecosystem: 'npm', name: 'ws', versions: ['8.21.1'] }], skipped: [], advisories: [],
  })
  assert.ok(calls.every(call => !call.body?.includes('vendor/pkg') && !call.body?.includes('private source')))
  await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies: false, security: false })
  assert.deepEqual((await h.send(`${path}?reason=dev`, 'viewer')).json(), { error: 'security-access-required' })
})

test('cached bundle repositories bypass npm metadata discovery after upgrading old inventories', async t => {
  const h = await setup(t)
  const bundle = Bundle.parse(stasis)
  bundle.repo = { github: 'org/repo1', directory: '' }
  bundle.modules.get('node_modules/dep').repo = { github: 'org/dep', directory: 'packages/dep' }
  bundle.reason = { run: ['node_modules/dep/index.js'] }
  const record = await h.seed({ repoId: 1, bytes: brotliCompressSync(Buffer.from(bundle.serialize())) })
  await h.cacheStorage.put(record.id, 'v3-metadata.json.br', Buffer.from('old metadata'))
  await h.cacheStorage.put(record.id, 'v4-advisory-inventory.json', Buffer.from(JSON.stringify({
    all: { packages: [{ ecosystem: 'npm', name: 'dep', versions: ['2.0.0'] }], skipped: [] }, reasons: {},
  })))
  const reads = t.mock.method(h.store, 'get')
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    calls.push(url)
    if (url === 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk') {
      assert.deepEqual(JSON.parse(init.body), { dep: ['2.0.0'] })
      return Promise.resolve(Response.json({}))
    }
    assert.equal(new URL(url).origin, 'https://api.github.com')
    assert.equal(new URL(url).pathname, '/repos/org/dep/security-advisories')
    return Promise.resolve(Response.json([{ ghsa_id: 'GHSA-2345-6789-cfgh', state: 'published', summary: 'Maintainer vulnerability',
      vulnerabilities: [{ package: { ecosystem: 'npm', name: 'dep' }, vulnerable_version_range: '<3.0.0' }] }]))
  })
  for (const reason of ['', '&reason=run']) {
    const response = await h.send(`/api/bundles/${record.id}/advisories?repoAdvisories=true${reason}`, 'viewer')
    assert.equal(response.status, 200)
    assert.deepEqual(response.json().packages, [{ ecosystem: 'npm', name: 'dep', versions: ['2.0.0'], github: 'org/dep' }])
    assert.equal(response.json().advisories[0].title, 'Maintainer vulnerability')
  }
  assert.equal(calls.length, 3, 'only the advisory bulk API and known GitHub repo are queried, the repo once')
  assert.equal(reads.mock.callCount(), 1, 'the upgraded inventory is reused for the scoped request')
  const metadata = (await h.send(`/api/bundles/${record.id}/metadata`, 'viewer')).json()
  const cached = parseBundleMetadata(metadata, record.integrity)
  assert.equal(cached.bundle.repo.directory, '')
  assert.equal(cached.bundle.modules.get('node_modules/dep').repo.github, 'org/dep')
  assert.equal(reads.mock.callCount(), 1)
})

test('managed repository rechecks enrich advisories and recheck security before returning', async t => {
  const h = await setup(t), record = await h.seed({ repoId: 1 })
  await h.db.setUserTokens(h.users.viewer.userId, { accessToken: 'viewer-token', refreshToken: null, expiresAt: null })
  await h.db.setUserTokens(h.users.owner.userId, { accessToken: 'owner-token', refreshToken: null, expiresAt: null })
  const path = `/api/bundles/${record.id}/advisories`
  const calls = []
  let revoke = false
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(url)
    assert.equal(new Headers(init.headers).get('authorization'), new URL(url).hostname === 'api.github.com' ? 'Bearer viewer-token' : null)
    if (url.endsWith('/advisories/bulk')) return Response.json({})
    // Revoke mid-audit: the repository's listing is answered from the cache.
    if (revoke) await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies: false, security: false })
    if (url.endsWith('/dep/2.0.0')) return Response.json({ name: 'dep', version: '2.0.0', repository: 'https://github.com/org/dep' })
    assert.match(url, /\/repos\/org\/dep\/security-advisories/u)
    return Response.json([{ ghsa_id: 'GHSA-2345-6789-cfgh', state: 'published', summary: 'Maintainer vulnerability', description: '# Impact\n\nFull advisory text.',
      vulnerabilities: [{ package: { ecosystem: 'npm', name: 'dep' }, vulnerable_version_range: '<3.0.0' }] }])
  })
  assert.deepEqual((await h.send(path, 'viewer')).json().advisories, [])
  assert.equal(calls.length, 1)
  const recheck = `${path}?repoAdvisories=true&details=true`
  const result = await h.send(recheck, 'viewer')
  assert.equal(result.status, 200)
  assert.equal(result.json().advisories[0].title, 'Maintainer vulnerability')
  assert.equal(result.json().advisories[0].source, 'repository')
  assert.equal(result.json().advisories[0].details, '# Impact\n\nFull advisory text.')
  assert.equal(calls.length, 4)
  revoke = true
  const denied = await h.send(recheck, 'viewer')
  assert.equal(denied.status, 403)
  assert.deepEqual(denied.json(), { error: 'security-access-required' })
  assert.equal(calls.length, 6, 'the cached listing is withheld without asking GitHub again')
})

for (const mode of ['refresh', 'expired', 'revoked', 'rejected']) {
  test(`GitHub dependency audits use the viewer credential lifecycle (${mode})`, async t => {
    const h = await setup(t)
    const bundle = new Bundle({ modules: new Map([
      ['lib/dep', { ecosystem: 'github', name: 'org/dep', version: '1.0.0', files: { 'code.sol': 'source' } }],
    ]) }).serialize()
    const record = await h.seed({ repoId: 1, bytes: brotliCompressSync(Buffer.from(bundle)) })
    await h.db.setUserTokens(h.users.viewer.userId, mode === 'rejected'
      ? { accessToken: 'rejected-token', refreshToken: null, expiresAt: null }
      : { accessToken: 'expired-token', refreshToken: mode === 'expired' ? null : 'refresh-token', expiresAt: 1 })
    const calls = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push(url)
      if (url === 'https://github.com/login/oauth/access_token') {
        assert.equal(JSON.parse(init.body).refresh_token, 'refresh-token')
        assert.ok(init.signal instanceof AbortSignal, 'refresh is bounded by the audit deadline')
        if (mode === 'revoked') await h.db.setTeamMember(h.team, h.users.viewer.userId, { dependencies: false, security: false })
        return Response.json({ access_token: 'refreshed-token', expires_in: 3600 })
      }
      assert.match(url, /^https:\/\/api\.github\.com\/repos\/org\/dep\/security-advisories/u)
      const authorization = new Headers(init.headers).get('authorization')
      if (mode === 'rejected' && authorization === 'Bearer rejected-token') return Response.json({ message: 'Bad credentials' }, { status: 401 })
      assert.equal(authorization, mode === 'expired' || mode === 'rejected' ? null : 'Bearer refreshed-token')
      return Response.json([])
    })
    const response = await h.send(`/api/bundles/${record.id}/advisories`, 'viewer')
    assert.equal(response.status, mode === 'revoked' ? 403 : 200)
    assert.equal(calls.length, mode === 'refresh' || mode === 'rejected' ? 2 : 1)
    if (mode === 'revoked') assert.deepEqual(response.json(), { error: 'security-access-required' })
    else assert.deepEqual(response.json().advisories, [])
    if (mode === 'refresh') assert.equal((await h.db.getUserTokens(h.users.viewer.userId)).accessToken, 'refreshed-token')
  })
}

test('bundle visibility controls downloads, cached sources, advisories and catalogs independently of reports', async t => {
  const h = await setup(t)
  const bundle = await h.seed({ repoId: 1 })
  const reportId = randomUUID()
  await h.db.insertReport({ id: reportId, filename: 'linked.json', contentType: 'application/json', byteSize: 2, sha256: 'report-hash',
    uploadedBy: h.users.admin.userId, repoId: 1, bundleId: bundle.id, visible: true }, Date.now())
  const toggle = (visible, who = 'manager', headers = {}) => h.send('/api/admin/bundles/set-visible', who, 'POST', JSON.stringify({ bundleId: bundle.id, visible }), headers)
  assert.equal((await toggle(false, 'viewer')).status, 403)
  assert.equal((await toggle(false, 'manager', { 'x-csrf-token': 'invalid' })).status, 403)
  assert.equal((await toggle('false')).status, 400)
  assert.equal((await toggle(false)).status, 200)
  assert.equal((await h.db.getBundle(bundle.id)).visible, false)
  assert.equal((await h.db.getReport(reportId)).visible, true, 'hiding a bundle preserves linked report visibility')
  for (const suffix of ['download', 'metadata', 'contents', 'advisories']) {
    assert.equal((await h.send(`/api/bundles/${bundle.id}/${suffix}`, 'viewer')).status, 404, suffix)
  }
  assert.equal((await h.send(`/api/admin/bundles/${bundle.id}`, 'viewer')).status, 404)
  for (const who of ['admin', 'manager', 'owner']) {
    assert.equal((await h.send(`/api/bundles/${bundle.id}/metadata`, who)).status, 200, who)
    const inventory = (await h.send('/api/admin/bundles', who)).json().bundles
    assert.equal(inventory.find(b => b.id === bundle.id).visible, false, who)
  }
  assert.deepEqual((await h.send('/api/teams', 'viewer')).json().teams[0].bundles, [])
  assert.equal((await h.send('/api/teams', 'manager')).json().teams[0].bundles[0].visible, false)
  const history = await h.db.listActivity({ page: 1, limit: 100, kind: 'visibility', query: '', contexts: null })
  assert.equal(history.history[0].report, bundle.filename)
  assert.equal(history.history[0].action, 'hid a bundle')
  assert.equal((await toggle(true)).status, 200)
  assert.equal((await h.send(`/api/bundles/${bundle.id}/download`, 'viewer')).status, 200)
  assert.equal((await h.send('/api/teams', 'viewer')).json().teams[0].bundles[0].visible, true)

  const open = h.cache.open.bind(h.cache)
  t.mock.method(h.cache, 'open', async (...args) => {
    const cached = await open(...args)
    await h.db.setBundleVisible(bundle.id, false)
    return cached
  })
  assert.equal((await h.send(`/api/bundles/${bundle.id}/metadata`, 'viewer')).status, 404, 'a slow cache read rechecks visibility before sending bytes')
})
