import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import './_polyfills.js'
import { ManagedCreateBundle } from '../ui/managed/create-bundle.js'

const commit = 'a'.repeat(40)
const entries = [{ name: 'entry.ts', path: 'src/entry.ts', type: 'file' }]

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
