import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import './_polyfills.js'
import { ManagedCreateBundle } from '../ui/managed/create-bundle.js'

const commit = 'a'.repeat(40)
const entries = [{ name: 'entry.ts', path: 'src/entry.ts', type: 'file' }]

test('the creation picker loads verified repositories and never selects a filtered-out initial repository', async t => {
  const calls = []
  const allowed = { repoId: 2, fullName: 'org/allowed' }
  t.mock.method(globalThis, 'fetch', url => {
    const path = new URL(url, 'https://test.invalid').pathname
    calls.push(path)
    return Promise.resolve(Response.json(path.endsWith('/browsable') ? { repos: [allowed] }
      : path.endsWith('/refs') ? { defaultBranch: 'main', branches: ['main'], tags: [] } : { commit, entries }))
  })
  const page = new ManagedCreateBundle()
  page.initialRepoId = 1
  assert.deepEqual(page._repos, [])
  await page.loadRepositories()
  assert.deepEqual(page._repos, [allowed])
  assert.equal(page._repoId, null)
  assert.deepEqual(calls, ['/api/admin/repositories/browsable'])
  page.initialRepoId = 2
  await page.loadRepositories()
  await setImmediate()
  assert.equal(page._repoId, 2)
  assert.deepEqual(page._entries, entries)
})

test('failed or cancelled repository authorization does not expose stale picker options', async t => {
  const page = new ManagedCreateBundle()
  page._repos = [{ repoId: 1, fullName: 'org/stale' }]
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({}, { status: 502 })))
  await page.loadRepositories()
  assert.deepEqual(page._repos, [])
  assert.match(page._reposError, /verify repository access/u)
  let finish
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { finish = resolve }))
  const loading = page.loadRepositories()
  page.disconnectedCallback()
  finish(Response.json({ repos: [{ repoId: 1, fullName: 'org/stale' }] }))
  await loading
  assert.deepEqual(page._repos, [])
})

test('selecting a repository browses its default branch and revision selections browse automatically', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', url => {
    const request = new URL(url, 'https://test.invalid')
    calls.push(request)
    return Promise.resolve(Response.json(request.pathname.endsWith('/refs')
      ? { defaultBranch: 'release', branches: ['develop', 'main'], tags: ['v1'] }
      : { commit, entries }))
  })
  const page = new ManagedCreateBundle()
  await page.selectRepository(1)
  await setImmediate()
  assert.equal(page._refKind, 'branch')
  assert.equal(page._refName, 'release')
  assert.equal(calls[1].searchParams.get('ref'), 'heads/release')
  assert.deepEqual(page._entries, entries)

  page.toggleFile('src/entry.ts')
  page.editRevision('develop')
  await setImmediate()
  assert.equal(calls[2].searchParams.get('ref'), 'heads/develop')
  assert.equal(page._selected.size, 0)
  page.selectRevisionType('tag')
  assert.equal(page._entries, null)
  page.editRevision('v1')
  await setImmediate()
  assert.equal(calls[3].searchParams.get('ref'), 'tags/v1')
  page.selectRevisionType('branch')
  await setImmediate()
  assert.equal(calls[4].searchParams.get('ref'), 'heads/release')
  page.toggleFile('src/entry.ts')
  page.selectRevisionType('branch')
  assert.equal(calls.length, 5)
  assert.equal(page._selected.size, 1)
})

test('typed revisions browse after a pause and pending browsing is cancelled when context changes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  t.mock.method(globalThis, 'fetch', url => {
    calls.push(new URL(url, 'https://test.invalid').searchParams.get('ref'))
    return Promise.resolve(Response.json({ commit, entries }))
  })
  const page = new ManagedCreateBundle()
  page._repoId = 1
  page.editRevision('feature/o')
  t.mock.timers.tick(300)
  page.editRevision('feature/one')
  t.mock.timers.tick(349)
  assert.equal(calls.length, 0)
  t.mock.timers.tick(1)
  await setImmediate()
  assert.deepEqual(calls, ['heads/feature/one'])

  page.selectRevisionType('commit')
  page.editRevision('abc')
  t.mock.timers.tick(350)
  assert.match(page._error, /commit SHA/u)
  assert.equal(calls.length, 1)
  page.editRevision(commit)
  t.mock.timers.tick(350)
  await setImmediate()
  assert.equal(calls[1], commit)

  page.editRevision('b'.repeat(40))
  await page.selectRepository(null)
  t.mock.timers.tick(350)
  assert.equal(calls.length, 2)
  page._repoId = 1
  page.editRevision('feature/two')
  page.selectRevisionType('tag')
  t.mock.timers.tick(350)
  assert.equal(calls.length, 2)
  page.editRevision('v2')
  page.disconnectedCallback()
  t.mock.timers.tick(350)
  assert.equal(calls.length, 2)
})

test('entry points persist across directories, requests use the pinned commit, and revision changes reset selection', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', url => {
    const query = new URL(url, 'https://test.invalid').searchParams
    calls.push(query)
    return Promise.resolve(Response.json({ commit, entries }))
  })
  const page = new ManagedCreateBundle()
  page._repoId = 1
  page.changeRevision('branch', 'feature/one')
  await page.loadDirectory('src')
  page.toggleFile('src/entry.ts')
  await page.loadDirectory('')
  assert.deepEqual([...page._selected], ['src/entry.ts'])
  assert.equal(calls[0].get('ref'), 'heads/feature/one')
  assert.equal(calls[1].get('ref'), commit)
  page.changeRevision('tag', 'v1')
  assert.equal(page._selected.size, 0)
  assert.equal(page._entries, null)
  await page.loadDirectory('')
  assert.equal(calls[2].get('ref'), 'tags/v1')
  page.changeRevision('commit', 'not-a-sha')
  await page.loadDirectory('')
  assert.match(page._error, /commit SHA/u)
  assert.equal(calls.length, 3)
})

test('late directory results and failures cannot overwrite a newer repository or revision', async t => {
  const pending = []
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((resolve, reject) => { pending.push({ resolve, reject, signal }) }))
  const page = new ManagedCreateBundle()
  page._repoId = 1
  page.changeRevision('branch', 'main')
  const old = page.loadDirectory('src')
  page.changeRevision('tag', 'v1')
  pending[0].resolve(Response.json({ commit, entries }))
  await old
  assert.equal(page._entries, null)
  assert.equal(page._commit, '')
  const newer = page.loadDirectory('')
  const repo = page.selectRepository(2)
  pending[1].reject(new Error('stale failure'))
  await newer
  pending[2].resolve(Response.json({ defaultBranch: 'develop', branches: ['develop'], tags: [] }))
  await repo
  await setImmediate()
  pending[3].resolve(Response.json({ commit: 'b'.repeat(40), entries: [] }))
  await setImmediate()
  assert.equal(page._repoId, 2)
  assert.equal(page._error, '')
  assert.equal(page._commit, 'b'.repeat(40))
  const detached = page.loadDirectory('src')
  page.disconnectedCallback()
  pending[4].resolve(Response.json({ commit, entries }))
  await detached
  assert.equal(page._entries, null)
})
