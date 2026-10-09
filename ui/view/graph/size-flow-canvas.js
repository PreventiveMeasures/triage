import { html } from '../frontend-global.js'
import { hideTooltip, scheduleTooltip } from '../tooltip.js'
import { graphBackground, textOnPackage } from './colors.js'
import { pkgColor } from './utils.js'
import { flowRibbon } from './size-flow-model.js'
import { SizeFlowChart, flowEdgeTooltip, flowNodeTooltip, shortSize } from './size-flow-chart.js'
import { flowEdgeBounds, flowHitCandidates, flowHitIndex, flowOutside, flowVisibleRibbons } from './size-flow-hit.js'

// This switches renderers, never truncates the graph. Small graphs keep their
// individual SVG controls; large graphs use the same model and full geometry.
export const canvasSizeFlow = layout => layout.nodes.length + layout.edges.length > 1500 && typeof Path2D === 'function'
const canvasLabel = 'Import paths. Use arrow keys to explore bars, Enter to select, or the sidebar search to find a file or package.'
const liveRibbonLimit = 1500

export class SizeFlowCanvas extends SizeFlowChart {
  isCanvas = true

  render() {
    return html`<canvas class="flow-canvas flow-base" aria-hidden="true"></canvas>
      <canvas class="flow-canvas flow-bars" aria-hidden="true"></canvas>
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
    this.clearHover(); this.focused = null; this.invalidateRaster()
  }

  update(root) {
    if (this.layout !== this.host.layout) this.prepare()
    this.base = root.querySelector('.flow-base'); this.bars = root.querySelector('.flow-bars'); this.overlay = root.querySelector('.flow-overlay')
    if (!this.base || !this.bars || !this.overlay) return
    const background = graphBackground(), matches = this.matchingNodes(), palette = pkgColor('__own__')
    if (matches !== this.paintedMatches || palette !== this.palette || background !== this.background) {
      this.paintedMatches = matches; this.palette = palette; this.background = background
      this.colors = new Map([...this.model.byId.values()].map(n => [n.pkg, pkgColor(n.pkg)]))
      this.foreground = getComputedStyle(this.host).getPropertyValue('--text').trim() || '#fff'
      this.invalidateRaster()
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
    this.base = null; this.bars = null; this.overlay = null
    this.invalidateRaster()
  }

  stopPreview() {
    clearTimeout(this.previewTimer)
    if (this.settleFrame != null) cancelAnimationFrame(this.settleFrame)
    this.settleFrame = null
    this.previewTimer = null; this.preview = false
  }

  invalidateRaster() {
    this.stopPreview()
    this.baseKey = null; this.barsKey = null
    this.overview = null; this.paintedViewport = null
  }

  viewportChanged() {
    const { width, height, zoom, pan } = this.host
    const key = `${width}:${height}:${zoom}:${pan.x}:${pan.y}`
    if (key === this.viewportKey) {
      if (this.preview && this.host.fitted) { this.stopPreview(); this.requestDraw() }
      return
    }
    this.viewportKey = key
    this.stopPreview()
    const painted = this.paintedViewport
    if (this.host.fitted === false && this.overview && painted?.width === width && painted.height === height
      && painted.dpr === (globalThis.devicePixelRatio || 1)) {
      this.preview = true
      this.previewTimer = setTimeout(() => {
        this.previewTimer = null
        // Give queued input a frame to cancel the expensive repaint, even
        // if a busy browser delivered this idle timer before its next frame.
        this.settleFrame = requestAnimationFrame(() => {
          this.settleFrame = requestAnimationFrame(() => { this.stopPreview(); this.requestDraw() })
        })
      }, 100)
    }
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
    this.view = { left: -pan.x / zoom, right: (width - pan.x) / zoom, top: -pan.y / zoom, bottom: (height - pan.y) / zoom }
    const liveRibbons = this.preview ? flowVisibleRibbons(this.index, this.view, liveRibbonLimit) : null
    if (liveRibbons) this.stopPreview()
    if (this.preview) {
      this.drawPreview(dpr)
      this.drawBars(dpr, key, true)
      const ctx = this.context(this.overlay, dpr), selected = this.layout.byId.get(this.host.selection?.node)
      if (selected) {
        ctx.globalAlpha = 1; ctx.strokeStyle = this.foreground; ctx.lineWidth = Math.min(1.5 / zoom, selected.width / 2)
        ctx.strokeRect(selected.x, selected.y, selected.width, 26)
      }
      this.previewVisible = true
      return
    }
    const redraw = this.baseKey !== key
    if (redraw) {
      const ctx = this.context(this.base, dpr)
      ctx.globalAlpha = 1; ctx.fillStyle = this.background; ctx.fillRect(this.view.left, this.view.top, width / zoom, height / zoom)
      this.visiblePaths = liveRibbons ?? this.paths.filter(entry => !flowOutside(entry, this.view))
      for (const entry of this.visiblePaths) this.paintPath(ctx, entry, this.edgeAlpha(entry.edge))
      this.baseKey = key
      this.paintedViewport = { width, height, zoom, pan: { ...pan }, dpr }
      // Keep one full overview as a fallback for areas newly exposed by a
      // gesture. The detailed viewport alone would leave holes on zoom-out.
      if (this.view.left <= 0 && this.view.top <= 0 && this.view.right >= this.layout.width - 1e-6 && this.view.bottom >= this.layout.height - 1e-6) {
        const canvas = this.overview?.canvas ?? document.createElement('canvas')
        canvas.width = this.base.width; canvas.height = this.base.height
        canvas.getContext('2d').drawImage(this.base, 0, 0)
        this.overview = { ...this.paintedViewport, canvas }
      }
    }
    this.drawBars(dpr, key)
    this.drawHighlight(dpr, redraw || this.previewVisible)
    this.previewVisible = false
  }

  drawPreview(dpr) {
    // The cached images contain ribbons only. Composite them underneath fresh
    // bars while input arrives, then redraw the ribbons precisely when idle.
    // Clip before scaling so even deep zoom copies at most viewport pixels.
    const { width, height, pan, zoom } = this.host, ctx = this.context(this.bars, dpr, false)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = false
    const detail = { ...this.paintedViewport, canvas: this.base }, scale = zoom / detail.zoom
    const x = pan.x - detail.pan.x * scale, y = pan.y - detail.pan.y * scale
    const coversViewport = x <= 0 && y <= 0 && x + detail.width * scale >= width && y + detail.height * scale >= height
    if (!coversViewport) { ctx.fillStyle = this.background; ctx.fillRect(0, 0, width, height) }
    for (const snapshot of coversViewport ? [detail] : [this.overview, detail]) {
      const factor = zoom / snapshot.zoom, sx = pan.x - snapshot.pan.x * factor, sy = pan.y - snapshot.pan.y * factor
      const left = Math.max(0, sx), top = Math.max(0, sy)
      const bottom = Math.min(height, sy + snapshot.height * factor), right = Math.min(width, sx + snapshot.width * factor)
      if (right <= left || bottom <= top) continue
      const pixelScale = snapshot.dpr / factor
      ctx.drawImage(snapshot.canvas, (left - sx) * pixelScale, (top - sy) * pixelScale,
        (right - left) * pixelScale, (bottom - top) * pixelScale, left, top, right - left, bottom - top)
    }
  }

  drawBars(dpr, key, preview = false) {
    if (!preview && this.barsKey === key && !this.previewVisible) return
    if (this.barsKey !== key) {
      this.visibleNodes = this.layout.nodes.filter(node =>
        !flowOutside({ left: node.x, right: node.x + node.width, top: node.y, bottom: node.y + 26 }, this.view))
    }
    // During a gesture the bars layer already contains the projected ribbons.
    // Redraw bars at the current scale on every input frame, keeping labels
    // sharp and borders thin. Hover alone never repaints this layer.
    const ctx = this.context(this.bars, dpr, !preview)
    for (const node of this.visibleNodes) this.paintNode(ctx, node)
    this.barsKey = key
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
    // Reveal the separate bars layer through the highlighted ribbons. This
    // keeps labels crisp and preserves the opacity of dimmed bars.
    if (highlights.length > 0) {
      ctx.save(); ctx.beginPath()
      const region = { left: x, right: x + width, top: y, bottom: y + height }
      for (const node of this.visibleNodes) {
        if (!flowOutside({ left: node.x, right: node.x + node.width, top: node.y, bottom: node.y + 26 }, region)) ctx.rect(node.x, node.y, node.width, 26)
      }
      ctx.clip(); ctx.clearRect(x, y, width, height); ctx.restore()
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
    let index = nodes.findIndex(n => n.id === (this.focused ?? this.host.selection?.node))
    if (['ArrowRight', 'ArrowDown'].includes(event.key)) index = Math.min(nodes.length - 1, index + 1)
    else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) index = Math.max(0, index - 1)
    else if (event.key === 'Home') index = 0
    else if (event.key === 'End') index = nodes.length - 1
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.host.select(nodes[Math.max(0, index)].id); return }
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
