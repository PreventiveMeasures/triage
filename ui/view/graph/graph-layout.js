// `<graph-layout>` — shadow-DOM host for the dependency-graph view.
// Owns the chrome (left-panel / stage / right-panel three-column
// layout) plus the chips, toolbar, canvas, and right-panel slots.
//
// Public shape (set via Lit property syntax on the host):
//   .graph    — buildGraph(...) result; nodes/edges/packages
//   .options  — { hideAllFiles?, triageCounts?, extraTopRow? }
//
// Why shadow DOM: this keeps the long `.graph2-*` selector set
// (~900 lines in graph2.css) scoped to this component instead of
// flooding the global cascade. The chip widgets (`<severity-chips>`,
// `<triage-filter>`) and the triage-selector / toolbar-row chrome
// inside the topbar render with classes from styles/toolbar.css,
// so toolbar.css gets inlined into our shadow styles too — bloats
// the bundle by ~10KB (text-loaded once, shared by every instance)
// but means the chips inside our shadow tree pick up the same
// styling the findings tab uses without per-class duplication.
//
// Refresh helpers (refreshGraph2Sidebar / refreshGraph2TopPkgs /
// refreshGraph2FocusOverlay in render.js, and the bundle siblings
// in render-bundle.js) reach inside this component via
// `host.shadowRoot.querySelector(...)`. Same for
// `attachGraph2Interaction(host, ...)` which wires the canvas
// hover / pan / zoom on top of the rendered shadow DOM.
//
// Event handling: clicks on data-g2-* targets inside the shadow
// tree bubble out as composed events to the document-level
// delegate in events.js. The delegate walks `e.composedPath()`
// instead of relying on `e.target` (which gets retargeted to the
// host element when an event crosses the shadow boundary).
import { LitElement, html, unsafeCSS } from 'lit'
import graph2CSS from './graph2.css'
import toolbarCSS from '../../styles/toolbar.css'
import { renderRightPanel, renderStage, renderTopBar } from './render.js'

class GraphLayout extends LitElement {
  static properties = {
    graph:   { attribute: false },
    options: { attribute: false },
  }

  static styles = [unsafeCSS(toolbarCSS), unsafeCSS(graph2CSS)]

  constructor() {
    super()
    this.graph = null
    this.options = {}
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
