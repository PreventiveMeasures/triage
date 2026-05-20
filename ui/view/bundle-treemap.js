// `<bundle-treemap>` — a classic squarified treemap of a bundle's
// source files, sized by UTF-8 byte length. Replaces the earlier
// per-package flex strips (which weren't a real treemap and degraded
// badly on big packages): this lays out the actual PATH hierarchy as
// nested rectangles, so a directory's box contains its children and a
// file's area is its share of the bundle.
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
import { LitElement, html } from 'lit'
import { styleMap } from 'lit/directives/style-map.js'
import { bundleSourcesAsMap } from './bundle-sources.js'
import { formatBytes, stripCommonPathPrefix } from './format.js'
import { pkgColor } from './graph/utils.js'
import { bundlePkgOf } from './render-bundle.js'

// After single-child collapse, six nested levels is plenty to drill;
// beyond it (or once a box is too small) a node aggregates so large
// bundles stay bounded in cell count and readable.
const MAX_DEPTH = 6
const HEADER_H = 14   // px reserved at a directory's top for its name
const PAD = 2         // px inset between a directory and its children
const MIN_SUBDIVIDE = 24 // px — a box smaller than this is a leaf block
const MIN_RENDER = 4  // px — rects below this are dropped (invisible)

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
// stamp each node's full (prefix-stripped) path for coloring + titles.
function finalize(node, parentPath) {
  node.path = node.name ? (parentPath ? `${parentPath}/${node.name}` : node.name) : parentPath
  if (node.isFile) { node.count = 1; return node.value }
  let value = 0
  let count = 0
  for (const c of node.children.values()) { value += finalize(c, node.path); count += c.count }
  node.value = value
  node.count = count
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
    this._status = 'loading'
    this._meta = { files: 0, total: 0, prefix: '' }
    this._ro = null
  }

  willUpdate(changed) {
    if (changed.has('details')) this._rebuild()
  }

  firstUpdated() {
    const plot = this.querySelector('.bundle-treemap-plot')
    if (!plot || typeof ResizeObserver === 'undefined') return
    this._ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (!cr) return
      const w = Math.floor(cr.width)
      const h = Math.floor(cr.height)
      if (w !== this._w || h !== this._h) { this._w = w; this._h = h }
    })
    this._ro.observe(plot)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    if (this._ro) { this._ro.disconnect(); this._ro = null }
  }

  // Parse the bundle into a path tree once per `details` change:
  // build dirs from prefix-stripped paths, collapse single-child
  // chains, then roll up sizes/counts. Layout itself happens per
  // render (it depends on the measured size).
  _rebuild() {
    this._root = null
    this._meta = { files: 0, total: 0, prefix: '' }
    if (!this.details) { this._status = 'loading'; return }
    const sources = bundleSourcesAsMap(this.details)
    if (!sources || sources.size === 0) { this._status = 'empty'; return }
    const origPaths = [...sources.keys()]
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
      let node = root
      for (let d = 0; d < parts.length - 1; d++) {
        let child = node.children.get(parts[d])
        if (!child) {
          child = { name: parts[d], children: new Map(), value: 0, isFile: false }
          node.children.set(parts[d], child)
        }
        node = child
      }
      const base = parts.at(-1)
      let leaf = node.children.get(base)
      // Defend against a path that is both a dir and a file across two
      // entries: keep the file leaf, fold the size in.
      if (!leaf || !leaf.isFile) {
        leaf = { name: base, isFile: true, value: 0, origPath: origPaths[i] }
        node.children.set(base, leaf)
      }
      leaf.value += size
      total += size
      files++
    }
    if (total === 0) { this._status = 'empty'; return }
    for (const c of root.children.values()) collapseNode(c)
    finalize(root, '')
    this._root = root
    this._meta = { files, total, prefix }
    this._status = 'ok'
  }

  _cell(c) {
    const total = this._meta.total || 1
    const p = (c.node.value / total) * 100
    const pctStr = p >= 10 ? p.toFixed(0) : p.toFixed(p >= 1 ? 1 : 2)
    const pos = { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` }
    if (c.kind === 'dir') {
      return html`<div
        class="bundle-treemap-node bundle-treemap-dir"
        style=${styleMap(pos)}
        title=${`${c.node.path}/ — ${formatBytes(c.node.value)} · ${c.node.count} ${c.node.count === 1 ? 'file' : 'files'} · ${pctStr}%`}
      ><span class="bundle-treemap-dirname">${c.node.name}</span></div>`
    }
    const color = pkgColor(bundlePkgOf(c.node.path))
    const style = styleMap({ ...pos, background: color, color: readableTextOn(color) })
    if (c.kind === 'agg') {
      return html`<div
        class="bundle-treemap-node bundle-treemap-leaf bundle-treemap-agg"
        style=${style}
        title=${`${c.node.path}/ — ${formatBytes(c.node.value)} · ${c.node.count} ${c.node.count === 1 ? 'file' : 'files'} · ${pctStr}%`}
      ><span class="bundle-treemap-label">${c.node.name}/</span></div>`
    }
    return html`<button
      type="button"
      class="bundle-treemap-node bundle-treemap-leaf bundle-treemap-file"
      style=${style}
      data-bundle-view-source=${c.node.origPath}
      title=${`${c.node.path}\n${formatBytes(c.node.value)} · ${pctStr}% of bundle`}
    ><span class="bundle-treemap-label">${c.node.name}</span></button>`
  }

  render() {
    const cells = []
    if (this._status === 'ok' && this._root && this._w > 0 && this._h > 0) {
      const kids = [...this._root.children.values()].toSorted((a, b) => b.value - a.value)
      for (const p of squarify(kids, { x: 0, y: 0, w: this._w, h: this._h })) {
        layout(p.node, p.x, p.y, p.w, p.h, 1, cells)
      }
    }
    const { files, total, prefix } = this._meta
    return html`<header class="bundle-treemap-head">
        <span class="bundle-treemap-title">Source treemap</span>
        <span class="bundle-treemap-sub">${files} ${files === 1 ? 'file' : 'files'} · ${formatBytes(total)}${prefix ? html` · <span class="mono" title=${prefix}>${prefix}</span>` : ''}</span>
      </header>
      <div class="bundle-treemap-plot">
        ${this._status === 'loading'
          ? html`<div class="bundle-treemap-empty">Loading…</div>`
          : this._status === 'empty'
            ? html`<div class="bundle-treemap-empty">This bundle doesn't carry any source content.</div>`
            : cells.map((c) => this._cell(c))}
      </div>`
  }
}

customElements.define('bundle-treemap', BundleTreemap)
