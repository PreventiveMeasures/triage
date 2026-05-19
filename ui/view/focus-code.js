// Lazy, state-free source-code loader for the focus view's inline
// code panel. Given a focused finding, looks for a bundle whose
// fileHashes include the finding's file; loads the bundle (parse +
// brotli decompress) async; caches sources on first success;
// triggers a re-render when the load completes so the panel paints
// the code on the second pass.
//
// Deliberately does NOT touch `state.bundleDetails` /
// `state.selectedBundle` — those are owned by the bundles view's
// own selection flow, and clobbering them here would yank the user
// out of whatever bundle panel they had open. Each integrity gets a
// single in-flight load; subsequent calls during the load return
// `null` (loading) without retriggering.
import { bundlesForFileHash, state } from '#client/index.js'
import { activeTabFor } from './group.js'
import { buildBundleDetails } from './bundle-load.js'
import { bundleSourcesAsMap } from './bundle-sources.js'
import { langForPath, highlight as prismHighlight } from './prism-highlight.js'
import { render } from './render.js'

// integrity → { sources: Map<file, content> | null, loading: bool, error: string | null }
const sourcesCache = new Map()

// integrity\0file → highlighted HTML string, or null when prism
// can't highlight this language (caller renders plain text).
// Async populated; the first `getFocusCode` call kicks the work,
// subsequent calls pick up the cached result.
const highlightCache = new Map()
const highlightPending = new Set()

function kickHighlight(integrity, file, content) {
  const key = `${integrity}\0${file}`
  if (highlightCache.has(key) || highlightPending.has(key)) return
  const lang = langForPath(file)
  if (!lang) {
    highlightCache.set(key, null)
    return
  }
  highlightPending.add(key)
  ;(async () => {
    const html = await prismHighlight(content, lang)
    highlightCache.set(key, html ?? null)
    highlightPending.delete(key)
    state.focusCodeTick++
    queueMicrotask(render)
  })()
}

async function loadSources(integrity) {
  // Already loaded or in-flight — nothing to do. We intentionally
  // don't cache the "state.bundles hasn't listed this integrity"
  // path below: that list is populated asynchronously on first
  // sidebar render and may lag a focus-view click, so the next
  // render's call should be free to retry.
  const existing = sourcesCache.get(integrity)
  if (existing && (existing.loading || existing.sources)) return
  const entry = (state.bundles ?? []).find((b) => b.integrity === integrity)
  if (!entry) return
  sourcesCache.set(integrity, { sources: null, loading: true, error: null })
  try {
    const details = await buildBundleDetails(integrity, entry)
    const sources = bundleSourcesAsMap(details)
    sourcesCache.set(integrity, { sources, loading: false, error: details.error ?? null })
  } catch (err) {
    sourcesCache.set(integrity, { sources: null, loading: false, error: err.message })
  }
  // Defer to a fresh microtask so the render runs cleanly outside
  // the await-resolution stack. Without this, render() executes
  // mid-resolution chain and the parent template's Lit diff occasionally
  // commits before the focus-pane-code branch sees the new cache —
  // the panel stays on the "Loading…" frame until the next manual
  // render (navigation, filter change). queueMicrotask + a state
  // tick (so observer-util consumers in the page also re-flow)
  // robustly resolves both cases.
  state.focusCodeTick++
  queueMicrotask(render)
}

// Resolve a finding to its bundle source. Returns:
//   { content, file, integrity, line, highlighted, loading: false }
//      — ready: render the code panel.
//   { loading: true } — first load is in flight; render a
//      placeholder, the load will trigger render() on settle.
//   null — finding has no bundle code reference, or the bundle
//      doesn't contain this file.
//
// Reading triggers loadSources / kickHighlight as side-effects,
// which is fine inside render(): both deduplicate, and the
// resulting render() call is async (microtask) so it doesn't
// recurse into the current frame.
export function getFocusCode(focusedGroup) {
  if (!focusedGroup) return null
  const active = activeTabFor(focusedGroup)
  if (!active.fileHash || !Array.isArray(active._bundleHashes) || active._bundleHashes.length === 0) {
    return null
  }
  const allowed = new Set(active._bundleHashes)
  const match = bundlesForFileHash(active.fileHash).find(({ integrity }) => allowed.has(integrity))
  if (!match) return null
  const cached = sourcesCache.get(match.integrity)
  if (!cached) {
    // First sight of this integrity — kick the load and report
    // pending. The cache flips to loading:true synchronously inside
    // loadSources so a sibling getFocusCode on the same pass
    // doesn't double-fire.
    void loadSources(match.integrity)
    return { loading: true }
  }
  if (cached.loading) return { loading: true }
  if (!cached.sources) return null
  const content = cached.sources.get(match.file)
  if (typeof content !== 'string') return null
  // Kick Prism highlight if we haven't yet — render() runs again
  // when the highlighted HTML lands and the second pass picks it
  // up via highlightCache below.
  kickHighlight(match.integrity, match.file, content)
  const key = `${match.integrity}\0${match.file}`
  const highlighted = highlightCache.has(key) ? highlightCache.get(key) : undefined
  const lineNum = parseInt(active.line, 10)
  return {
    content,
    file: match.file,
    integrity: match.integrity,
    line: Number.isFinite(lineNum) ? lineNum : null,
    highlighted,
    loading: false,
  }
}
