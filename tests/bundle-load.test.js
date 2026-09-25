import assert from 'node:assert/strict'
import { beforeEach, it, mock } from 'node:test'
import { createBundleMetadata } from '../ui/view/bundle-metadata.js'
import { beginViewNavigation } from '../ui/view/view-navigation.js'

const json = { version: 3, sources: ['src/main.js'], sourcesContent: ['export default 1'], names: [] }
const entry = { integrity: 'sha512-test', name: 'test.map' }
const recorded = new Map(), state = { bundles: [entry] }, stored = new Map()
let decodes = 0, indexReads = 0, managed = false, readGate = null, reads = 0, renders = 0, saved = Promise.withResolvers(), writes = 0
mock.module('../client/index.js', { namedExports: {
  isManagedUiMode: () => managed,
  state, ensureBundleFindingsIndexed: async () => {}, hasBundleFileHashes: (key) => recorded.has(key),
  readBundle: async () => { reads++; if (readGate) await readGate; return new TextEncoder().encode(JSON.stringify(json)) },
  readBundleIndex: (key) => { indexReads++; return Promise.resolve(stored.get(key)) },
  saveBundleIndex: (key, value) => { writes++; stored.set(key, value); saved.resolve(); return Promise.resolve() },
  recordBundleFileHashes: (key, hashes) => recorded.set(key, hashes),
} })
mock.module('../ui/view/render.js', { namedExports: { render: () => { renders++ } } })
mock.module('../ui/view/graph/state.js', { namedExports: { graph2: {} } })
mock.module('../ui/view/brotli-decompress.js', { namedExports: {
  brotliDecompress: () => { decodes++; throw new Error('unexpected local Brotli decode') },
} })
let contentFailure = false, contentRequests = 0, contentSignals = [], metadataRequests = 0
mock.module('../ui/view/client-managed.js', { namedExports: {
  fetchBundleMetadata: () => { metadataRequests++; return Promise.resolve(index) },
  fetchBundleContents: async (id, { signal }) => {
    contentRequests++; contentSignals.push(signal)
    signal.throwIfAborted()
    if (readGate) {
      await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        readGate.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      })
    }
    signal.throwIfAborted()
    if (contentFailure) throw new Error('offline')
    return JSON.stringify(json)
  },
} })
const { buildBundleDetails, ensureBundleSources, openBundle, prefetchBundleHashes, prefetchBundleHashesAfterPaint, selectBundle, selectBundleTab } = await import('../ui/view/bundle-load.js')
const index = await createBundleMetadata({ integrity: entry.integrity, kind: 'sourcemap', size: 123, json })
beforeEach(() => {
  decodes = 0; managed = false
  stored.clear(); recorded.clear(); indexReads = 0; reads = 0; writes = 0; renders = 0; readGate = null
  saved = Promise.withResolvers()
  metadataRequests = 0; contentRequests = 0; contentSignals = []; contentFailure = false
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


it('managed bundle metadata and deferred contents stay in memory without reading or writing local storage', async () => {
  managed = true
  state.bundles = [{ ...entry, managedId: 'managed-id', size: 123 }]
  await openBundle(entry.integrity)
  const metadata = state.bundleDetails
  assert.equal(metadata.metadataOnly, true)
  assert.equal(metadataRequests, 1)
  assert.equal(contentRequests, 0)
  assert.equal(indexReads, 0); assert.equal(reads, 0); assert.equal(writes, 0); assert.equal(recorded.size, 0)
  const first = ensureBundleSources(), second = ensureBundleSources()
  assert.equal(first, second)
  const full = await first
  assert.equal(full.managedId, 'managed-id')
  assert.deepEqual(full.json.sourcesContent, json.sourcesContent)
  assert.equal(full.codeStats, metadata.codeStats)
  assert.equal(contentRequests, 1)
  assert.equal(indexReads, 0); assert.equal(reads, 0); assert.equal(writes, 0)
  await ensureBundleSources()
  assert.equal(contentRequests, 1)
  assert.equal(decodes, 0)
})

it('managed mode cannot decode a leftover local bundle entry or reuse its parsed details', async () => {
  const local = { ...entry, name: 'test.stasis.code.br' }
  state.bundleDetails = { integrity: entry.integrity, kind: 'stasis', bundle: {} }
  managed = true
  for (const sources of [true, false]) {
    await assert.rejects(buildBundleDetails(entry.integrity, local, { sources }), { name: 'AbortError' })
  }
  assert.equal(reads, 0); assert.equal(indexReads, 0); assert.equal(decodes, 0)
})

it('switching into managed mode during a local bundle read prevents Brotli decoding', async () => {
  const gate = Promise.withResolvers(); readGate = gate.promise
  const loading = buildBundleDetails(entry.integrity, { ...entry, name: 'test.stasis.code.br' })
  managed = true
  gate.resolve()
  await assert.rejects(loading, { name: 'AbortError' })
  assert.equal(reads, 1); assert.equal(decodes, 0); assert.equal(writes, 0)
})

it('mode changes cancel bundle opens and source upgrades without unhandled rejections', async () => {
  for (const upgrade of [false, true]) {
    managed = false
    selectBundle(entry.integrity, 'code')
    if (upgrade) state.bundleDetails = { integrity: entry.integrity, metadataOnly: true }
    const gate = Promise.withResolvers(); readGate = gate.promise
    const loading = upgrade ? ensureBundleSources() : openBundle(entry.integrity)
    managed = true
    gate.resolve()
    await loading
  }
  assert.equal(decodes, 0); assert.equal(renders, 0)
})

it('a failed managed contents request keeps metadata and retries only when requested', async () => {
  state.bundles = [{ ...entry, managedId: 'managed-id', size: 123 }]
  await openBundle(entry.integrity)
  const metadata = state.bundleDetails
  contentFailure = true
  assert.equal(await ensureBundleSources(), null)
  assert.equal(state.bundleDetails, metadata)
  assert.equal(metadata.sourceError, 'offline')
  await ensureBundleSources()
  assert.equal(contentRequests, 1)
  delete metadata.sourceError
  contentFailure = false
  assert.equal((await ensureBundleSources()).metadataOnly, undefined)
  assert.equal(contentRequests, 2)
})

it('leaving a managed bundle aborts its source upgrade before the body finishes', async () => {
  state.bundles = [{ ...entry, managedId: 'managed-id', size: 123 }]
  await openBundle(entry.integrity)
  const gate = Promise.withResolvers(); readGate = gate.promise
  const pending = ensureBundleSources()
  selectBundle('another')
  assert.equal(contentSignals[0].aborted, true)
  assert.equal(await pending, null)
  assert.equal(state.bundleDetails, null)
  gate.resolve()
})

it('navigation aborts every managed source load, including the comparison target', async () => {
  const first = { ...entry, managedId: 'first' }, second = { ...entry, integrity: 'second', managedId: 'second' }
  const gate = Promise.withResolvers(); readGate = gate.promise
  const jobs = [buildBundleDetails(first.integrity, first), buildBundleDetails(second.integrity, second)]
  const rejected = jobs.map(job => assert.rejects(job, { name: 'AbortError' }))
  beginViewNavigation() // Home, Manage, report navigation, Back/Forward and mode transitions share this boundary.
  assert.ok(contentSignals.every(signal => signal.aborted))
  await Promise.all(rejected)
  assert.equal(renders, 0)
  gate.resolve()
})

it('immediately reopening a managed bundle starts a fresh download and still deduplicates consumers', async () => {
  const managedEntry = { ...entry, managedId: 'managed-id' }
  const gate = Promise.withResolvers(); readGate = gate.promise
  const abandoned = buildBundleDetails(entry.integrity, managedEntry)
  const rejected = assert.rejects(abandoned, { name: 'AbortError' })
  beginViewNavigation()
  readGate = null
  const reopened = buildBundleDetails(entry.integrity, managedEntry)
  assert.notEqual(reopened, abandoned)
  assert.equal(buildBundleDetails(entry.integrity, managedEntry), reopened)
  await rejected
  assert.deepEqual((await reopened).json.sourcesContent, json.sourcesContent)
  assert.equal(contentRequests, 2)
  assert.equal(contentSignals[1].aborted, false)
  gate.resolve()
})

it('every source-to-metadata tab transition aborts contents and retains metadata', async () => {
  state.bundles = [{ ...entry, managedId: 'managed-id', size: 123 }]
  for (const from of ['code', 'search', 'terminal', 'compare']) {
    for (const to of ['overview', 'graph', 'treemap', 'issues', 'advisories']) {
      selectBundle(entry.integrity, 'overview')
      await openBundle(entry.integrity)
      const metadata = state.bundleDetails
      selectBundleTab(from)
      const gate = Promise.withResolvers(); readGate = gate.promise
      const loading = ensureBundleSources()
      selectBundleTab(to)
      assert.equal(contentSignals.at(-1).aborted, true, `${from} -> ${to}`)
      assert.equal(await loading, null)
      assert.equal(state.bundleDetails, metadata)
      assert.equal(metadata.sourceError, undefined)
      gate.resolve(); readGate = null
    }
  }
})

it('an immediate source-tab return retries the same metadata and cannot inherit the cancelled upgrade', async () => {
  state.bundles = [{ ...entry, managedId: 'managed-id', size: 123 }]
  await openBundle(entry.integrity)
  selectBundleTab('code')
  const gate = Promise.withResolvers(); readGate = gate.promise
  const abandoned = ensureBundleSources()
  selectBundleTab('overview')
  selectBundleTab('code')
  const retry = ensureBundleSources()
  assert.notEqual(retry, abandoned)
  assert.equal(await abandoned, null)
  assert.equal(ensureBundleSources(), retry, 'the old rejection cannot remove the new pending upgrade')
  assert.equal(contentRequests, 2)
  gate.resolve()
  assert.deepEqual((await retry).json.sourcesContent, json.sourcesContent)
})

it('source tabs share a download and keep completed contents when returning to metadata', async () => {
  state.bundles = [{ ...entry, managedId: 'managed-id', size: 123 }]
  await openBundle(entry.integrity)
  const gate = Promise.withResolvers(); readGate = gate.promise
  selectBundleTab('code')
  const loading = ensureBundleSources()
  for (const tab of ['search', 'terminal', 'compare', 'code']) {
    selectBundleTab(tab)
    assert.equal(ensureBundleSources(), loading)
    assert.equal(contentSignals[0].aborted, false)
  }
  gate.resolve()
  const full = await loading
  selectBundleTab('overview')
  selectBundleTab('code')
  assert.equal(await ensureBundleSources(), full)
  assert.equal(contentRequests, 1)
})

it('closing a metadata source overlay aborts its download and clears the source selection', async () => {
  state.bundles = [{ ...entry, managedId: 'managed-id', size: 123 }]
  await openBundle(entry.integrity)
  const metadata = state.bundleDetails
  state.bundleSourceFile = 'src/main.js'
  state.bundleSourceFindingIdx = 1
  const gate = Promise.withResolvers(); readGate = gate.promise
  const loading = ensureBundleSources()
  selectBundleTab(state.bundleDetailsTab)
  assert.equal(contentSignals[0].aborted, true)
  assert.equal(await loading, null)
  assert.equal(state.bundleDetails, metadata)
  assert.equal(state.bundleSourceFile, null)
  assert.equal(state.bundleSourceFindingIdx, null)
  gate.resolve()
})
