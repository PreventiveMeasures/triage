import { keyed } from 'lit/directives/keyed.js'
import { LitElement, html, unsafeCSS } from 'lit'
import { styleMap } from '../style-map.js'
import { hideTooltip, installShadowTooltipListener } from '../tooltip.js'
import { graph2 } from './state.js'
import { pkgColor } from './utils.js'
import { graphBackground } from './colors.js'
import { buildSizeFlow, fitSizeFlowWidth, layoutSizeFlow, sizeFlowConnector, sizeFlowFilterSize, sizeFlowLargeThreshold } from './size-flow-model.js'
import { SizeFlowChart, flowAmount, packageCount, shortSize } from './size-flow-chart.js'
import { graphTerms } from './data.js'
import { graphZoomMetrics } from './zoom.js'
import css from './size-flow.css'
import sidebarListCSS from './sidebar-list.css'
import zoomControlsCSS from './zoom-controls.css'
import detailActionCSS from '../../styles/detail-action.css'

const sidePadding = 10
const availableWidth = width => Math.max(1, width - 2 * sidePadding)

function flowRow(node, amount, onClick) {
  return html`<button class="g2-dist-item flow-link" data-tooltip=${node.label} @click=${onClick}>
    <span class="g2-dist-dot" style=${styleMap({ background: pkgColor(node.pkg) })}></span>
    <span class="g2-dist-name">${node.label}</span><span class="g2-dist-count">${amount}</span>
  </button>`
}

// `<size-flow>` draws Size flow, weighing files or packages by their bytes, or
// with `metric` 'count' Package flow, weighing packages by how many packages
// they bring (buildSizeFlow).
class SizeFlow extends LitElement {
  static properties = { graph: { attribute: false }, packages: { type: Boolean }, metric: { type: String } }
  static styles = [unsafeCSS(sidebarListCSS), unsafeCSS(css), unsafeCSS(zoomControlsCSS), unsafeCSS(detailActionCSS)]

  constructor() {
    super()
    this.packages = false; this.metric = 'size'; this.zoom = 1
    this.pan = { x: 0, y: 0 }
    this.width = 0; this.height = 0
    this.needsFit = true
    this.fitted = true
    this.largeOnly = true
    this.largeSuppressed = false
    this.largeThreshold = 0
    this.models = new Map()
    this.chart = new SizeFlowChart(this)
    this.focus = null; this.selection = null; this.hover = null
    this.bridge = { requestDraw: () => this.requestUpdate(), _cleanup: () => {} }
  }

  willUpdate(changes) {
    if (!this.graph) return
    let rebuild = false
    if (changes.has('graph')) this.models.clear()
    if (changes.has('packages') || changes.has('metric')) this.needsFit = true
    if (!this.model || changes.has('graph') || changes.has('packages') || changes.has('metric')) {
      const key = `${this.metric}:${this.packages}`
      if (!this.models.has(key)) this.models.set(key, buildSizeFlow(this.graph, { packages: this.packages, metric: this.metric }))
      this.model = this.models.get(key)
      this.largeThreshold = sizeFlowLargeThreshold(this.model)
      rebuild = true
      if (!this.model.byId.has(this.focus)) this.focus = null
      if (this.selection && !this.model.byId.has(this.selection.node)) this.selection = null
      this.hover = null
    }
    if (rebuild || this.layoutFocus !== this.focus) this.largeSuppressed = this.isSmallFocus()
    if (this.focus && sizeFlowFilterSize(this.model.byId.get(this.focus)) < this.minSize) this.focus = null
    if (rebuild || this.layoutFocus !== this.focus || this.layoutMinSize !== this.minSize) {
      if (this.renderRoot) hideTooltip(this.renderRoot)
      this.layout = fitSizeFlowWidth(layoutSizeFlow(this.model, { focus: this.focus, minSize: this.minSize }), availableWidth(this.width), this.height)
      this.layoutFocus = this.focus
      this.layoutMinSize = this.minSize
      if (this.selection && !this.layout.byId.has(this.selection.node)) this.selection = null
    }
  }

  get minSize() { return this.largeOnly && !this.largeSuppressed ? this.largeThreshold : 0 }

  toggleLarge() { this.largeOnly = !this.largeOnly; this.needsFit = true; this.requestUpdate() }

  get counts() { return this.model?.metric === 'count' }

  amount(n) { return flowAmount(this.model.metric, n) }

  renderControls() {
    const threshold = this.counts ? `${this.largeThreshold}+ packages` : `${this.largeThreshold / 1024}+ KiB`
    return this.largeThreshold && !this.largeSuppressed ? html`<mode-switch label=${`Large · ${threshold}`} .checked=${this.largeOnly}
      @click=${() => this.toggleLarge()}></mode-switch>` : null
  }

  updated() {
    graph2.graphState = this.bridge
    const controlsKey = `${this.model?.metric}:${this.largeThreshold}:${this.largeOnly}:${this.largeSuppressed}`
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
    // Internal hover transitions are trimmed at this shadow boundary; the
    // graph-layout listener only sees entry/exit of the whole component.
    installShadowTooltipListener(this.renderRoot, { gate: () => !this.drag })
    this.events = new AbortController()
    const { signal } = this.events
    stage.addEventListener('wheel', e => this.wheel(e), { passive: false, signal })
    stage.addEventListener('pointerdown', e => this.startPan(e), { signal })
    window.addEventListener('pointermove', e => this.movePan(e), { signal })
    window.addEventListener('pointerup', e => this.endPan(e), { signal })
    window.addEventListener('pointercancel', e => this.endPan(e), { signal })
    window.addEventListener('deepview-theme-changed', () => this.requestUpdate(), { signal })
    stage.addEventListener('click', e => {
      const dragged = this.suppressClick && e.detail > 0
      this.suppressClick = false
      if (dragged) { e.preventDefault(); e.stopPropagation(); return }
      // The chart's own click handler selects whatever it hits.
      if (!e.target.closest?.('.flow-canvas')) this.select(null)
    }, { capture: true, signal })
    this.resizeObserver = new ResizeObserver(() => this.syncViewport())
    this.resizeObserver.observe(stage)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    hideTooltip(this.renderRoot)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.events?.abort(); this.events = null
    this.chart.dispose()
    this.viewportElements = null
    this.drag = null
    if (graph2.graphState === this.bridge) graph2.graphState = null
  }

  select(node, edge = null) {
    if (!node && this.focus) { this.follow(null); return }
    this.selection = node ? { node, edge } : null; this.requestUpdate()
  }

  follow(node) {
    this.focus = node; this.selection = node ? { node, edge: null } : null; this.needsFit = true; this.requestUpdate()
  }

  isSmallFocus() {
    if (!this.focus) return false
    // Count the import subtree before Large filtering, stopping at the cutoff.
    // Suppress Large for this view without changing the user's saved setting.
    const pending = [this.focus], seen = new Set(pending)
    for (const id of pending) {
      if (seen.size >= 200) break
      for (const { to } of this.model.byId.get(id).outgoing) {
        if (!seen.has(to)) { seen.add(to); pending.push(to) }
        if (seen.size >= 200) break
      }
    }
    return seen.size < 200
  }

  fitScale() {
    return this.layout && this.width > 0 && this.height > 0
      ? Math.min(availableWidth(this.width) / this.layout.width, this.height / this.layout.height, 9.99) : 1
  }

  zoomMetrics() { return graphZoomMetrics(this.zoom, Math.min(this.fitScale(), 1)) }

  align() {
    this.pan = { x: sidePadding, y: (this.height - this.layout.height * this.zoom) / 2 }
  }

  syncViewport() {
    const box = this.renderRoot.querySelector('.flow-viewport')?.getBoundingClientRect()
    if (!this.layout || !box || box.width <= 0 || box.height <= 0) return
    const layout = fitSizeFlowWidth(this.layout, availableWidth(box.width), box.height)
    if (this.width > 0 && this.height > 0) {
      this.pan.x = box.width / 2 - (this.width / 2 - this.pan.x) * layout.width / this.layout.width
      this.pan.y += (box.height - this.height) / 2
    }
    if (layout !== this.layout) { hideTooltip(this.renderRoot); this.layout = layout; this.requestUpdate() }
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
    const layout = fitSizeFlowWidth(this.layout, availableWidth(box.width), box.height)
    if (layout !== this.layout) { hideTooltip(this.renderRoot); this.layout = layout; this.requestUpdate() }
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
      this.pan.x += (sidePadding - this.pan.x) * step
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

  drawViewport() {
    // Pointer and wheel input repaint the chart and the zoom controls only,
    // never the component.
    this.chart.viewportChanged()
    this.viewportElements ??= {
      label: this.renderRoot.querySelector('.g2-zoom-pct'),
      zoomIn: this.renderRoot.querySelector('[aria-label="Zoom in"]'),
      zoomOut: this.renderRoot.querySelector('[aria-label="Zoom out"]'),
    }
    const { label, zoomIn, zoomOut } = this.viewportElements
    const { min, max, percent } = this.zoomMetrics()
    if (label) label.textContent = `${percent}%`
    if (zoomIn) zoomIn.disabled = this.zoom >= max * .9999
    if (zoomOut) zoomOut.disabled = this.zoom <= min * 1.0001
  }

  matchesNode(node) {
    if (sizeFlowFilterSize(node) < this.minSize || this.layout?.hiddenPackages?.has(node.pkg)) return false
    const query = graph2.pathFilter.trim().toLowerCase()
    if (query && !`${node.label} ${node.pkg}`.toLowerCase().includes(query)) return false
    if (this.graph.issuesHidden) return true
    const some = key => node.files.some(file => [...(this.model.files.get(file)[key] ?? [])].some(v =>
      (key === 'severitySet' ? graph2.selectedSeverities : graph2.selectedColors).has(v)))
    return (graph2.selectedSeverities.size === 0 || some('severitySet')) && (graph2.selectedColors.size === 0 || some('colorSet'))
  }

  renderLinks(edges, incoming = false) {
    return edges.toSorted((a, b) => b.size - a.size).slice(0, 100).map(e => {
      const n = this.model.byId.get(incoming ? e.from : e.to)
      return flowRow(n, this.amount(e.size), () => this.select(n.id, e.id))
    })
  }

  renderSearch() {
    if (!graph2.pathFilter.trim()) return null
    const matches = this.chart.searchMatches()
    const beyond = this.counts ? 'any package' : 'any file or package'
    return html`<h4>Matches · ${matches.length}</h4>${matches.slice(0, 100).map(n => flowRow(n, this.amount(n.removable), () => this.follow(n.id)))}
      ${matches.length > 100 ? html`<p>Showing the 100 largest matches. Refine the search to find ${beyond}, including those beyond the visible graph.</p>` : null}`
  }

  renderPanel() {
    if (this.counts) return this.renderCountPanel()
    const node = this.model.byId.get(this.selection?.node)
    const edge = this.model.edgeById.get(this.selection?.edge)
    if (!node) {return html`<h3>Size flow</h3><div class="flow-metrics"><b>${shortSize(this.model.total.size)}</b><span>unique reachable source</span></div>
      <p>Bar width shows how much source leaves the bundle when a file or package is removed.</p>
      <p>Select a bar or ribbon for details.<br>Double-click a bar to follow its imports.</p>
      ${this.model.total.missing ? html`<p>${this.model.total.missing} files have unknown sizes; totals include known bytes only.</p>` : null}
      ${this.model.weakEdges ? html`<p>${this.model.weakEdges} weak config/metadata loads excluded.</p>` : null}
      ${this.model.omittedFiles ? html`<p>${this.model.omittedFiles} files are not reachable from these entry points.</p>` : null}
      <h4>${this.model.inferred ? 'Inferred roots (no entry points in this view)' : 'Entry points'}</h4>
      ${this.renderRoots()}`}
    return html`<div class="flow-panel-heading"><h3>${node.label}</h3><button type="button" class="detail-action" aria-label="Clear flow selection" @click=${() => this.select(null)}>×</button></div>
      ${edge ? html`<p class="flow-direction">${this.model.byId.get(edge.from).label}<br>↓ imports<br>${this.model.byId.get(edge.to).label}</p><div class="flow-metrics"><b>${shortSize(edge.size)}</b><span>reachable through this edge · ${edge.count} ${edge.count === 1 ? 'file import' : 'file imports'}</span></div>` : null}
      <div class="flow-metrics"><b>${shortSize(node.removable)}</b><span>unique size · removed if deleted · bar width</span><b>${shortSize(node.size)}</b><span>reachable size</span><b>${shortSize(node.own)}</b><span>own source size · ${node.files.length} ${node.files.length === 1 ? 'file' : 'files'}</span></div>
      ${this.renderVersions(node)}
      ${sizeFlowConnector(node, this.minSize) ? html`<p>Kept by Large so retained dependencies remain connected to an entry point.</p>` : null}
      ${node.removableMissing ? html`<p>${node.removableMissing} removed files have unknown sizes; removal totals include known bytes only.</p>` : null}
      ${node.missing ? html`<p>${node.missing} reachable file sizes are unknown.</p>` : null}
      ${node.virtual ? html`<p>Entry source is absent from this bundle; only its recorded imports are counted.</p>` : null}
      <div class="flow-actions"><button aria-pressed=${!!this.focus} @click=${() => this.follow(this.focus ? null : node.id)}>Follow imports</button>
      ${!this.packages && !node.virtual ? html`<button data-bundle-view-source=${this.model.files.get(node.files[0]).origFile ?? node.files[0]}>View source</button>` : null}</div>
      <h4>Imports · ${node.outgoing.length}</h4>${this.renderLinks(node.outgoing)}
      <h4>Imported by · ${node.incoming.length}</h4>${this.renderLinks(node.incoming, true)}
      ${Math.max(node.incoming.length, node.outgoing.length) > 100 ? html`<p>Showing the 100 largest flows in each direction.</p>` : null}`
  }

  renderRoots() {
    return html`${this.model.roots.slice(0, 100).map(id => { const n = this.model.byId.get(id); return flowRow(n, this.amount(n.removable), () => this.select(id)) })}
      ${this.model.roots.length > 100 ? html`<p>Showing the first 100 entry points. Search to find another.</p>` : null}`
  }

  // Package flow's panel: packages counted once each, so no byte sizes, and
  // a lockfile's packages depend on each other rather than import files.
  renderCountPanel() {
    const { model } = this, terms = graphTerms(this.graph)
    const node = model.byId.get(this.selection?.node)
    const edge = model.edgeById.get(this.selection?.edge)
    if (!node) {return html`<h3>Package flow</h3><div class="flow-metrics"><b>${model.total.size}</b><span>${model.total.size === 1 ? 'package' : 'packages'} reachable</span></div>
      <p>Bar width shows how many packages leave the graph when a package is removed: the package itself and every dependency nothing else still needs.</p>
      <p>Select a bar or ribbon for details.<br>Double-click a bar to follow its dependencies.</p>
      ${model.weakEdges ? html`<p>${model.weakEdges} weak config/metadata loads excluded.</p>` : null}
      ${model.omittedPackages ? html`<p>${packageCount(model.omittedPackages)} ${model.omittedPackages === 1 ? 'is' : 'are'} not reachable from these ${this.graph.packagesOnly ? 'workspaces' : 'entry points'}.</p>` : null}
      <h4>${model.inferred ? 'Inferred roots (no entry points in this view)' : this.graph.packagesOnly ? 'Workspaces' : 'Entry points'}</h4>
      ${this.renderRoots()}`}
    const dependencies = node.size - 1
    return html`<div class="flow-panel-heading"><h3>${node.label}</h3><button type="button" class="detail-action" aria-label="Clear flow selection" @click=${() => this.select(null)}>×</button></div>
      ${edge ? html`<p class="flow-direction">${model.byId.get(edge.from).label}<br>↓ ${terms.linked}<br>${model.byId.get(edge.to).label}</p><div class="flow-metrics"><b>${edge.size}</b><span>${edge.size === 1 ? 'package' : 'packages'} reachable through this dependency${this.graph.packagesOnly ? '' : ` · ${edge.count} ${edge.count === 1 ? 'file import' : 'file imports'}`}</span></div>` : null}
      <div class="flow-metrics"><b>${node.removable}</b><span>unique ${node.removable === 1 ? 'package' : 'packages'} · removed if deleted · bar width</span><b>${node.size}</b><span>${node.size === 1 ? 'package' : 'packages'} reachable · itself and ${dependencies} ${dependencies === 1 ? 'dependency' : 'dependencies'}</span></div>
      ${this.renderVersions(node)}
      ${sizeFlowConnector(node, this.minSize) ? html`<p>Kept by Large so retained dependencies remain connected to ${this.graph.packagesOnly ? 'a workspace' : 'an entry point'}.</p>` : null}
      ${node.virtual ? html`<p>Entry source is absent from this bundle; only its recorded imports are counted.</p>` : null}
      <div class="flow-actions"><button aria-pressed=${!!this.focus} @click=${() => this.follow(this.focus ? null : node.id)}>Follow dependencies</button></div>
      <h4>${terms.outgoing} · ${node.outgoing.length}</h4>${this.renderLinks(node.outgoing)}
      <h4>${terms.incoming} · ${node.incoming.length}</h4>${this.renderLinks(node.incoming, true)}
      ${Math.max(node.incoming.length, node.outgoing.length) > 100 ? html`<p>Showing the 100 largest flows in each direction.</p>` : null}`
  }

  renderVersions(node) {
    if (!node.instances?.length) return null
    if (node.instances.length === 1) {
      const instance = node.instances[0]
      return html`<div class="flow-versions"><div>${instance.version || 'Unknown version'}</div><small>${instance.directory}</small></div>`
    }
    const counts = this.counts
    const list = html`<ul class="flow-versions">${node.instances.map(instance => html`<li>
      <div><span>${instance.version || 'Unknown version'}</span>${counts ? null : html`<span>${shortSize(instance.size)}${instance.missing ? '+' : ''}</span>`}</div>
      <small>${instance.directory}</small>
      ${instance.missing && !counts ? html`<small>${instance.missing} files have unknown sizes</small>` : null}
    </li>`)}</ul>`
    return keyed(node.id, html`<details class="flow-versions-details"><summary>Versions: ${node.instances.length}</summary>${counts ? null : html`<h4>Own source size</h4>`}${list}</details>`)
  }

  render() {
    if (!this.layout) return null
    const { nodes } = this.layout
    const minSize = this.counts ? packageCount(this.minSize) : shortSize(this.minSize)
    return html`<section class="flow-stage" aria-label=${this.counts ? 'Package dependency flow' : 'Dependency size flow'} style=${styleMap({ '--flow-background': graphBackground() })}>
      <div class="flow-viewport">${this.chart.render()}${nodes.length > 0 ? null : html`<p>${this.minSize ? `No nodes reach ${minSize}. Turn off Large to show all nodes.` : 'No recorded dependency paths in this view.'}</p>`}</div>
      <div class="flow-count">${nodes.length} ${this.model.packages ? nodes.length === 1 ? 'package' : 'packages' : nodes.length === 1 ? 'file' : 'files'}</div>
      <div class="g2-zoom-ctrl" role="group" aria-label="Flow zoom">
        <button aria-label="Zoom in" ?disabled=${this.zoom >= this.zoomMetrics().max * .9999} @click=${() => this.zoomBy(1.4)}>+</button>
        <div class="g2-zoom-pct"></div>
        <button aria-label="Zoom out" ?disabled=${this.zoom <= this.zoomMetrics().min * 1.0001} @click=${() => this.zoomBy(1 / 1.4)}>−</button>
        <button class="g2-zoom-fit-btn" aria-label="Fit to view" @click=${() => this.fit()}>fit</button>
      </div>
    </section><aside class="flow-panel" aria-label=${this.counts ? 'Package flow details' : 'Size flow details'} aria-live="polite">${this.renderSearch()}${this.renderPanel()}</aside>`
  }
}

customElements.define('size-flow', SizeFlow)
