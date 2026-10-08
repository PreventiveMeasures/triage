import { guard } from 'lit/directives/guard.js'
import { LitElement, html, unsafeCSS } from '../frontend-global.js'
import { graph2 } from './state.js'
import { pkgColor } from './utils.js'
import { buildSizeFlow, fitSizeFlowWidth, layoutSizeFlow } from './size-flow-model.js'
import { SizeFlowChart, shortSize } from './size-flow-chart.js'
import { graphZoomMetrics } from './zoom.js'
import css from './size-flow.css'
import sidebarListCSS from './sidebar-list.css'
import zoomControlsCSS from './zoom-controls.css'
import detailActionCSS from '../../styles/detail-action.css'

function flowRow(node, size, onClick) {
  return html`<button class="g2-dist-item flow-link" data-tooltip=${node.label} @click=${onClick}>
    <span class="g2-dist-dot" style=${`background:${pkgColor(node.pkg)}`}></span>
    <span class="g2-dist-name">${node.label}</span><span class="g2-dist-count">${shortSize(size)}</span>
  </button>`
}

class SizeFlow extends LitElement {
  static properties = { graph: { attribute: false }, packages: { type: Boolean } }
  static styles = [unsafeCSS(sidebarListCSS), unsafeCSS(css), unsafeCSS(zoomControlsCSS), unsafeCSS(detailActionCSS)]

  constructor() {
    super()
    this.packages = false; this.zoom = 1
    this.pan = { x: 0, y: 0 }
    this.width = 0; this.height = 0
    this.needsFit = true
    this.fitted = true
    this.largeOnly = true
    this.chart = new SizeFlowChart(this)
    this.focus = null; this.selection = null; this.hover = null
    this.bridge = { requestDraw: () => this.requestUpdate(), _cleanup: () => {} }
  }

  willUpdate(changes) {
    if (!this.graph) return
    let rebuild = false
    if (!this.model || changes.has('graph') || changes.has('packages')) {
      this.model = buildSizeFlow(this.graph, { packages: this.packages })
      rebuild = true
      if (!this.model.byId.has(this.focus)) this.focus = null
      if (this.selection && !this.model.byId.has(this.selection.node)) this.selection = null
      this.hover = null
    }
    if (this.focus && this.model.byId.get(this.focus)?.size < this.minSize) this.focus = null
    if (rebuild || this.layoutFocus !== this.focus || this.layoutMinSize !== this.minSize) {
      this.layout = fitSizeFlowWidth(layoutSizeFlow(this.model, { focus: this.focus, minSize: this.minSize }), this.width, this.height)
      this.layoutFocus = this.focus
      this.layoutMinSize = this.minSize
      if (this.selection && !this.layout.byId.has(this.selection.node)) this.selection = null
    }
  }

  get minSize() { return this.graph.nodes.length > 50 && this.largeOnly ? 4096 : 0 }

  toggleLarge() { this.largeOnly = !this.largeOnly; this.needsFit = true; this.requestUpdate() }

  renderControls() {
    return this.graph.nodes.length > 50 ? html`<mode-switch label="Large" .checked=${this.largeOnly}
      data-tooltip="At least 4 KiB of unique reachable source" @click=${() => this.toggleLarge()}></mode-switch>` : null
  }

  updated() {
    graph2.graphState = this.bridge
    const controlsKey = `${this.graph.nodes.length > 50}:${this.largeOnly}`
    if (controlsKey !== this.controlsKey) {
      this.controlsKey = controlsKey
      this.dispatchEvent(new CustomEvent('flow-controls-change', { detail: this.renderControls(), bubbles: true, composed: true }))
    }
    this.connectViewport()
    this.syncViewport()
    this.chart.update(this.renderRoot)
  }

  connectViewport() {
    const stage = this.renderRoot.querySelector('.flow-viewport')
    if (!stage || this.events) return
    this.events = new AbortController()
    const { signal } = this.events
    stage.addEventListener('wheel', e => this.wheel(e), { passive: false, signal })
    stage.addEventListener('pointerdown', e => this.startPan(e), { signal })
    window.addEventListener('pointermove', e => this.movePan(e), { signal })
    window.addEventListener('pointerup', e => this.endPan(e), { signal })
    window.addEventListener('pointercancel', e => this.endPan(e), { signal })
    stage.addEventListener('click', e => {
      const dragged = this.suppressClick && e.detail > 0
      this.suppressClick = false
      if (dragged) { e.preventDefault(); e.stopPropagation(); return }
      if (!e.target.closest?.('[data-flow-node], [data-flow-edge]')) this.select(null)
    }, { capture: true, signal })
    this.resizeObserver = new ResizeObserver(() => this.syncViewport())
    this.resizeObserver.observe(stage)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.events?.abort(); this.events = null
    this.viewportElements = null
    this.drag = null
    if (graph2.graphState === this.bridge) graph2.graphState = null
  }

  select(node, edge = null) { this.selection = node ? { node, edge } : null; this.requestUpdate() }

  follow(node) { this.focus = node; this.selection = node ? { node, edge: null } : null; this.needsFit = true; this.requestUpdate() }

  fitScale() {
    return this.layout && this.width > 0 && this.height > 0
      ? Math.min(this.width / this.layout.width, this.height / this.layout.height, 9.99) : 1
  }

  zoomMetrics() { return graphZoomMetrics(this.zoom, Math.min(this.fitScale(), 1)) }

  align() {
    this.pan = { x: 0, y: (this.height - this.layout.height * this.zoom) / 2 }
  }

  syncViewport() {
    const box = this.renderRoot.querySelector('.flow-viewport')?.getBoundingClientRect()
    if (!this.layout || !box || box.width <= 0 || box.height <= 0) return
    const layout = fitSizeFlowWidth(this.layout, box.width, box.height)
    if (this.width > 0 && this.height > 0) {
      this.pan.x = box.width / 2 - (this.width / 2 - this.pan.x) * layout.width / this.layout.width
      this.pan.y += (box.height - this.height) / 2
    }
    if (layout !== this.layout) { this.layout = layout; this.requestUpdate() }
    this.width = box.width; this.height = box.height
    if (this.needsFit || this.fitted) { this.fit(); return }
    // Content and viewport changes can raise the floor. Clamp immediately,
    // but retain a valid user viewport through popup/data refreshes.
    const { min, max } = this.zoomMetrics()
    const zoom = Math.max(min, Math.min(max, this.zoom))
    if (zoom !== this.zoom) { this.zoom = zoom; this.align() }
    this.drawViewport()
  }

  fit() {
    const box = this.renderRoot.querySelector('.flow-viewport')?.getBoundingClientRect()
    if (!this.layout || !box || box.width <= 0 || box.height <= 0) return
    const layout = fitSizeFlowWidth(this.layout, box.width, box.height)
    if (layout !== this.layout) { this.layout = layout; this.requestUpdate() }
    this.width = box.width; this.height = box.height
    this.zoom = this.fitScale()
    this.needsFit = false
    this.fitted = true
    this.align(); this.drawViewport()
  }

  zoomBy(factor, x = this.width / 2, y = this.height / 2) {
    const { min, max } = this.zoomMetrics()
    const zoom = Math.max(min, Math.min(max, this.zoom * factor))
    const ratio = zoom / this.zoom
    if (zoom !== this.zoom) this.fitted = false
    this.pan.x = x - (x - this.pan.x) * ratio
    this.pan.y = y - (y - this.pan.y) * ratio
    this.zoom = zoom; this.drawViewport()
  }

  wheel(e) {
    e.preventDefault()
    const box = this.renderRoot.querySelector('.flow-viewport').getBoundingClientRect()
    const factor = Math.exp(-e.deltaY * .0015), { min } = this.zoomMetrics()
    if (factor < 1 && this.zoom <= min * 1.0001) {
      // Match the other graphs: at the floor, further scroll-out eases back
      // toward the left-aligned overview instead of shrinking the graph.
      this.zoom = min
      const step = Math.min(.4, (1 - factor) * 3)
      this.pan.x += -this.pan.x * step
      this.pan.y += ((this.height - this.layout.height * min) / 2 - this.pan.y) * step
      this.drawViewport()
    } else this.zoomBy(factor, e.clientX - box.left, e.clientY - box.top)
  }

  startPan(e) {
    if (e.button !== 0) return
    this.suppressClick = false
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan: { ...this.pan }, moved: false }
  }

  movePan(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true
    if (!this.drag.moved) return
    this.fitted = false
    this.suppressClick = true
    this.chart.setHover(null)
    this.pan = { x: this.drag.pan.x + dx, y: this.drag.pan.y + dy }
    this.drawViewport()
  }

  endPan(e) { if (e.pointerId === this.drag?.id) this.drag = null }

  viewportTransform() { return `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})` }

  drawViewport() {
    // Keep pointer/wheel updates independent of the potentially huge SVG
    // template: only its transform and the zoom controls need to change.
    this.viewportElements ??= {
      chart: this.renderRoot.querySelector('.flow-chart'),
      label: this.renderRoot.querySelector('.g2-zoom-pct'),
      zoomIn: this.renderRoot.querySelector('[aria-label="Zoom in"]'),
      zoomOut: this.renderRoot.querySelector('[aria-label="Zoom out"]'),
    }
    const { chart, label, zoomIn, zoomOut } = this.viewportElements
    if (chart) { chart.style.transform = this.viewportTransform(); chart.style.setProperty('--flow-zoom', String(this.zoom)) }
    const { min, max, percent } = this.zoomMetrics()
    if (label) label.textContent = `${percent}%`
    if (zoomIn) zoomIn.disabled = this.zoom >= max * .9999
    if (zoomOut) zoomOut.disabled = this.zoom <= min * 1.0001
  }

  matches(node) {
    if (node.size < this.minSize) return false
    const query = graph2.pathFilter.trim().toLowerCase()
    if (query && !`${node.label} ${node.pkg}`.toLowerCase().includes(query)) return false
    const some = key => node.files.some(file => [...(this.model.files.get(file)[key] ?? [])].some(v =>
      (key === 'severitySet' ? graph2.selectedSeverities : graph2.selectedColors).has(v)))
    return (graph2.selectedSeverities.size === 0 || some('severitySet')) && (graph2.selectedColors.size === 0 || some('colorSet'))
  }

  renderLinks(edges, incoming = false) {
    return edges.toSorted((a, b) => b.size - a.size).slice(0, 100).map(e => {
      const n = this.model.byId.get(incoming ? e.from : e.to)
      return flowRow(n, e.size, () => this.select(n.id, e.id))
    })
  }

  renderSearch() {
    if (!graph2.pathFilter.trim()) return null
    const matches = this.chart.searchMatches()
    return html`<h4>Matches · ${matches.length}</h4>${matches.slice(0, 100).map(n => flowRow(n, n.removable, () => this.follow(n.id)))}
      ${matches.length > 100 ? html`<p>Showing the 100 largest matches. Refine the search to find any file or package, including those beyond the visible graph.</p>` : null}`
  }

  renderPanel() {
    const node = this.model.byId.get(this.selection?.node)
    const edge = this.model.edgeById.get(this.selection?.edge)
    if (!node) {return html`<h3>Size flow</h3><div class="flow-metrics"><b>${shortSize(this.model.total.size)}</b><span>unique reachable source</span></div>
      <p>Bar widths show how much source would leave this bundle if the file or package were deleted: its own code plus dependencies no longer reachable from any entry point.</p>
      <p>Shared dependencies stay when another path still loads them. Package removal deletes all its files together. Following imports keeps the same bundle-wide calculation.</p>
      <p>Ribbons may overlap and taper to the bars they connect. Select a ribbon to see the total source size reachable through its import. These totals can overlap.</p>
      <p>Dashed ribbons return to an earlier level, including cycles. Tiny bars and ribbons keep a minimum visible width.</p>
      ${this.model.total.missing ? html`<p>${this.model.total.missing} files have unknown sizes; totals include known bytes only.</p>` : null}
      ${this.model.weakEdges ? html`<p>${this.model.weakEdges} weak config/metadata loads excluded.</p>` : null}
      ${this.model.omittedFiles ? html`<p>${this.model.omittedFiles} files are not reachable from these entry points.</p>` : null}
      <h4>${this.model.inferred ? 'Inferred roots (no entry points in this view)' : 'Entry points'}</h4>
      ${this.model.roots.slice(0, 100).map(id => { const n = this.model.byId.get(id); return flowRow(n, n.removable, () => this.select(id)) })}
      ${this.model.roots.length > 100 ? html`<p>Showing the first 100 entry points. Search to find another.</p>` : null}`}
    return html`<div class="flow-panel-heading"><h3>${node.label}</h3><button type="button" class="detail-action" aria-label="Clear flow selection" @click=${() => { if (this.focus) this.follow(null); else this.select(null) }}>×</button></div>
      ${edge ? html`<p class="flow-direction">${this.model.byId.get(edge.from).label}<br>↓ imports<br>${this.model.byId.get(edge.to).label}</p><div class="flow-metrics"><b>${shortSize(edge.size)}</b><span>reachable through this edge · ${edge.count} ${edge.count === 1 ? 'file import' : 'file imports'}</span></div>` : null}
      <div class="flow-metrics"><b>${shortSize(node.removable)}</b><span>removed if deleted · bar width</span><b>${shortSize(node.size)}</b><span>unique reachable size</span><b>${shortSize(node.own)}</b><span>own source size · ${node.files.length} ${node.files.length === 1 ? 'file' : 'files'}</span></div>
      ${node.removableMissing ? html`<p>${node.removableMissing} removed files have unknown sizes; removal totals include known bytes only.</p>` : null}
      ${node.missing ? html`<p>${node.missing} reachable file sizes are unknown.</p>` : null}
      ${node.virtual ? html`<p>Entry source is absent from this bundle; only its recorded imports are counted.</p>` : null}
      <div class="flow-actions"><button @click=${() => this.follow(node.id)}>Follow imports</button>
      ${!this.packages && !node.virtual ? html`<button data-bundle-view-source=${this.model.files.get(node.files[0]).origFile ?? node.files[0]}>View source</button>` : null}</div>
      <h4>Imports · ${node.outgoing.length}</h4>${this.renderLinks(node.outgoing)}
      <h4>Imported by · ${node.incoming.length}</h4>${this.renderLinks(node.incoming, true)}
      ${Math.max(node.incoming.length, node.outgoing.length) > 100 ? html`<p>Showing the 100 largest flows in each direction.</p>` : null}`
  }

  render() {
    if (!this.layout) return null
    const { nodes, width, height } = this.layout
    return html`<section class="flow-stage" aria-label="Dependency size flow">
      <div class="flow-viewport"><svg class="flow-chart" width=${width} height=${height} style=${`transform:${this.viewportTransform()};--flow-zoom:${this.zoom}`} viewBox=${`0 0 ${width} ${height}`} role="group" aria-label="Import paths with bars weighted by bundle size removed if deleted">
        ${guard([this.layout], () => this.chart.render())}
      </svg>${nodes.length > 0 ? null : html`<p>${this.minSize ? 'No nodes reach 4 KiB. Turn off Large to show all nodes.' : 'No recorded dependency paths in this view.'}</p>`}</div>
      <div class="flow-count">${nodes.length} ${this.packages ? nodes.length === 1 ? 'package' : 'packages' : nodes.length === 1 ? 'file' : 'files'}</div>
      <div class="g2-zoom-ctrl" role="group" aria-label="Flow zoom">
        <button aria-label="Zoom in" ?disabled=${this.zoom >= this.zoomMetrics().max * .9999} @click=${() => this.zoomBy(1.4)}>+</button>
        <div class="g2-zoom-pct"></div>
        <button aria-label="Zoom out" ?disabled=${this.zoom <= this.zoomMetrics().min * 1.0001} @click=${() => this.zoomBy(1 / 1.4)}>−</button>
        <button class="g2-zoom-fit-btn" aria-label="Fit to view" @click=${() => this.fit()}>fit</button>
      </div>
    </section><aside class="flow-panel" aria-label="Size flow details" aria-live="polite">${this.renderSearch()}${this.renderPanel()}</aside>`
  }
}

customElements.define('size-flow', SizeFlow)
