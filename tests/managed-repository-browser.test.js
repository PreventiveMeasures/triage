import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { createRepositoryBrowser, scopedDirectory } from '../server-managed/repository-browser.ts'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const commit = 'a'.repeat(40)
const anonymous = { githubUserId: 1, token: null }
const appConfig = { ...config, githubAppId: '1', githubAppPrivateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) }
const privateRepo = { ...repo, private: true, installationId: 7 }
const publicMetadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }

test('repository reader pins branches/tags to commits and only returns directory metadata', async () => {
  const calls = []
  const reader = await createRepositoryBrowser(config, anonymous, async (url, options) => {
    await Promise.resolve()
    calls.push(url)
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    if (url === 'https://api.github.com/repos/org/repo') return Response.json(publicMetadata)
    if (url.includes('/commits/')) return Response.json({ sha: commit })
    if (url.includes('/branches?')) return Response.json([{ name: 'main' }, { name: 'feature/a' }])
    if (url.includes('/tags?')) return Response.json([{ name: 'v1' }])
    return Response.json([
      { name: 'a.ts', path: 'src/a.ts', type: 'file', content: 'never return source' },
      { name: 'external', path: 'src/external', type: 'file', submodule_git_url: 'https://example.com' },
      { name: 'leak', path: 'private/leak', type: 'file' },
    ])
  }).reader(repo)
  assert.deepEqual(await reader.refs(), { defaultBranch: 'main', branches: ['main', 'feature/a'], tags: ['v1'] })
  assert.equal(await reader.commit('heads/feature/a'), commit)
  assert.equal(await reader.commit('tags/v1'), commit)
  const count = calls.length
  assert.equal(await reader.commit(commit), commit)
  assert.equal(calls.length, count, 'navigation reuses the pinned SHA')
  assert.deepEqual(await reader.directory('src', commit), { entries: [
    { name: 'a.ts', path: 'src/a.ts', type: 'file' }, { name: 'external', path: 'src/external', type: 'submodule' },
  ], limited: false })
  assert.ok(calls.some(url => url.endsWith('/commits/heads%2Ffeature%2Fa')))
  assert.ok(calls.at(-1).endsWith(`/contents/src?ref=${commit}`))
  await assert.rejects(createRepositoryBrowser(config, anonymous, () => Promise.resolve(Response.json({ ...publicMetadata, private: true, visibility: 'private' }))).reader(privateRepo), /no-repository/u)
})

test('directory grants expose ancestors but no sibling names or prefix collisions', () => {
  assert.deepEqual(scopedDirectory('', ['packages/app', 'packages/api']), [{ name: 'packages', path: 'packages', type: 'dir' }])
  assert.deepEqual(scopedDirectory('packages', ['packages/app']), [{ name: 'app', path: 'packages/app', type: 'dir' }])
  assert.equal(scopedDirectory('packages/app/src', ['packages/app']), null)
  assert.equal(scopedDirectory('', [null]), null)
  assert.deepEqual(scopedDirectory('packages/application', ['packages/app']), [])
})

test('renamed default branches come from live metadata even outside the first page of suggestions', async t => {
  const { request } = await fixture(t, { selectedRepo: { ...repo, defaultBranch: 'old-default' } })
  const commits = []
  let defaultBranch = 'release/current'
  t.mock.method(globalThis, 'fetch', url => {
    const path = new URL(url).pathname
    if (path === '/repos/org/repo') return Promise.resolve(Response.json({ ...publicMetadata, default_branch: defaultBranch }))
    if (path === '/repos/org/repo/branches') return Promise.resolve(Response.json(Array.from({ length: 100 }, (_, i) => ({ name: `feature-${i}` }))))
    if (path === '/repos/org/repo/tags') return Promise.resolve(Response.json([]))
    if (path.startsWith('/repos/org/repo/commits/')) {
      commits.push(decodeURIComponent(path.slice('/repos/org/repo/commits/'.length)))
      return Promise.resolve(Response.json({ sha: commit }))
    }
    assert.equal(path, '/repos/org/repo/contents/src/allowed')
    return Promise.resolve(Response.json([{ name: 'entry.ts', path: 'src/allowed/entry.ts', type: 'file' }]))
  })
  const refs = await request({ repoId: '1' }, { route: 'refs' })
  assert.equal(refs.status, 200)
  assert.equal(refs.body.defaultBranch, 'release/current')
  assert.equal(refs.body.branches.length, 100)
  assert.ok(!refs.body.branches.includes(refs.body.defaultBranch))
  assert.equal((await request({ repoId: '1', ref: `heads/${refs.body.defaultBranch}`, path: 'src/allowed' })).status, 200)
  assert.equal((await request({ repoId: '1', path: 'src/allowed' })).status, 200)
  assert.deepEqual(commits, ['heads/release/current', 'heads/release/current'])

  defaultBranch = undefined
  assert.equal((await request({ repoId: '1' }, { route: 'refs' })).body.defaultBranch, '')
  assert.equal((await request({ repoId: '1', path: 'src/allowed' })).status, 200)
  assert.equal(commits.at(-1), 'HEAD', 'missing live metadata never falls back to a stale stored branch')
})

async function fixture(t, { role = 'manage', selectedRepo = repo, member = true, tokens = null, fixtureConfig = config } = {}) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(fixtureConfig, db, { githubUserId: 1, login: 'manager', name: null, avatarUrl: null }, Date.now())
  const { userId } = session
  await db.setUserRole(userId, role)
  await db.selectRepo(selectedRepo, Date.now())
  if (tokens) await db.setUserTokens(userId, tokens)
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 1, 'src/allowed')
  if (member) await db.setTeamMember('team', userId, { dependencies: true, security: true })
  const handler = createManagedRequestHandler({ config: fixtureConfig, db, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {} })
  const responses = []
  const request = async (query, { method = 'GET', signedIn = true, route = 'contents' } = {}) => {
    const res = { status: 0, body: '', headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body; responses.push(body) } }
    await handler({ method, url: `/api/admin/repositories/${route}?${new URLSearchParams(query)}`, headers: { cookie: signedIn ? session.setCookie.split(';')[0] : undefined } }, res)
    return { status: res.status, body: JSON.parse(res.body), headers: res.headers }
  }
  return { db, userId, request, responses }
}

for (const first of ['refs', 'contents']) {
  test(`refs withDefault reads cached default contents concurrently and waits for ${first === 'refs' ? 'contents' : 'refs'}`, async t => {
    const { db, request, responses } = await fixture(t, { role: 'admin' })
    await db.cacheRepoDefaultBranch((await db.listSelectedRepos())[0], 'main')
    let finishContents, finishRefs
    t.mock.method(globalThis, 'fetch', url => {
      const { pathname, searchParams } = new URL(url)
      if (pathname === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
      if (pathname.endsWith('/branches')) return new Promise(resolve => { finishRefs = () => resolve(Response.json([{ name: 'main' }])) })
      if (pathname.endsWith('/tags')) return Promise.resolve(Response.json([{ name: 'v1' }]))
      if (pathname.endsWith('/commits/heads%2Fmain')) return Promise.resolve(Response.json({ sha: commit }))
      assert.equal(pathname, '/repos/org/repo/contents/')
      assert.equal(searchParams.get('ref'), commit)
      return new Promise(resolve => { finishContents = () => resolve(Response.json([{ name: 'entry.ts', path: 'entry.ts', type: 'file' }])) })
    })
    const pending = request({ repoId: '1', withDefault: 'true' }, { route: 'refs' })
    await setImmediate()
    assert.equal(typeof finishRefs, 'function')
    assert.equal(typeof finishContents, 'function', 'contents starts while refs are still pending')
    assert.deepEqual(responses, [])
    if (first === 'refs') finishRefs()
    else finishContents()
    await setImmediate()
    assert.deepEqual(responses, [], 'neither half is sent early')
    if (first === 'refs') finishContents()
    else finishRefs()
    assert.deepEqual(await pending, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: {
      defaultBranch: 'main', branches: ['main'], tags: ['v1'], defaultContents: {
        entries: [{ name: 'entry.ts', path: 'entry.ts', type: 'file' }], limited: false, path: '', commit,
      },
    } })
    assert.equal(responses.length, 1)
  })
}

for (const deleted of [false, true]) {
  test(`refs withDefault replaces a ${deleted ? 'deleted' : 'renamed'} cached default before responding`, async t => {
    const { db, request, responses } = await fixture(t, { role: 'admin' })
    await db.cacheRepoDefaultBranch((await db.listSelectedRepos())[0], 'old/default')
    let finishOld, finishRefs
    const commits = []
    const currentCommit = 'b'.repeat(40)
    t.mock.method(globalThis, 'fetch', async url => {
      const { pathname, searchParams } = new URL(url)
      if (pathname === '/repos/org/repo') return Response.json({ ...publicMetadata, default_branch: 'release/current' })
      if (pathname.endsWith('/branches')) return new Promise(resolve => { finishRefs = () => resolve(Response.json([{ name: 'feature' }])) })
      if (pathname.endsWith('/tags')) return Response.json([])
      if (pathname.includes('/commits/')) {
        const ref = decodeURIComponent(pathname.split('/commits/')[1])
        commits.push(ref)
        if (ref === 'heads/old/default') return new Promise(resolve => { finishOld = () => resolve(deleted ? Response.json({}, { status: 404 }) : Response.json({ sha: commit })) })
        assert.equal(ref, 'heads/release/current')
        assert.equal((await db.listSelectedRepos())[0].cachedDefaultBranch, 'release/current', 'the cache is updated before refetching')
        return Response.json({ sha: currentCommit })
      }
      assert.equal(pathname, '/repos/org/repo/contents/')
      const name = searchParams.get('ref') === currentCommit ? 'current.ts' : 'stale.ts'
      return Response.json([{ name, path: name, type: 'file' }])
    })
    const pending = request({ repoId: '1', withDefault: 'true' }, { route: 'refs' })
    await setImmediate()
    finishRefs()
    await setImmediate()
    assert.deepEqual(commits, ['heads/old/default'], 'replacement waits for the original contents attempt too')
    assert.deepEqual(responses, [])
    finishOld()
    const result = await pending
    assert.equal(result.status, 200)
    assert.equal(result.body.defaultBranch, 'release/current')
    assert.deepEqual(result.body.branches, ['feature'], 'the default need not occur on the first suggestions page')
    assert.deepEqual(result.body.defaultContents.entries, [{ name: 'current.ts', path: 'current.ts', type: 'file' }])
    assert.equal(result.body.defaultContents.commit, currentCommit)
    assert.deepEqual(commits, ['heads/old/default', 'heads/release/current'])
    assert.equal(responses.length, 1)
  })
}

test('refs withDefault populates a cold cache and can clear a missing default', async t => {
  const { db, request } = await fixture(t, { role: 'admin' })
  assert.equal((await db.listSelectedRepos())[0].cachedDefaultBranch, null)
  let commitReads = 0, defaultBranch = 'main'
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname
    if (path === '/repos/org/repo') return Response.json({ ...publicMetadata, default_branch: defaultBranch })
    if (path.endsWith('/branches') || path.endsWith('/tags')) return Response.json([])
    if (path.includes('/commits/')) {
      commitReads++
      if (!defaultBranch) return Response.json({}, { status: 404 })
      assert.equal((await db.listSelectedRepos())[0].cachedDefaultBranch, 'main')
      return Response.json({ sha: commit })
    }
    return Response.json([])
  })
  const cold = await request({ repoId: '1', withDefault: 'true' }, { route: 'refs' })
  assert.equal(cold.status, 200)
  assert.equal(cold.body.defaultContents.commit, commit)
  assert.equal(commitReads, 1)
  assert.equal((await db.listSelectedRepos())[0].cachedDefaultBranch, 'main')
  defaultBranch = ''
  const missing = await request({ repoId: '1', withDefault: 'true' }, { route: 'refs' })
  assert.equal(missing.status, 200)
  assert.equal(missing.body.defaultContents, null)
  assert.equal((await db.listSelectedRepos())[0].cachedDefaultBranch, null)
  const plain = await request({ repoId: '1', withDefault: 'false' }, { route: 'refs' })
  assert.deepEqual(plain.body, { defaultBranch: '', branches: [], tags: [] })
  assert.equal(commitReads, 2, 'plain refs does not fetch contents')
})

for (const failure of ['refs', 'contents']) {
  test(`refs withDefault suppresses the full response when ${failure} fails`, async t => {
    const { db, request, responses } = await fixture(t, { role: 'admin' })
    await db.cacheRepoDefaultBranch((await db.listSelectedRepos())[0], 'main')
    let finishContents
    t.mock.method(globalThis, 'fetch', url => {
      const path = new URL(url).pathname
      if (path === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
      if (path.endsWith('/branches')) return Promise.resolve(failure === 'refs' ? Response.json({}, { status: 503 }) : Response.json([{ name: 'main' }]))
      if (path.endsWith('/tags')) return Promise.resolve(Response.json([]))
      if (path.includes('/commits/')) return Promise.resolve(Response.json({ sha: commit }))
      return new Promise(resolve => { finishContents = () => resolve(failure === 'contents' ? Response.json({}, { status: 404 }) : Response.json([])) })
    })
    const pending = request({ repoId: '1', withDefault: 'true' }, { route: 'refs' })
    await setImmediate()
    assert.deepEqual(responses, [])
    finishContents()
    const result = await pending
    assert.equal(result.status, failure === 'refs' ? 502 : 404)
    assert.equal(result.body.defaultBranch, undefined)
    assert.equal(result.body.defaultContents, undefined)
    assert.equal(responses.length, 1)
  })
}

test('combined refs honors virtual root scopes and rechecks managed and GitHub access', async t => {
  const { db, request, userId } = await fixture(t)
  let duringRead = () => {}, metadata = publicMetadata
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname
    if (path === '/repos/org/repo') return Response.json(metadata)
    if (path.endsWith('/branches') || path.endsWith('/tags')) return Response.json([])
    assert.equal(path, '/repos/org/repo/commits/heads%2Fmain', 'scoped ancestors never fetch the upstream root directory')
    await duringRead()
    return Response.json({ sha: commit })
  })
  const query = { repoId: '1', withDefault: 'true' }
  const result = await request(query, { route: 'refs' })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.defaultContents, { entries: [{ name: 'src', path: 'src', type: 'dir' }], limited: false,
    path: '', commit, packageEntryPoints: [], solidityEntryPoints: [], soliditySuggestionsLimited: false })
  duringRead = () => db.removeTeamMember('team', userId)
  assert.equal((await request(query, { route: 'refs' })).status, 404)
  await db.setTeamMember('team', userId, { dependencies: true, security: true })
  duringRead = () => { metadata = { ...publicMetadata, private: true, visibility: 'private' } }
  assert.equal((await request(query, { route: 'refs' })).status, 404)
})

test('SQLite upgrades repository default caches as nullable and preserves selection metadata', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-repo-default-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'db.sqlite')
  let db = openSqliteManagedDb(path)
  await db.selectRepo(repo, 1)
  await db.close()
  const legacy = new DatabaseSync(path)
  legacy.exec('ALTER TABLE managed_selected_repo DROP COLUMN cached_default_branch')
  legacy.close()
  db = openSqliteManagedDb(path)
  let [selected] = await db.listSelectedRepos()
  assert.equal(selected.cachedDefaultBranch, null)
  assert.equal(await db.cacheRepoDefaultBranch(selected, 'release'), true)
  await db.close()
  db = openSqliteManagedDb(path)
  t.after(() => db.close())
  ;[selected] = await db.listSelectedRepos()
  assert.equal(selected.cachedDefaultBranch, 'release', 'the cache survives reopening')
  assert.equal(selected.defaultBranch, 'main', 'selection metadata is independent')
  assert.equal(await db.cacheRepoDefaultBranch({ ...selected, fullName: 'wrong/repo' }, 'bad'), false)
  assert.equal(await db.cacheRepoDefaultBranch(selected, null), true)
  assert.equal((await db.listSelectedRepos())[0].cachedDefaultBranch, null)
})

test('SQLite upgrades repositories to record their visibility, internal ones stored as private', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-repo-visibility-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'db.sqlite')
  let db = openSqliteManagedDb(path)
  await db.selectRepo({ ...repo, private: false }, 1)
  await db.close()
  const legacy = new DatabaseSync(path)
  legacy.exec('ALTER TABLE managed_selected_repo DROP COLUMN visibility')
  legacy.close()
  db = openSqliteManagedDb(path)
  t.after(() => db.close())
  let [selected] = await db.listSelectedRepos()
  assert.deepEqual([selected.private, selected.visibility], [false, null], 'a repository selected before stays unrecorded')
  await db.selectRepo({ ...repo, private: false, visibility: 'internal' }, 2)
  ;[selected] = await db.listSelectedRepos()
  assert.deepEqual([selected.private, selected.visibility], [true, 'internal'])
})

test('browser endpoints require manage access, honor path grants, and recheck changes during GitHub reads', async t => {
  const { db, userId, request } = await fixture(t)
  let duringRead = async () => {}
  let directoryReads = 0
  const upstream = t.mock.method(globalThis, 'fetch', async url => {
    if (url === 'https://api.github.com/repos/org/repo') return Response.json(publicMetadata)
    assert.ok(url.includes('/contents/src/allowed'))
    directoryReads++
    await duringRead()
    return Response.json([{ name: 'entry.ts', path: 'src/allowed/entry.ts', type: 'file' }])
  })
  const params = { repoId: '1', ref: commit }
  assert.equal((await request(params, { signedIn: false })).status, 401)
  assert.equal((await request(params, { method: 'POST' })).status, 405)
  assert.equal((await request({ ...params, path: '../private' })).status, 400)
  assert.equal((await request({ ...params, repoId: '2' })).status, 404)
  assert.equal((await request({ ...params, path: 'private' })).status, 404)
  assert.deepEqual((await request(params)).body.entries, [{ name: 'src', path: 'src', type: 'dir' }])
  assert.equal(directoryReads, 0, 'ancestor navigation never reads unauthorized directory listings')
  assert.equal(upstream.mock.callCount(), 2, 'ancestor navigation still checks live GitHub access')
  assert.equal((await request({ ...params, path: 'src/allowed' })).body.entries[0].name, 'entry.ts')
  duringRead = () => db.removeTeamMember('team', userId)
  assert.equal((await request({ ...params, path: 'src/allowed' })).status, 404, 'membership revoked while reading')
  await db.setUserRole(userId, 'view')
  assert.equal((await request(params, { route: 'refs' })).status, 403)
})

const userTokens = { accessToken: 'login-token', refreshToken: null, expiresAt: null }

function packageFixture(t) {
  const bytes = Buffer.from(JSON.stringify({ main: './index.js', exports: { './cli': './bin/cli.js' }, bin: { cli: './bin/cli.js' }, description: 'do not return raw contents' }))
  const state = {
    metadata: publicMetadata, duringBlob: async () => {},
    entry: { name: 'package.json', path: 'src/allowed/package.json', type: 'file', size: bytes.length, sha: 'b'.repeat(40), download_url: 'https://untrusted.invalid/package.json' },
    blob: { encoding: 'base64', size: bytes.length, content: bytes.toString('base64') },
  }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url)
    calls.push(parsed.pathname)
    assert.equal(parsed.origin, 'https://api.github.com')
    assert.equal(options.headers.authorization, 'Bearer login-token')
    if (parsed.pathname === '/repos/org/repo') return Response.json(state.metadata)
    if (parsed.pathname === '/repos/org/repo/contents/src/allowed') {
      assert.equal(parsed.searchParams.get('ref'), commit)
      return Response.json(state.entry ? [state.entry] : [])
    }
    assert.equal(parsed.pathname, `/repos/org/repo/git/blobs/${'b'.repeat(40)}`)
    await state.duringBlob()
    return Response.json(state.blob)
  })
  return { state, calls }
}

test('authorized package suggestions use the user token and the blob from the pinned directory', async t => {
  const { request } = await fixture(t, { tokens: userTokens })
  const { calls } = packageFixture(t)
  const response = await request({ repoId: '1', ref: commit, path: 'src/allowed' })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.packageEntryPoints, ['src/allowed/index.js', 'src/allowed/bin/cli.js'])
  assert.equal(response.body.commit, commit)
  assert.ok(!JSON.stringify(response.body).includes('do not return raw contents'))
  assert.deepEqual(calls, ['/repos/org/repo', '/repos/org/repo/contents/src/allowed', `/repos/org/repo/git/blobs/${'b'.repeat(40)}`, '/repos/org/repo'])
})

test('virtual directories and absent, oversized, or non-file manifests never trigger a blob read', async t => {
  const { request } = await fixture(t, { tokens: userTokens })
  const { state, calls } = packageFixture(t)
  const params = { repoId: '1', ref: commit }
  assert.equal((await request(params)).status, 200)
  assert.deepEqual(calls, ['/repos/org/repo', '/repos/org/repo'])
  const entry = state.entry
  for (const invalid of [null, { ...entry, size: 256 * 1024 + 1 }, { ...entry, type: 'symlink' }, { ...entry, submodule_git_url: 'https://example.com' }, { ...entry, sha: '../untrusted' }, { ...entry, path: 'src/private/package.json' }]) {
    state.entry = invalid
    const response = await request({ ...params, path: 'src/allowed' })
    assert.equal(response.status, 200)
    assert.equal(response.body.packageEntryPoints, undefined)
  }
  assert.ok(!calls.some(path => path.includes('/git/blobs/')))
})

test('package reads recheck membership, narrowed path grants, and live GitHub visibility', async t => {
  const { request, db, userId } = await fixture(t, { tokens: userTokens })
  const { state } = packageFixture(t)
  const params = { repoId: '1', ref: commit, path: 'src/allowed' }
  state.duringBlob = () => db.removeTeamMember('team', userId)
  assert.equal((await request(params)).status, 404)
  await db.setTeamMember('team', userId, { dependencies: true, security: true })
  state.duringBlob = async () => {
    await db.removeTeamRepo('team', 1)
    await db.setTeamRepo('team', 1, 'src/allowed/nested')
  }
  const narrowed = await request(params)
  assert.equal(narrowed.status, 200)
  assert.deepEqual(narrowed.body.entries, [{ name: 'nested', path: 'src/allowed/nested', type: 'dir' }])
  assert.deepEqual(narrowed.body.packageEntryPoints, [])
  await db.removeTeamRepo('team', 1)
  await db.setTeamRepo('team', 1, 'src/allowed')
  state.duringBlob = () => { state.metadata = { ...publicMetadata, private: true, visibility: 'private' } }
  assert.equal((await request(params)).status, 404)
})

test('invalid package JSON leaves the authorized file listing usable', async t => {
  const { request } = await fixture(t, { tokens: userTokens })
  const { state, calls } = packageFixture(t)
  state.blob = { encoding: 'base64', size: 1, content: 'ew==' }
  const response = await request({ repoId: '1', ref: commit, path: 'src/allowed' })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.entries, [{ name: 'package.json', path: 'src/allowed/package.json', type: 'file' }])
  assert.deepEqual(response.body.packageEntryPoints, [])
  assert.equal(calls.at(-1), '/repos/org/repo', 'optional reads still finish with the live access check')
})

test('Solidity tree discovery stays inside pinned authorized listings and rechecks access after reads', async t => {
  const { request, db, userId } = await fixture(t, { tokens: userTokens })
  const treeSha = 'c'.repeat(40)
  const calls = []
  let duringTree = async () => {}
  let metadata = publicMetadata
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url)
    calls.push(parsed.pathname)
    assert.equal(options.headers.authorization, 'Bearer login-token')
    if (parsed.pathname === '/repos/org/repo') return Response.json(metadata)
    if (parsed.pathname === '/repos/org/repo/contents/src/allowed') {
      assert.equal(parsed.searchParams.get('ref'), commit)
      return Response.json([{ name: 'contracts', path: 'src/allowed/contracts', type: 'dir', sha: treeSha }])
    }
    assert.equal(parsed.pathname, `/repos/org/repo/git/trees/${treeSha}`)
    assert.equal(parsed.searchParams.get('recursive'), '1')
    await duringTree()
    return Response.json({ tree: [{ path: 'Token.sol', type: 'blob', mode: '100644' }], truncated: false })
  })
  const params = { repoId: '1', ref: commit, path: 'src/allowed' }
  assert.equal((await request({ ...params, path: '' })).status, 200)
  assert.deepEqual(calls, ['/repos/org/repo', '/repos/org/repo'], 'virtual ancestors do not read any Git trees')
  assert.equal((await request({ ...params, path: 'src/private' })).status, 404)
  const result = await request(params)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.solidityEntryPoints, ['src/allowed/contracts/Token.sol'])
  assert.equal(result.body.soliditySuggestionsLimited, false)
  assert.equal(result.body.commit, commit)
  duringTree = () => db.removeTeamMember('team', userId)
  assert.equal((await request(params)).status, 404)
  await db.setTeamMember('team', userId, { dependencies: true, security: true })
  duringTree = async () => {
    await db.removeTeamRepo('team', 1)
    await db.setTeamRepo('team', 1, 'src/allowed/nested')
  }
  const narrowed = await request(params)
  assert.equal(narrowed.status, 200)
  assert.deepEqual(narrowed.body.entries, [{ name: 'nested', path: 'src/allowed/nested', type: 'dir' }])
  assert.deepEqual(narrowed.body.solidityEntryPoints, [])
  assert.equal(narrowed.body.soliditySuggestionsLimited, false)
  await db.removeTeamRepo('team', 1)
  await db.setTeamRepo('team', 1, 'src/allowed')
  duringTree = () => { metadata = { ...publicMetadata, private: true, visibility: 'private' } }
  assert.equal((await request(params)).status, 404)
})

function githubFixture(t, { publicRepo = false, permission = 'read', identityId = 1, permissionUserId = 1 } = {}) {
  const state = { metadata: { ...publicMetadata, private: !publicRepo, visibility: publicRepo ? 'public' : 'private' }, permission, identityId, permissionUserId, duringRead: async () => {} }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname
    calls.push(path)
    if (path === '/app/installations/7/access_tokens') return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() })
    if (path === '/repos/org/repo') return Response.json(state.metadata)
    if (path === '/user') {
      assert.equal(options.headers.authorization, 'Bearer login-token')
      return Response.json({ id: state.identityId, login: 'renamed-user' })
    }
    if (path === '/repos/org/repo/collaborators/renamed-user/permission') {
      assert.equal(options.headers.authorization, 'Bearer installation-token')
      return Response.json({ permission: state.permission, user: { id: state.permissionUserId } })
    }
    assert.ok(['/repos/org/repo/branches', '/repos/org/repo/tags', '/repos/org/repo/contents/src/allowed'].includes(path), path)
    await state.duringRead()
    return Response.json(path.includes('/contents/') ? [{ name: 'entry.ts', path: 'src/allowed/entry.ts', type: 'file' }] : [{ name: 'main' }])
  })
  return { calls, state }
}

for (const [role, member, publicRepo, permission, allowed] of [
  ['admin', false, false, 'read', true],
  ['admin', false, false, 'none', false],
  ['admin', false, true, 'none', true],
  ['manage', true, false, 'read', true],
  ['manage', true, false, 'none', false],
  ['manage', true, true, 'none', true],
  ['manage', false, false, 'read', false],
  ['manage', false, true, 'read', false],
  ['view', true, false, 'read', false],
]) {
  test(`the dropdown uses managed access and browsing requires both gates: ${role}, team=${member}, public=${publicRepo}, GitHub=${permission}`, async t => {
    const { request } = await fixture(t, { role, member, selectedRepo: privateRepo, tokens: userTokens, fixtureConfig: appConfig })
    const { calls } = githubFixture(t, { publicRepo, permission })
    const listing = await request({}, { route: 'browsable' })
    assert.equal(listing.status, role === 'view' ? 403 : 200)
    if (role !== 'view') assert.deepEqual(listing.body.repos, role === 'admin' || member ? [{ repoId: 1, fullName: 'org/repo' }] : [])
    assert.equal(calls.length, 0, 'listing repository names never calls GitHub')
    for (const route of ['refs', 'contents']) {
      const result = await request({ repoId: '1', ref: commit, path: 'src/allowed' }, { route })
      assert.equal(result.status, allowed ? 200 : role === 'view' ? 403 : 404)
      if (!allowed) assert.ok(!JSON.stringify(result.body).includes('entry.ts'))
    }
    if (role === 'view' || (role === 'manage' && !member)) assert.equal(calls.length, 0, 'local authorization precedes all GitHub requests')
    if (!allowed) assert.ok(!calls.some(path => /\/(?:contents|branches|tags)(?:\/|$)/u.test(path)), 'denied users never trigger source or ref reads')
  })
}

for (const tokens of [null, { ...userTokens, expiresAt: 1 }]) {
  test(`a ${tokens ? 'expired' : 'missing'} GitHub credential allows public repositories only`, async t => {
    const { request } = await fixture(t, { role: 'admin', selectedRepo: privateRepo, tokens, fixtureConfig: appConfig })
    const { state, calls } = githubFixture(t)
    assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [{ repoId: 1, fullName: 'org/repo' }])
    assert.equal((await request({ repoId: '1', ref: commit })).status, 404)
    state.metadata = publicMetadata
    assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [{ repoId: 1, fullName: 'org/repo' }])
    assert.equal((await request({ repoId: '1', ref: commit, path: 'src/allowed' })).status, 200)
    assert.ok(!calls.includes('/user'))
  })
}

for (const visibility of ['private', 'internal', undefined]) {
  test(`stored public flags never bypass live ${visibility ?? 'unknown'} visibility`, async t => {
    const { request } = await fixture(t, { selectedRepo: { ...privateRepo, private: false }, tokens: userTokens, fixtureConfig: appConfig })
    const { state } = githubFixture(t, { permission: 'none' })
    state.metadata = { ...publicMetadata, visibility }
    assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [{ repoId: 1, fullName: 'org/repo' }])
    assert.equal((await request({ repoId: '1', ref: commit })).status, 404, 'virtual ancestor directories also require GitHub access')
  })
}

for (const mismatch of ['identity', 'permission', 'repository']) {
  test(`a mismatched ${mismatch} response fails closed`, async t => {
    const { request } = await fixture(t, { selectedRepo: privateRepo, tokens: userTokens, fixtureConfig: appConfig })
    const { state } = githubFixture(t)
    if (mismatch === 'identity') state.identityId = 99
    if (mismatch === 'permission') state.permissionUserId = 99
    if (mismatch === 'repository') state.metadata.id = 99
    assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [{ repoId: 1, fullName: 'org/repo' }])
    assert.equal((await request({ repoId: '1', ref: commit, path: 'src/allowed' })).status, 404)
  })
}

test('GitHub permission revocation or public visibility changes during reads suppress the results', async t => {
  const { request } = await fixture(t, { selectedRepo: privateRepo, tokens: userTokens, fixtureConfig: appConfig })
  const { state } = githubFixture(t)
  state.duringRead = () => { state.permission = 'none' }
  assert.equal((await request({ repoId: '1', ref: commit, path: 'src/allowed' })).status, 404)
  state.metadata = publicMetadata
  state.duringRead = () => { state.metadata = { ...publicMetadata, private: true, visibility: 'private' } }
  assert.equal((await request({ repoId: '1' }, { route: 'refs' })).status, 404)
})

test('the dropdown rechecks local team access and omits deactivated repositories', async t => {
  const { request, db, userId } = await fixture(t)
  t.mock.method(globalThis, 'fetch', () => { assert.fail('listing repository names must not call GitHub') })
  assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [{ repoId: 1, fullName: 'org/repo' }])
  await db.removeTeamMember('team', userId)
  assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [])
  assert.equal((await request({ repoId: '1' }, { route: 'refs' })).status, 404)
  await db.setUserRole(userId, 'admin')
  assert.equal((await request({}, { route: 'browsable' })).body.repos.length, 1)
  await db.deselectRepo(1)
  assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [])
  assert.equal((await request({ repoId: '1' }, { route: 'refs' })).status, 404)
})

test('GitHub failures leave the managed repository list available but never return source data', async t => {
  const { request } = await fixture(t, { selectedRepo: privateRepo, tokens: userTokens, fixtureConfig: appConfig })
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ message: 'unavailable' }, { status: 503 })))
  assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [{ repoId: 1, fullName: 'org/repo' }])
  for (const route of ['refs', 'contents']) {
    const result = await request({ repoId: '1', ref: commit }, { route })
    assert.equal(result.status, 502)
    assert.ok(!JSON.stringify(result.body).includes('org/repo'))
  }
})

for (const failure of ['token mint', 'authenticated metadata']) {
  test(`public repositories remain browsable after ${failure} fails, but anonymous fallback never grants nonpublic access`, async t => {
    const { request } = await fixture(t, { selectedRepo: privateRepo, fixtureConfig: appConfig })
    let metadata = publicMetadata
    let sourceReads = 0
    let revokeDuringRead = false
    const calls = []
    t.mock.method(globalThis, 'fetch', (url, options) => {
      const path = new URL(url).pathname
      const authorization = options.headers.authorization
      calls.push({ path, authorization })
      if (path === '/app/installations/7/access_tokens') {
        return Promise.resolve(failure === 'token mint' ? Response.json({}, { status: 404 }) : Response.json({ token: 'stale-installation' }))
      }
      if (path === '/repos/org/repo') return Promise.resolve(authorization ? Response.json({}, { status: 403 }) : Response.json(metadata))
      assert.equal(authorization, undefined, 'fallback source reads must be anonymous too')
      assert.ok(['/repos/org/repo/branches', '/repos/org/repo/tags', '/repos/org/repo/contents/src/allowed'].includes(path), path)
      sourceReads++
      if (revokeDuringRead) metadata = { ...publicMetadata, private: true, visibility: 'private' }
      return Promise.resolve(Response.json(path.includes('/contents/') ? [{ name: 'entry.ts', path: 'src/allowed/entry.ts', type: 'file' }] : [{ name: 'main' }]))
    })
    assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [{ repoId: 1, fullName: 'org/repo' }])
    for (const route of ['refs', 'contents']) {
      assert.equal((await request({ repoId: '1', ref: commit, path: 'src/allowed' }, { route })).status, 200)
    }
    assert.equal(sourceReads, 3)
    assert.ok(!calls.some(call => call.path.includes('/collaborators/') || call.path === '/user'))

    for (const denied of [
      { ...publicMetadata, private: true, visibility: 'private' },
      { ...publicMetadata, visibility: 'internal' },
      { ...publicMetadata, visibility: undefined },
      { ...publicMetadata, id: 999 },
    ]) {
      metadata = denied
      assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [{ repoId: 1, fullName: 'org/repo' }])
      for (const route of ['refs', 'contents']) assert.equal((await request({ repoId: '1', ref: commit, path: 'src/allowed' }, { route })).status, 404)
      assert.equal(sourceReads, 3, 'unverified metadata never grants source reads')
    }
    metadata = publicMetadata
    revokeDuringRead = true
    assert.equal((await request({ repoId: '1', ref: commit, path: 'src/allowed' })).status, 404, 'public visibility is still rechecked after source reads')
  })
}

test('opening and refreshing the picker with 100 private repositories makes zero GitHub requests', async t => {
  const { request, db } = await fixture(t, { role: 'admin', selectedRepo: privateRepo, tokens: { ...userTokens, expiresAt: 1 }, fixtureConfig: appConfig })
  const repos = Array.from({ length: 100 }, (_, i) => ({ ...privateRepo, repoId: i + 1, fullName: i === 0 ? 'org/repo' : `org/repo${i + 1}` }))
  for (const item of repos.slice(1)) await db.selectRepo(item, Date.now())
  let calls = 0
  t.mock.method(globalThis, 'fetch', () => {
    calls++
    return Promise.resolve(Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
  })
  for (let i = 0; i < 2; i++) {
    const listing = await request({}, { route: 'browsable' })
    assert.equal(listing.status, 200)
    assert.deepEqual(listing.body.repos, repos.map(({ repoId, fullName }) => ({ repoId, fullName })).toSorted((a, b) => a.fullName.localeCompare(b.fullName)))
  }
  assert.equal(calls, 0, 'even expired credentials are left untouched until repository selection')
})

test('request credentials are isolated by installation and failed token lookups also coalesce', async t => {
  const repos = [privateRepo, { ...privateRepo, repoId: 2, fullName: 'org/second', installationId: 8 }, { ...privateRepo, repoId: 3, fullName: 'org/third' }]
  const minted = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const path = new URL(url).pathname
    if (path.endsWith('/access_tokens')) {
      minted.push(path)
      return Promise.resolve(path.includes('/7/') ? Response.json({}, { status: 404 }) : Response.json({ token: 'installation-8' }))
    }
    assert.ok(path.startsWith('/repos/org/'))
    const id = path.endsWith('/repo') ? 1 : path.endsWith('/second') ? 2 : 3
    assert.equal(options.headers.authorization, id === 2 ? 'Bearer installation-8' : undefined)
    return Promise.resolve(Response.json({ ...publicMetadata, id, full_name: path.slice('/repos/'.length) }))
  })
  const browser = createRepositoryBrowser(appConfig, anonymous)
  assert.equal((await Promise.all(repos.map(item => browser.reader(item)))).length, 3)
  assert.deepEqual(minted.toSorted(), ['/app/installations/7/access_tokens', '/app/installations/8/access_tokens'])
})

test('reusing an installation token still rechecks user permissions, public visibility, and managed grants', async t => {
  const { request, db, userId } = await fixture(t, { selectedRepo: privateRepo, tokens: userTokens, fixtureConfig: appConfig })
  const { calls, state } = githubFixture(t)
  const params = { repoId: '1', ref: commit, path: 'src/allowed' }
  assert.equal((await request(params)).status, 200)
  assert.equal((await request(params)).status, 200)
  assert.equal(calls.filter(path => path.endsWith('/access_tokens')).length, 1)
  assert.equal(calls.filter(path => path === '/user').length, 4, 'identities remain request-local and are rechecked after reading')
  assert.equal(calls.filter(path => path.includes('/collaborators/')).length, 4)
  state.permission = 'none'
  assert.equal((await request(params)).status, 404)
  state.metadata = publicMetadata
  assert.equal((await request(params)).status, 200)
  state.metadata = { ...publicMetadata, private: true, visibility: 'private' }
  assert.equal((await request(params)).status, 404, 'a cached credential is not cached public visibility')
  state.permission = 'read'
  await db.removeTeamMember('team', userId)
  assert.equal((await request(params)).status, 404)
  assert.equal(calls.filter(path => path.endsWith('/access_tokens')).length, 1)
})

test('users share installation credentials without sharing private repository authorization', async () => {
  let mints = 0
  const permissions = []
  const fetch = (url, options) => {
    const path = new URL(url).pathname
    if (path.endsWith('/access_tokens')) {
      mints++
      return Promise.resolve(Response.json({ token: 'shared-installation', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }))
    }
    if (path === '/repos/org/repo') return Promise.resolve(Response.json({ ...publicMetadata, private: true, visibility: 'private' }))
    if (path === '/user') return Promise.resolve(Response.json(options.headers.authorization === 'Bearer alice' ? { id: 1, login: 'alice' } : { id: 2, login: 'bob' }))
    permissions.push(path)
    const alice = path.includes('/alice/')
    assert.equal(options.headers.authorization, 'Bearer shared-installation')
    return Promise.resolve(Response.json({ user: { id: alice ? 1 : 2 }, permission: alice ? 'read' : 'none' }))
  }
  await createRepositoryBrowser(appConfig, { githubUserId: 1, token: 'alice' }, fetch).reader(privateRepo)
  await assert.rejects(createRepositoryBrowser(appConfig, { githubUserId: 2, token: 'bob' }, fetch).reader(privateRepo), /no-repository/u)
  assert.equal(mints, 1)
  assert.deepEqual(permissions, ['/repos/org/repo/collaborators/alice/permission', '/repos/org/repo/collaborators/bob/permission'])
})

test('source reads refresh the cached GitHub identity before returning data', async t => {
  const { request } = await fixture(t, { selectedRepo: privateRepo, tokens: userTokens, fixtureConfig: appConfig })
  const { calls, state } = githubFixture(t)
  state.duringRead = () => { state.identityId = 99 }
  const response = await request({ repoId: '1', ref: commit, path: 'src/allowed' })
  assert.equal(response.status, 404)
  assert.equal(calls.filter(path => path === '/user').length, 2)
  assert.ok(!JSON.stringify(response.body).includes('entry.ts'))
})

for (const installationId of [null, 7]) {
  test(`public refs and files use the user token without minting installation ${installationId}`, async t => {
    const { request } = await fixture(t, { selectedRepo: { ...repo, installationId }, tokens: userTokens, fixtureConfig: appConfig })
    const calls = []
    t.mock.method(globalThis, 'fetch', (url, options) => {
      const path = new URL(url).pathname
      calls.push(path)
      assert.equal(options.headers.authorization, 'Bearer login-token')
      if (path === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
      if (path.endsWith('/commits/heads%2Fmain')) return Promise.resolve(Response.json({ sha: commit }))
      if (path.endsWith('/branches')) return Promise.resolve(Response.json([{ name: 'main' }]))
      if (path.endsWith('/tags')) return Promise.resolve(Response.json([{ name: 'v1' }]))
      assert.equal(path, '/repos/org/repo/contents/src/allowed')
      return Promise.resolve(Response.json([{ name: 'entry.ts', path: 'src/allowed/entry.ts', type: 'file' }]))
    })
    assert.equal((await request({ repoId: '1' }, { route: 'refs' })).status, 200)
    assert.equal((await request({ repoId: '1', ref: 'heads/main', path: 'src/allowed' })).status, 200)
    assert.equal(calls.length, 8, 'no installation or identity lookups for live public access')
  })
}

test('a user token that can read private metadata does not bypass repository App authorization', async t => {
  const { request } = await fixture(t, { selectedRepo: repo, tokens: userTokens })
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push(new URL(url).pathname)
    assert.equal(options.headers.authorization, 'Bearer login-token')
    return Promise.resolve(Response.json({ ...publicMetadata, private: true, visibility: 'private' }))
  })
  for (const route of ['refs', 'contents']) assert.equal((await request({ repoId: '1', ref: commit }, { route })).status, 404)
  assert.deepEqual(calls, ['/repos/org/repo', '/repos/org/repo'])
})

test('an unavailable login token can use the installation for public reads', async t => {
  const { request } = await fixture(t, { selectedRepo: { ...repo, installationId: 7 }, tokens: userTokens, fixtureConfig: appConfig })
  let userRequests = 0
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const path = new URL(url).pathname
    if (path.endsWith('/access_tokens')) return Promise.resolve(Response.json({ token: 'installation-token' }))
    if (options.headers.authorization === 'Bearer login-token') {
      userRequests++
      assert.equal(path, '/repos/org/repo')
      return Promise.resolve(Response.json({}, { status: 401 }))
    }
    assert.equal(options.headers.authorization, 'Bearer installation-token')
    return Promise.resolve(Response.json(path === '/repos/org/repo' ? publicMetadata : [{ name: 'main' }]))
  })
  assert.equal((await request({ repoId: '1' }, { route: 'refs' })).status, 200)
  assert.equal(userRequests, 1)
})

for (const failure of [
  { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 300) }, message: 'API rate limit exceeded' },
  { status: 403, headers: { 'retry-after': '120' }, message: 'Secondary rate limit' },
  { status: 403, headers: {}, message: 'You have exceeded a secondary rate limit.' },
  { status: 429, headers: {}, message: 'Too many requests' },
]) {
  test(`rate limiting is surfaced without trying other credentials: ${failure.status}, ${failure.message}`, async t => {
    const { request } = await fixture(t, { selectedRepo: { ...repo, installationId: 7 }, tokens: userTokens, fixtureConfig: appConfig })
    const calls = []
    t.mock.method(globalThis, 'fetch', (url, options) => {
      calls.push(url)
      assert.equal(options.headers.authorization, 'Bearer login-token')
      return Promise.resolve(Response.json({ message: failure.message }, { status: failure.status, headers: failure.headers }))
    })
    for (const route of ['refs', 'contents']) {
      const response = await request({ repoId: '1', ref: commit }, { route })
      assert.equal(response.status, 429)
      assert.equal(response.body.error, 'github-rate-limited')
      assert.ok(Number(response.headers['retry-after']) >= 60)
    }
    assert.equal(calls.length, 2, 'one attempt per request, with no installation or anonymous retry')
  })
}

test('GitHub outages do not cause anonymous fallback or token minting', async t => {
  const { request } = await fixture(t, { selectedRepo: privateRepo, tokens: userTokens, fixtureConfig: appConfig })
  let calls = 0
  t.mock.method(globalThis, 'fetch', () => { calls++; return Promise.resolve(Response.json({}, { status: 503 })) })
  const response = await request({ repoId: '1' }, { route: 'refs' })
  assert.equal(response.status, 502)
  assert.equal(response.body.error, 'github-status-503')
  assert.equal(calls, 1)
})

test('private refs fall back from the login token to installation reads and effective permission checks', async t => {
  const { request } = await fixture(t, { selectedRepo: privateRepo, tokens: userTokens, fixtureConfig: appConfig })
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const path = new URL(url).pathname
    const auth = options.headers.authorization
    calls.push({ path, auth })
    if (path.endsWith('/access_tokens')) return Promise.resolve(Response.json({ token: 'installation-token' }))
    if (path === '/user') {
      assert.equal(auth, 'Bearer login-token')
      return Promise.resolve(Response.json({ id: 1, login: 'user' }))
    }
    if (path === '/repos/org/repo' && auth === 'Bearer login-token') return Promise.resolve(Response.json({}, { status: 404 }))
    assert.equal(auth, 'Bearer installation-token')
    if (path === '/repos/org/repo') return Promise.resolve(Response.json({ ...publicMetadata, private: true, visibility: 'private' }))
    if (path.endsWith('/permission')) return Promise.resolve(Response.json({ permission: 'read', user: { id: 1 } }))
    assert.ok(path.endsWith('/branches') || path.endsWith('/tags'))
    return Promise.resolve(Response.json([{ name: 'main' }]))
  })
  assert.equal((await request({ repoId: '1' }, { route: 'refs' })).status, 200)
  assert.equal(calls.filter(call => call.path.endsWith('/permission')).length, 2)
  assert.equal(calls.filter(call => call.path.endsWith('/access_tokens')).length, 1)
})

test('rate limiting during installation-token minting is not retried anonymously', async t => {
  const { request } = await fixture(t, { selectedRepo: privateRepo, fixtureConfig: appConfig })
  const calls = []
  t.mock.method(globalThis, 'fetch', url => {
    calls.push(new URL(url).pathname)
    return Promise.resolve(Response.json({ message: 'rate limit exceeded' }, { status: 403, headers: { 'retry-after': '120' } }))
  })
  const response = await request({ repoId: '1' }, { route: 'refs' })
  assert.equal(response.status, 429)
  assert.equal(response.headers['retry-after'], '120')
  assert.deepEqual(calls, ['/app/installations/7/access_tokens'])
})
