import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { templateText, templates } from './_lit.js'

// The Treemap of a directory too large to open, its files as its tree lists them.
const state = { managedSession: { id: 's', role: 'admin' } }
const requests = []
let answer = () => Promise.resolve(null)
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchRepositoryTree: (...args) => {
    requests.push(args.slice(0, 3))
    return answer(...args)
  },
} })
await import('../ui/view/repository-treemap.js')
const RepositoryTreemap = customElements.get('repository-treemap')
const BundleTreemap = customElements.get('bundle-treemap')

const commit = 'a'.repeat(40)
const shownAt = (path, at = commit) => Object.assign(new RepositoryTreemap(), { repository: { repoId: 7, repo: 'org/repo', commit: at, path } })
const treemapOf = view => templates(view.render()).find(template => template.strings.join('').includes('<bundle-treemap'))?.values.at(-1)

beforeEach(() => {
  requests.length = 0
  state.managedSession = { id: `s${Math.random()}`, role: 'admin' }
})

test('a directory too large to open is drawn from its files\' sizes as its tree lists them, none opening its source, read once a session', async () => {
  answer = () => Promise.resolve({ commit, path: 'vendor', files: ['vendor/react/index.js', 'vendor/react/lib/core.js', 'vendor/zod/index.js', 'vendor/zod/empty.js'],
    sizes: [1200, 30_000, 400, 0], cut: false })
  const view = shownAt('vendor')
  assert.match(templateText(view.render()), /role="status">Reading its files…</u)
  await setImmediate()
  assert.deepEqual(requests, [[7, 'vendor', commit]])
  const details = treemapOf(view)
  assert.deepEqual([...details.fileSizes], [['vendor/react/index.js', 1200], ['vendor/react/lib/core.js', 30_000], ['vendor/zod/index.js', 400], ['vendor/zod/empty.js', 0]])
  assert.equal(details.listedOnly, true)
  assert.doesNotMatch(templateText(view.render()), /nearest its root/u, 'none left out')
  // Drawn as a directory opened is, its common directory aside, each file a cell opening nothing.
  const treemap = Object.assign(new BundleTreemap(), { details })
  treemap._rebuild()
  assert.equal(treemap._status, 'ok')
  assert.deepEqual(treemap._meta, { total: 31_600, prefix: 'vendor/' })
  const leaves = []
  const walk = node => {
    for (const child of node.children?.values() ?? []) {
      if (child.isFile) leaves.push(child)
      else walk(child)
    }
  }
  walk(treemap._root)
  assert.deepEqual(leaves.map(leaf => [leaf.origPath, leaf.value, leaf.resource]).toSorted(),
    [['vendor/react/index.js', 1200, true], ['vendor/react/lib/core.js', 30_000, true], ['vendor/zod/index.js', 400, true]], 'an empty file no cell')
  // Kept: shown again, it isn't read again.
  shownAt('vendor').render()
  await setImmediate()
  assert.equal(requests.length, 1)
})

test('a listing GitHub cut short says the files drawn are those nearest its root', async () => {
  answer = () => Promise.resolve({ commit, path: '', files: ['a.js', 'b/c.js'], sizes: [10, 20], cut: true })
  const view = shownAt('')
  view.render()
  await setImmediate()
  assert.match(templateText(view.render()), /<p class="history-note">Only the 2 files nearest its root are drawn\.<\/p>/u)
})

test('a tree that can\'t be read says why, and reads again on Retry', async () => {
  answer = () => Promise.resolve({ commit, path: 'vendor', files: null, sizes: null, cut: false })
  const view = shownAt('vendor')
  view.render()
  await setImmediate()
  assert.match(templateText(view.render()), /<p role="alert">GitHub has no files at this commit\.<\/p>/u)
  answer = () => Promise.reject(Object.assign(new Error('GitHub couldn’t be reached.'), { code: 'github-unreachable' }))
  const failed = shownAt('vendor', 'b'.repeat(40))
  failed.render()
  await setImmediate()
  assert.match(templateText(failed.render()), /<p role="alert">GitHub couldn’t be reached\.<\/p>/u)
  answer = () => Promise.resolve({ commit, path: 'vendor', files: ['vendor/a.js'], sizes: [5], cut: false })
  templates(failed.render()).find(template => template.strings.join('').includes('Retry')).values[1]()
  failed.render()
  await setImmediate()
  assert.deepEqual([...treemapOf(failed).fileSizes], [['vendor/a.js', 5]])
  assert.equal(requests.length, 3)
  // An answer without sizes to draw by is none.
  answer = () => Promise.resolve({ commit, path: 'x', files: ['x/a.js'], cut: false })
  const sizeless = shownAt('x')
  sizeless.render()
  await setImmediate()
  assert.match(templateText(sizeless.render()), /<p role="alert">The server answered with no files\.<\/p>/u)
})
