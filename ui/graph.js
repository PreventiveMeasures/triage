// Bundle/findings graph view — separate esbuild entry point so the
// `<graph-layout>` LitElement (with its ~37 KB of bundled shadow
// CSS), the canvas hover / pan / zoom logic, AND the
// selection-card / focus-overlay / top-packages templates don't
// land in the main view.js bundle. `ui/view/graph-attach.js`
// `await import('./graph.js')`s this module lazily the first time
// the graph view is shown.
//
// The side-effect import registers `customElements.define(
// 'graph-layout', …)` so the host element returned from
// `attachGraphLayout` is already upgraded by the time it lands in
// the DOM. `attachGraph2Interaction` is re-exported so the attach
// helper can wire the canvas in the same async cycle.
//
// `refreshSidebar` / `refreshTopPkgs` carry the per-click refresh
// logic (shadow-root querySelector + litRender(renderSelectionCard…)).
// Keeping the rendering bodies here holds the chunky templates
// (renderSelectionCard, renderFocusOverlay, renderTopPkgsBlock) out
// of the main bundle — the main-bundle refresh wrappers in
// render.js / render-bundle.js only do data-fetch + ctx assembly
// (which needs the `state` aggregator) and dispatch into us.

import { render as litRender } from './view/frontend-global.js'
import './view/graph/graph-layout.js'
import { renderFocusOverlay, renderSelectionCard, renderTopPkgsBlock } from './view/graph/render.js'
import { buildGraph } from './view/graph/data.js'

export { attachGraph2Interaction } from './view/graph/canvas.js'

// Cross-bundle sharing seam — re-export the lazy bundle's
// `_swapImpl` so the main-bundle attach helper can point our
// `graph2` proxy at the main bundle's live `_impl`. Without this
// swap, every lazy-side `graph2.X` write/read would touch a
// separate copy and the canvas would never see chip / severity /
// path-filter clicks coming from `events.js`. See
// `view/graph/state.js` for the proxy contract.
export { _swapImpl as _swapGraph2Impl } from './view/graph/state.js'

// Repaint the right-panel selection card + the top-right canvas
// drill-in overlay slot. Both depend on the same selection / solo /
// focus state (graph2 in view/graph/state.js), so they refresh
// together. Called by the main-bundle wrappers
// `refreshGraph2Sidebar` (render.js) / `refreshBundleGraphSidebar`
// (render-bundle.js), which compute `graph` + `ctx` from state.
export function refreshSidebar(prep, ctx) {
  const root = document.querySelector('graph-layout')?.shadowRoot
  if (!root) return
  const graph = buildGraphFromPrep(prep)
  const area = root.querySelector('#g2-selection-area')
  if (area) litRender(renderSelectionCard(graph, ctx), area)
  const focusSlot = root.querySelector('#g2-focus-overlay-slot')
  if (focusSlot) litRender(renderFocusOverlay(graph), focusSlot)
}

// Repaint just the right-panel Top-packages block — fires when
// the user flips the Issues / Files mini-tab so the canvas's rAF
// + hover state aren't torn down by a full render() cycle.
export function refreshTopPkgs(prep) {
  const root = document.querySelector('graph-layout')?.shadowRoot
  if (!root) return
  const block = root.querySelector('#g2-top-pkgs-block')
  if (!block) return
  litRender(renderTopPkgsBlock(buildGraphFromPrep(prep)), block)
}

// `prep` is the raw-inputs shape `buildGraph2Data` /
// `buildBundleGraphData` assemble from `state.reports` /
// `state.bundleDetails`. The `buildGraph(...)` call lives here so
// data.js stays out of the main bundle.
//
// `prep.options.pkgOf` (bundle-only) drives package classification
// at buildGraph time; `prep.strippedToOrig` (bundle-only) stamps
// each node's `origFile` so the selection card's "View source →"
// button can hand the unstripped path back to the source viewer.
export function buildGraphFromPrep(prep) {
  const graph = buildGraph(prep.treeData, prep.files, prep.ownCounts, prep.transitiveCounts,
    prep.severitySets, prep.colorSets, prep.fileFindings, prep.options)
  if (prep.strippedToOrig) {
    for (const n of graph.nodes) n.origFile = prep.strippedToOrig.get(n.file)
  }
  // Bundle-only "Packages" mode gate (3+ packages on the full
  // inventory; see buildBundleGraphData). Stamped on the graph so
  // the canvas can AND it with the `graph2.packagesView` toggle —
  // a toggle value persisted from another bundle can't flip a
  // 2-package (or findings-tab) graph into package mode.
  graph.canPackagesView = prep.canPackagesView ?? false
  return graph
}
