import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { repositoryReader, scopedDirectory } from '../server-managed/repository-browser.ts'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const commit = 'a'.repeat(40)

test('repository reader pins branches/tags to commits and only returns directory metadata', async () => {
  const calls = []
  const reader = await repositoryReader(config, repo, async (url, options) => {
    await Promise.resolve()
    calls.push(url)
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
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
  await assert.rejects(repositoryReader(config, { ...repo, private: true }), /repository-access-unavailable/u)
})

test('directory grants expose ancestors but no sibling names or prefix collisions', () => {
  assert.deepEqual(scopedDirectory('', ['packages/app', 'packages/api']), [{ name: 'packages', path: 'packages', type: 'dir' }])
  assert.deepEqual(scopedDirectory('packages', ['packages/app']), [{ name: 'app', path: 'packages/app', type: 'dir' }])
  assert.equal(scopedDirectory('packages/app/src', ['packages/app']), null)
  assert.equal(scopedDirectory('', [null]), null)
  assert.deepEqual(scopedDirectory('packages/application', ['packages/app']), [])
})

async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(config, db, { githubUserId: 1, login: 'manager', name: null, avatarUrl: null }, Date.now())
  const { userId } = session
  await db.setUserRole(userId, 'manage')
  await db.selectRepo(repo, Date.now())
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 1, 'src/allowed')
  await db.setTeamMember('team', userId, { dependencies: true, security: true })
  const handler = createManagedRequestHandler({ config, db, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {} })
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
  const upstream = t.mock.method(globalThis, 'fetch', async url => {
    assert.ok(url.includes('/contents/src/allowed'))
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
  assert.equal(upstream.mock.callCount(), 0, 'ancestor navigation never reads unauthorized directory listings')
  assert.equal((await request({ ...params, path: 'src/allowed' })).body.entries[0].name, 'entry.ts')
  duringRead = () => db.removeTeamMember('team', userId)
  assert.equal((await request({ ...params, path: 'src/allowed' })).status, 404, 'membership revoked while reading')
  await db.setUserRole(userId, 'view')
  assert.equal((await request(params, { route: 'refs' })).status, 403)
})
