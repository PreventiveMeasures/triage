import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { listInstalledRepos } from '../server-managed/github-app.ts'
import { RepositoryDiscovery } from '../server-managed/repository-discovery.ts'

const config = {
  githubAppId: '1',
  githubAppPrivateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }),
}
const repositories = [
  { id: 1, full_name: 'Org/Public', private: false, visibility: 'public' },
  { id: 2, full_name: 'Org/Team', private: true, visibility: 'private' },
  { id: 3, full_name: 'Org/Other', private: true, visibility: 'private' },
]

function fixture() {
  const calls = []
  const state = { permissionStatus: 200, allowed: true, userStatus: 200 }
  const fetch = async (url, options) => {
    const path = new URL(url).pathname
    const token = options.headers.authorization
    calls.push({ path, token })
    await setImmediate()
    if (path === '/app/installations') return Response.json([{ id: 7 }])
    if (path === '/app/installations/7/access_tokens') return Response.json({ token: 'installation' })
    if (path === '/installation/repositories') return Response.json({ total_count: 3, repositories })
    if (path === '/user') return Response.json({ id: token === 'Bearer alice' ? 10 : 20, login: token === 'Bearer alice' ? 'alice-renamed' : 'bob' }, { status: state.userStatus })
    if (path === '/user/repos') return Response.json([{ id: 4, full_name: 'Org/Uninstalled', private: false, visibility: 'public' }, repositories[0]])
    if (path.includes('/collaborators/')) {
      assert.equal(token, 'Bearer installation')
      const alice = path.includes('/alice-renamed/')
      const access = state.allowed && path.includes(alice ? '/Team/' : '/Other/')
      return Response.json({ permission: access ? 'read' : 'none', role_name: access ? 'triage' : 'none', user: { id: alice ? 10 : 20 } }, { status: state.permissionStatus })
    }
    throw new Error(`Unexpected GitHub request: ${path}`)
  }
  let now = 1000
  return { calls, state, fetch, advance: () => { now += 60_001 }, directory: new RepositoryDiscovery(config, fetch, () => now) }
}
const names = listing => listing.repositories.map(repo => repo.fullName)

test('installed discovery checks effective GH access, isolates admins, and Show all skips user requests', async () => {
  const { directory, calls } = fixture()
  assert.deepEqual(names(await directory.list('installed', 'admin-a', 'alice')), ['Org/Public', 'Org/Team'])
  assert.deepEqual(names(await directory.list('installed', 'admin-b', 'bob')), ['Org/Other', 'Org/Public'])
  const beforeAll = calls.length
  assert.deepEqual(names(await directory.list('installed', 'admin-a', null, true)), ['Org/Other', 'Org/Public', 'Org/Team'])
  assert.equal(calls.length, beforeAll)
  assert.equal(calls.filter(call => call.path === '/app/installations').length, 1)
  assert.equal(calls.filter(call => call.path === '/user/repos').length, 0, 'installed scope skips unrelated public discovery')
  assert.ok(!calls.some(call => call.path.includes('/Public/collaborators/')), 'public repos are already readable')
})

test('search/page discovery coalesces and caches, expires, and refresh bypasses both catalogue and permissions', async () => {
  const { directory, calls, advance, state } = fixture()
  const [first, second] = await Promise.all([directory.list('installed', 'a', 'alice'), directory.list('installed', 'a', 'alice')])
  assert.deepEqual(first, second)
  const count = calls.length
  await directory.list('installed', 'a', 'alice')
  assert.equal(calls.length, count)
  assert.equal(calls.filter(call => call.path === '/user').length, 1)
  advance()
  await directory.list('installed', 'a', 'alice')
  assert.equal(calls.length, 2 * count)
  state.allowed = false
  assert.deepEqual(names(await directory.list('installed', 'a', 'alice', false, true)), ['Org/Public'])
  assert.equal(calls.length, 3 * count)
  // A credential change on the same managed account cannot reuse old results.
  state.allowed = true
  assert.deepEqual(names(await directory.list('installed', 'a', 'bob')), ['Org/Other', 'Org/Public'])
})

test('missing/stale login, denied permissions and GitHub errors never expose all private repos', async () => {
  const { directory, state } = fixture()
  const missing = await directory.list('installed', 'a', null)
  assert.deepEqual(names(missing), ['Org/Public'])
  assert.equal(missing.tokenMissing, true)
  state.userStatus = 401
  const stale = await directory.list('installed', 'a', 'alice')
  assert.deepEqual(stale, missing)
  state.userStatus = 200
  state.permissionStatus = 403
  await assert.rejects(directory.list('installed', 'a', 'alice'), /github-status-403/u)
  state.permissionStatus = 200
  assert.deepEqual(names(await directory.list('installed', 'a', 'alice')), ['Org/Public', 'Org/Team'], 'errors are not cached')
  state.permissionStatus = 404
  assert.deepEqual(names(await directory.list('installed', 'a', 'alice', false, true)), ['Org/Public'])
})

test('public discovery preserves the uninstalled-only list and caches both GitHub sources', async () => {
  const { directory, calls } = fixture()
  assert.deepEqual(names(await directory.list('public', 'a', 'alice')), ['Org/Uninstalled'])
  const count = calls.length
  await directory.list('public', 'a', 'alice')
  assert.equal(calls.length, count)
  assert.ok(!calls.some(call => call.path.includes('/collaborators/')))
})

test('permission lookup uses fresh identity and rejects a permission response for another account', async () => {
  const { fetch } = fixture()
  const directory = new RepositoryDiscovery(config, (url, options) => {
    if (new URL(url).pathname.includes('/collaborators/')) return Promise.resolve(Response.json({ permission: 'admin', user: { id: 999 } }))
    return fetch(url, options)
  })
  assert.deepEqual(names(await directory.list('installed', 'a', 'alice')), ['Org/Public'])
})

test('all installation pages are listed with bounded parallel installation work', async () => {
  const pages = []
  let active = 0
  let peak = 0
  const repos = await listInstalledRepos(config, async (url, options) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/app/installations') {
      const page = Number(parsed.searchParams.get('page'))
      pages.push(page)
      return Response.json(page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) : [{ id: 101 }])
    }
    if (parsed.pathname.endsWith('/access_tokens')) {
      active++
      peak = Math.max(peak, active)
      await setImmediate()
      return Response.json({ token: parsed.pathname.split('/')[3] })
    }
    const id = Number(options.headers.authorization.slice('Bearer '.length))
    await setImmediate()
    active--
    return Response.json({ total_count: 1, repositories: [{ id, full_name: `Org/Repo${id}` }] })
  })
  assert.deepEqual(pages, [1, 2])
  assert.equal(repos.length, 101)
  assert.equal(peak, 4)
})

test('internal and unknown visibility require permission checks even with private=false', async () => {
  const { fetch, state } = fixture()
  const extra = [
    { id: 11, full_name: 'Org/InternalAllowed', private: false, visibility: 'internal' },
    { id: 12, full_name: 'Org/InternalDenied', private: false, visibility: 'internal' },
    { id: 13, full_name: 'Org/Unknown', private: false },
    { id: 14, full_name: 'Org/Unexpected', private: false, visibility: 'unexpected' },
  ]
  const checked = []
  const directory = new RepositoryDiscovery(config, (url, options) => {
    const path = new URL(url).pathname
    if (path === '/installation/repositories') return Promise.resolve(Response.json({ total_count: 7, repositories: [...repositories, ...extra] }))
    if (extra.some(repo => path.startsWith(`/repos/${repo.full_name}/collaborators/`))) {
      checked.push(path)
      assert.equal(options.headers.authorization, 'Bearer installation')
      return Promise.resolve(Response.json({ permission: path.includes('/InternalAllowed/') ? 'read' : 'none', user: { id: 10 } }))
    }
    if (path === '/user/repos') return Promise.resolve(Response.json([...extra, { id: 15, full_name: 'Org/UserPublic', private: false, visibility: 'public' }]))
    return fetch(url, options)
  })
  assert.deepEqual(names(await directory.list('installed', 'a', 'alice')), ['Org/InternalAllowed', 'Org/Public', 'Org/Team'])
  assert.equal(checked.length, 4, 'internal, missing and unrecognized visibility all get checked')
  assert.deepEqual(names(await directory.list('installed', 'a', null)), ['Org/Public'])
  state.userStatus = 401
  assert.deepEqual(names(await directory.list('installed', 'a', 'expired-token')), ['Org/Public'])
  const all = await directory.list('installed', 'a', null, true)
  assert.equal(all.repositories.length, 7, 'explicit Show all still includes internal repositories')
  assert.equal(all.repositories.find(repo => repo.id === 11).visibility, 'internal', 'parsing preserves visibility')
  assert.equal(all.repositories.find(repo => repo.id === 13).visibility, null)
  state.userStatus = 200
  // None of the nonpublic user repos are installed in this fixture response.
  // Public discovery still requires explicit public visibility.
  const publicDirectory = new RepositoryDiscovery(config, (url, options) => {
    if (new URL(url).pathname === '/user/repos') return Promise.resolve(Response.json([...extra, { id: 15, full_name: 'Org/UserPublic', private: false, visibility: 'public' }]))
    return fetch(url, options)
  })
  assert.deepEqual(names(await publicDirectory.list('public', 'a', 'alice')), ['Org/UserPublic'])
})

for (const failure of [401, 403, 429, 503, 'network', 'malformed']) {
  test(`public discovery survives installation failure (${failure}) and retries after recovery`, async (t) => {
    const { fetch, calls } = fixture()
    t.mock.method(console, 'warn', () => {})
    let broken = true
    let installationAttempts = 0
    const directory = new RepositoryDiscovery(config, (url, options) => {
      if (new URL(url).pathname === '/app/installations') {
        installationAttempts++
        if (broken) {
          if (failure === 'network') return Promise.reject(new Error('unreachable'))
          if (failure === 'malformed') return Promise.resolve(Response.json({ invalid: true }))
          return Promise.resolve(Response.json({ message: 'unavailable' }, { status: failure }))
        }
      }
      return fetch(url, options)
    })
    const fallback = await directory.list('public', 'a', 'alice')
    assert.equal(fallback.tokenMissing, false, 'installation failures do not invalidate the user login')
    assert.deepEqual(names(fallback), ['Org/Public', 'Org/Uninstalled'])
    assert.equal(installationAttempts, 1)
    broken = false
    const recovered = await directory.list('public', 'a', 'alice')
    assert.deepEqual(names(recovered), ['Org/Uninstalled'], 'installation deduplication recovers without waiting for cache expiry')
    assert.equal(installationAttempts, 2)
    assert.equal(calls.filter(call => call.path === '/user/repos').length, 1, 'healthy user repos stay cached')
  })
}

test('public discovery still surfaces user-repository failures independently of installation discovery', async (t) => {
  const { fetch } = fixture()
  t.mock.method(console, 'warn', () => {})
  let userStatus = 403
  const directory = new RepositoryDiscovery(config, (url, options) => {
    const path = new URL(url).pathname
    if (path === '/app/installations') return Promise.resolve(Response.json({}, { status: 503 }))
    if (path === '/user/repos') return Promise.resolve(Response.json({}, { status: userStatus }))
    return fetch(url, options)
  })
  await assert.rejects(directory.list('public', 'a', 'alice'), /github-status-403/u)
  userStatus = 401
  assert.deepEqual(await directory.list('public', 'a', 'alice'), { repositories: [], tokenMissing: true })
})
