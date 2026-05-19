// Bundle/findings graph view — separate esbuild entry point so the
// `<graph-layout>` LitElement (with its ~37 KB of bundled shadow
// CSS) and the canvas hover / pan / zoom logic don't land in the
// main view.js bundle. `ui/view/graph-attach.js` `await import(
// './graph.js')`s this module lazily the first time the graph
// view is shown.
//
// The side-effect import registers `customElements.define(
// 'graph-layout', …)` so the host element returned from
// `attachGraphLayout` is already upgraded by the time it lands in
// the DOM. `attachGraph2Interaction` is re-exported so the attach
// helper can wire the canvas in the same async cycle.

import './view/graph/graph-layout.js'
export { attachGraph2Interaction } from './view/graph/canvas.js'
