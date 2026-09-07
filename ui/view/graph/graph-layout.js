// `<graph-layout>` — shadow-DOM host for the dependency-graph view.
// Owns the chrome (left-panel / stage / right-panel three-column
// layout) plus the chips, toolbar, canvas, and right-panel slots.
//
// Public shape (set via Lit property syntax on the host):
//   .graph    — buildGraph(...) result; nodes/edges/packages
//   .options  — { hideAllFiles?, triageCounts?, extraTopRow? }
//
// Why shadow DOM: scopes the long `.graph2-*` selector set (~900
// lines in graph2.css) to this component instead of flooding the
// global cascade. The chip widgets (`<severity-chips>`,
// `<triage-filter>`) and triage-selector / toolbar-row chrome use
// classes from `styles/toolbar.css`; the per-severity count chips
// in the selection sidebar (`renderSevChips` → `.tree-count-chip`)
// come from `styles/tree-count-chip.css`. Both files are inlined
// into our shadow styles so those classes pick up the same styling
// they get elsewhere on the page.
//
// Refresh helpers (refreshGraph2Sidebar / refreshGraph2TopPkgs in
// render.js, the bundle siblings in render-bundle.js, dispatching
// into refreshSidebar / refreshTopPkgs in ui/graph.js) reach inside
// this component via
// `host.shadowRoot.querySelector(...)`. Same for
// `attachGraph2Interaction(host, ...)` which wires the canvas
// hover / pan / zoom on top of the rendered shadow DOM.
//
// Event handling: clicks on data-g2-* targets inside the shadow
// tree bubble out as composed events to the document-level
// delegate in events.js. The delegate walks `e.composedPath()`
// instead of relying on `e.target` (which gets retargeted to the
// host element when an event crosses the shadow boundary).
import { LitElement, html, unsafeCSS } from '../frontend-global.js'
import graph2CSS from './graph2.css'
import treeCountChipCSS from '../../styles/tree-count-chip.css'
import toolbarCSS from '../../styles/toolbar.css'
import { renderRightPanel, renderStage, renderTopBar } from './render.js'
import { installShadowTooltipListener } from '../tooltip.js'

class GraphLayout extends LitElement {
  static properties = {
    graph:   { attribute: false },
    options: { attribute: false },
  }

  static styles = [unsafeCSS(toolbarCSS), unsafeCSS(treeCountChipCSS), unsafeCSS(graph2CSS)]

  constructor() {
    super()
    this.graph = null
    this.options = {}
  }

  connectedCallback() {
    super.connectedCallback()
    // Topbar / zoom / selection controls in here carry `data-tooltip`;
    // the document-level handler can't see past this shadow boundary,
    // so the root gets its own listener. Idempotent, and it covers the
    // nested light-DOM chip elements (`<triage-filter>` and friends)
    // too — they live in this tree, so `closest` reaches this root.
    installShadowTooltipListener(this.renderRoot)
  }

  render() {
    if (!this.graph) return html``
    return html`<div class="graph2-layout">
      ${renderTopBar(this.graph, this.options)}
      ${renderStage(this.graph)}
      ${renderRightPanel()}
    </div>`
  }
}

customElements.define('graph-layout', GraphLayout)
