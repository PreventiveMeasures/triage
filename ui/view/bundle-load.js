// Shared async open-bundle pipeline, consolidated so error handling
// etc. live in one place. Every caller needs the same readBundle →
// branch by extension → JSON.parse / brotliDecompress → set
// bundleDetails + render → kick the SHA-512 file-hash index → kick
// the findings index flow: the sidebar bundle row click
// (`.file-item[data-bundle-integrity]` in sidebar.js), the
// finding-card "Code →" shortcut (`data-finding-code-bundle` in
// events.js), the `<bundle-compare>` swap button (`bundle-swap` in
// events.js), the bundle-only drop branch in `ingest.js`, and the
// boot-time `LAST_FILE_KEY` bundle restore in `view.js`.
import { Bundle } from '@exodus/stasis-core/bundle'
import { ensureBundleFindingsIndexed, hasBundleFileHashes, isManagedUiMode, readBundle, readBundleIndex, recordBundleFileHashes, saveBundleIndex, state } from '#client/index.js'
import { fetchBundleContents, fetchBundleMetadata } from './client-managed.js'
import { decodeUtf8 } from '../../common/utf8.js'
import { brotliDecompress } from './brotli-decompress.js'
import { graph2 } from './graph/state.js'
import { render } from './render.js'
import { beginViewNavigation, currentViewSignal } from './view-navigation.js'
import { bundleNeedsSources, computeBundleFileHashes, createBundleMetadata, parseBundleContents, parseBundleMetadata } from './bundle-metadata.js'

const sourceLoads = new Map()
const metadataLoads = new Map()
const hashLoads = new Map()
const sourceUpgrades = new WeakMap()

async function cachedMetadata(integrity) {
  try {
    const data = await readBundleIndex(integrity)
    return data ? parseBundleMetadata(data, integrity) : null
  } catch { return null }
}

// In-flight deduplication only: completed source bodies are owned by their
// active view, never retained in a process-wide preload/cache of bundles.
export function buildBundleDetails(integrity, entry, { sources = true } = {}) {
  if (!entry.managedId && isManagedUiMode()) return Promise.reject(new DOMException('Local bundle closed', 'AbortError'))
  const loads = sources ? sourceLoads : metadataLoads
  const kind = entry.name.toLowerCase().endsWith('.map') ? 'sourcemap' : 'stasis'
  const active = state.bundleDetails
  // Share the bundle already owned by the active view with finding source
  // links and comparison/code consumers, without retaining another bundle.
  if (active?.integrity === integrity && active.kind === kind && active.managedId === entry.managedId && !active.error
      && (!sources || !active.metadataOnly)) return Promise.resolve(active)
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
      if (cached?.kind === kind && !cached.stale) return cached
      return buildBundleDetails(integrity, entry)
    }
    const [details, cached] = await Promise.all([readBundleDetails(integrity, entry), cachedMetadata(integrity)])
    if (!details.error) {
      const current = cached?.kind === details.kind && !cached.stale
      if (current) {
        details.fileHashes = cached.fileHashes
        details.fileSizes = cached.fileSizes
        details.lineCounts = cached.lineCounts
      }
      // A stale index (an older version: see bundle-metadata.js) lends the
      // parsed bundle nothing — its sizes are what the Overview and Treemap
      // got wrong — and is rewritten after this explicit open, so later
      // metadata-only opens read the current one. Persistence is best-effort.
      if (!current) {
        createBundleMetadata(details).then((index) => saveBundleIndex(integrity, index)).catch(() => {})
      }
    }
    return details
  })()
  loads.set(key, { job, signal })
  job.finally(() => { if (loads.get(key)?.job === job) loads.delete(key) }).catch(() => {})
  return job
}

// Reset every per-bundle UI slot and make `integrity` the selected
// bundle on the bundles view. Shared by the sidebar bundle-row click,
// the bundle-only drop branch (ingest.js), the `bundle-swap` listener
// (events.js) and the boot restore (view.js) — each then persists /
// repaints / calls `openBundle` on its own. Keep the active detail tab
// between bundles; entering from another view starts on Overview. An explicit
// tab still takes priority for boot restore and Compare's swap action.
export function selectBundle(integrity, tab = state.currentView === 'bundles' ? state.bundleDetailsTab : 'overview') {
  beginViewNavigation()
  state.currentView = 'bundles'
  state.selectedBundle = integrity
  state.bundleDetails = null
  state.bundleSourceFile = null
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

// Read OPFS bytes, classify by entry name (`.map` → sourcemap, else
// → stasis), and parse into the `details` object the render path
// consumes. Errors (read fail, JSON parse fail, brotli fail) come
// back as a fallback shape rather than thrown — the caller assigns
// `state.bundleDetails` unconditionally; the render path shows a
// "failed to parse" placeholder when `details.error` is set.
//
// Sourcemap → `details.json` is the raw `.map` JSON. Stasis →
// `details.bundle` is an `@exodus/stasis-core` `Bundle` (handles v0 +
// v1 uniformly; .sources / .imports / .modules are Map-shaped).
//
// buildBundleDetails also exposes this to the focus view's inline code
// panel and Compare without touching `state.bundleDetails`.
async function readBundleDetails(integrity, entry) {
  try {
    const bytes = await readBundle(integrity)
    // Mode discovery/transition can finish while the local read is pending.
    // Never send those bytes into the Brotli decoder on the managed surface.
    if (isManagedUiMode()) throw new DOMException('Local bundle closed', 'AbortError')
    const isMap = entry.name.toLowerCase().endsWith('.map')
    const kind = isMap ? 'sourcemap' : 'stasis'
    try {
      if (isMap) {
        const json = JSON.parse(decodeUtf8(bytes))
        return { integrity, kind, size: bytes.byteLength, json }
      }
      // Stasis bundles are brotli-compressed JSON snapshots;
      // brotliDecompress dispatches native-or-fallback (see
      // view/brotli-decompress.js). Bundle.parse validates the
      // wrapper (version, scope, asserts on tampered shapes) and
      // normalizes both v0 and v1 layouts.
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

// Background SHA-512 hashing of every source file so the bundle
// graph + Issues tab can join findings by fileHash. No-op when
// neither parse slot landed (load failed). Caller has already set
// `state.bundleDetails` and rendered; this attaches `fileHashes`
// once it lands and re-renders. Stale resolves (user clicked another
// row mid-hash) drop silently.
function kickFileHashes(details) {
  if (details?.managedId || (!details?.json && !details?.bundle)) return
  if (details.fileHashes) { recordBundleFileHashes(details.integrity, details.fileHashes); return }
  ;(async () => {
    try {
      const fileHashes = await computeBundleFileHashes(details)
      // Cross-bundle hash index always gets the result, even after
      // navigating away — the report-card's "Code →" lookup needs it
      // regardless of the bundle panel's visibility.
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
  if (hashLoads.has(integrity)) return hashLoads.get(integrity)
  const entry = (state.bundles ?? []).find((b) => b.integrity === integrity)
  if (!entry || entry.managedId) return Promise.resolve()
  const job = (async () => {
    const details = await cachedMetadata(integrity)
    if (!details?.json && !details?.bundle) return
    try {
      const fileHashes = await computeBundleFileHashes(details)
      recordBundleFileHashes(integrity, fileHashes)
    } catch {}
  })()
  hashLoads.set(integrity, job)
  job.finally(() => { if (hashLoads.get(integrity) === job) hashLoads.delete(integrity) }).catch(() => {})
  return job
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

// Full open-bundle pipeline. Caller owns the pre-load state setup
// (selectedBundle, bundleDetails=null, view slots like
// bundleDetailsTab / shownTriage / graph2.showAll) and the
// loading-state render(); this owns the parse + post-parse fan-out
// (set details + render, kick file hashes, kick the cross-report
// findings indexer). Bails silently when the entry is gone (bundle
// deleted in another tab between click and now).
//
// Stale resolves are dropped via `state.selectedBundle !== integrity`
// after each await, so a fast click into another bundle doesn't let
// the previous load clobber the new one's panel.
export async function openBundle(integrity) {
  const entry = (state.bundles ?? []).find((b) => b.integrity === integrity)
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
  if (sourceUpgrades.has(details)) return sourceUpgrades.get(details)
  const entry = (state.bundles ?? []).find((b) => b.integrity === details.integrity)
  if (!entry) return Promise.resolve(null)
  const job = buildBundleDetails(details.integrity, entry).then((full) => {
    if (state.bundleDetails !== details) return full
    if (full.error && details.managedId) {
      details.sourceError = full.error
      sourceUpgrades.delete(details)
      render()
      return null
    }
    if (!full.error) { full.fileHashes = details.fileHashes; full.fileSizes = details.fileSizes; full.lineCounts = details.lineCounts; full.codeStats = details.codeStats }
    state.bundleDetails = full
    render()
    return full
  }).catch(err => {
    sourceUpgrades.delete(details)
    if (err.name === 'AbortError') return null
    throw err
  })
  sourceUpgrades.set(details, job)
  return job
}
