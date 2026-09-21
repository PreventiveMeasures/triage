import { LitElement, html, unsafeCSS } from '../frontend-global.js'
import { graph2 } from './state.js'
import { pkgColor } from './utils.js'
import { buildDependencyMatrix } from './matrix-model.js'
import { MATRIX_LEFT, MATRIX_TOP, matrixFitCell, matrixHit, matrixZoomCell, paintMatrix } from './matrix-paint.js'
import { renderMatrixPanel } from './matrix-panel.js'
import css from './dependency-matrix.css'
import sidebarListCSS from './sidebar-list.css'
import detailActionCSS from '../../styles/detail-action.css'

class DependencyMatrix extends LitElement {
  static properties = { graph: { attribute: false } }
  static styles = [unsafeCSS(sidebarListCSS), unsafeCSS(css), unsafeCSS(detailActionCSS)]

  constructor() {
    super()
    this.expanded = new Set()
    this.order = 'structure'
    this.cyclesOnly = false
    this.neighborhood = null
    this.selection = null
    this.hover = null
    this.view = { cell: 18, x: 0, y: 0 }
    this.width = 0; this.height = 0
    this.dirty = true; this.needsFit = true
    this.bridge = { requestDraw: () => this.requestUpdate(), _cleanup: () => {} }
  }

  willUpdate(changes) {
    if (!this.graph) return
    if (changes.has('graph') || this.query !== graph2.pathFilter || this.dirty) {
      this.query = graph2.pathFilter
      this.model = buildDependencyMatrix(this.graph, { expanded: this.expanded, order: this.order,
        query: this.query, neighborhood: this.neighborhood, cyclesOnly: this.cyclesOnly })
      if (this.neighborhood && !this.model.byId.has(this.neighborhood)) {
        this.neighborhood = null
        this.model = buildDependencyMatrix(this.graph, { expanded: this.expanded, order: this.order, query: this.query, cyclesOnly: this.cyclesOnly })
      }
      if (this.selection && !this.model.byId.has(this.selection.from)) this.selection = null
      this.hover = null
      this.dirty = false; this.needsFit = true
    }
  }

  firstUpdated() {
    const canvas = this.renderRoot.querySelector('canvas')
    this.canvas = canvas
    this.resizeObserver = new ResizeObserver(() => {
      const box = canvas.parentElement.getBoundingClientRect()
      this.width = box.width; this.height = box.height
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(this.width * dpr); canvas.height = Math.round(this.height * dpr)
      this.clamp()
      this.paint()
    })
    this.resizeObserver.observe(canvas.parentElement)
    this.themeObserver = new MutationObserver(() => this.requestUpdate())
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    this.events = new AbortController()
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) this.zoom(Math.exp(-e.deltaY * .005), e.offsetX, e.offsetY)
      else {
        this.view.x += e.shiftKey ? e.deltaY : e.deltaX
        this.view.y += e.shiftKey ? 0 : e.deltaY
        this.clamp(); this.hover = null; this.paint()
      }
    }, { passive: false, signal: this.events.signal })
  }

  updated() {
    // Shares search/highlight updates with the existing graph toolbar.
    graph2.graphState = this.bridge
    // Render controls in the shared topbar, retaining this component's state
    // and handlers. Pointer/zoom updates need not rerender the parent toolbar.
    const controlsKey = JSON.stringify([this.cyclesOnly, this.model.cycleCount, this.expanded.size, !!this.neighborhood])
    if (controlsKey !== this.controlsKey) {
      this.controlsKey = controlsKey
      this.dispatchEvent(new CustomEvent('matrix-controls-change', { detail: this.renderControls(), bubbles: true, composed: true }))
    }
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.paint())
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.resizeObserver?.disconnect(); this.themeObserver?.disconnect(); this.events?.abort()
    cancelAnimationFrame(this.frame)
    if (graph2.graphState === this.bridge) graph2.graphState = null
  }

  clamp() {
    this.view.cell = matrixZoomCell(this.view.cell, this.model.rows.length, this.width, this.height)
    const size = this.model.rows.length * this.view.cell
    this.view.x = Math.max(0, Math.min(this.view.x, Math.max(0, size - this.width + MATRIX_LEFT + 12)))
    this.view.y = Math.max(0, Math.min(this.view.y, Math.max(0, size - this.height + MATRIX_TOP + 12)))
  }

  fit() {
    this.view = { cell: matrixFitCell(this.model.rows.length, this.width, this.height), x: 0, y: 0 }
    this.needsFit = false
    this.requestUpdate()
  }

  zoom(factor, x = (this.width + MATRIX_LEFT) / 2, y = (this.height + MATRIX_TOP) / 2) {
    const before = this.view.cell, next = matrixZoomCell(before * factor, this.model.rows.length, this.width, this.height)
    this.view.x = (this.view.x + x - MATRIX_LEFT) * next / before - x + MATRIX_LEFT
    this.view.y = (this.view.y + y - MATRIX_TOP) * next / before - y + MATRIX_TOP
    this.view.cell = next; this.clamp(); this.hover = null; this.requestUpdate()
  }

  select(from, to = null, reveal = true) {
    this.selection = { from, to }
    if (reveal && this.model.index.has(from)) {
      this.view.cell = Math.max(16, this.view.cell)
      this.view.y = this.model.index.get(from) * this.view.cell - (this.height - MATRIX_TOP) / 2
      this.view.x = (this.model.index.get(to ?? from) ?? 0) * this.view.cell - (this.width - MATRIX_LEFT) / 2
      this.clamp()
    }
    this.requestUpdate()
  }

  expand(pkg) {
    if (this.expanded.has(pkg)) this.expanded.delete(pkg)
    else this.expanded.add(pkg)
    this.revealPkg = pkg
    this.selection = null; this.neighborhood = null; this.dirty = true; this.requestUpdate()
  }

  pointer(e) {
    const box = this.canvas.getBoundingClientRect()
    return matrixHit(e.clientX - box.left, e.clientY - box.top, this.model, this.view)
  }

  move(e) {
    if (this.drag) {
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true
      if (this.drag.moved) {
        this.view.x = this.drag.ox - dx; this.view.y = this.drag.oy - dy
        this.clamp(); this.hover = null; this.paint()
        return
      }
    }
    const hit = this.pointer(e)
    if (hit?.row !== this.hover?.row || hit?.col !== this.hover?.col) { this.hover = hit; this.requestUpdate() }
  }

  key(e) {
    if (e.key === 'Escape') { this.selection = null; this.hover = null; this.requestUpdate(); return }
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key) || this.model.rows.length === 0) return
    e.preventDefault()
    let r = this.model.index.get(this.selection?.from) ?? 0
    let c = this.model.index.get(this.selection?.to) ?? r
    if (e.key === 'Enter') { this.expand(this.model.rows[r].pkg); return }
    if (e.key === 'ArrowDown') r++
    if (e.key === 'ArrowUp') r--
    if (e.key === 'ArrowRight') c++
    if (e.key === 'ArrowLeft') c--
    const bound = (n) => Math.max(0, Math.min(this.model.rows.length - 1, n))
    this.select(this.model.rows[bound(r)].id, this.model.rows[bound(c)].id)
  }

  paint() {
    if (!this.canvas || !this.model || this.width <= MATRIX_LEFT || this.height <= MATRIX_TOP) return
    if (this.needsFit) this.fit()
    if (this.revealPkg) {
      const row = this.model.rows.find((n) => n.pkg === this.revealPkg)
      this.revealPkg = null
      if (row) this.select(row.id)
    }
    const ctx = this.canvas.getContext('2d'), dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const styles = getComputedStyle(this), value = (name) => styles.getPropertyValue(name).trim()
    const light = document.body.classList.contains('theme-light') || document.body.classList.contains('theme-pink')
    const theme = { bg: value('--graph-canvas-bg') || '#0c0c0c', surface: value('--surface'), text: value('--text'), muted: value('--muted'),
      border: value('--border'), grid: light ? '#0000000b' : '#ffffff0b', highlight: light ? '#0969da18' : '#ffffff12', cycle: light ? '#a21caf' : '#e879c7' }
    this.style.setProperty('--matrix-cycle', theme.cycle)
    const c = this.model.index.get(this.selection?.to), r = this.model.index.get(this.selection?.from)
    paintMatrix(ctx, this.model, this.view, { width: this.width, height: this.height, theme, colorOf: pkgColor,
      hover: this.hover, selected: r === undefined ? null : { row: r, col: c ?? null },
      dimmed: (row) => !row.files.some((file) => {
        const n = this.graph.nodeByFile.get(file)
        return (graph2.selectedSeverities.size === 0 || [...graph2.selectedSeverities].some((s) => n.severitySet?.has(s)))
          && (graph2.selectedColors.size === 0 || [...graph2.selectedColors].some((s) => n.colorSet?.has(s)))
      }),
    })
  }

  renderControls() {
    return html`<div class="g2-matrix-controls">
        <mode-switch label=${`${this.model.cycleCount} ${this.model.cycleCount === 1 ? 'cycle' : 'cycles'}`} .checked=${this.cyclesOnly} @click=${() => { this.cyclesOnly = !this.cyclesOnly; this.dirty = true; this.requestUpdate() }}></mode-switch>
        ${this.expanded.size > 0 ? html`<button @click=${() => { this.expanded.clear(); this.selection = null; this.dirty = true; this.requestUpdate() }}>Collapse all</button>` : null}
        ${this.neighborhood ? html`<button @click=${() => { this.neighborhood = null; this.dirty = true; this.requestUpdate() }}>All dependencies</button>` : null}
      </div>`
  }

  render() {
    if (!this.model) return null
    const hoverCol = this.model.rows[this.hover?.col], hoverRow = this.model.rows[this.hover?.row]
    const hoverImports = hoverCol && hoverRow ? this.model.cells.get(hoverRow.id)?.get(hoverCol.id)?.count ?? 0 : 0
    return html`<div class="matrix-layout">
      <div class="matrix-stage" style=${`--matrix-label-width: ${MATRIX_LEFT}px`}>
        <select class="matrix-order" aria-label="Matrix order" @change=${(e) => { this.order = e.target.value; this.dirty = true; this.requestUpdate() }}>
          <option value="structure" ?selected=${this.order === 'structure'}>Structure ↓</option><option value="name" ?selected=${this.order === 'name'}>Name ↓</option><option value="importers" ?selected=${this.order === 'importers'}>Most imported ↓</option><option value="imports" ?selected=${this.order === 'imports'}>Most imports ↓</option>
        </select>
        <canvas tabindex="0" role="img" aria-label="Dependency matrix. Rows import columns. Arrow keys select cells; Enter expands a package."
          @keydown=${(e) => this.key(e)} @pointermove=${(e) => this.move(e)} @pointerleave=${() => { if (!this.drag) { this.hover = null; this.requestUpdate() } }}
          @pointerdown=${(e) => { if (e.button !== 0) return; this.canvas.setPointerCapture(e.pointerId); this.drag = { x: e.clientX, y: e.clientY, ox: this.view.x, oy: this.view.y, moved: false } }}
          @pointercancel=${() => { this.drag = null }}
          @pointerup=${(e) => { if (!this.drag) return; if (!this.drag.moved) { const hit = this.pointer(e); if (hit) this.select(this.model.rows[hit.row].id, hit.col === null ? null : this.model.rows[hit.col].id, false) } this.drag = null }}
          @dblclick=${(e) => { const hit = this.pointer(e); if (hit) this.expand(this.model.rows[hit.row].pkg) }}></canvas>
        ${hoverRow && (!hoverCol || hoverImports > 0) ? html`<div class="matrix-hover">${hoverRow.label}${hoverCol ? ` → ${hoverCol.label} · ${hoverImports} imports` : ` · ${hoverRow.files.length} files`}</div>` : null}
        <div class="matrix-zoom"><button aria-label="Zoom out" @click=${() => this.zoom(1 / 1.5)}>−</button><span>${Math.round(this.view.cell / 18 * 100)}%</span><button aria-label="Zoom in" @click=${() => this.zoom(1.5)}>+</button><button @click=${() => this.fit()}>Fit</button></div>
      </div>
      <aside class="matrix-panel" aria-label="Matrix details" aria-live="polite">${renderMatrixPanel(this.model, this.graph, this.selection, {
        select: (from, to) => this.select(from, to), expand: (pkg) => this.expand(pkg), expanded: this.expanded, neighborhood: this.neighborhood,
        focus: (id) => { this.neighborhood = this.neighborhood === id ? null : id; this.dirty = true; this.requestUpdate() },
        clear: () => { this.selection = null; this.requestUpdate() },
      })}</aside>
    </div>`
  }
}

customElements.define('dependency-matrix', DependencyMatrix)
