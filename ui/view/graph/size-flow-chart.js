import { svg } from 'lit'
import { formatBytes } from '../format.js'
import { graph2 } from './state.js'
import { pkgColor } from './utils.js'
import { textOnPackage } from './colors.js'
import { flowRibbon, sizeFlowConnector } from './size-flow-model.js'

export const shortSize = formatBytes

// Retain the geometry and delegated listeners across inspector/filter updates.
// Hover touches at most two ribbons; selection only touches incident edges.
export class SizeFlowChart {
  constructor(host) { this.host = host }

  render() {
    const { layout, model } = this.host
    if (this.layout === layout) return this.template
    this.layout = layout; this.model = model
    this.template = svg`<g @click=${e => this.activate(e)} @dblclick=${e => this.activate(e, true)}
      @keydown=${e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.activate(e) } }}
      @pointerover=${e => this.setHover(e.target.closest('[data-flow-edge]')?.dataset.flowEdge ?? null)}
      @pointerout=${e => this.setHover(e.relatedTarget?.closest?.('[data-flow-edge]')?.dataset.flowEdge ?? null)}>
      ${layout.edges.map(e => this.renderEdge(e))}${layout.nodes.map(n => this.renderNode(n))}
      <rect class="flow-selection" height="26" visibility="hidden" aria-hidden="true"></rect>
    </g>`
    return this.template
  }

  renderNode(n) {
    const tooltip = `${n.label}\n${formatBytes(n.removable)} unique · ${formatBytes(n.size)} reachable · ${formatBytes(n.own)} own${n.removableMissing ? ` · ${n.removableMissing} removed file sizes unknown` : ''}${sizeFlowConnector(n, this.host.minSize) ? '\nKept by Large to preserve an entry-point path' : ''}`
    const label = n.width >= 40 ? `${n.label.replace(/^node_modules\//u, '')} · ${shortSize(n.removable)}` : ''
    return svg`<g class="flow-node" data-flow-node=${n.id} role="button" tabindex="0" aria-label=${tooltip} data-tooltip=${tooltip} aria-pressed="false" fill=${textOnPackage(pkgColor(n.pkg))}>
      <rect x=${n.x} y=${n.y} width=${n.width} height="26" style=${`--flow-bar-width:${n.width}px`} fill=${pkgColor(n.pkg)} stroke="var(--flow-background)"></rect>
      ${label ? svg`<svg x=${n.x + 5} y=${n.y} width=${Math.max(0, n.width - 10)} height="26"><text x="0" y="18">${label}</text></svg>` : null}
    </g>`
  }

  renderEdge(e) {
    const from = this.model.byId.get(e.from), to = this.model.byId.get(e.to)
    const tooltip = `${from.label} → ${to.label}\n${formatBytes(e.size)} reachable${e.returning ? ' · return / cycle edge' : ''}`
    return svg`<path class="flow-edge" data-flow-edge=${e.id} d=${flowRibbon(e)} fill=${pkgColor(to.pkg)} opacity=".22"
      stroke=${e.returning ? 'var(--text)' : 'none'} stroke-width=".7" stroke-dasharray=${e.returning ? '3 3' : ''}
      role="button" tabindex="0" aria-label=${tooltip} data-tooltip=${tooltip}></path>`
  }

  activate(e, follow = false) {
    const target = e.target.closest('[data-flow-node], [data-flow-edge]')
    if (!target) return
    const node = target.dataset.flowNode
    if (node) { if (follow) this.host.follow(node); else this.host.select(node); return }
    const edge = this.model.edgeById.get(target.dataset.flowEdge)
    if (edge && !follow) this.host.select(edge.to, edge.id)
  }

  setHover(id) {
    if (this.host.drag?.moved) id = null
    const previous = this.host.hover
    if (previous === id) return
    this.host.hover = id
    this.paintEdge(previous); this.paintEdge(id)
  }

  matchingNodes() {
    const model = this.host.model
    const key = JSON.stringify([this.host.minSize, this.host.graph.issuesHidden, graph2.pathFilter, [...graph2.selectedSeverities].toSorted(), [...graph2.selectedColors].toSorted()])
    if (this.matchModel !== model || this.filterKey !== key) {
      this.matches = new Set([...model.byId.values()].filter(n => this.host.matches(n)).map(n => n.id))
      this.matchModel = model; this.filterKey = key
      this.searchResult = null
    }
    return this.matches
  }

  searchMatches() {
    const ids = this.matchingNodes()
    return this.searchResult ??= [...ids].map(id => this.host.model.byId.get(id)).toSorted((a, b) => b.removable - a.removable)
  }

  update(root) {
    if (!this.layout) return
    const fresh = this.domLayout !== this.layout
    if (fresh) {
      this.nodes = new Map([...root.querySelectorAll('[data-flow-node]')].map(el => [el.dataset.flowNode, el]))
      this.edges = new Map([...root.querySelectorAll('[data-flow-edge]')].map(el => [el.dataset.flowEdge, el]))
      this.outline = root.querySelector('.flow-selection')
      this.domLayout = this.layout
    }
    // Geometry stays cached on a theme change; repaint only its colors.
    const palette = pkgColor('__own__')
    if (fresh || palette !== this.palette) {
      this.palette = palette
      for (const [id, el] of this.nodes) {
        const color = pkgColor(this.model.byId.get(id).pkg)
        el.querySelector('rect').setAttribute('fill', color)
        el.setAttribute('fill', textOnPackage(color))
      }
      for (const [id, el] of this.edges) el.setAttribute('fill', pkgColor(this.model.byId.get(this.model.edgeById.get(id).to).pkg))
    }
    const matches = this.matchingNodes()
    const all = fresh || matches !== this.paintedMatches
    this.paintedMatches = matches
    const selected = this.host.selection
    const nodeIds = all ? this.nodes.keys() : new Set([this.selected?.node, selected?.node])
    for (const id of nodeIds) {
      const el = this.nodes.get(id)
      if (!el) continue
      const active = id === selected?.node
      el.setAttribute('opacity', this.matches.has(id) ? '1' : '.15')
      el.setAttribute('aria-pressed', String(active))
    }
    // Paint selection after every bar so a neighboring fill/border cannot
    // cover its right edge. Keep the node order and retained SVG unchanged.
    if (this.outline && (fresh || this.selected?.node !== selected?.node)) {
      const node = this.layout.byId.get(selected?.node)
      this.outline.setAttribute('visibility', node ? 'visible' : 'hidden')
      if (node) {
        for (const key of ['x', 'y', 'width']) this.outline.setAttribute(key, String(node[key]))
        this.outline.setAttribute('style', `--flow-bar-width:${node.width}px`)
      }
    }
    if (all) for (const id of this.edges.keys()) this.paintEdge(id)
    else if (this.selected?.node !== selected?.node || this.selected?.edge !== selected?.edge) {
      const ids = new Set([this.selected?.edge, selected?.edge])
      for (const id of [this.selected?.node, selected?.node]) {
        const node = this.model.byId.get(id)
        if (node) for (const e of [...node.incoming, ...node.outgoing]) ids.add(e.id)
      }
      for (const id of ids) this.paintEdge(id)
    }
    this.selected = selected
  }

  paintEdge(id) {
    const edge = this.model?.edgeById.get(id), el = this.edges?.get(id)
    if (!el || !edge) return
    const selected = this.host.selection
    const dimmed = !this.matches.has(edge.from) && !this.matches.has(edge.to)
    const active = selected?.edge === id || this.host.hover === id
    const related = selected?.node === edge.from || selected?.node === edge.to
    el.setAttribute('opacity', String(dimmed ? .04 : active ? .8 : related ? .6 : .22))
  }
}
