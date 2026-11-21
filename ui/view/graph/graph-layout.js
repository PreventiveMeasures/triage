// `<graph-layout>`: the graph view's shadow-DOM host (`.graph` a buildGraph
// result, `.options` the topbar's), composing the topbar, the stage or the
// Matrix / Size flow element, and the right panel. The shadow root scopes
// graph2.css; the toolbar and tree-count-chip sheets are inlined so their
// shared classes style alike in here. The refresh helpers (ui/graph.js) and
// attachGraph2Interaction reach into the shadow root; clicks on data-g2-*
// targets reach events.js's document delegate, which reads composedPath()
// since the shadow boundary retargets `e.target`.
import { LitElement, html, unsafeCSS } from 'lit'
import graph2CSS from './graph2.css'
import sidebarListCSS from './sidebar-list.css'
import zoomControlsCSS from './zoom-controls.css'
import treeCountChipCSS from '../../styles/tree-count-chip.css'
import toolbarCSS from '../../styles/toolbar.css'
import { renderRightPanel, renderStage, renderTopBar } from './render.js'
import { installShadowTooltipListener } from '../tooltip.js'
import { graph2 } from './state.js'
import './dependency-matrix.js'
import './size-flow.js'
import '../mode-switch.js'

// The layouts `<size-flow>` draws: Size flow and Package flow.
const FLOW_LAYOUTS = new Set(['flow', 'package-flow'])

class GraphLayout extends LitElement {
  static properties = {
    graph:   { attribute: false },
    options: { attribute: false },
    matrixControls: { state: true },
    flowControls: { state: true },
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
    this.flowControls = null
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

  // The bundle layout drawn, if this is a bundle graph.
  get layout() { return this.options.showBundleLayouts ? graph2.bundleLayout : null }

  willUpdate(changed) {
    if (this.layout !== 'matrix') this.matrixControls = null
    if (!FLOW_LAYOUTS.has(this.layout)) this.flowControls = null
    // New first-row contents may make room for the Issues switch again.
    if (changed.has('graph') || changed.has('options') || changed.has('matrixControls') || changed.has('flowControls')) this._issuesWrapWidth = 0
  }

  updated() {
    this.toggleAttribute('matrix', this.layout === 'matrix')
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
    const topBar = (controls) => renderTopBar(this.graph, this.options, controls, { issuesWrapped: this.issuesWrapped })
    if (FLOW_LAYOUTS.has(this.layout)) {
      // Package flow is Size flow's chart weighed in packages, always at
      // package altitude.
      const counts = this.layout === 'package-flow'
      return html`<div class="graph2-layout">
        ${topBar(this.flowControls)}
        <size-flow .graph=${this.graph} .packages=${counts || graph2.flowPackagesView} .metric=${counts ? 'count' : 'size'}
          @flow-controls-change=${e => { this.flowControls = e.detail }}></size-flow>
      </div>`
    }
    if (this.layout === 'matrix') {
      return html`<div class="graph2-layout g2-matrix-layout">
        ${topBar(this.matrixControls)}
        <dependency-matrix .graph=${this.graph} @matrix-controls-change=${(e) => { this.matrixControls = e.detail }}></dependency-matrix>
      </div>`
    }
    return html`<div class="graph2-layout">
      ${topBar(null)}
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
