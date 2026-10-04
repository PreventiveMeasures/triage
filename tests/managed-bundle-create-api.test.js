import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mock, test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession, endSession } from '../server-managed/session.ts'
import * as builder from '../server-managed/bundle-build.ts'
import { managedBundleEntry, managedBundleRoute } from '../ui/view/managed-bundle-navigation.js'
import { managedRoutePath } from '../common/managed/routes.js'

let build
mock.module('../server-managed/bundle-build.ts', { namedExports: { ...builder, buildRepositoryBundle: (...args) => build(...args) } })
const { createManagedRequestHandler } = await import('../server-managed/http.ts')

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 600_000, maxBundleBytes: 1_000_000 }
const commit = 'a'.repeat(40)
const body = { repoId: 1, commit, entries: ['index.js'], conditions: { preset: 'node', conditions: ['node'], platforms: [] } }
const result = { bytes: Buffer.from('compressed bundle'), directory: '', filename: 'org-repo.aaaaaaa.stasis.code.br' }

async function fixture(t, { role = 'admin', member = true, scope = null } = {}) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(config, db, { githubUserId: 1, login: 'builder', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, role)
  await db.selectRepo({ repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }, Date.now())
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 1, scope)
  if (member) await db.setTeamMember('team', session.userId, { dependencies: true, security: true })
  const blobs = new Map()
  const bundleStore = { put: async (id, bytes) => { blobs.set(id, bytes); await Promise.resolve() },
    get: id => Promise.resolve(blobs.get(id)), delete: id => Promise.resolve(blobs.delete(id)) }
  const handler = createManagedRequestHandler({ config, db, bundleStore,
    originGate: { isOriginAllowed: req => req.headers.origin !== 'https://evil.test' }, isShuttingDown: () => false, track() {} })
  const metadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }
  let reads = 0
  t.mock.method(globalThis, 'fetch', url => {
    assert.equal(url, 'https://api.github.com/repos/org/repo')
    reads++
    return Promise.resolve(Response.json(metadata))
  })
  const builds = []
  build = (...args) => { builds.push(args); return Promise.resolve(result) }
  const send = async (input = body, { method = 'POST', csrf = session.csrfToken, origin, beforeBody } = {}) => {
    // ServerResponse uses Node's EventEmitter close lifecycle.
    // oxlint-disable-next-line unicorn/prefer-event-target
    const res = Object.assign(new EventEmitter(), { status: 0, body: '', headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers }, end(value) { this.body = value ?? '' } })
    const req = { method, url: '/api/admin/bundles/create', headers: { cookie: session.setCookie.split(';')[0], 'x-csrf-token': csrf, ...(origin ? { origin } : {}) },
      async *[Symbol.asyncIterator]() { await beforeBody?.(); yield Buffer.from(JSON.stringify(input)) } }
    await handler(req, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
  return { db, session, blobs, builds, send, metadata, reads: () => reads, bundleStore }
}

test('creation stores a Stasis bundle with a routable slug and deduplicates retries', async t => {
  const f = await fixture(t, { role: 'manage' })
  const response = await f.send()
  assert.equal(response.status, 201)
  assert.equal(response.body.filename, result.filename)
  const stored = await f.db.getBundle(response.body.id)
  assert.equal(stored.kind, 'stasis')
  assert.equal(stored.repoId, 1)
  assert.equal(stored.uploadedBy, f.session.userId)
  assert.equal(f.builds[0][1].github, 'org/repo')
  assert.equal(f.builds[0][1].token, null)
  assert.equal(f.builds[0][1].input.commit, commit)
  assert.equal(f.reads(), 2, 'GitHub access is rechecked after building')
  const duplicate = await f.send()
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.body.id, response.body.id)
  assert.equal(duplicate.body.deduped, true)
  assert.equal(f.blobs.size, 1)
  for (const created of [response.body, duplicate.body]) {
    assert.equal(created.slug, stored.slug)
    const route = managedBundleRoute([], managedBundleEntry(created), null)
    assert.equal(managedRoutePath(route), `/manage/bundle/${stored.slug}`)
  }
})

test('creation returns the persisted slug when the shortened UUID collides', async t => {
  const f = await fixture(t)
  const insert = f.db.insertBundle.bind(f.db)
  t.mock.method(f.db, 'insertBundle', async (bundle, ...args) => {
    await insert({ ...bundle, id: bundle.id.split('-').at(-1), integrity: 'existing-bundle', dataKey: null }, ...args)
    await insert(bundle, ...args)
  })
  const response = await f.send()
  assert.equal(response.status, 201)
  const stored = await f.db.getBundle(response.body.id)
  assert.equal(stored.slug, response.body.id, 'a collision uses the full UUID as its slug')
  assert.equal(response.body.slug, stored.slug)
  const route = managedBundleRoute([], managedBundleEntry(response.body), null)
  assert.equal(managedRoutePath(route), `/manage/bundle/${stored.slug}`)
})

test('creation rejects role, team, directory, CSRF, origin, and validation failures before building', async t => {
  for (const [options, request, status] of [
    [{ role: 'view' }, {}, 403], [{ role: 'manage', member: false }, {}, 404],
    [{ role: 'manage', scope: 'packages/app' }, {}, 403], [{}, { csrf: 'wrong' }, 403],
    [{}, { origin: 'https://evil.test' }, 403], [{}, { method: 'GET' }, 405],
  ]) { await t.test(JSON.stringify([options, request]), async st => {
    const f = await fixture(st, options)
    assert.equal((await f.send(body, request)).status, status)
    assert.equal(f.builds.length, 0)
    assert.equal(f.reads(), 0)
  }) }
  const f = await fixture(t)
  assert.equal((await f.send({ ...body, entries: ['../secret.js'] })).status, 400)
  assert.equal(f.builds.length, 0)
})

test('private GitHub access is required even for a managed administrator', async t => {
  const f = await fixture(t)
  Object.assign(f.metadata, { private: true, visibility: 'private' })
  assert.equal((await f.send()).status, 404)
  assert.equal(f.builds.length, 0)
})

test('creation returns only the public build error code, without internal diagnostics', async t => {
  const f = await fixture(t)
  build = () => Promise.reject(Object.assign(new builder.BundleBuildError(422, 'build-failed'), {
    diagnostic: { message: 'internal worker path and credentials', stack: 'private stack' },
  }))
  assert.deepEqual(await f.send(), { status: 422, body: { error: 'build-failed' } })
  assert.equal(f.blobs.size, 0)
})

test('shared capacity rejects creation before GitHub work, and released slots can be reused', async t => {
  const f = await fixture(t, { role: 'manage' })
  assert.equal(await f.db.claimBundleBuildLease(f.session.userId, 'another-instance'), true)
  assert.deepEqual(await f.send(), { status: 429, body: { error: 'build-busy' } })
  assert.equal(f.reads(), 0)
  assert.equal(f.builds.length, 0)
  await f.db.releaseBundleBuildLease('another-instance')
  assert.equal((await f.send()).status, 201)
  assert.equal(await f.db.claimBundleBuildLease(f.session.userId, 'after-completion'), true)
})

for (const change of ['role', 'logout', 'team', 'repository', 'github', 'root']) {
  // Tests run serially; each fixture replaces the mocked builder before use.
  // oxlint-disable-next-line eslint/no-loop-func
  test(`creation discards completed builds after ${change} changes`, async t => {
    const f = await fixture(t, { role: 'manage' })
    build = async () => {
      if (change === 'role') await f.db.setUserRole(f.session.userId, 'view')
      if (change === 'logout') await endSession(config, f.db, f.session.setCookie.split(';')[0])
      if (change === 'team') await f.db.removeTeamMember('team', f.session.userId)
      if (change === 'repository') await f.db.deselectRepo(1)
      if (change === 'github') Object.assign(f.metadata, { private: true, visibility: 'private' })
      if (change === 'root') { await f.db.removeTeamRepo('team', 1); await f.db.setTeamRepo('team', 1, 'src') }
      return result
    }
    const response = await f.send()
    assert.ok([401, 403, 404].includes(response.status), JSON.stringify(response))
    assert.equal(f.blobs.size, 0)
    assert.equal((await f.db.listBundles()).length, 0)
  })
}

test('database authorization still rejects revocation during the blob write', async t => {
  const f = await fixture(t, { role: 'manage' })
  const put = f.bundleStore.put
  f.bundleStore.put = async (...args) => { await put(...args); await f.db.setUserRole(f.session.userId, 'view') }
  assert.equal((await f.send()).status, 403)
  assert.equal(f.blobs.size, 0)
  assert.equal((await f.db.listBundles()).length, 0)
})
