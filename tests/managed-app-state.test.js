import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ManagedAppState } from '../ui/managed/state.js'

function pending() {
  let reject, resolve
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('cached data paints synchronously while a shared refresh updates it in the background', async () => {
  const state = new ManagedAppState()
  const original = { repos: ['first'] }
  await state.load('repos:connected', 'repositories', () => original)
  const refresh = pending()
  const seen = []
  const first = state.load('repos:connected', 'repositories', () => refresh.promise, { apply: value => seen.push(value) })
  assert.deepEqual(seen, [original])
  const second = state.load('repos:connected', 'repositories', () => assert.fail('duplicate request'))
  refresh.resolve({ repos: ['updated'] })
  await Promise.all([first, second])
  assert.deepEqual(seen, [original, { repos: ['updated'] }])
  assert.deepEqual(state.read('repos:connected'), { repos: ['updated'] })
})

test('failed shared refresh retains cached empty collections and emits one toast; retry works', async () => {
  const notices = []
  const state = new ManagedAppState(message => notices.push(message))
  await state.load('reports', 'reports', () => [])
  const refresh = pending()
  const first = state.load('reports', 'reports', () => refresh.promise)
  const second = state.load('reports', 'reports', () => assert.fail('duplicate request'))
  refresh.reject(new Error('HTTP 503'))
  await Promise.all([assert.rejects(first, /503/u), assert.rejects(second, /503/u)])
  assert.deepEqual(state.read('reports'), [])
  assert.deepEqual(notices, ["Couldn't refresh reports: HTTP 503"])
  await state.load('reports', 'reports', () => ['new'])
  assert.deepEqual(state.read('reports'), ['new'])
})

test('repository queries, scopes, pages, and detail ids keep independent values', async () => {
  const state = new ManagedAppState()
  const keys = ['repos:["connected","",1]', 'repos:["connected","",2]', 'repos:["connected","abc",1]', 'repos:["public","",1]', 'repo-impact:1', 'repo-impact:2']
  for (const key of keys) await state.load(key, key, () => [key])
  for (const key of keys) assert.deepEqual(state.read(key), [key])
})

test('identity and role changes clear cached data and reject late responses, token rotation preserves data', async () => {
  const notices = []
  const state = new ManagedAppState(message => notices.push(message))
  const admin = { id: 'a', role: 'admin', csrfToken: 'first' }
  state.setSession(admin)
  await state.load('users', 'users', () => ['private'])
  state.setSession({ ...admin, csrfToken: 'rotated' })
  assert.deepEqual(state.read('users'), ['private'])
  for (const session of [{ id: 'a', role: 'manage' }, { id: 'b', role: 'manage' }, null]) {
    const request = pending()
    let signal
    const loading = state.load('reports', 'reports', requestSignal => { signal = requestSignal; return request.promise }, { apply: () => assert.fail('late response') })
    state.setSession(session)
    assert.equal(state.resources.size, 0)
    assert.equal(signal.aborted, true)
    request.resolve(['stale']) // A transport may finish despite cancellation.
    await assert.rejects(loading, { name: 'AbortError' })
    assert.equal(state.resources.size, 0)
  }
  assert.deepEqual(notices, [])
})

test('mutations invalidate only related resources and prevent older reads from restoring them', async () => {
  const state = new ManagedAppState()
  await state.load('teams', 'teams', () => ['keep'])
  await state.load('reports', 'reports', () => ['old'])
  const request = pending()
  const oldRead = state.load('reports', 'reports', () => request.promise)
  await state.mutate(() => {}, ['reports', 'report-preview'])
  assert.deepEqual(state.read('teams'), ['keep'])
  assert.equal(state.read('reports'), undefined)
  await state.load('reports', 'reports', () => ['current'])
  request.resolve(['old'])
  await assert.rejects(oldRead, { name: 'AbortError' })
  assert.deepEqual(state.read('reports'), ['current'])
})

test('a failed mutation keeps the cache, while a mutation from a previous session cannot invalidate new data', async () => {
  const notices = []
  const state = new ManagedAppState(message => notices.push(message))
  state.setSession({ id: 'a', role: 'admin' })
  await state.load('teams', 'teams', () => ['old'])
  await assert.rejects(state.mutate(() => { throw new Error('HTTP 403') }, ['teams']), /403/u)
  assert.deepEqual(state.read('teams'), ['old'])
  assert.equal(notices.length, 1)
  const request = pending()
  const mutation = state.mutate(() => request.promise, ['teams'])
  state.setSession({ id: 'b', role: 'admin' })
  await state.load('teams', 'teams', () => ['new'])
  request.resolve()
  await assert.rejects(mutation, { name: 'AbortError' })
  assert.deepEqual(state.read('teams'), ['new'])
})
