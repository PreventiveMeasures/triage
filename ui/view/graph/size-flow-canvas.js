import { html } from '../frontend-global.js'
import { hideTooltip, scheduleTooltip } from '../tooltip.js'
import { graphBackground, textOnPackage } from './colors.js'
import { pkgColor } from './utils.js'
import { flowRibbon } from './size-flow-model.js'
import { SizeFlowChart, flowEdgeTooltip, flowNodeTooltip, shortSize } from './size-flow-chart.js'
import { flowEdgeBounds, flowHitCandidates, flowHitIndex, flowOutside } from './size-flow-hit.js'

// This switches renderers, never truncates the graph. Small graphs keep their
// individual SVG controls; large graphs use the same model and full geometry.
export const canvasSizeFlow = layout => layout.nodes.length + layout.edges.length > 1500 && typeof Path2D === 'function'
const canvasLabel = 'Import paths. Use arrow keys to explore bars, Enter to select, or the sidebar search to find a file or package.'

export class SizeFlowCanvas extends SizeFlowChart {
  isCanvas = true

  render() {
    return html`<canvas class="flow-canvas flow-base" aria-hidden="true"></canvas>
      <canvas class="flow-canvas flow-overlay" tabindex="0" role="group"
        aria-label=${canvasLabel}
        @pointermove=${e => this.pointer(e)} @pointerleave=${() => this.clearHover()}
        @click=${e => this.click(e)} @dblclick=${e => this.click(e, true)} @keydown=${e => this.key(e)}></canvas>`
  }

  prepare() {
    this.layout = this.host.layout; this.model = this.host.model
    this.paths = this.layout.edges.map((edge, order) => ({ edge, order, path: new Path2D(flowRibbon(edge)), ...flowEdgeBounds(edge) }))
    this.pathById = new Map(this.paths.map(entry => [entry.edge.id, entry]))
    const nodes = this.layout.nodes.map((node, i) => ({ node, order: this.paths.length + i,
      left: node.x, right: node.x + node.width, top: node.y, bottom: node.y + 26 }))
    this.index = flowHitIndex([...this.paths, ...nodes])
    this.clearHover(); this.focused = null; this.baseKey = null
  }

  update(root) {
    if (this.layout !== this.host.layout) this.prepare()
    this.base = root.querySelector('.flow-base'); this.overlay = root.querySelector('.flow-overlay')
    if (!this.base || !this.overlay) return
    const background = graphBackground(), matches = this.matchingNodes(), palette = pkgColor('__own__')
    if (matches !== this.paintedMatches || palette !== this.palette || background !== this.background) {
      this.paintedMatches = matches; this.palette = palette; this.background = background
      this.colors = new Map([...this.model.byId.values()].map(n => [n.pkg, pkgColor(n.pkg)]))
      this.foreground = getComputedStyle(this.host).getPropertyValue('--text').trim() || '#fff'
      this.baseKey = null
    }
    this.requestDraw()
  }

  requestDraw() {
    if (this.frame != null || !this.overlay) return
    this.frame = requestAnimationFrame(() => { this.frame = null; this.draw() })
  }

  dispose() {
    this.clearHover()
    if (this.frame != null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.base = null; this.overlay = null
    this.baseKey = null
  }

  viewportChanged() {
    const { width, height, zoom, pan } = this.host
    const key = `${width}:${height}:${zoom}:${pan.x}:${pan.y}`
    if (key === this.viewportKey) return
    this.viewportKey = key
    this.clearHover(); this.requestDraw()
  }

  context(canvas, dpr, clear = true) {
    const height = Math.ceil(this.host.height * dpr), width = Math.ceil(this.host.width * dpr)
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (clear) ctx.clearRect(0, 0, width, height)
    const { pan, zoom } = this.host
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * pan.x, dpr * pan.y)
    return ctx
  }

  draw() {
    if (!this.overlay || !this.host.width || !this.host.height) return
    const { pan, zoom, width, height } = this.host, dpr = globalThis.devicePixelRatio || 1
    const key = `${this.viewportKey}:${dpr}`
    const redraw = this.baseKey !== key
    if (redraw) {
      this.view = { left: -pan.x / zoom, right: (width - pan.x) / zoom, top: -pan.y / zoom, bottom: (height - pan.y) / zoom }
      const ctx = this.context(this.base, dpr)
      ctx.globalAlpha = 1; ctx.fillStyle = this.background; ctx.fillRect(this.view.left, this.view.top, width / zoom, height / zoom)
      this.visiblePaths = this.paths.filter(entry => !flowOutside(entry, this.view))
      for (const entry of this.visiblePaths) this.paintPath(ctx, entry, this.edgeAlpha(entry.edge))
      this.visibleNodes = this.layout.nodes.filter(node => !flowOutside({ left: node.x, right: node.x + node.width, top: node.y, bottom: node.y + 26 }, this.view))
      for (const node of this.visibleNodes) this.paintNode(ctx, node)
      this.baseKey = key
    }
    this.drawHighlight(dpr, redraw)
  }

  edgeAlpha(edge) { return !this.matches.has(edge.from) && !this.matches.has(edge.to) ? .04 : .22 }

  paintPath(ctx, entry, alpha) {
    ctx.globalAlpha = alpha; ctx.fillStyle = this.colors.get(this.model.byId.get(entry.edge.to).pkg)
    ctx.fill(entry.path)
    if (entry.edge.returning) {
      ctx.strokeStyle = this.foreground; ctx.lineWidth = .7 / this.host.zoom; ctx.setLineDash([3, 3])
      ctx.stroke(entry.path); ctx.setLineDash([])
    }
  }

  paintNode(ctx, node) {
    if (flowOutside({ left: node.x, right: node.x + node.width, top: node.y, bottom: node.y + 26 }, this.view)) return
    const { zoom } = this.host, color = this.colors.get(node.pkg)
    ctx.globalAlpha = this.matches.has(node.id) ? 1 : .15
    ctx.fillStyle = color; ctx.fillRect(node.x, node.y, node.width, 26)
    // Inset borders use no layout space and occupy at most half the width.
    const border = Math.min(.5 / zoom, node.width / 4, 13)
    ctx.strokeStyle = this.background; ctx.lineWidth = border
    ctx.strokeRect(node.x + border / 2, node.y + border / 2, node.width - border, 26 - border)
    // Don't paint unreadable subpixel glyphs. Bars and hit targets stay present.
    if (node.width >= 40 && node.width * zoom >= 24 && 14 * zoom >= 6) {
      ctx.save(); ctx.beginPath(); ctx.rect(node.x + 5, node.y, Math.max(0, node.width - 10), 26); ctx.clip()
      ctx.font = "14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      ctx.fillStyle = textOnPackage(color)
      ctx.fillText(`${node.label.replace(/^node_modules\//u, '')} · ${shortSize(node.removable)}`, node.x + 5, node.y + 18)
      ctx.restore()
    }
  }

  drawHighlight(dpr, redraw) {
    const selected = this.host.selection
    const edges = new Set([selected?.edge, this.host.hover])
    for (const id of [selected?.node, this.focused]) {
      const node = this.model.byId.get(id)
      if (node) for (const edge of [...node.incoming, ...node.outgoing]) edges.add(edge.id)
    }
    const highlights = []
    for (const id of edges) {
      const entry = this.pathById.get(id)
      if (!entry || flowOutside(entry, this.view) || this.edgeAlpha(entry.edge) === .04) continue
      const alpha = id === selected?.edge || id === this.host.hover ? .8 : .6
      highlights.push({ entry, alpha: (alpha - .22) / (1 - .22) })
    }
    const outlines = [...new Set([selected?.node, this.focused])].map(id => this.layout.byId.get(id)).filter(Boolean)
    const bounds = highlights.map(({ entry }) => entry).concat(outlines.map(node =>
      ({ left: node.x, right: node.x + node.width, top: node.y, bottom: node.y + 26 })))
    const union = boxes => boxes.reduce((area, box) => ({ left: Math.min(area.left, box.left), right: Math.max(area.right, box.right),
      top: Math.min(area.top, box.top), bottom: Math.max(area.bottom, box.bottom) }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity })
    const current = union(bounds), damage = redraw ? this.view : union([current, this.highlightBounds ?? current])
    this.highlightBounds = current
    const ctx = this.context(this.overlay, dpr, redraw)
    const pad = 2 / this.host.zoom
    const x = Math.max(this.view.left, damage.left - pad), y = Math.max(this.view.top, damage.top - pad)
    const height = Math.min(this.view.bottom, damage.bottom + pad) - y, width = Math.min(this.view.right, damage.right + pad) - x
    if (!(width > 0 && height > 0)) return
    // A hover usually damages only one narrow ribbon. Keep the rest of this
    // layer intact, rather than clearing/copying the entire viewport per move.
    if (!redraw) ctx.clearRect(x, y, width, height)
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip()
    for (const { entry, alpha } of highlights) this.paintPath(ctx, entry, alpha)
    // Restore the original pixels over bars. This keeps ribbon highlights
    // behind them, without repainting their text or doubling dimmed opacity.
    if (highlights.length > 0) {
      ctx.save(); ctx.beginPath()
      const region = { left: x, right: x + width, top: y, bottom: y + height }
      for (const node of this.visibleNodes) {
        if (!flowOutside({ left: node.x, right: node.x + node.width, top: node.y, bottom: node.y + 26 }, region)) ctx.rect(node.x, node.y, node.width, 26)
      }
      ctx.clip(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.drawImage(this.base, 0, 0); ctx.restore()
    }
    ctx.globalAlpha = 1; ctx.strokeStyle = this.foreground
    for (const node of outlines) {
      ctx.lineWidth = Math.min(1.5 / this.host.zoom, node.width / 2)
      ctx.strokeRect(node.x, node.y, node.width, 26)
    }
    ctx.restore()
  }

  hit(event) {
    if (!this.overlay || !this.index) return null
    const box = this.overlay.getBoundingClientRect(), { pan, zoom } = this.host
    const x = (event.clientX - box.left - pan.x) / zoom, y = (event.clientY - box.top - pan.y) / zoom
    const ctx = this.overlay.getContext('2d')
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0)
    const hit = flowHitCandidates(this.index, x, y).find(entry => entry.node || ctx.isPointInPath(entry.path, x, y))
    ctx.restore()
    return hit ?? null
  }

  pointer(event) {
    if (this.host.drag) return
    const hit = this.hit(event), id = hit?.node?.id ?? hit?.edge.id ?? null
    if (id !== this.hoverId) {
      this.clearHover(); this.hoverId = id; this.focused = hit?.node?.id ?? null
      this.host.hover = hit?.edge?.id ?? null
      if (hit) {
        this.overlay.dataset.tooltip = hit.node ? flowNodeTooltip(hit.node, this.host.minSize) : flowEdgeTooltip(hit.edge, this.model)
        this.overlay.setAttribute('aria-label', this.overlay.dataset.tooltip)
        this.overlay.style.cursor = 'default'
      }
      this.requestDraw()
    }
    if (hit) scheduleTooltip(this.overlay, { gate: () => !this.host.drag && this.hoverId === id })
  }

  clearHover() {
    hideTooltip(this.host.renderRoot)
    this.hoverId = null; this.focused = null; this.host.hover = null
    if (this.overlay) {
      delete this.overlay.dataset.tooltip; this.overlay.style.cursor = 'grab'
      this.overlay.setAttribute('aria-label', canvasLabel)
    }
    this.requestDraw()
  }

  setHover(id) { if (id == null) this.clearHover(); else { this.host.hover = id; this.requestDraw() } }

  click(event, follow = false) {
    if (event.defaultPrevented) return
    const hit = this.hit(event)
    if (follow) { if (hit?.node) this.host.follow(hit.node.id); return }
    this.host.select(hit?.node?.id ?? hit?.edge.to ?? null, hit?.edge?.id ?? null)
  }

  key(event) {
    const nodes = this.layout.nodes
    if (nodes.length === 0) return
    let index = Math.max(0, nodes.findIndex(n => n.id === (this.focused ?? this.host.selection?.node)))
    if (['ArrowRight', 'ArrowDown'].includes(event.key)) index = Math.min(nodes.length - 1, index + 1)
    else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) index = Math.max(0, index - 1)
    else if (event.key === 'Home') index = 0
    else if (event.key === 'End') index = nodes.length - 1
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.host.select(nodes[index].id); return }
    else if (event.key === 'Escape') { this.clearHover(); this.host.select(null); return }
    else return
    event.preventDefault()
    const node = nodes[index], { pan, zoom, width, height } = this.host
    if (node.x * zoom + pan.x < 0 || (node.x + node.width) * zoom + pan.x > width
      || node.y * zoom + pan.y < 0 || (node.y + 26) * zoom + pan.y > height) {
      this.host.pan = { x: width / 2 - (node.x + node.width / 2) * zoom, y: height / 2 - (node.y + 13) * zoom }
      this.host.fitted = false; this.host.drawViewport()
    }
    this.focused = node.id; this.overlay.setAttribute('aria-label', flowNodeTooltip(node, this.host.minSize)); this.requestDraw()
  }
}
