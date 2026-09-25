import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { getPreviewRole, managedFetch, setPreviewRole } from '../client/managed/request.js'
import { probeSession, probeTeams, pushReportTriage } from '../client/managed/session.js'
import { fetchScanModels } from '../ui/view/scan-models.js'

afterEach(() => setPreviewRole(null))

function forbidNetwork(t) {
  return t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request') })
}

for (const role of ['admin', 'manage', 'triage', 'view', 'none']) {
  test(`fake ${role} login supplies its role identity without a server`, async (t) => {
    const network = forbidNetwork(t)
    setPreviewRole(role)
    assert.equal(getPreviewRole(), role)
    assert.deepEqual(await probeSession(), {
      id: `preview:${role}`, login: role, name: role[0].toUpperCase() + role.slice(1),
      avatarUrl: null, role, csrfToken: null,
    })
    assert.deepEqual(await probeTeams(), [])
    assert.equal(network.mock.callCount(), 0)
  })
}

test('admin preview supplies initial Manage data and models to the actual API consumers', async (t) => {
  const network = forbidNetwork(t)
  setPreviewRole('admin')
  const users = await (await managedFetch('/api/admin/users')).json()
  assert.equal(users.users[0].login, 'admin')
  assert.equal(users.users[0].name, 'Admin')
  for (const [path, field] of [
    ['teams', 'teams'], ['repositories?page=1', 'repositories'], ['reports', 'reports'],
    ['bundles', 'bundles'], ['history', 'history'],
  ]) {
    const res = await managedFetch(`/api/admin/${path}`)
    assert.equal(res.status, 200)
    assert.deepEqual((await res.json())[field], [])
  }
  const catalogue = await fetchScanModels(undefined, managedFetch)
  assert.ok(catalogue.models.length >= 10)
  assert.ok(catalogue.models.some(model => model.id === catalogue.defaultModel))
  assert.equal(network.mock.callCount(), 0)
})

test('changing the preview role immediately changes access', async (t) => {
  const network = forbidNetwork(t)
  for (const role of ['admin', 'manage', 'triage', 'view', 'none', 'admin']) {
    setPreviewRole(role)
    assert.equal((await probeSession()).role, role)
    assert.equal((await managedFetch('/api/admin/users')).status, role === 'admin' ? 200 : 403)
    assert.equal((await managedFetch('/api/admin/reports')).status, ['admin', 'manage'].includes(role) ? 200 : 403)
  }
  assert.equal(network.mock.callCount(), 0)
})

test('preview mutations and unknown routes never reach a real server; logout stays local', async (t) => {
  const network = forbidNetwork(t)
  setPreviewRole('admin')
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(managedFetch('/api/admin/reports', { method }), /Changes are not saved/u)
  }
  assert.equal(await pushReportTriage('real-report', { finding: { comment: 'fake' } }, 'real-token'), 0)
  assert.equal((await managedFetch('/api/reports/real-report')).status, 404)
  assert.equal((await managedFetch('/api/auth/logout', { method: 'POST' })).status, 200)
  assert.equal(network.mock.callCount(), 0)
})

test('invalid role leaves the current preview unchanged and an aborted request is rejected', async () => {
  setPreviewRole('admin')
  for (const value of ['', 'owner', 'Admin', undefined, {}, 1]) {
    assert.throws(() => setPreviewRole(value), /Unknown managed preview role/u)
    assert.equal(getPreviewRole(), 'admin')
  }
  await assert.rejects(managedFetch('/api/auth/session', { signal: AbortSignal.abort() }), { name: 'AbortError' })
})

test('clearing preview restores the real session; a fresh module has no fake login', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ user: { id: 'real', login: 'real-user', role: 'view' } })))
  setPreviewRole('admin')
  assert.equal((await probeSession()).login, 'admin')
  assert.equal(network.mock.callCount(), 0)
  const fresh = await import('../client/managed/request.js?fresh-preview-session')
  assert.equal(fresh.getPreviewRole(), null)
  setPreviewRole(null)
  assert.equal(getPreviewRole(), null)
  assert.equal((await probeSession()).login, 'real-user')
  assert.equal(network.mock.callCount(), 1)
})

test('a real response started before a preview transition cannot restore stale data', async (t) => {
  let resolve
  t.mock.method(globalThis, 'fetch', () => new Promise(done => { resolve = done }))
  const request = managedFetch('/api/auth/session')
  setPreviewRole('admin')
  setPreviewRole(null)
  resolve(Response.json({ user: { login: 'stale' } }))
  await assert.rejects(request, { name: 'AbortError' })
})

test('managed requests bypass the browser HTTP cache for all server data', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({})))
  for (const path of ['/api/auth/session', '/api/reports/id', '/api/reports/id/triage', '/api/admin/bundles']) {
    await managedFetch(path, { credentials: 'same-origin', cache: 'force-cache' })
  }
  for (const call of network.mock.calls) {
    assert.equal(call.arguments[1].cache, 'no-store')
    assert.equal(call.arguments[1].credentials, 'same-origin')
  }
})
