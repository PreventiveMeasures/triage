import { svg } from 'lit'
import { LitElement, html, unsafeCSS } from '../frontend-global.js'
import { formatBytes } from '../format.js'
import { graph2 } from './state.js'
import { pkgColor } from './utils.js'
import { buildSizeFlow, flowRibbon, layoutSizeFlow } from './size-flow-model.js'
import css from './size-flow.css'

function shortSize(size) {
  if (size >= 1e6) return `${(size / 1e6).toFixed(1)} MB`
  if (size >= 1e3) return `${(size / 1e3).toFixed(1)} kB`
  return `${size} B`
}

class SizeFlow extends LitElement {
  static properties = { graph: { attribute: false }, packages: { type: Boolean } }
  static styles = unsafeCSS(css)

  constructor() {
    super()
    this.packages = false; this.depth = 4; this.zoom = 1
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
    if (rebuild || this.layoutFocus !== this.focus || this.layoutDepth !== this.depth) {
      this.layout = layoutSizeFlow(this.model, { focus: this.focus, depth: this.depth })
      this.layoutFocus = this.focus; this.layoutDepth = this.depth
    }
  }

  updated() { graph2.graphState = this.bridge }

  disconnectedCallback() {
    super.disconnectedCallback()
    if (graph2.graphState === this.bridge) graph2.graphState = null
  }

  select(node, edge = null) { this.selection = { node, edge }; this.requestUpdate() }

  follow(node) { this.focus = node; this.selection = node ? { node, edge: null } : null; this.requestUpdate(); this.resetScroll() }

  fit() {
    const stage = this.renderRoot.querySelector('.flow-scroll')
    this.zoom = stage ? Math.min(1, stage.clientHeight / (this.layout.height * Math.max(500, stage.clientWidth) / this.layout.width)) : 1
    this.requestUpdate(); this.resetScroll()
  }

  async resetScroll() {
    await this.updateComplete
    this.renderRoot.querySelector('.flow-scroll')?.scrollTo(0, 0)
  }

  matches(node) {
    const query = graph2.pathFilter.trim().toLowerCase()
    if (query && !`${node.label} ${node.pkg}`.toLowerCase().includes(query)) return false
    const some = key => node.files.some(file => [...(this.model.files.get(file)[key] ?? [])].some(v =>
      (key === 'severitySet' ? graph2.selectedSeverities : graph2.selectedColors).has(v)))
    return (graph2.selectedSeverities.size === 0 || some('severitySet')) && (graph2.selectedColors.size === 0 || some('colorSet'))
  }

  renderNode(n) {
    const selected = this.selection?.node === n.id
    const title = `${n.label}\n${formatBytes(n.size)} reachable · ${formatBytes(n.own)} own${n.missing ? ` · ${n.missing} file sizes unknown` : ''}`
    const label = n.width >= 40 ? `${n.label.replace(/^node_modules\//u, '')} · ${shortSize(n.size)}` : ''
    return svg`<g class="flow-node" role="button" tabindex="0" aria-label=${title} aria-pressed=${String(selected)} opacity=${this.matches(n) ? 1 : .15}
      @click=${() => this.select(n.id)} @dblclick=${() => this.follow(n.id)}
      @keydown=${e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(n.id) } }}>
      <title>${title}</title>
      <rect x=${n.x} y=${n.y} width=${n.width} height="26" rx="3" fill=${pkgColor(n.pkg)} stroke=${selected ? 'var(--text)' : 'var(--graph-canvas-bg)'} stroke-width=${selected ? 2 : 1}></rect>
      <svg x=${n.x + 5} y=${n.y} width=${Math.max(0, n.width - 10)} height="26"><text x="0" y="18">${label}</text></svg>
    </g>`
  }

  renderEdge(e) {
    const from = this.model.byId.get(e.from), to = this.model.byId.get(e.to)
    const active = this.selection?.edge === e.id || this.hover === e.id
    const related = this.selection?.node === e.from || this.selection?.node === e.to
    const dimmed = !this.matches(from) && !this.matches(to)
    const title = `${from.label} → ${to.label}\n${formatBytes(e.size)} reachable${e.returning ? ' · return / cycle edge' : ''}`
    return svg`<path class="flow-edge" d=${flowRibbon(e)} fill=${pkgColor(to.pkg)} opacity=${dimmed ? .04 : active ? .8 : related ? .6 : .22}
      stroke=${e.returning ? 'var(--text)' : 'none'} stroke-width=".7" stroke-dasharray=${e.returning ? '3 3' : ''}
      role="button" tabindex="0" aria-label=${title}
      @click=${() => this.select(e.to, e.id)} @keydown=${event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.select(e.to, e.id) } }}
      @pointerenter=${() => { this.hover = e.id; this.requestUpdate() }} @pointerleave=${() => { this.hover = null; this.requestUpdate() }}><title>${title}</title></path>`
  }

  renderLinks(edges, incoming = false) {
    return edges.toSorted((a, b) => b.size - a.size).slice(0, 100).map(e => {
      const n = this.model.byId.get(incoming ? e.from : e.to)
      return html`<button class="flow-link" title=${n.label} @click=${() => this.select(n.id, e.id)}><i style=${`background:${pkgColor(n.pkg)}`}></i><span>${n.label}</span><b>${shortSize(e.size)}</b></button>`
    })
  }

  renderSearch() {
    if (!graph2.pathFilter.trim()) return null
    const matches = [...this.model.byId.values()].filter(n => this.matches(n)).toSorted((a, b) => b.size - a.size)
    return html`<h4>Matches · ${matches.length}</h4>${matches.slice(0, 100).map(n => html`<button class="flow-link" title=${n.label} @click=${() => this.follow(n.id)}><span>${n.label}</span><b>${shortSize(n.size)}</b></button>`)}
      ${matches.length > 100 ? html`<p>Showing the 100 largest matches. Refine the search to find any file or package, including those beyond the visible graph.</p>` : null}`
  }

  renderPanel() {
    const node = this.model.byId.get(this.selection?.node)
    const edge = this.model.edges.find(e => e.id === this.selection?.edge)
    if (!node) {return html`<h3>Size flow</h3><div class="flow-metrics"><b>${shortSize(this.model.total.size)}</b><span>unique reachable source</span></div>
      <p>Ribbons show the total source size reachable through each import. Shared code contributes its full size to every loading edge, so flows are not additive.</p>
      <p>Bars make room for incoming and outgoing ribbons. Select a file or ribbon to compare its own size with its unique reachable size.</p>
      <p>Dashed ribbons return to an earlier level, including cycles. Thin ribbons have a minimum visible width.</p>
      ${this.model.total.missing ? html`<p>${this.model.total.missing} files have unknown sizes; totals include known bytes only.</p>` : null}
      ${this.model.weakEdges ? html`<p>${this.model.weakEdges} weak config/metadata loads excluded.</p>` : null}
      ${this.model.omittedFiles ? html`<p>${this.model.omittedFiles} files are not reachable from these entry points.</p>` : null}
      <h4>${this.model.inferred ? 'Inferred roots (no entry points in this view)' : 'Entry points'}</h4>
      ${this.model.roots.slice(0, 100).map(id => { const n = this.model.byId.get(id); return html`<button class="flow-link" @click=${() => this.select(id)}><span>${n.label}</span><b>${shortSize(n.size)}</b></button>` })}
      ${this.model.roots.length > 100 ? html`<p>Showing the first 100 entry points. Search to find another.</p>` : null}`}
    return html`<div class="flow-panel-heading"><h3>${node.label}</h3><button aria-label="Clear flow selection" @click=${() => { this.selection = null; this.requestUpdate() }}>×</button></div>
      ${edge ? html`<p class="flow-direction">${this.model.byId.get(edge.from).label}<br>↓ imports<br>${this.model.byId.get(edge.to).label}</p><div class="flow-metrics"><b>${shortSize(edge.size)}</b><span>reachable through this edge · ${edge.count} ${edge.count === 1 ? 'file import' : 'file imports'}</span></div>` : null}
      <div class="flow-metrics"><b>${shortSize(node.size)}</b><span>unique reachable size</span><b>${shortSize(node.own)}</b><span>own source size · ${node.files.length} ${node.files.length === 1 ? 'file' : 'files'}</span></div>
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
    const { nodes, edges, width, height, hidden } = this.layout
    return html`<section class="flow-stage" aria-label="Dependency size flow">
      <div class="flow-controls"><button ?disabled=${!this.focus} @click=${() => this.follow(null)}>Entry points</button>
        <label>Depth <select aria-label="Flow depth" .value=${String(this.depth)} @change=${e => { this.depth = Number(e.target.value); this.requestUpdate() }}>
          ${[1, 2, 3, 4, 6, 10, Infinity].map(n => html`<option value=${String(n)} ?selected=${this.depth === n}>${n === Infinity ? 'All' : n}</option>`)}
        </select></label>
        <button aria-label="Zoom out" @click=${() => { this.zoom = Math.max(.5, this.zoom / 1.5); this.requestUpdate() }}>−</button>
        <button @click=${() => this.fit()}>Fit</button>
        <button aria-label="Zoom in" @click=${() => { this.zoom = Math.min(12, this.zoom * 1.5); this.requestUpdate() }}>+</button>
        <span>${nodes.length} ${this.packages ? nodes.length === 1 ? 'package' : 'packages' : nodes.length === 1 ? 'file' : 'files'}${hidden ? ` · ${hidden} beyond this view` : ''}</span>
      </div>
      ${hidden ? html`<p class="flow-notice">Select a deeper level or All to show more dependencies. Sizes include dependencies beyond the selected depth.</p>` : null}
      <div class="flow-scroll"><svg class="flow-chart" style=${`width:${this.zoom * 100}%;min-width:${this.zoom * 500}px`} viewBox=${`0 0 ${width} ${height}`} role="group" aria-label="Import ribbons weighted by total reachable bytes">
        <text class="flow-level" x="24" y="24">${this.focus ? this.model.byId.get(this.focus).label : this.model.inferred ? 'Inferred roots' : 'Entry points'} ↓</text>
        ${edges.map(e => this.renderEdge(e))}${nodes.map(n => this.renderNode(n))}
      </svg>${nodes.length > 0 ? null : html`<p>No recorded dependency paths in this view.</p>`}</div>
    </section><aside class="flow-panel" aria-label="Size flow details" aria-live="polite">${this.renderSearch()}${this.renderPanel()}</aside>`
  }
}

customElements.define('size-flow', SizeFlow)
