import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { repositoryReader, scopedDirectory } from '../server-managed/repository-browser.ts'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const commit = 'a'.repeat(40)
const anonymous = { githubUserId: 1, token: null }
const appConfig = { ...config, githubAppId: '1', githubAppPrivateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) }
const privateRepo = { ...repo, private: true, installationId: 7 }
const publicMetadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public' }

test('repository reader pins branches/tags to commits and only returns directory metadata', async () => {
  const calls = []
  const reader = await repositoryReader(config, repo, anonymous, async (url, options) => {
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
  })
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
  await assert.rejects(repositoryReader(config, privateRepo, anonymous, () => Promise.resolve(Response.json({ ...publicMetadata, private: true, visibility: 'private' }))), /no-repository/u)
})

test('directory grants expose ancestors but no sibling names or prefix collisions', () => {
  assert.deepEqual(scopedDirectory('', ['packages/app', 'packages/api']), [{ name: 'packages', path: 'packages', type: 'dir' }])
  assert.deepEqual(scopedDirectory('packages', ['packages/app']), [{ name: 'app', path: 'packages/app', type: 'dir' }])
  assert.equal(scopedDirectory('packages/app/src', ['packages/app']), null)
  assert.equal(scopedDirectory('', [null]), null)
  assert.deepEqual(scopedDirectory('packages/application', ['packages/app']), [])
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
  const request = async (query, { method = 'GET', signedIn = true, route = 'contents' } = {}) => {
    const res = { status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body } }
    await handler({ method, url: `/api/admin/repositories/${route}?${new URLSearchParams(query)}`, headers: { cookie: signedIn ? session.setCookie.split(';')[0] : undefined } }, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
  return { db, userId, request }
}

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

function githubFixture(t, { publicRepo = false, permission = 'read', identityId = 1, permissionUserId = 1 } = {}) {
  const state = { metadata: { ...publicMetadata, private: !publicRepo, visibility: publicRepo ? 'public' : 'private' }, permission, identityId, permissionUserId, duringRead: async () => {} }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname
    calls.push(path)
    if (path === '/app/installations/7/access_tokens') return Response.json({ token: 'installation-token' })
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
  test(`source dropdown and browsing require both gates: ${role}, team=${member}, public=${publicRepo}, GitHub=${permission}`, async t => {
    const { request } = await fixture(t, { role, member, selectedRepo: privateRepo, tokens: userTokens, fixtureConfig: appConfig })
    const { calls } = githubFixture(t, { publicRepo, permission })
    const listing = await request({}, { route: 'browsable' })
    assert.equal(listing.status, role === 'view' ? 403 : 200)
    if (role !== 'view') assert.deepEqual(listing.body.repos, allowed ? [{ repoId: 1, fullName: 'org/repo' }] : [])
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
    assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [])
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
    assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [])
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
    assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [])
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

test('the dropdown rechecks team access after GitHub reads and omits deactivated repositories', async t => {
  const { request, db, userId } = await fixture(t)
  t.mock.method(globalThis, 'fetch', async () => {
    await db.removeTeamMember('team', userId)
    return Response.json(publicMetadata)
  })
  assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [])
  await db.setUserRole(userId, 'admin')
  await db.deselectRepo(1)
  assert.deepEqual((await request({}, { route: 'browsable' })).body.repos, [])
  assert.equal((await request({ repoId: '1' }, { route: 'refs' })).status, 404)
})

test('GitHub failures never yield dropdown names or source data', async t => {
  const { request } = await fixture(t, { selectedRepo: privateRepo, tokens: userTokens, fixtureConfig: appConfig })
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ message: 'unavailable' }, { status: 503 })))
  for (const route of ['browsable', 'refs', 'contents']) {
    const result = await request({ repoId: '1', ref: commit }, { route })
    assert.equal(result.status, 502)
    assert.ok(!JSON.stringify(result.body).includes('org/repo'))
  }
})
