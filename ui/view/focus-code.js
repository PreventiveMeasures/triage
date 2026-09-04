// Lazy, state-free source-code loader for the focus view's inline
// code panel. Given a focused finding, looks for a bundle whose
// fileHashes include the finding's file; loads the bundle (parse +
// brotli decompress) async; caches sources on first success;
// triggers a re-render when the load completes so the panel paints
// the code on the second pass.
//
// Deliberately does NOT touch `state.bundleDetails` /
// `state.selectedBundle` — those are owned by the bundles view's
// selection flow, and clobbering them would yank the user out of
// whatever bundle panel they had open. Each integrity gets a single
// in-flight load; calls during the load return `null` (loading)
// without retriggering.
import { bundlesForFileHash, state } from '#client/index.js'
import { activeTabFor } from './group.js'
import { buildBundleDetails } from './bundle-load.js'
import { bundleSourcesAsMap } from './bundle-sources.js'
import { historyFor } from './focus-code-history.js'
import { lineRange } from './format.js'
import { langForPath, highlight as prismHighlight } from './prism-highlight.js'
import { render } from './render.js'
import { report } from './dom.js'
import { revealCitedLines } from './reveal-cited.js'

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
  // Already loaded or in-flight — nothing to do. Intentionally don't
  // cache the "state.bundles hasn't listed this integrity" miss below:
  // that list populates asynchronously on first sidebar render and may
  // lag a focus-view click, so the next render's call should retry.
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
  // Defer to a fresh microtask so render runs outside the await-
  // resolution stack. Run mid-chain, the parent template's Lit diff
  // occasionally commits before the focus-pane-code branch sees the
  // new cache, leaving the panel on "Loading…" until the next manual
  // render (navigation, filter change). The state tick also re-flows
  // observer-util consumers on the page.
  state.focusCodeTick++
  queueMicrotask(render)
  // Scroll the cited lines into view after the render above commits
  // them. setFocusGid tries this right after its own render(), but on
  // a cache miss the panel isn't painted yet and the elements don't
  // exist. A second microtask (FIFO after the render above) retries
  // once the content has landed.
  queueMicrotask(revealFocusCodeLines)
}

// Bring the cited lines into view in the focus panel's code body.
// `.focus-code-body` is the box that scrolls; the rule for where the
// block lands in it is shared with the card's previews (see
// reveal-cited.js).
export function revealFocusCodeLines() {
  const rows = report.querySelectorAll('.focus-code-line-active')
  if (rows.length === 0) return
  revealCitedLines(rows[0].closest('.focus-code-body'), rows)
}

// The bundle attached to a finding, as `{ integrity, file }`, or null.
// "Attached" means the analyzer ran against a bundle (`_bundleHashes`,
// stamped at ingest) that carries a source with this finding's
// `fileHash` — so the match is by CONTENT, not by path, and the `file`
// it comes back with is that bundle's own key for it.
//
// The one definition of the question "do we have this finding's code",
// asked by the focus view's inline panel, the card's `Code` shortcut,
// and the source previews beside its links.
export function attachedBundle(f) {
  const allowed = f?._bundleHashes
  if (!f?.fileHash || !Array.isArray(allowed) || allowed.length === 0) return null
  // `includes` over a Set: a finding names the one or two bundles the
  // analyzer saw, and this runs twice per card on every render of a
  // list that can be thousands long — building a Set to ask about two
  // strings costs more than the scan it saves.
  return bundlesForFileHash(f.fileHash).find(({ integrity }) => allowed.includes(integrity)) ?? null
}

// One file out of a bundle. Returns:
//   { content, highlighted, loading: false } — ready to render.
//      `highlighted` is the prism HTML, `null` for a language the
//      bundle carries no grammar for, `undefined` until it settles.
//   { loading: true } — first load in flight; the load triggers
//      render() on settle, so a caller renders a placeholder and
//      picks the content up on the next pass.
//   null — the bundle isn't one we can load, or has no such file.
//
// Reading triggers loadSources / kickHighlight as side-effects, which
// is safe inside render(): both deduplicate, and their follow-up
// render() is a microtask so it doesn't recurse this frame.
//
// `kick: false` asks what we ALREADY have, and answers null rather
// than starting a load. For a caller that renders one file per mark on
// a card and would otherwise pull a bundle off disk for every one of
// them before the reader has asked for any — see render-finding.js,
// where the hover tooltip peeks and the pointer does the kicking.
export function bundleSource(integrity, file, { kick = true } = {}) {
  const cached = sourcesCache.get(integrity)
  if (!cached) {
    if (!kick) return null
    // First sight of this integrity — kick the load and report
    // pending. The cache flips to loading:true synchronously inside
    // loadSources so a sibling call on the same pass doesn't double-fire.
    void loadSources(integrity)
    return { loading: true }
  }
  if (cached.loading && !kick) return null
  if (cached.loading) return { loading: true }
  if (!cached.sources) return null
  const content = cached.sources.get(file)
  if (typeof content !== 'string') return null
  // Kick Prism highlight if we haven't yet — render() runs again when
  // the highlighted HTML lands and the second pass picks it up.
  kickHighlight(integrity, file, content)
  const key = `${integrity}\0${file}`
  return {
    content,
    highlighted: highlightCache.has(key) ? highlightCache.get(key) : undefined,
    loading: false,
  }
}

// Where the panel starts for a finding: the active tab's own file,
// with the finding's lines marked.
//
// A RANGE, not a line: a report citing `20-30` means the span, and
// marking only line 20 hides what it was pointing at (format.js
// lineRange).
function focusCodeBase(focusedGroup) {
  if (!focusedGroup) return null
  const active = activeTabFor(focusedGroup)
  const match = attachedBundle(active)
  if (!match) return null
  return { integrity: match.integrity, file: match.file, range: lineRange(active.line) }
}

// The panel's history for the finding on screen, as state — the rules
// themselves are in focus-code-history.js, which knows nothing about
// state or the DOM and is where they are tested.
//
// Read-only, deliberately: this runs inside render(), where writing
// state would either be lost to observer-util's tracking or loop
// through it. Anything that MOVES the panel writes the state instead
// (events.js pushFocusCode / stepFocusCode).
export function focusCodeHistory(focusedGroup) {
  const base = focusCodeBase(focusedGroup)
  if (!base) return null
  return { base, ...historyFor(state.focusCodeStack, state.focusCodeAt, base) }
}

// Where the panel is right now, for a finding — the same answer
// `getFocusCode` draws, without the source behind it.
//
// For the evidence list, which marks the row the panel is on. It takes
// the active FINDING rather than the group because that is what the
// card has in hand, and the active tab is what the base is computed
// from either way.
export function focusCodePosition(f) {
  const match = attachedBundle(f)
  if (!match) return null
  const base = { integrity: match.integrity, file: match.file, range: lineRange(f?.line) }
  return historyFor(state.focusCodeStack, state.focusCodeAt, base).pos
}

// The focus view's inline code panel: whatever file the history says
// it is on, whole, with that position's lines marked. Same three
// answers as bundleSource above, plus the file / integrity / range the
// panel's header and gutter need.
export function getFocusCode(focusedGroup) {
  const history = focusCodeHistory(focusedGroup)
  if (!history) return null
  const { pos } = history
  const source = bundleSource(pos.integrity, pos.file)
  if (!source || source.loading) return source
  return { ...source, file: pos.file, integrity: pos.integrity, range: pos.range }
}
