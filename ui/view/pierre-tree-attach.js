// Lazy loader for the `<pierre-tree>` file-tree renderer.
// Mirrors the brotli / prism / terminal pattern: a runtime-string
// dynamic import keeps `@pierre/trees` (preact + the tree's own
// shadow-DOM virtualized renderer) out of the main view.js
// bundle. First call kicks the fetch; subsequent calls share the
// same promise so `pierre-trees.js` only downloads + parses once
// per session.
//
// `attachPierreTree(host, details)` is idempotent for a given
// host element: the inner `<pierre-tree>` instance is reused on
// re-render so the user's expand/collapse state and scroll
// position survive Lit-driven slot rebuilds. The function reads
// `state.bundleSourceFile` and `state.bundleCodeSearchQuery`
// directly — render-bundle.js doesn't have to thread inputs
// through, mirroring how `attachTerminal` reads
// `state.bundleDetails`.

import { state } from '#client/index.js'
import { bundleSourcesAsMap } from './bundle-sources.js'
import { SEVERITIES, stripCommonPathPrefix } from './format.js'
import { bundleFindingsByFile } from './render-bundle.js'

let loadPromise = null

function loadPierreTrees() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    // Path held in a variable so esbuild can't statically resolve
    // it — keeps `pierre-trees.js` (and the @pierre/trees runtime
    // it pulls) out of the main bundle. The browser resolves the
    // URL relative to the page, so this works at any deploy path.
    const path = './pierre-trees.js'
    try {
      return await import(path)
    } catch (err) {
      // Don't pin the module to a rejected promise — a transient
      // failure (offline at first attach, stale service-worker
      // cache, etc.) would otherwise make every future call
      // replay the same rejection. Reset so the next attach
      // retries the import from scratch.
      loadPromise = null
      throw err
    }
  })()
  return loadPromise
}

// Build the prefix-stripped paths the tree should render, the
// stripped → original map (so selection events can hand the
// original key back to `state.bundleSourceFile`, which is what
// `bundleSourcesAsMap` keys by), and the decoration map (per-file
// issue chip text + tooltip, keyed by the stripped path so the
// renderRowDecoration lookup matches `ctx.item.path`).
function buildInputs(details) {
  const sources = bundleSourcesAsMap(details)
  if (sources.size === 0) {
    return { paths: [], stripped: [], orig: new Map(), back: new Map(), decorations: new Map() }
  }
  const origPaths = [...sources.keys()].toSorted()
  const { stripped } = stripCommonPathPrefix(origPaths)
  // Two-way map so the selection callback (which receives a
  // stripped path) can resolve to the original key the rest of
  // the view code uses, and currentPath updates (which arrive as
  // original keys via `state.bundleSourceFile`) can find the
  // stripped key the tree knows about.
  const strippedFromOrig = new Map()
  const origFromStripped = new Map()
  for (let i = 0; i < origPaths.length; i++) {
    strippedFromOrig.set(origPaths[i], stripped[i])
    origFromStripped.set(stripped[i], origPaths[i])
  }
  // Per-file issue decorations — uses the existing fileHashes
  // index that the Code view already consults. Keyed by stripped
  // path so renderRowDecoration's `ctx.item.path` lookup hits.
  const decorations = new Map()
  if (details?.fileHashes) {
    const idx = bundleFindingsByFile(details.fileHashes, 'issues')
    for (let i = 0; i < origPaths.length; i++) {
      const findings = idx.get(origPaths[i])
      if (!findings || findings.length === 0) continue
      const count = findings.length
      const top = topSeverity(findings)
      decorations.set(stripped[i], {
        text: String(count),
        title: `${count} ${count === 1 ? 'issue' : 'issues'}${top ? ` (top: ${top.replaceAll('_', ' ')})` : ''}`,
      })
    }
  }
  return { paths: stripped, stripped, orig: strippedFromOrig, back: origFromStripped, decorations }
}

// Worst severity present on a set of findings — same precedence
// as the rest of the report (critical → low). Used to caption the
// row-decoration chip tooltip.
function topSeverity(findings) {
  const seen = new Set()
  for (const f of findings) if (f?.severity) seen.add(f.severity)
  for (const s of SEVERITIES) if (seen.has(s)) return s
  return null
}

// Wire selection events from the pierre-tree element onto
// `state.bundleSourceFile`. The element-level mapping (stripped
// → original) lives on a WeakMap so each element keeps its own
// back-map without leaking when the host is replaced.
const backMaps = new WeakMap()

function onSelect(el, e, render) {
  const back = backMaps.get(el)
  const stripped = e.detail?.path ?? null
  if (!stripped) {
    // null selection: clear the open source. Same shape as the
    // events.js close-details handlers.
    if (state.bundleSourceFile) {
      state.bundleSourceFile = null
      render()
    }
    return
  }
  const orig = back?.get(stripped) ?? stripped
  if (state.bundleSourceFile === orig) return
  state.bundleSourceFile = orig
  // Drop any open finding panel from a prior file; the new file's
  // findings may not match the previous index.
  state.bundleSourceFindingIdx = null
  render()
}

export async function attachPierreTree(host, details, render) {
  if (!host || !details) return null
  let mod
  try {
    mod = await loadPierreTrees()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    host.textContent = `File tree failed to load: ${msg}`
    return null
  }
  // Lit may have rebuilt the slot during the await; bail if our
  // target host is no longer in the document. The next render
  // will re-issue attachPierreTree against the new slot.
  if (!host.isConnected) return null
  const { paths, orig: strippedFromOrig, back, decorations } = buildInputs(details)
  const stripped = state.bundleSourceFile
    ? strippedFromOrig.get(state.bundleSourceFile) ?? null
    : null
  const query = state.bundleCodeSearchQuery ?? ''

  let el = host.firstElementChild
  if (!el || el.tagName !== 'PIERRE-TREE') {
    el = mod.createPierreTreeElement({
      decorations,
      paths,
      currentPath: stripped,
      query,
    })
    backMaps.set(el, back)
    el.addEventListener('pierre-tree-select', (e) => onSelect(el, e, render))
    host.replaceChildren(el)
  } else {
    // Reuse the existing tree so expand/collapse + scroll state
    // survive Lit slot rebuilds. Order matters: set decorations
    // first so the next paths reset picks up the fresh map; the
    // path setter triggers resetPaths internally.
    backMaps.set(el, back)
    el.decorations = decorations
    el.paths = paths
    el.currentPath = stripped
    el.query = query
  }
  return el
}
