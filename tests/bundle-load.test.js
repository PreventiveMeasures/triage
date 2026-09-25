import assert from 'node:assert/strict'
import { beforeEach, it, mock } from 'node:test'
import { createBundleMetadata } from '../ui/view/bundle-metadata.js'

const json = { version: 3, sources: ['src/main.js'], sourcesContent: ['export default 1'], names: [] }
const entry = { integrity: 'sha512-test', name: 'test.map' }
const recorded = new Map(), state = { bundles: [entry] }, stored = new Map()
let indexReads = 0, readGate = null, reads = 0, renders = 0, saved = Promise.withResolvers(), writes = 0
mock.module('../client/index.js', { namedExports: {
  state, ensureBundleFindingsIndexed: async () => {}, hasBundleFileHashes: (key) => recorded.has(key),
  readBundle: async () => { reads++; if (readGate) await readGate; return new TextEncoder().encode(JSON.stringify(json)) },
  readBundleIndex: (key) => { indexReads++; return Promise.resolve(stored.get(key)) },
  saveBundleIndex: (key, value) => { writes++; stored.set(key, value); saved.resolve(); return Promise.resolve() },
  recordBundleFileHashes: (key, hashes) => recorded.set(key, hashes),
} })
mock.module('../ui/view/render.js', { namedExports: { render: () => { renders++ } } })
mock.module('../ui/view/graph/state.js', { namedExports: { graph2: {} } })
const { buildBundleDetails, ensureBundleSources, openBundle, prefetchBundleHashes, prefetchBundleHashesAfterPaint, selectBundle } = await import('../ui/view/bundle-load.js')
const index = await createBundleMetadata({ integrity: entry.integrity, kind: 'sourcemap', size: 123, json })
beforeEach(() => {
  stored.clear(); recorded.clear(); indexReads = 0; reads = 0; writes = 0; renders = 0; readGate = null
  saved = Promise.withResolvers()
  state.bundles = [entry]; selectBundle(entry.integrity, 'overview')
})

it('does not preload source bundles for report hash lookups, even on cache misses', async () => {
  await prefetchBundleHashes(entry.integrity)
  assert.equal(reads, 0)
  assert.equal(recorded.size, 0)
  stored.set(entry.integrity, index)
  await prefetchBundleHashes(entry.integrity)
  assert.equal(reads, 0)
  assert.equal(recorded.get(entry.integrity).size, 1)
})

it('shares concurrent hash lookups so reports referencing one bundle parse its metadata once', async () => {
  stored.set(entry.integrity, index)
  const first = prefetchBundleHashes(entry.integrity)
  assert.equal(prefetchBundleHashes(entry.integrity), first)
  await first
  await prefetchBundleHashes(entry.integrity)
  assert.equal(indexReads, 1)
  assert.equal(reads, 0)
  assert.equal(recorded.get(entry.integrity).size, 1)
})

async function checkPrefetchAfterPaint(t, navigateAway) {
  const originalFrame = globalThis.requestAnimationFrame
  let frame
  globalThis.requestAnimationFrame = (cb) => { frame = cb }
  t.after(() => {
    if (originalFrame) globalThis.requestAnimationFrame = originalFrame
    else delete globalThis.requestAnimationFrame
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Even a cache miss must be attempted only once when many reports name
  // the same bundle; a successful hash cache cannot mask repeated reads.
  let current = true
  const job = prefetchBundleHashesAfterPaint([entry.integrity, entry.integrity], () => current)
  assert.equal(indexReads, 0)
  assert.equal(recorded.size, 0)
  frame()
  assert.equal(indexReads, 0, 'animation-frame callbacks run before paint; wait for the following task too')
  if (navigateAway) current = false
  t.mock.timers.tick(0)
  await job
  assert.equal(indexReads, navigateAway ? 0 : 1)
  assert.equal(reads, 0, 'deferred prefetch never loads a source bundle on a metadata miss')
}
it('defers and deduplicates report bundle metadata reads until after paint', (t) => checkPrefetchAfterPaint(t, false))
it('cancels deferred bundle metadata reads for an abandoned view', (t) => checkPrefetchAfterPaint(t, true))

it('opens metadata without reading the bundle, then shares an on-demand full-source upgrade', async () => {
  stored.set(entry.integrity, index)
  await openBundle(entry.integrity)
  const metadata = state.bundleDetails
  assert.equal(metadata.metadataOnly, true)
  assert.equal(reads, 0)
  assert.equal(recorded.get(entry.integrity), metadata.fileHashes)
  let release
  readGate = new Promise((resolve) => { release = resolve })
  const a = ensureBundleSources(), b = ensureBundleSources()
  assert.equal(a, b)
  release()
  const full = await a
  assert.equal(reads, 1)
  assert.equal(full.metadataOnly, undefined)
  assert.deepEqual(full.json.sourcesContent, json.sourcesContent)
  assert.equal(full.fileHashes, metadata.fileHashes)
  assert.equal(full.fileSizes, metadata.fileSizes)
  assert.equal(writes, 0, 'precomputed hashes are reused without rebuilding the index')
  assert.equal(state.bundleDetails, full)
  assert.equal(renders, 2)
  assert.equal(await buildBundleDetails(entry.integrity, entry), full)
  assert.equal(reads, 1, 'source links reuse the bundle already held by the active view')
  selectBundle('another')
  await buildBundleDetails(entry.integrity, entry)
  assert.equal(reads, 2, 'completed full bundles are not kept in a global cache')
})

it('source tabs load full bundles directly and stale upgrades cannot replace a new selection', async () => {
  stored.set(entry.integrity, index)
  for (const tab of ['terminal', 'code', 'search', 'compare']) {
    selectBundle(entry.integrity, tab)
    await openBundle(entry.integrity)
    assert.deepEqual(state.bundleDetails.json.sourcesContent, json.sourcesContent)
    assert.equal(state.bundleDetails.fileHashes.size, 1)
  }
  assert.equal(reads, 4)
  selectBundle(entry.integrity, 'overview')
  await openBundle(entry.integrity)
  let release
  readGate = new Promise((resolve) => { release = resolve })
  const upgrade = ensureBundleSources()
  selectBundle('another')
  release()
  await upgrade
  assert.equal(state.bundleDetails, null)
  assert.equal(state.selectedBundle, 'another')
})

it('a corrupt index falls back to parsing and regenerates a valid index after the explicit open', async () => {
  stored.set(entry.integrity, { ...index, version: -1 })
  const full = await buildBundleDetails(entry.integrity, entry, { sources: false })
  assert.deepEqual(full.json.sourcesContent, json.sourcesContent)
  assert.equal(reads, 1)
  // Let the asynchronous hash and best-effort persistence finish.
  await saved.promise
  assert.equal(stored.get(entry.integrity).version, 2)
  const metadata = await buildBundleDetails(entry.integrity, entry, { sources: false })
  assert.equal(metadata.metadataOnly, true)
  assert.equal(reads, 1)
})

it('an index from an older version is not served, lends nothing to the parse, and is rewritten on open', async () => {
  // A version 1 index whose sizes are wrong, as one written before #313 was.
  stored.set(entry.integrity, { ...index, version: 1, files: index.files.map(([path, , hash]) => [path, 999, hash]) })
  const full = await buildBundleDetails(entry.integrity, entry, { sources: false })
  assert.equal(full.metadataOnly, undefined, 'a stale index is not rendered')
  assert.equal(reads, 1)
  assert.equal(full.fileSizes, undefined, 'its sizes are not copied onto the parse')
  await saved.promise
  assert.equal(stored.get(entry.integrity).version, 2)
  assert.deepEqual(stored.get(entry.integrity).files, index.files)
  const metadata = await buildBundleDetails(entry.integrity, entry, { sources: false })
  assert.equal(metadata.metadataOnly, true)
  assert.equal(reads, 1)
})

it('keeps detail tabs between bundles and clears bundle-specific source/search state', () => {
  for (const tab of ['graph', 'code', 'search', 'terminal', 'treemap', 'issues', 'overview']) {
    selectBundle(entry.integrity, tab)
    state.bundleSourceFile = 'src/main.js'
    state.bundleCodeSearchQuery = 'old bundle'
    state.bundleSearchQuery = 'old search'
    selectBundle('second-bundle')
    assert.equal(state.bundleDetailsTab, tab)
    assert.equal(state.selectedBundle, 'second-bundle')
    assert.equal(state.bundleSourceFile, null)
    assert.equal(state.bundleCodeSearchQuery, '')
    assert.equal(state.bundleSearchQuery, '')
  }
})

it('resets to Overview after a non-bundle view, but honors explicit tab restores', () => {
  for (const view of ['findings', 'links', 'packages', 'repositories']) {
    selectBundle(entry.integrity, 'graph')
    state.currentView = view
    selectBundle('second-bundle')
    assert.equal(state.bundleDetailsTab, 'overview')
  }
  state.currentView = 'findings'
  selectBundle(entry.integrity, 'graph')
  assert.equal(state.bundleDetailsTab, 'graph', 'boot restores the saved tab')
  selectBundle('second-bundle', 'compare')
  assert.equal(state.bundleDetailsTab, 'compare', 'explicit navigation wins')
})
