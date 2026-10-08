import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'

const assigned = []
globalThis.location = Object.assign(new URL('https://triage.test/manage/users'), { assign: path => { assigned.push(path) } })
globalThis.document = new EventTarget()
const { managedFetch } = await import('../client/managed/request.js')
const { probeSession, stopViewing, viewAs } = await import('../client/managed/session.js')

test('the session probe carries the admin viewing as another user', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({
    user: { id: 'viewed', login: 'viewed', name: 'Viewed', role: 'triage' }, csrfToken: 'view-csrf',
    viewer: { id: 'admin', login: 'admin', name: null },
  })))
  assert.deepEqual(await probeSession(), {
    id: 'viewed', login: 'viewed', name: 'Viewed', avatarUrl: null, role: 'triage', csrfToken: 'view-csrf',
    viewer: { id: 'admin', login: 'admin', name: null },
  })
  fetch.mock.mockImplementation(() => Promise.resolve(Response.json({ user: { id: 'admin', login: 'admin', role: 'admin' }, csrfToken: 'csrf' })))
  assert.equal(Object.hasOwn(await probeSession(), 'viewer'), false)
})

test('starting and ending a view reload into the resulting session', async t => {
  assigned.length = 0
  const requests = []
  const fetch = t.mock.method(globalThis, 'fetch', (url, init) => {
    requests.push({ url, method: init.method, csrf: new Headers(init.headers).get('x-csrf-token'), body: init.body })
    return Promise.resolve(new Response(null, { status: 204 }))
  })
  await viewAs('viewed', 'admin-csrf')
  await stopViewing('view-csrf')
  assert.deepEqual(requests, [
    { url: '/api/auth/view-as', method: 'POST', csrf: 'admin-csrf', body: JSON.stringify({ userId: 'viewed' }) },
    { url: '/api/auth/view-as', method: 'DELETE', csrf: 'view-csrf', body: undefined },
  ])
  assert.deepEqual(assigned, ['/', '/manage/users'])
  fetch.mock.mockImplementation(() => Promise.resolve(Response.json({ error: 'forbidden' }, { status: 403 })))
  await assert.rejects(viewAs('viewed', 'admin-csrf'), /HTTP 403/u)
  fetch.mock.mockImplementation(() => Promise.reject(new TypeError('offline')))
  await stopViewing('view-csrf')
  assert.deepEqual(assigned, ['/', '/manage/users', '/manage/users'], 'an ended view is cleared by the reload instead')
})

test('refused writes are announced whichever caller sent them, and still answer the caller', async t => {
  let announced = 0
  document.addEventListener('managed-view-only', () => { announced++ })
  t.mock.method(globalThis, 'fetch', url => Promise.resolve(Response.json({ error: url === '/forbidden' ? 'forbidden' : 'view-only' }, { status: 403 })))
  const refused = await managedFetch('/api/reports/r/triage', { method: 'POST', body: '{}' })
  assert.deepEqual(await refused.json(), { error: 'view-only' })
  await managedFetch('/forbidden', { method: 'DELETE' })
  await managedFetch('/api/teams')
  await setImmediate()
  assert.equal(announced, 1)
})
