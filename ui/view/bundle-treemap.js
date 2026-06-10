// `<bundle-treemap>` — a classic squarified treemap of a bundle's
// source files, sized by UTF-8 byte length. Lays out the actual PATH
// hierarchy as nested rectangles (a directory's box contains its
// children, a file's area is its share of the bundle), unlike flat
// per-package strips which aren't real treemaps and degrade badly on
// big packages.
//
// Squarified layout (Bruls/Huizing/van Wijk) needs pixel dimensions
// to choose row orientation by aspect ratio, so the element measures
// its own plot via ResizeObserver and re-lays-out on resize — the
// same reason the graph view owns a canvas. Light DOM (no shadow
// root) so the report.css rules apply and clicks on a file cell reach
// the existing `[data-bundle-view-source]` delegate in events.js,
// opening the source viewer just like the Files tab / Code slide.
//
// Three tree transforms keep it legible on real stasis bundles (which
// vendor whole dependency trees):
//   * single-child directory chains collapse — `a/b/c.txt` where `b`
//     is `a`'s only entry shows one box `a/b` containing `c.txt`;
//   * depth is capped (MAX_DEPTH) — deeper subtrees render as one
//     aggregate block instead of unreadable confetti;
//   * sub-pixel rects are dropped, and a box too small to host a
//     header + children renders as a single block.
//
// Navigation: clicking a directory cell (a `dir` container's header
// strip or a depth-capped `agg` block) drills into that subtree —
// it becomes the new layout root filling the whole plot, so the
// depth cap that aggregated it now spends a fresh budget revealing
// its contents. A breadcrumb trail in the header walks back up
// (each ancestor is a button; the home crumb returns to the whole
// bundle). File cells keep their existing behavior — a click opens
// the source viewer via the `[data-bundle-view-source]` delegate.
//
// Cells are plain `<div>`s, not buttons, and carry no `:hover` style.
// A treemap can hold thousands of them; making each a focusable button
// bloated the accessibility tree, and per-cell hover repaints (the fill
// of a large directory box especially) janked mouse-over on big trees.
// Every click still reaches its delegate through a `data-*` attribute,
// so the viz stays mouse-driven (keyboard users get the Files / Code
// tabs); only the few header breadcrumbs remain buttons.
import { LitElement, html, render as litRender } from 'lit'
import { styleMap } from 'lit/directives/style-map.js'
import { classMap } from 'lit/directives/class-map.js'
import { bundlePackageDirs, bundleSourcesAsMap } from './bundle-sources.js'
import { formatBytes, stripCommonPathPrefix } from './format.js'
import { pkgColor } from './graph/utils.js'
import { bundlePkgOf } from './bundle-pkg-of.js'

// After single-child collapse, six nested levels is plenty to drill;
// beyond it (or once a box is too small) a node aggregates so large
// bundles stay bounded in cell count and readable.
const MAX_DEPTH = 6
const HEADER_H = 14   // px reserved at a directory's top for its name
const PAD = 2         // px inset between a directory and its children
const MIN_SUBDIVIDE = 24 // px — a box smaller than this is a leaf block
const MIN_RENDER = 4  // px — rects below this are dropped (invisible)

// Last drill-in location per bundle integrity. The slide body's
// `choose(tab, …)` tears `<bundle-treemap>` down on every tab
// switch, so the focus has to outlive the element for a Treemap →
// Code → Treemap round trip to land back where the user was (same
// reason the terminal caches its element). Holds the focused dir's
// path string, not node refs — `_rebuild` re-resolves it against
// the fresh tree and silently drops paths that no longer exist.
const _focusPathByBundle = new Map()

// Black or white label text for legibility over an arbitrary hex
// fill — leaf cells paint the package hue edge to edge. Standard sRGB
// relative-luminance split, no per-theme table to keep in sync.
function readableTextOn(hex) {
  const m = /^#?([0-9a-f]{6})$/iu.exec(hex)
  if (!m) return '#fff'
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6 ? '#1a1a1a' : '#fff'
}

// Worst (largest) aspect ratio in a squarify row of total area `sum`
// laid along a side of length `len`, given the row's max/min areas.
function worstRatio(max, min, sum, len) {
  const s2 = sum * sum
  const l2 = len * len
  return Math.max((l2 * max) / s2, s2 / (l2 * min))
}

// Squarify one rectangle: tile `nodes` (each carrying `.value`) into
// sub-rects whose areas are proportional to value, growing rows along
// the shorter side while the worst aspect ratio keeps improving.
// Returns `[{ node, x, y, w, h }]`.
function squarify(nodes, rect) {
  const out = []
  const items = nodes.filter((n) => n.value > 0)
  let { x, y, w, h } = rect
  if (items.length === 0 || w <= 0 || h <= 0) return out
  let total = 0
  for (const n of items) total += n.value
  const scale = (w * h) / total
  let i = 0
  while (i < items.length && w > 0.5 && h > 0.5) {
    const len = Math.min(w, h)
    let k = i
    let sum = 0
    let mx = 0
    let mn = Infinity
    let best = Infinity
    while (k < items.length) {
      const a = items[k].value * scale
      const nMx = a > mx ? a : mx
      const nMn = a < mn ? a : mn
      const wr = worstRatio(nMx, nMn, sum + a, len)
      if (k === i || wr <= best) {
        best = wr; sum += a; mx = nMx; mn = nMn; k++
      } else break
    }
    const thick = sum / len
    if (w >= h) {
      let oy = y
      for (let m = i; m < k; m++) {
        const ih = m === k - 1 ? (y + h) - oy : (items[m].value * scale) / thick
        out.push({ node: items[m], x, y: oy, w: thick, h: ih })
        oy += ih
      }
      x += thick; w -= thick
    } else {
      let ox = x
      for (let m = i; m < k; m++) {
        const iw = m === k - 1 ? (x + w) - ox : (items[m].value * scale) / thick
        out.push({ node: items[m], x: ox, y, w: iw, h: thick })
        ox += iw
      }
      y += thick; h -= thick
    }
    i = k
  }
  return out
}

// Collapse single-child directory chains in place: while a node's
// only child is itself a directory, fold it in and join the names
// (`a` + `b` -> `a/b`). A lone FILE child is left alone, so the
// example `a/b/c.txt` becomes a box `a/b` holding `c.txt`. Applied to
// every node except the virtual root (whose top-level boxes stay
// separate).
function collapseNode(node) {
  while (node.children && node.children.size === 1) {
    const only = node.children.values().next().value
    if (only.isFile) break
    node.name = `${node.name}/${only.name}`
    node.children = only.children
  }
  if (node.children) for (const c of node.children.values()) collapseNode(c)
}

// Bottom-up: sum byte sizes + leaf counts onto every directory, and
// stamp each node's full (prefix-stripped) path for coloring +
// titles. Also threads a `parent` pointer through every node and
// registers each directory in `byPath` (path → node) — the drill-in
// navigation resolves a clicked cell's path to its node, then walks
// `parent` up to the root to rebuild the breadcrumb chain. Paths are
// unique (the tree is keyed by path segments and file/dir collisions
// are rejected at build time), so the map can't alias two nodes.
function finalize(node, parentPath, parent, byPath) {
  node.path = node.name ? (parentPath ? `${parentPath}/${node.name}` : node.name) : parentPath
  node.parent = parent
  if (node.isFile) { node.count = 1; return node.value }
  byPath.set(node.path, node)
  let value = 0
  let count = 0
  // Roll the package up from children: a directory whose every
  // descendant shares one package inherits it (so a depth-capped
  // `agg` block paints that package's hue), while a directory spanning
  // packages — `vendor/` over several `vendor/<vendor>/<pkg>` workspace
  // packages — resolves to null ("mixed") and the cell falls back to
  // its top-level-dir color. `undefined` until the first child is
  // seen; a single differing child latches it to null.
  let pkg
  for (const c of node.children.values()) {
    value += finalize(c, node.path, node, byPath)
    count += c.count
    if (pkg === undefined) pkg = c.pkg
    else if (pkg !== c.pkg) pkg = null
  }
  node.value = value
  node.count = count
  node.pkg = pkg ?? null
  return value
}

// Recursively place a node's rectangle (and its descendants) into the
// flat cell list. A directory big enough to host a header + children
// becomes a `dir` container with its sub-rects squarified inside;
// anything past the depth cap or too small becomes a single `agg`
// (directory) / `file` block.
function layout(node, x, y, w, h, depth, out) {
  if (w < MIN_RENDER || h < MIN_RENDER) return
  if (node.isFile) { out.push({ kind: 'file', node, x, y, w, h }); return }
  const subdivide = depth < MAX_DEPTH && w >= MIN_SUBDIVIDE && h >= MIN_SUBDIVIDE && node.children.size > 0
  if (!subdivide) { out.push({ kind: 'agg', node, x, y, w, h }); return }
  out.push({ kind: 'dir', node, x, y, w, h })
  const headH = h >= HEADER_H + MIN_RENDER + PAD ? HEADER_H : 0
  const ix = x + PAD
  const iy = y + headH
  const iw = w - PAD * 2
  const ih = h - headH - PAD
  if (iw < MIN_RENDER || ih < MIN_RENDER) return
  const kids = [...node.children.values()].toSorted((a, b) => b.value - a.value)
  for (const p of squarify(kids, { x: ix, y: iy, w: iw, h: ih })) {
    layout(p.node, p.x, p.y, p.w, p.h, depth + 1, out)
  }
}

class BundleTreemap extends LitElement {
  static properties = {
    details: { attribute: false },
    _w: { state: true },
    _h: { state: true },
    // Drill-in path: nodes from the root down to the focused subtree
    // (empty = whole bundle). Reassigned as a fresh array on every
    // navigation so Lit's identity check re-lays-out.
    _focus: { state: true },
  }

  // Light DOM so report.css rules apply and file-cell clicks bubble to
  // the document-level [data-bundle-view-source] delegate in events.js.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.details = null
    this._w = 0
    this._h = 0
    this._root = null
    this._focus = []
    this._dirByPath = new Map()
    this._status = 'loading'
    this._meta = { files: 0, total: 0, prefix: '' }
    this._ro = null
    this._plot = null
    this._tooltip = null
    this._ttCell = null
    this._onPointerMove = this._onPointerMove.bind(this)
    this._onPointerLeave = this._onPointerLeave.bind(this)
    this._onPlotClick = this._onPlotClick.bind(this)
  }

  willUpdate(changed) {
    if (changed.has('details')) this._rebuild()
  }

  firstUpdated() {
    this._plot = this.querySelector('.bundle-treemap-plot')
    this._tooltip = this.querySelector('.bundle-treemap-tooltip')
    if (!this._plot || typeof ResizeObserver === 'undefined') return
    this._ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (!cr) return
      const w = Math.floor(cr.width)
      const h = Math.floor(cr.height)
      if (w !== this._w || h !== this._h) { this._w = w; this._h = h }
    })
    this._ro.observe(this._plot)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    if (this._ro) { this._ro.disconnect(); this._ro = null }
  }

  // Custom tooltip — mirrors the graph's #g2-tooltip (graph/canvas.js):
  // a static element rendered into imperatively and positioned with
  // edge-flip + clamp, so hovering never triggers the component's
  // (layout-running) render(). Pointer events are delegated on the plot;
  // the hovered cell carries its text in data-tt-* attributes.
  _onPointerMove(e) {
    const cell = e.target.closest('.bundle-treemap-node')
    if (!cell || !this._tooltip) { this._hideTooltip(); return }
    if (cell !== this._ttCell) {
      this._ttCell = cell
      const d = cell.dataset
      litRender(html`
        <div class="bundle-treemap-tt-path">${d.ttPath}</div>
        ${d.ttPkg ? html`<div class="bundle-treemap-tt-head">
          <span class="bundle-treemap-tt-dot" style=${`background:${d.ttColor}`}></span>
          <span class="bundle-treemap-tt-pkg">${d.ttPkg}</span>
        </div>` : ''}
        <div class="bundle-treemap-tt-meta">${d.ttMeta}</div>
      `, this._tooltip)
    }
    this._positionTooltip(e.clientX, e.clientY)
  }

  _onPointerLeave() { this._hideTooltip() }

  // Place the tooltip 12px down-right of the cursor, flipping to the
  // other side of either axis when it would overflow the plot and
  // clamping so it never escapes the (overflow-hidden) plot box.
  _positionTooltip(cx, cy) {
    const tt = this._tooltip
    if (!tt || !this._plot) return
    tt.classList.add('show')
    const rect = this._plot.getBoundingClientRect()
    const sx = cx - rect.left
    const sy = cy - rect.top
    const OFFSET = 12
    let tx = sx + OFFSET
    if (tx + tt.offsetWidth > rect.width - 4) tx = sx - tt.offsetWidth - OFFSET
    if (tx < 4) tx = 4
    let ty = sy + OFFSET
    if (ty + tt.offsetHeight > rect.height - 4) ty = sy - tt.offsetHeight - OFFSET
    if (ty < 4) ty = 4
    tt.style.left = `${tx}px`
    tt.style.top = `${ty}px`
  }

  _hideTooltip() {
    this._ttCell = null
    if (this._tooltip) this._tooltip.classList.remove('show')
  }

  // Parse the bundle into a path tree once per `details` change:
  // build dirs from prefix-stripped paths, collapse single-child
  // chains, then roll up sizes/counts. Layout itself happens per
  // render (it depends on the measured size).
  _rebuild() {
    this._root = null
    // A new bundle invalidates the old node refs — drop any drill-in
    // so we don't render a focus path into a tree that no longer
    // exists. This bundle's own remembered focus (path-keyed, not
    // ref-keyed) is re-resolved at the end once the new tree stands.
    this._focus = []
    this._dirByPath = new Map()
    this._meta = { files: 0, total: 0, prefix: '' }
    if (!this.details) { this._status = 'loading'; return }
    const sources = bundleSourcesAsMap(this.details)
    if (!sources || sources.size === 0) { this._status = 'empty'; return }
    const origPaths = [...sources.keys()]
    // Stasis package boundaries (keyed by original path) so each leaf
    // is colored by its authoritative package — sibling workspace
    // packages stay distinct instead of merging under a shared parent
    // dir. Null for sourcemap bundles; leaves then bucket via the path
    // heuristic alone.
    const packageDirs = bundlePackageDirs(this.details)
    const { prefix, stripped } = stripCommonPathPrefix(origPaths)
    const enc = new TextEncoder()
    const root = { name: '', children: new Map(), value: 0, isFile: false }
    let total = 0
    let files = 0
    for (let i = 0; i < origPaths.length; i++) {
      const content = sources.get(origPaths[i])
      const size = typeof content === 'string' ? enc.encode(content).byteLength : 0
      if (size <= 0) continue
      const parts = stripped[i].split('/')
      // Walk/create a directory node per segment but the last. A source
      // path that is both a file and a prefix-dir of another ("x" and
      // "x/a.js") can't coexist in one tree; bail on the colliding entry
      // rather than descending into a file leaf (no `.children`) or
      // clobbering an already-built subtree.
      let node = root
      let blocked = false
      for (let d = 0; d < parts.length - 1; d++) {
        let child = node.children.get(parts[d])
        if (child && child.isFile) { blocked = true; break }
        if (!child) {
          child = { name: parts[d], children: new Map(), value: 0, isFile: false }
          node.children.set(parts[d], child)
        }
        node = child
      }
      if (blocked) continue
      const base = parts.at(-1)
      let leaf = node.children.get(base)
      if (leaf && !leaf.isFile) continue
      if (!leaf) {
        // Classify on the stripped path (own-source split matches the
        // file labels) but resolve the stasis package dir from the
        // original path (the map is keyed pre-strip).
        const pkg = bundlePkgOf(stripped[i], { packageDir: packageDirs?.get(origPaths[i]) })
        leaf = { name: base, isFile: true, value: 0, origPath: origPaths[i], pkg }
        node.children.set(base, leaf)
      }
      leaf.value += size
      total += size
      files++
    }
    if (total === 0) { this._status = 'empty'; return }
    for (const c of root.children.values()) collapseNode(c)
    const dirByPath = new Map()
    finalize(root, '', null, dirByPath)
    this._root = root
    this._dirByPath = dirByPath
    this._meta = { files, total, prefix }
    this._status = 'ok'
    // Restore this bundle's remembered drill-in onto the fresh node
    // refs — the element is rebuilt on every tab switch, so without
    // this a Treemap → Code → Treemap round trip always landed back
    // at the root. Defensive existence check: integrity is the
    // content hash, so the path should always resolve, but a missing
    // entry must fall back to the root rather than a dead focus.
    const remembered = this.details?.integrity ? _focusPathByBundle.get(this.details.integrity) : null
    if (remembered) {
      const node = dirByPath.get(remembered)
      if (node) this._focus = this._chainTo(node)
      else _focusPathByBundle.delete(this.details.integrity)
    }
  }

  // The subtree currently filling the plot — the deepest focused node,
  // or the whole-bundle root when nothing is drilled into.
  get _focusNode() {
    return this._focus.length > 0 ? this._focus.at(-1) : this._root
  }

  // Focus chain root→node, built by walking parent pointers
  // (excluding the virtual root) so the breadcrumb is correct even
  // when the target sits several levels below the current focus.
  _chainTo(node) {
    const chain = []
    for (let n = node; n && n !== this._root; n = n.parent) chain.push(n)
    chain.reverse()
    return chain
  }

  // Record the current focus in the per-bundle store so it survives
  // the element teardown a tab switch triggers. Root focus deletes
  // the entry rather than storing '' — `_rebuild`'s restore treats
  // absence as "start at the root".
  _rememberFocus() {
    const integrity = this.details?.integrity
    if (!integrity) return
    const path = this._focus.at(-1)?.path
    if (path) _focusPathByBundle.set(integrity, path)
    else _focusPathByBundle.delete(integrity)
  }

  // Drill into a directory. Files and empty nodes aren't navigable.
  _drillInto(node) {
    if (!node || node.isFile || !node.children || node.children.size === 0) return
    this._focus = this._chainTo(node)
    this._rememberFocus()
    this._hideTooltip()
  }

  // Jump to a breadcrumb: index -1 is the home crumb (whole bundle);
  // otherwise keep the first index+1 nodes of the chain. No-op when
  // it wouldn't change the focus, so re-clicking the active crumb
  // doesn't churn a render.
  _focusTo(index) {
    const next = index < 0 ? [] : this._focus.slice(0, index + 1)
    if (next.length === this._focus.length) return
    this._focus = next
    this._rememberFocus()
    this._hideTooltip()
  }

  // Plot-level click delegate. Only directory cells carry
  // `data-treemap-into`; a file cell has no such attribute, so its
  // click falls through this handler and reaches the document-level
  // `[data-bundle-view-source]` delegate that opens the source viewer.
  _onPlotClick(e) {
    const nav = e.target.closest('[data-treemap-into]')
    if (!nav) return
    const node = this._dirByPath.get(nav.dataset.treemapInto)
    if (node) this._drillInto(node)
  }

  // Breadcrumb trail. The home crumb keeps the old "Source treemap"
  // title styling (and reads as the title when nothing's drilled in);
  // each focused segment follows, the last rendered as plain text
  // (it's the current location, not a jump target).
  _renderCrumbs() {
    const focus = this._focus
    const atRoot = focus.length === 0
    // Home + ancestors sit in a shrinkable, overflow-clipped lead
    // group; the current crumb is pinned as a sibling. On a deep
    // drill-in the lead elides from its trailing edge (home stays,
    // middle ancestors clip) while the current location — the most
    // useful crumb — never gives up space.
    const lead = focus.slice(0, -1)
    const current = atRoot ? null : focus.at(-1)
    return html`<nav class="bundle-treemap-crumbs" aria-label="Treemap location">
      <span class="bundle-treemap-crumbs-lead">
        <button
          type="button"
          class=${classMap({ 'bundle-treemap-crumb-home': true, 'at-root': atRoot })}
          @click=${() => this._focusTo(-1)}
        >Source treemap</button>
        ${lead.map((node, i) => html`<span class="bundle-treemap-crumb-sep" aria-hidden="true">›</span><button
          type="button"
          class="bundle-treemap-crumb"
          @click=${() => this._focusTo(i)}
          title=${node.path}
        >${node.name}</button>`)}
      </span>
      ${current ? html`<span class="bundle-treemap-crumb-sep" aria-hidden="true">›</span><span
        class="bundle-treemap-crumb-current"
        aria-current="location"
        title=${current.path}
      >${current.name}</span>` : ''}
    </nav>`
  }

  _cell(c) {
    const total = this._meta.total || 1
    const p = (c.node.value / total) * 100
    const pctStr = p >= 10 ? p.toFixed(0) : p.toFixed(p >= 1 ? 1 : 2)
    const pos = { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` }
    const fileCount = `${c.node.count} ${c.node.count === 1 ? 'file' : 'files'}`
    // dir/agg are directories — tooltip path gets a trailing slash + a
    // file-count; the dir container omits the package head line (a
    // directory spans packages), leaves carry it.
    if (c.kind === 'dir') {
      return html`<div
        class="bundle-treemap-node bundle-treemap-dir"
        style=${styleMap(pos)}
        data-treemap-into=${c.node.path}
        data-tt-path=${`${c.node.path}/`}
        data-tt-meta=${`${formatBytes(c.node.value)} · ${fileCount} · ${pctStr}%`}
      ><span class="bundle-treemap-dirname">${c.node.name}</span></div>`
    }
    // Leaves carry their package from `_rebuild` (stasis-aware); a
    // directory rendered as one block inherits it via `finalize` when
    // its whole subtree shares a package, else `pkg` is null (mixed)
    // and we fall back to the path heuristic for a stable hue.
    const pkg = c.node.pkg ?? bundlePkgOf(c.node.path)
    const color = pkgColor(pkg)
    const style = styleMap({ ...pos, background: color, color: readableTextOn(color) })
    const ttPkg = pkg === '__own__' ? 'own source' : pkg
    if (c.kind === 'agg') {
      return html`<div
        class="bundle-treemap-node bundle-treemap-leaf bundle-treemap-agg"
        style=${style}
        data-treemap-into=${c.node.path}
        data-tt-path=${`${c.node.path}/`}
        data-tt-pkg=${ttPkg}
        data-tt-color=${color}
        data-tt-meta=${`${formatBytes(c.node.value)} · ${fileCount} · ${pctStr}%`}
      ><span class="bundle-treemap-label">${c.node.name}/</span></div>`
    }
    return html`<div
      class="bundle-treemap-node bundle-treemap-leaf bundle-treemap-file"
      style=${style}
      data-bundle-view-source=${c.node.origPath}
      data-tt-path=${c.node.path}
      data-tt-pkg=${ttPkg}
      data-tt-color=${color}
      data-tt-meta=${`${formatBytes(c.node.value)} · ${pctStr}% of bundle`}
    ><span class="bundle-treemap-label">${c.node.name}</span></div>`
  }

  render() {
    const focus = this._focusNode
    const cells = []
    if (this._status === 'ok' && focus && focus.children && this._w > 0 && this._h > 0) {
      const kids = [...focus.children.values()].toSorted((a, b) => b.value - a.value)
      for (const p of squarify(kids, { x: 0, y: 0, w: this._w, h: this._h })) {
        layout(p.node, p.x, p.y, p.w, p.h, 1, cells)
      }
    }
    const { files, total, prefix } = this._meta
    // Sub-line tracks the focused subtree so the count + size reflect
    // what's actually on screen after a drill-in (the whole bundle at
    // the root, where focus === _root and these match `_meta`).
    const curFiles = this._status === 'ok' && focus ? focus.count : files
    const curBytes = this._status === 'ok' && focus ? focus.value : total
    return html`<header class="bundle-treemap-head">
        ${this._renderCrumbs()}
        <span class="bundle-treemap-sub">${curFiles} ${curFiles === 1 ? 'file' : 'files'} · ${formatBytes(curBytes)}${prefix ? html` · <span class="mono">${prefix}</span>` : ''}</span>
      </header>
      <div class="bundle-treemap-plot" @click=${this._onPlotClick} @pointermove=${this._onPointerMove} @pointerleave=${this._onPointerLeave}>
        ${this._status === 'loading'
          ? html`<div class="bundle-treemap-empty">Loading…</div>`
          : this._status === 'empty'
            ? html`<div class="bundle-treemap-empty">This bundle doesn't carry any source content.</div>`
            : cells.map((c) => this._cell(c))}
        <div class="bundle-treemap-tooltip"></div>
      </div>`
  }
}

customElements.define('bundle-treemap', BundleTreemap)
