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
import sidebarListCSS from './sidebar-list.css'
import zoomControlsCSS from './zoom-controls.css'
import treeCountChipCSS from '../../styles/tree-count-chip.css'
import toolbarCSS from '../../styles/toolbar.css'
import { renderRightPanel, renderStage, renderTopBar } from './render.js'
import { installShadowTooltipListener } from '../tooltip.js'
import { graph2 } from './state.js'
import './dependency-matrix.js'
import '../mode-switch.js'

class GraphLayout extends LitElement {
  static properties = {
    graph:   { attribute: false },
    options: { attribute: false },
    matrixControls: { state: true },
    // Bundle Issues switch moved from the end of the first row to the
    // start of the issue row (see _placeIssues).
    issuesWrapped: { state: true },
  }

  static styles = [unsafeCSS(toolbarCSS), unsafeCSS(treeCountChipCSS), unsafeCSS(graph2CSS), unsafeCSS(sidebarListCSS), unsafeCSS(zoomControlsCSS)]

  constructor() {
    super()
    this.graph = null
    this.options = {}
    this.matrixControls = null
    this.issuesWrapped = false
    this._topbarObserver = null
    this._observedControls = null
    this._issuesWrapWidth = 0
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._topbarObserver?.disconnect()
    this._observedControls = null
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

  willUpdate(changed) {
    if (!this.options.showBundleLayouts || graph2.bundleLayout !== 'matrix') this.matrixControls = null
    // New first-row contents may make room for the Issues switch again.
    if (changed.has('graph') || changed.has('options') || changed.has('matrixControls')) this._issuesWrapWidth = 0
  }

  updated() {
    this.toggleAttribute('matrix', !!this.options.showBundleLayouts && graph2.bundleLayout === 'matrix')
    const controls = this.renderRoot.querySelector('.g2-topbar-controls')
    if (controls !== this._observedControls && typeof ResizeObserver === 'function') {
      this._topbarObserver ??= new ResizeObserver(() => this._placeIssues())
      this._topbarObserver.disconnect()
      if (controls) this._topbarObserver.observe(controls)
      this._observedControls = controls
    }
    this._placeIssues()
  }

  // The bundle Issues switch ends the first row while that row, switch
  // included, fits on one line. Otherwise it leads the issue row, where
  // the issue filters follow it. CSS can't move an item between rows, so
  // this measures: in the first row, whether the switch fell below the
  // first line; in the issue row, whether it would fit back, judged by the
  // base sizes the browser breaks lines by. A return is only tried on a
  // wider row than the last miss (or new row contents), so a misjudged fit
  // can't bounce the switch between rows.
  _placeIssues() {
    const controls = this.renderRoot.querySelector('.g2-topbar-controls')
    const issues = this.renderRoot.querySelector('.g2-issues-switch')
    if (!controls || !issues) return
    const width = controls.clientWidth
    if (!this.issuesWrapped) {
      if (belowFirstLine(controls, issues)) {
        this._issuesWrapWidth = width
        this.issuesWrapped = true
      }
    } else if (width > this._issuesWrapWidth && fitsOnFirstLine(controls, issues)) {
      this.issuesWrapped = false
    }
  }

  render() {
    if (!this.graph) return html``
    if (this.options.showBundleLayouts && graph2.bundleLayout === 'matrix') {
      return html`<div class="graph2-layout g2-matrix-layout">
        ${renderTopBar(this.graph, this.options, this.matrixControls, { issuesWrapped: this.issuesWrapped })}
        <dependency-matrix .graph=${this.graph} @matrix-controls-change=${(e) => { this.matrixControls = e.detail }}></dependency-matrix>
      </div>`
    }
    return html`<div class="graph2-layout">
      ${renderTopBar(this.graph, this.options, null, { issuesWrapped: this.issuesWrapped })}
      ${renderStage(this.graph)}
      ${renderRightPanel()}
    </div>`
  }
}

// The switch sits below the row's first line (whose first item, the
// layout tabs, is its tallest). Child elements that haven't rendered yet
// have no height and would read as stacked, so no verdict until both have
// a size; if the switch does wrap once they render, the row grows and the
// observer asks again.
function belowFirstLine(container, el) {
  const first = container.firstElementChild
  if (!first || first === el) return false
  const box = el.getBoundingClientRect(), firstBox = first.getBoundingClientRect()
  return box.height > 0 && firstBox.height > 0 && box.top >= firstBox.bottom - 1
}

// Would `el` fit at the end of the row's single line? Only when the row
// doesn't wrap without it; then sums its items at their base sizes (a
// growing item counts its flex basis) plus the gaps, the way the browser
// decides where lines break.
function fitsOnFirstLine(container, el) {
  const items = [...container.children]
  if (items.length === 0) return true
  const firstBottom = items[0].getBoundingClientRect().bottom
  const gap = parseFloat(getComputedStyle(container).columnGap) || 0
  let used = 0
  for (const item of items) {
    const box = item.getBoundingClientRect()
    if (box.top >= firstBottom - 1) return false
    const style = getComputedStyle(item)
    const basis = parseFloat(style.flexBasis)
    const width = parseFloat(style.flexGrow) > 0 && Number.isFinite(basis)
      ? Math.max(parseFloat(style.minWidth) || 0, Math.min(box.width, basis)) : box.width
    used += width + gap
  }
  return used + el.getBoundingClientRect().width <= container.clientWidth
}

customElements.define('graph-layout', GraphLayout)
