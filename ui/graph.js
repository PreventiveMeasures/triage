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
// logic that used to live in view/render.js + view/render-bundle.js
// (each one was a `document.querySelector('graph-layout').shadowRoot
// .querySelector('#…')` + `litRender(renderSelectionCard…)` pair).
// Moving the rendering bodies here keeps the chunky template
// functions (renderSelectionCard, renderFocusOverlay,
// renderTopPkgsBlock) out of the main bundle — the main-bundle
// refresh wrappers in render.js / render-bundle.js only handle the
// data-fetch + ctx assembly (which needs the `state` aggregator)
// and dispatch into the loaded module.

import { render as litRender } from 'lit'
import './view/graph/graph-layout.js'
import { renderFocusOverlay, renderSelectionCard, renderTopPkgsBlock } from './view/graph/render.js'

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
// drill-in overlay slot. Both surfaces depend on the same
// selection / solo / focus state (graph2 module-state in
// view/graph/state.js), so they refresh together. The wrappers in
// view/render.js (`refreshGraph2Sidebar`) and view/render-bundle.js
// (`refreshBundleGraphSidebar`) compute `graph` + `ctx` from main-
// bundle state and call us here — the rendering itself lands in
// this lazy bundle so its dependencies (graph/render.js + chunky
// per-card templates) stay out of view.js.
export function refreshSidebar(graph, ctx) {
  const root = document.querySelector('graph-layout')?.shadowRoot
  if (!root) return
  const area = root.querySelector('#g2-selection-area')
  if (area) litRender(renderSelectionCard(graph, ctx), area)
  const focusSlot = root.querySelector('#g2-focus-overlay-slot')
  if (focusSlot) litRender(renderFocusOverlay(graph), focusSlot)
}

// Repaint just the right-panel Top-packages block — fires when
// the user flips the Issues / Files mini-tab so the canvas's rAF
// + hover state aren't torn down by a full render() cycle.
export function refreshTopPkgs(graph) {
  const root = document.querySelector('graph-layout')?.shadowRoot
  if (!root) return
  const block = root.querySelector('#g2-top-pkgs-block')
  if (block) litRender(renderTopPkgsBlock(graph), block)
}
