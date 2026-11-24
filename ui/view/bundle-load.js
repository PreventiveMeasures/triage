// Opening a bundle: read and parse it, set state.bundleDetails and render,
// then hash its files and index findings against them. One pipeline for the
// sidebar's bundle rows, a finding card's Code, Compare's swap, a bundle
// dropped (ingest.js) and the boot restore (view.js).
import { Bundle } from '@exodus/stasis-core/bundle'
import { ensureBundleFindingsIndexed, hasBundleFileHashes, isManagedUiMode, readBundle, readBundleIndex, recordBundleFileHashes, saveBundleIndex, state } from '#client/index.js'
import { fetchBundleContents, fetchBundleMetadata } from './client-managed.js'
import { decodeUtf8 } from '../../common/utf8.js'
import { brotliDecompress } from './brotli-decompress.js'
import { graph2 } from './graph/state.js'
import { render } from './render.js'
import { beginViewNavigation, currentViewSignal } from './view-navigation.js'
import { bundleNeedsSources, computeBundleFileHashes, createBundleMetadata, parseBundleContents, parseBundleMetadata } from '../../common/bundle-metadata.js'

// Loads in flight, each `{ job, signal }`: deduplicated while they run, as
// completed source bodies belong to their view, never to a cache of bundles.
const sourceLoads = new Map()
const metadataLoads = new Map()
const hashLoads = new Map()
const sourceUpgrades = new WeakMap()

function inFlight(loads, key, job, signal) {
  loads.set(key, { job, signal })
  job.finally(() => { if (loads.get(key)?.job === job) loads.delete(key) }).catch(() => {})
  return job
}

const bundleEntry = integrity => (state.bundles ?? []).find((b) => b.integrity === integrity)
const kindOf = entry => entry.name.toLowerCase().endsWith('.map') ? 'sourcemap' : 'stasis'

async function cachedMetadata(integrity) {
  try {
    const data = await readBundleIndex(integrity)
    return data ? parseBundleMetadata(data, integrity) : null
  } catch { return null }
}

// Parsed bundles handed to a swap's navigation: Compare holds both sides
// parsed, so neither the bundle the swap opens nor the one it then compares
// against needs reading and parsing again. Each is taken by its first use;
// the navigation (events.js `bundle-swap`) releases whatever is left once it
// settles, so a swap that is abandoned or fails keeps nothing in memory.
let handoff = null
export function handOffBundles(bundles) {
  const parsed = new Map(bundles.filter(details => details && !details.error).map(details => [details.integrity, details]))
  handoff = parsed.size > 0 ? { bundles: parsed } : null
  return handoff
}

export function releaseHandoff(held) {
  if (handoff === held) handoff = null
}

// A handed-over bundle, if `accept` takes it; it is then no longer held.
export function takeHandedOffBundle(integrity, accept = () => true) {
  const details = handoff?.bundles.get(integrity)
  if (!details || !accept(details)) return null
  handoff.bundles.delete(integrity)
  if (handoff.bundles.size === 0) handoff = null
  return details
}

// A bundle's details, with its sources or its metadata alone: the active
// view's own where it has them, or a swap's handed over, else read.
export function buildBundleDetails(integrity, entry, { sources = true } = {}) {
  if (!entry.managedId && isManagedUiMode()) return Promise.reject(new DOMException('Local bundle closed', 'AbortError'))
  const loads = sources ? sourceLoads : metadataLoads
  const kind = kindOf(entry)
  // The active view's details, or a swap's, where they are of this kind and bundle.
  const fits = details => details.kind === kind && details.managedId === entry.managedId && (!sources || !details.metadataOnly)
  const active = state.bundleDetails
  if (active?.integrity === integrity && fits(active) && !active.error) return Promise.resolve(active)
  const handed = takeHandedOffBundle(integrity, fits)
  if (handed) return Promise.resolve(handed)
  const key = `${entry.managedId ?? 'local'}:${integrity}:${kind}`
  const signal = entry.managedId && sources ? currentViewSignal() : undefined
  const pending = loads.get(key)
  if (pending && pending.signal === signal) return pending.job
  const job = (async () => {
    if (entry.managedId) {
      try {
        const details = sources
          ? parseBundleContents(await fetchBundleContents(entry.managedId, { signal }), { integrity, kind, size: entry.size })
          : parseBundleMetadata(await fetchBundleMetadata(entry.managedId), integrity)
        details.managedId = entry.managedId
        return details
      } catch (err) {
        if (err.name === 'AbortError') throw err
        return { integrity, kind, size: entry.size, managedId: entry.managedId, error: err.message }
      }
    }
    if (!sources) {
      const cached = await cachedMetadata(integrity)
      return cached?.kind === kind && !cached.stale ? cached : buildBundleDetails(integrity, entry)
    }
    const [details, cached] = await Promise.all([readBundleDetails(integrity, entry), cachedMetadata(integrity)])
    if (!details.error) {
      // A stale index (an older version: bundle-metadata.js) lends nothing,
      // its sizes being what the Overview and Treemap got wrong, and is
      // rewritten, best effort, for later metadata-only opens.
      if (cached?.kind === details.kind && !cached.stale) {
        details.fileHashes = cached.fileHashes
        details.fileSizes = cached.fileSizes
        details.lineCounts = cached.lineCounts
      } else {
        createBundleMetadata(details).then((index) => saveBundleIndex(integrity, index)).catch(() => {})
      }
    }
    return details
  })()
  return inFlight(loads, key, job, signal)
}

// Make `integrity` the selected bundle of the bundles view, every
// per-bundle slot reset; its callers persist, render and openBundle on their
// own. The detail tab carries between bundles, Overview from another view,
// an explicit `tab` first. From Code to Code, the file open (or asked for
// while the sources load) is asked for again: the Code view opens it where
// the bundle has the path, else makes its usual pick. `file` asks Code for
// one of its own (`{ path, line, endLine }`), as a source popup's Open in
// Code does.
export function selectBundle(integrity, tab = state.currentView === 'bundles' ? state.bundleDetailsTab : 'overview', { workspaceId = null, file = null } = {}) {
  const details = state.bundleDetails, request = state.bundleCodeFileRequest
  const pending = request?.bundle === state.selectedBundle && (!details || (details.metadataOnly === true && !details.sourceError))
  const carried = file?.path ?? (state.currentView === 'bundles' && state.bundleDetailsTab === 'code' && tab === 'code'
    ? state.bundleSourceFile ?? (pending ? request.path : null) : null)
  beginViewNavigation()
  state.currentView = 'bundles'
  state.selectedBundle = integrity
  state.selectedBundleWorkspace = workspaceId
  state.bundleDetails = null
  state.bundleSourceFile = null
  state.bundleCodeHistory = null
  state.bundleCodeFileRequest = carried ? { ...file, bundle: integrity, path: carried } : null
  state.bundleCompare = null
  state.bundleSourceFindingIdx = null
  state.bundleCodeSearchQuery = ''
  state.bundleCodeSearchMode = 'files'
  state.bundleSearchQuery = ''
  state.bundleSearchRegex = false
  state.bundleSearchCase = false
  state.bundleSearchContext = true
  state.bundleDetailsTab = tab ?? 'overview'
  graph2.showAll = true
  state.shownTriage = null
}

// Downloads carry between source tabs, cancelled (unfinished alone) on a
// return to metadata or the source overlay closed. Import links keep their
// source and history from Search into Code, and a source popup's Open in
// Code its finding panel too; Compare's other side stays.
export function selectBundleTab(tab, { preserveSource = false } = {}) {
  if (bundleNeedsSources(state.bundleDetailsTab, state.bundleSourceFile) && !bundleNeedsSources(tab, preserveSource ? state.bundleSourceFile : null)) beginViewNavigation()
  state.bundleDetailsTab = tab
  state.bundleCodeFileRequest = null
  if (!preserveSource) {
    state.bundleSourceFile = null
    state.bundleCodeHistory = null
    state.bundleSourceFindingIdx = null
  }
}

// A local bundle's OPFS bytes parsed into details: a sourcemap's `map` and
// header `json` (bundle-sourcemap.js), a Stasis bundle's `bundle`, an
// @exodus/stasis-core `Bundle` (v0 and v1 alike, its parts Maps). A failed
// read or parse comes back as `error`, which the view says.
async function readBundleDetails(integrity, entry) {
  try {
    const bytes = await readBundle(integrity)
    // Mode discovery can end while the read is pending: never send its bytes
    // into the Brotli decoder on the managed surface.
    if (isManagedUiMode()) throw new DOMException('Local bundle closed', 'AbortError')
    const kind = kindOf(entry)
    try {
      if (kind === 'sourcemap') return parseBundleContents(decodeUtf8(bytes), { integrity, kind, size: bytes.byteLength })
      // A brotli-compressed JSON snapshot; Bundle.parse validates its wrapper.
      const decoded = decodeUtf8(await brotliDecompress(bytes, () => !isManagedUiMode()))
      const bundle = Bundle.parse(decoded)
      return { integrity, kind, size: bytes.byteLength, bundle }
    } catch (err) {
      if (err.name === 'AbortError') throw err
      return { integrity, kind, size: bytes.byteLength, error: err.message }
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return { integrity, error: err.message, size: 0 }
  }
}

// Every source's SHA-512, hashed in the background, for the graph and the
// Issues tab to match findings by: attached to the details and rendered
// while they are still open.
function kickFileHashes(details) {
  if (details?.managedId || (!details?.json && !details?.bundle)) return
  if (details.fileHashes) { recordBundleFileHashes(details.integrity, details.fileHashes); return }
  ;(async () => {
    try {
      const fileHashes = await computeBundleFileHashes(details)
      // Recorded even after navigating away, for a finding card's Code.
      recordBundleFileHashes(details.integrity, fileHashes)
      if (state.bundleDetails !== details) return
      details.fileHashes = fileHashes
      render()
    } catch {}
  })()
}

// Report-driven lookups may read a saved index, but never preload/decompress
// an unopened source bundle. A cache miss waits for an explicit bundle open.
export function prefetchBundleHashes(integrity) {
  if (hasBundleFileHashes(integrity)) return Promise.resolve()
  if (hashLoads.has(integrity)) return hashLoads.get(integrity).job
  const entry = bundleEntry(integrity)
  if (!entry || entry.managedId) return Promise.resolve()
  const job = (async () => {
    const details = await cachedMetadata(integrity)
    if (!details?.json && !details?.bundle) return
    try {
      const fileHashes = await computeBundleFileHashes(details)
      recordBundleFileHashes(integrity, fileHashes)
    } catch {}
  })()
  return inFlight(hashLoads, integrity, job)
}

// Start only after the caller has rendered the complete view and the browser
// can paint it. A workspace often references the same bundle in many reports;
// parse each saved index once, and avoid a burst of concurrent metadata parses.
export async function prefetchBundleHashesAfterPaint(integrities, isCurrent = () => true) {
  const unique = new Set(integrities)
  if (unique.size === 0) return
  await new Promise((resolve) => {
    const afterFrame = () => setTimeout(resolve, 0)
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(afterFrame)
    else afterFrame()
  })
  for (const integrity of unique) {
    if (!isCurrent()) return
    await prefetchBundleHashes(integrity)
  }
}

// The open pipeline once its caller has selected the bundle (selectBundle)
// and rendered it loading: parse, set the details and render, hash its
// files, index findings. A bundle gone (deleted in another tab) or no
// longer selected once read is let be.
export async function openBundle(integrity) {
  const entry = bundleEntry(integrity)
  if (!entry) return
  let details
  try {
    details = await buildBundleDetails(integrity, entry, {
      sources: bundleNeedsSources(state.bundleDetailsTab, state.bundleSourceFile),
    })
  } catch (err) {
    if (err.name === 'AbortError') return
    throw err
  }
  if (state.selectedBundle !== integrity || (entry.managedId && !state.bundles.includes(entry))) return
  state.bundleDetails = details
  render()
  kickFileHashes(details)
  if (!entry.managedId) ensureBundleFindingsIndexed().catch(() => {})
}

// Upgrade metadata only when a body-consuming view is requested. Hashes and
// sizes survive the upgrade; rapid tab/source clicks share the same load.
export function ensureBundleSources(details = state.bundleDetails) {
  if (details?.sourceError) return Promise.resolve(null)
  if (!details?.metadataOnly) return Promise.resolve(details)
  const signal = details.managedId ? currentViewSignal() : undefined
  const pending = sourceUpgrades.get(details)
  if (pending && pending.signal === signal) return pending.job
  const entry = bundleEntry(details.integrity)
  if (!entry) return Promise.resolve(null)
  const job = buildBundleDetails(details.integrity, entry).then((full) => {
    signal?.throwIfAborted()
    if (state.bundleDetails !== details) return full
    if (full.error && details.managedId) {
      details.sourceError = full.error
      render()
      return null
    }
    if (!full.error) {
      full.fileHashes = details.fileHashes; full.fileSizes = details.fileSizes; full.lineCounts = details.lineCounts; full.codeStats = details.codeStats
      // A managed sourcemap's edges, read on the server with the parser the
      // client goes without.
      if (details.edges) full.edges = details.edges
    }
    state.bundleDetails = full
    render()
    return full
  }).catch(err => {
    if (err.name === 'AbortError') return null
    throw err
  })
  return inFlight(sourceUpgrades, details, job, signal)
}
