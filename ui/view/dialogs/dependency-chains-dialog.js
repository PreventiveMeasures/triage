import { html, nothing, svg, unsafeCSS } from 'lit'
import { styleMap } from 'lit/directives/style-map.js'
import { autorun } from '@rray/frontend/state-management'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { bundleDependencyChains, layoutDependencyChains, traceDependencyChains } from '../bundle-dependency-chains.js'
import { pkgColor } from '../graph/utils.js'
import styles from './dialog-dependency-chains.css'

class DependencyChainsDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(styles)]
  static properties = { _active: { state: true }, _current: { state: true } }
  constructor() { super(); this._active = null }

  connectedCallback() {
    super.connectedCallback()
    this.graph = bundleDependencyChains(this.details, this)
    this.layout = layoutDependencyChains(this.graph)
    this._dispose = autorun(() => {
      this._current = this.isCurrent()
      if (!this._current) queueMicrotask(this._onClose)
    })
  }
  firstUpdated() {
    super.firstUpdated()
    const scroller = this.renderRoot.querySelector('.graph-scroll')
    if (!scroller) return
    // Keep the app and selected version in view when the viewport is narrow;
    // side branches remain reachable by scrolling, with readable labels.
    this._resize = new ResizeObserver(() => { scroller.scrollLeft = (this.layout.width - scroller.clientWidth) / 2 })
    this._resize.observe(scroller)
  }
  disconnectedCallback() { this._dispose?.(); this._resize?.disconnect(); super.disconnectedCallback() }

  renderNode(id) {
    const node = this.graph.nodes.get(id)
    const parents = [...this.graph.importedBy.get(id)].map(parent => this.graph.nodes.get(parent))
    const version = `${node.version || 'Source'}${node.ecosystem && node.ecosystem !== 'npm' ? ` · ${node.ecosystem}` : ''}`
    const description = parents.length > 0 ? `Imported by ${parents.map(parent => `${parent.name}${parent.version ? `@${parent.version}` : ''}`).join(', ')}.`
      : node.root ? 'Bundle entry point or app source.' : 'No importer is recorded in this scope.'
    return html`<div class=${`package${node.target ? ' selected' : ''}`} tabindex="0" role="group"
      aria-label=${`${node.ecosystem ? `${node.ecosystem}:` : ''}${node.name}${node.version ? `@${node.version}` : ''}. ${description} Location: ${id}.`}
      style=${styleMap({ '--package-color': pkgColor(node.own ? '__own__' : node.name) })}>
      <span class="name" data-tooltip=${node.name} data-tooltip-truncated>${node.name}</span>
      <div class="package-meta"><span class="version" data-tooltip=${version} data-tooltip-truncated>${version}</span>
        ${node.target ? html`<span class="badge selected-badge">Selected</span>` : nothing}
        ${node.root ? html`<span class="badge">${node.own ? 'App' : 'Entry point'}</span>` : nothing}
      </div>
      <span class="location" data-tooltip=${id} data-tooltip-truncated>${node.own ? 'App source' : id}</span>
    </div>`
  }

  renderGraph() {
    const { boxes, edges, width, height } = this.layout, highlighted = traceDependencyChains(this.layout, this._active)
    const hasImporter = new Set(edges.map(edge => edge.to))
    const unrecorded = boxes.filter(box => !hasImporter.has(box.id) && !box.members.some(id => this.graph.nodes.get(id).root))
    return html`<div class="graph-scroll" tabindex="0" aria-label="Package dependency chains. Arrows point from importer to dependency.">
      <div class="graph" style=${styleMap({ width: `${width}px`, height: `${height}px` })}>
        <svg class="connections" width=${width} height=${height} aria-hidden="true">
          <defs><marker id="dependency-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10z" fill="context-stroke"/></marker></defs>
          ${edges.map(edge => svg`<path d=${edge.path} class=${highlighted && !highlighted.edges.has(edge) ? 'dimmed' : ''} marker-end="url(#dependency-arrow)"/>`)}
        </svg>
        ${boxes.map(box => html`<div class=${`package-group${box.members.length > 1 ? ' cycle' : ''}${highlighted && !highlighted.groups.has(box.id) ? ' dimmed' : ''}`}
          style=${styleMap({ left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px` })}
          @pointerenter=${() => { this._active = box.id }} @pointerleave=${() => { this._active = null }}
          @focusin=${() => { this._active = box.id }} @focusout=${() => { this._active = null }}>
          ${box.members.length > 1 ? html`<div class="cycle-label">Circular imports</div>` : nothing}
          ${box.members.map(id => this.renderNode(id))}
        </div>`)}
      </div>
      ${unrecorded.length > 0 ? html`<p class="note">Some chains have no recorded app or entry point. These packages are bundled, but their origin is not captured in this scope.</p>` : nothing}
    </div>`
  }

  render() {
    if (!this._current) return nothing
    const { nodes, targets } = this.graph
    return html`<dialog aria-labelledby="dependency-title" @close=${this._onClose}>
      <header><div><p class="eyebrow">Why is this version here?</p><h3 id="dependency-title">${this.packageKey}<span class="heading-version">${this.version}</span></h3></div>
        <button type="button" aria-label="Close dependency chains" @click=${this._onClose}>×</button>
      </header>
      <div class="graph-caption">
        <span>${nodes.size} ${nodes.size === 1 ? 'package' : 'packages'}${targets.length > 1 ? ` · ${targets.length} installations of this version` : ''}${this.reason ? ` · Scope: ${this.reason}` : ''}</span>
        <span>↓ imports · Hover or focus to trace a chain</span>
      </div>
      ${targets.length > 0 ? this.renderGraph() : html`<p class="empty">Dependency metadata for this version is not available in this bundle scope.</p>`}
    </dialog>`
  }
}
customElements.define('dependency-chains-dialog', DependencyChainsDialog)

export function openDependencyChainsDialog(props) {
  return openAppDialog('dependency-chains-dialog', props)
}
