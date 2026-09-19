import assert from 'node:assert/strict'
import { beforeEach, it, mock } from 'node:test'
import { createBundleMetadata } from '../ui/view/bundle-metadata.js'

const json = { version: 3, sources: ['src/main.js'], sourcesContent: ['export default 1'], names: [] }
const entry = { integrity: 'sha512-test', name: 'test.map' }
const recorded = new Map(), state = { bundles: [entry] }, stored = new Map()
let readGate = null, reads = 0, renders = 0, saved = Promise.withResolvers(), writes = 0
mock.module('../client/index.js', { namedExports: {
  state, ensureBundleFindingsIndexed: async () => {}, hasBundleFileHashes: (key) => recorded.has(key),
  readBundle: async () => { reads++; if (readGate) await readGate; return new TextEncoder().encode(JSON.stringify(json)) },
  readBundleIndex: (key) => Promise.resolve(stored.get(key)),
  saveBundleIndex: (key, value) => { writes++; stored.set(key, value); saved.resolve(); return Promise.resolve() },
  recordBundleFileHashes: (key, hashes) => recorded.set(key, hashes),
} })
mock.module('../ui/view/render.js', { namedExports: { render: () => { renders++ } } })
mock.module('../ui/view/graph/state.js', { namedExports: { graph2: {} } })
const { buildBundleDetails, ensureBundleSources, openBundle, prefetchBundleHashes, selectBundle } = await import('../ui/view/bundle-load.js')
const index = await createBundleMetadata({ integrity: entry.integrity, kind: 'sourcemap', size: 123, json })
beforeEach(() => {
  stored.clear(); recorded.clear(); reads = 0; writes = 0; renders = 0; readGate = null
  saved = Promise.withResolvers()
  state.bundles = [entry]; selectBundle(entry.integrity)
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
  selectBundle(entry.integrity)
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
  assert.equal(stored.get(entry.integrity).version, 1)
  const metadata = await buildBundleDetails(entry.integrity, entry, { sources: false })
  assert.equal(metadata.metadataOnly, true)
  assert.equal(reads, 1)
})
