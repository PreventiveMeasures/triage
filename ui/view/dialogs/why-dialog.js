import { html, nothing, svg, unsafeCSS } from 'lit'
import { styleMap } from 'lit/directives/style-map.js'
import { repeat } from 'lit/directives/repeat.js'
import { autorun } from '@rray/frontend/state-management'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { bundleWhy, layoutWhy, traceWhy } from '../bundle-why.js'
import { WHY_CARD_HEIGHT, WHY_CARD_WIDTH, WHY_DIALOG_GUTTER } from '../why-layout.js'
import { pkgColor } from '../graph/utils.js'
import styles from './dialog-why.css'

const packageColor = node => pkgColor(node.own ? '__own__' : node.name)
const graphViewportWidth = () => Math.floor(Math.min(document.documentElement.clientWidth * .94, 80 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize)))

class WhyDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(styles)]
  static properties = { _active: { state: true }, _current: { state: true }, _hovered: { state: true }, _focused: { state: true }, layout: { state: true } }
  constructor() { super(); this._active = null; this._hovered = null; this._focused = null }
  _expandedCycles = new Set()

  layoutForViewport() {
    const focused = this.renderRoot?.activeElement
    this._hovered = null
    this._maxWidth = graphViewportWidth()
    this.layout = layoutWhy(this.graph, { maxWidth: this._maxWidth, expandedCycles: this._expandedCycles })
    // Keyed cards survive regrouping, but moving a focused DOM node can blur
    // it. Keep the same package focused and visible after the new placement.
    if (focused?.matches('.package, .cycle-toggle')) {
      this.updateComplete.then(() => {
        if (this._current && focused.isConnected) {
          focused.focus({ preventScroll: true })
          focused.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
        return undefined
      })
    }
  }

  toggleCycle(id) {
    if (this._expandedCycles.has(id)) this._expandedCycles.delete(id)
    else this._expandedCycles.add(id)
    this._focused = null
    this.layoutForViewport()
  }

  connectedCallback() {
    super.connectedCallback()
    this.graph = bundleWhy(this.details, this)
    this.layoutForViewport()
    this._dispose = autorun(() => {
      this._current = this.isCurrent()
      if (!this._current) queueMicrotask(this._onClose)
    })
  }
  firstUpdated() {
    super.firstUpdated()
    const scroller = this.renderRoot.querySelector('.graph-scroll')
    if (!scroller) return
    // Keep the app and selected packages in view when the viewport is narrow;
    // side branches remain reachable by scrolling, with readable labels.
    this._resize = new ResizeObserver(() => {
      const maxWidth = graphViewportWidth()
      if (maxWidth !== this._maxWidth) { this.layoutForViewport(); return }
      // Expansion also resizes the scroller. Keep focused side-branch toggles
      // in view instead of undoing layoutForViewport's focus restoration.
      if (!this.renderRoot.activeElement?.matches('.package, .cycle-toggle')) scroller.scrollLeft = (this.layout.width - scroller.clientWidth) / 2
    })
    this._resize.observe(scroller)
    this._resize.observe(document.documentElement)
  }
  disconnectedCallback() { this._dispose?.(); this._resize?.disconnect(); super.disconnectedCallback() }

  renderNode({ id, x, y }, neighbors) {
    const node = this.graph.nodes.get(id)
    const parents = [...this.graph.importedBy.get(id)].map(parent => this.graph.nodes.get(parent))
    const version = `${node.version || 'Source'}${node.ecosystem && node.ecosystem !== 'npm' ? ` · ${node.ecosystem}` : ''}`
    const description = parents.length > 0 ? `Imported by ${parents.map(parent => `${parent.name}${parent.version ? `@${parent.version}` : ''}`).join(', ')}.`
      : node.root ? 'Bundle entry point or app source.' : node.traceBoundary || node.excludedImporters?.size ? 'Dependency tracing stops here.' : 'No importer is recorded in this scope.'
    return html`<div class=${`package${node.target ? ' selected' : ''}${neighbors && !neighbors.has(id) ? ' package-subdued' : ''}`} tabindex="0" role="group"
      @pointerenter=${() => { this._hovered = id }} @pointerleave=${() => { this._hovered = null }}
      @focus=${() => { this._focused = id }} @blur=${() => { this._focused = null }}
      aria-label=${`${node.ecosystem ? `${node.ecosystem}:` : ''}${node.name}${node.version ? `@${node.version}` : ''}. ${description} Location: ${id}.`}
      style=${styleMap({ left: `${x}px`, top: `${y}px`, '--package-color': packageColor(node) })}>
      <div class="package-main"><span class="name" data-tooltip=${node.name} data-tooltip-truncated>${node.name}</span>
        <span class="version" data-tooltip=${version} data-tooltip-truncated>${version}</span></div>
      <div class="package-meta"><span class="location" data-tooltip=${id} data-tooltip-truncated>${node.own ? 'App source' : id}</span>
        ${node.target ? html`<span class="badge selected-badge">Selected</span>` : nothing}
        ${node.root ? html`<span class="badge">${node.own ? 'App' : 'Entry point'}</span>` : nothing}
      </div>
    </div>`
  }

  renderGraph() {
    const { boxes, edges, width, height } = this.layout
    const activePackage = this._hovered ?? this._focused
    const activeGroup = activePackage === null ? this._active : this.layout.componentOf.get(activePackage)
    const highlighted = traceWhy(this.layout, activeGroup)
    const neighbors = activePackage === null ? null : new Set([activePackage, ...this.graph.imports.get(activePackage), ...this.graph.importedBy.get(activePackage)])
    const hasImporter = new Set(edges.map(edge => edge.to))
    const unrecorded = boxes.filter(box => !hasImporter.has(box.id) && !box.members.some(id => {
      const node = this.graph.nodes.get(id)
      // Only cuts from outside this group explain its missing incoming chain.
      return node.root || node.traceBoundary
        || [...(node.excludedImporters ?? [])].some(parent => this.layout.componentOf.get(parent) !== box.id)
    }))
    return html`<div class="graph-scroll" tabindex="0" aria-label="Package dependency chains. Arrows point from importer to dependency.">
      <div class="graph" style=${styleMap({ width: `${width}px`, height: `${height}px`, '--package-width': `${WHY_CARD_WIDTH}px`, '--package-height': `${WHY_CARD_HEIGHT}px` })}>
        <svg class="connections" width=${width} height=${height} aria-hidden="true">
          <defs><marker id="dependency-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10z" fill="context-stroke"/></marker></defs>
          ${edges.map(edge => {
            const direct = edge.fromPackage === activePackage || edge.toPackage === activePackage
            const unrelated = highlighted && !highlighted.edges.has(edge)
              || activePackage !== null && (edge.from === activeGroup || edge.to === activeGroup) && !direct
            return svg`<path d=${edge.path} class=${unrelated ? 'dimmed' : direct ? 'traced' : ''}
              style=${styleMap({ '--connection-color': packageColor(this.graph.nodes.get(edge.fromPackage)) })} marker-end="url(#dependency-arrow)"/>`
          })}
        </svg>
        ${boxes.map(box => this.renderGroup(box, highlighted, activePackage, neighbors))}
      </div>
      ${unrecorded.length > 0 ? html`<p class="note">Some chains have no recorded app or entry point. These packages are bundled, but their origin is not captured in this scope.</p>` : nothing}
    </div>`
  }

  renderGroup(box, highlighted, activePackage, neighbors) {
    const selected = box.members.some(id => this.graph.nodes.get(id).target)
    const adjacent = neighbors && box.members.some(id => neighbors.has(id))
    return html`<div class=${`package-group${box.stacked ? ' stacked' : ''}${box.members.length > 1 ? ' cycle' : ''}${box.members.length > 8 ? ' large-cycle' : ''}${box.collapsed ? ' collapsed' : ''}${box.collapsed && selected ? ' selected-cycle' : ''}${highlighted && !highlighted.groups.has(box.id) ? ' dimmed' : ''}`}
      style=${styleMap({ left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` })}
      @pointerenter=${() => { this._active = box.id }} @pointerleave=${() => { this._active = null }}>
      ${box.collapsible ? html`<button type="button" class="cycle-label cycle-toggle" aria-expanded=${!box.collapsed} aria-controls=${`cycle-content-${box.id}`}
        @click=${() => this.toggleCycle(box.id)}>
        <span class="cycle-chevron" aria-hidden="true">${box.collapsed ? '▸' : '▾'}</span>
        <span class="cycle-summary"><span>Circular imports</span><span class="cycle-count">${box.members.length} packages</span></span>
        ${box.collapsed && selected ? html`<span class="badge selected-badge">Selected</span>` : nothing}
      </button>` : box.members.length > 1 ? html`<div class="cycle-label">Circular imports${box.members.length > 8 ? ` · ${box.members.length} packages` : ''}</div>` : nothing}
      <div id=${`cycle-content-${box.id}`} ?hidden=${box.collapsed}>
      ${box.internalEdges.length > 0 ? html`<svg class="connections cycle-connections" width=${box.width} height=${box.height} aria-hidden="true">
        ${box.internalEdges.map(edge => svg`<path d=${edge.path}
          class=${adjacent ? edge.from === activePackage || edge.to === activePackage ? 'traced' : 'subdued' : ''}
          style=${styleMap({ '--connection-color': packageColor(this.graph.nodes.get(edge.from)) })} marker-end="url(#dependency-arrow)"/>`)}
      </svg>` : nothing}
      ${repeat(box.packages, node => node.id, node => this.renderNode(node, adjacent ? neighbors : null))}
      </div>
    </div>`
  }

  render() {
    if (!this._current) return nothing
    const { nodes, targets } = this.graph
    return html`<dialog aria-labelledby="why-title" style=${styleMap({ '--graph-dialog-width': `${Math.max(480, this.layout.width + WHY_DIALOG_GUTTER)}px` })} @close=${this._onClose} @click=${this._onBackdrop}>
      <header><h3 id="why-title">${this.packageKey}${this.version === undefined ? nothing : html`<span class="heading-version">${this.version}</span>`}</h3>
        <button type="button" aria-label="Close dependency chains" @click=${this._onClose}>×</button>
      </header>
      <div class="graph-caption">
        <span>${nodes.size} ${nodes.size === 1 ? 'package' : 'packages'}${targets.length > 1 ? ` · ${targets.length} installations${this.version === undefined ? '' : ' of this version'}` : ''}${this.reason ? ` · Scope: ${this.reason}` : ''}</span>
        <span>↓ imports</span>
      </div>
      ${targets.length > 0 ? this.renderGraph() : html`<p class="empty">Dependency metadata for this ${this.version === undefined ? 'package' : 'version'} is not available in this bundle scope.</p>`}
    </dialog>`
  }
}
customElements.define('why-dialog', WhyDialog)

export function openWhyDialog(props) {
  return openAppDialog('why-dialog', props)
}
