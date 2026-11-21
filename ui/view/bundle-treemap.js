// `<bundle-treemap>`: a squarified treemap of a bundle's files by their
// bytes (`bundleFileSizes`: images and fonts too, directory captures not),
// laid out as their path hierarchy, a directory's box holding its children.
// The layout picks row orientation by aspect ratio, so the element measures
// its plot (ResizeObserver) and lays out again on resize. Light DOM, so
// report.css applies and file cells' clicks reach events.js's
// `[data-bundle-view-source]` delegate, opening the source viewer; a
// resource's, or any of a tree listed alone (`details.listedOnly`, a
// repository directory too large to open: repository-treemap.js), opens none.
//
// Legible on Stasis bundles vendoring whole dependency trees: single-child
// directory chains collapse (`a/b` holding `c.txt`), depth is capped
// (MAX_DEPTH), deeper subtrees and boxes too small for a header and children
// drawing as one block, and sub-pixel rects are dropped.
//
// A directory cell (a box's header strip, or a capped block) drills in: it
// fills the plot, the depth cap spending a fresh budget on it; breadcrumbs
// walk back up. A header switch swaps in a sunburst of the same tree, rings
// outward from the focused directory, angle its share of bytes, with the
// same cell contract (`data-treemap-into`, `data-bundle-view-source`,
// `data-tt-*`), its center disc zooming out a level; focus, breadcrumbs and
// tooltip are shared. A Code | Resources pill, where a bundle holds both,
// narrows the tree to one kind; pressing either while one is on clears it
// (both would be everything). The graph never draws resources.
//
// Cells are plain `<div>`s with no `:hover` style: a treemap can hold
// thousands, and focusable buttons bloated the accessibility tree while
// per-cell hover repaints janked big trees. Keyboard users have the Files
// and Code tabs; only the breadcrumbs are buttons.
import { LitElement, html, render as litRender, nothing, svg } from 'lit'
import { styleMap } from './style-map.js'
import { classMap } from 'lit/directives/class-map.js'
import { bundleFileKinds, bundleFileSizes, bundlePackageDirs } from '../../common/bundle-sources.js'
import { bundleScopes, scopeOptions } from '../../common/bundle-reasons.js'
import { formatBytes, stripCommonPathPrefix } from './format.js'
import { mixedColor, paletteColor, pkgColor } from './graph/utils.js'
import { bundlePkgOf, pkgLabel } from '../../common/bundle-pkg-of.js'
import { treemapGroups } from './treemap-groups.js'
import './bundle-scope-selector.js'

// After single-child collapse, six nested levels is plenty to drill; past
// them (or once a box is too small) a node aggregates.
const MAX_DEPTH = 6
const HEADER_H = 14   // px reserved at a directory's top for its name
const PAD = 2         // px inset between a directory and its children
const MIN_SUBDIVIDE = 24 // px — a box smaller than this is a leaf block
const MIN_RENDER = 4  // px — rects below this are dropped (invisible)
const MIN_ARC = 1.5   // px — sunburst arcs thinner than this along their outer edge are dropped

// The focused directory's path and the scope, by bundle integrity: a tab
// switch tears the element down, and Treemap → Code → Treemap should land
// where the user was. `_rebuild` resolves the path against the fresh tree,
// dropping one that is gone.
const _focusPathByBundle = new Map()
const _reasonByBundle = new Map()
// Keep `value` for a bundle, or forget the bundle's where there is none.
function remember(byBundle, integrity, value) {
  if (!integrity) return
  if (value) byBundle.set(integrity, value)
  else byBundle.delete(integrity)
}

// The projection ('treemap' | 'sunburst') and the Code | Resources pill
// ('' for all, 'code' or 'resources'): viewing habits, one slot each for
// every bundle, outliving the element likewise.
let _sharedMode = 'treemap'
let _sharedKind = ''

// Black or white label text over a hex fill, by sRGB relative luminance.
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
    // The row runs down the left where the rect is wide, else across its top.
    const thick = sum / len
    const down = w >= h
    const end = down ? y + h : x + w
    for (let at = down ? y : x, m = i; m < k; m++) {
      const span = m === k - 1 ? end - at : (items[m].value * scale) / thick
      out.push(down ? { node: items[m], x, y: at, w: thick, h: span } : { node: items[m], x: at, y, w: span, h: thick })
      at += span
    }
    if (down) { x += thick; w -= thick } else { y += thick; h -= thick }
    i = k
  }
  return out
}

// Collapse single-child directory chains in place (`a` + `b` -> `a/b`); a
// lone file child stays, so `a/b/c.txt` is a box `a/b` holding `c.txt`.
function collapseNode(node) {
  while (node.children && node.children.size === 1) {
    const only = node.children.values().next().value
    if (only.isFile) break
    node.name = `${node.name}/${only.name}`
    node.children = only.children
  }
  if (node.children) for (const c of node.children.values()) collapseNode(c)
}

// Bottom-up: sum bytes and file counts onto every directory, stamp each
// node's (prefix-stripped) path and `parent`, and register directories in
// `byPath`, which a drill-in resolves a clicked cell's path by before
// walking `parent` up for the breadcrumbs. Paths are unique (file/directory
// collisions are dropped at build), so it aliases no two nodes.
function finalize(node, parentPath, parent, byPath) {
  node.path = node.name ? (parentPath ? `${parentPath}/${node.name}` : node.name) : parentPath
  node.parent = parent
  if (node.isFile) { node.count = 1; return node.value }
  byPath.set(node.path, node)
  let value = 0
  let count = 0
  // A directory whose every descendant shares one package, or directory
  // group (treemap-groups.js), inherits it, so a capped block paints its
  // hue; one spanning several (`vendor/` over workspace packages) is null.
  let group, pkg
  const shared = (held, own) => held === undefined || held === own ? own : null
  for (const c of node.children.values()) {
    value += finalize(c, node.path, node, byPath)
    count += c.count
    pkg = shared(pkg, c.pkg)
    group = shared(group, c.group)
  }
  node.value = value
  node.count = count
  node.pkg = pkg ?? null
  node.group = group ?? null
  return value
}

// A single package's files' directory groups by path (treemap-groups.js),
// and each group's rank by its bytes; none for several packages, colored by
// package.
function singlePackageGroups(pkgs, stripped, prefix, sizes) {
  const groups = new Set(pkgs).size === 1 ? treemapGroups(stripped, prefix) : new Map()
  const bytes = new Map()
  stripped.forEach((path, i) => {
    if (groups.has(path)) bytes.set(groups.get(path), (bytes.get(groups.get(path)) ?? 0) + Math.max(sizes[i] ?? 0, 0))
  })
  return { groups, ranks: new Map([...bytes].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([group], rank) => [group, rank])) }
}

// Place a node's rectangle and its descendants' in the flat cell list: a
// directory big enough for a header and children a `dir` box, its children
// squarified inside; one past the depth cap or too small an `agg` block.
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

// Percent of the bundle: whole from 10%, one decimal from 1%, two below, so
// small files don't all read "0%".
function pctLabel(value, total) {
  const p = (value / (total || 1)) * 100
  return p >= 10 ? p.toFixed(0) : p.toFixed(p >= 1 ? 1 : 2)
}

// A node's tooltip line: its bytes, a directory's files, and its share.
function nodeMeta(node, total) {
  const pct = pctLabel(node.value, total)
  return node.isFile ? `${formatBytes(node.value)} · ${pct}% of bundle`
    : `${formatBytes(node.value)} · ${node.count} ${node.count === 1 ? 'file' : 'files'} · ${pct}%`
}

// Levels the sunburst would draw below `node` (a child is 1), its ring
// count, so shallow trees get thick rings; capped at `cap`.
function levelsBelow(node, cap) {
  if (cap <= 0 || node.isFile || !node.children || node.children.size === 0) return 0
  let depth = 1
  for (const c of node.children.values()) {
    if (depth >= cap) break
    const d = 1 + levelsBelow(c, cap - 1)
    if (d > depth) depth = d
  }
  return depth
}

// SVG path of an annular sector between radii r0 < r1 from a0 to a1
// (radians, clockwise, 0 at 3 o'clock). A full circle stops a hair short of
// 2π, as coincident endpoints draw nothing; the seam hides under the stroke.
function arcPath(cx, cy, r0, r1, a0, a1) {
  const sweep = Math.min(a1 - a0, Math.PI * 2 - 1e-4)
  const a2 = a0 + sweep
  const large = sweep > Math.PI ? 1 : 0
  const c0 = Math.cos(a0)
  const s0 = Math.sin(a0)
  const c2 = Math.cos(a2)
  const s2 = Math.sin(a2)
  const p = (v) => v.toFixed(2)
  return `M${p(cx + r1 * c0)} ${p(cy + r1 * s0)}`
    + `A${p(r1)} ${p(r1)} 0 ${large} 1 ${p(cx + r1 * c2)} ${p(cy + r1 * s2)}`
    + `L${p(cx + r0 * c2)} ${p(cy + r0 * s2)}`
    + `A${p(r0)} ${p(r0)} 0 ${large} 0 ${p(cx + r0 * c0)} ${p(cy + r0 * s0)}Z`
}

// The sunburst's center label cut to `px` (SVG text has no ellipsis), at
// ~6.4px a glyph of its .66rem mono.
function fitLabel(s, px) {
  const max = Math.max(4, Math.floor(px / 6.4))
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

class BundleTreemap extends LitElement {
  static properties = {
    details: { attribute: false },
    _w: { state: true },
    _h: { state: true },
    // Nodes from the root down to the focused one (none for the whole
    // bundle), a new array on every navigation.
    _focus: { state: true },
    _mode: { state: true },
    _reason: { state: true },
    _kind: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.details = null
    this._w = 0
    this._h = 0
    this._focus = []
    this._mode = _sharedMode
    this._reason = ''
    this._kind = _sharedKind
    // The tree's own fields (_root, _status, _meta...) are set by _rebuild,
    // which the first update runs.
  }

  willUpdate(changed) {
    if (changed.has('details')) this._reason = _reasonByBundle.get(this.details?.integrity) ?? ''
    if (changed.has('details') || changed.has('_reason') || changed.has('_kind')) this._rebuild()
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

  // The tooltip, as the graph's #g2-tooltip (graph/canvas.js): rendered into
  // imperatively, so hovering never runs the layout's render(), from the
  // hovered cell's data-tt-* attributes.
  _onPointerMove(e) {
    const cell = e.target.closest('.bundle-treemap-node')
    if (!cell || !this._tooltip) { this._hideTooltip(); return }
    if (cell !== this._ttCell) {
      this._ttCell = cell
      const d = cell.dataset
      litRender(html`
        <div class="bundle-treemap-tt-path">${d.ttPath}</div>
        ${d.ttPkg ? html`<div class="bundle-treemap-tt-head">
          <span class="bundle-treemap-tt-dot" style=${styleMap({ background: d.ttColor })}></span>
          <span class="bundle-treemap-tt-pkg">${d.ttPkg}</span>
        </div>` : ''}
        <div class="bundle-treemap-tt-meta">${d.ttMeta}</div>
      `, this._tooltip)
    }
    this._positionTooltip(e.clientX, e.clientY)
  }

  _onPointerLeave() { this._hideTooltip() }

  // 12px down-right of the cursor, flipped where it would overflow the plot
  // and clamped inside it.
  _positionTooltip(cx, cy) {
    const tt = this._tooltip
    if (!tt || !this._plot) return
    tt.classList.add('show')
    const rect = this._plot.getBoundingClientRect()
    const place = (at, size, room) => Math.max(4, at + 12 + size > room - 4 ? at - size - 12 : at + 12)
    const left = place(cx - rect.left, tt.offsetWidth, rect.width)
    const top = place(cy - rect.top, tt.offsetHeight, rect.height)
    tt.style.left = `${left}px`
    tt.style.top = `${top}px`
  }

  _hideTooltip() {
    this._ttCell = null
    if (this._tooltip) this._tooltip.classList.remove('show')
  }

  // The path tree, built on a change of bundle, scope or kind; laid out on
  // every render, as that depends on the measured size. The old tree's
  // focus goes with it, the bundle's remembered one resolved again at the end.
  _rebuild() {
    this._root = null
    this._focus = []
    this._dirByPath = new Map()
    this._reasons = { ids: [] }
    this._mixedKinds = false
    this._meta = { total: 0, prefix: '' }
    this._hideTooltip()
    if (!this.details) { this._status = 'loading'; return }
    const sizes = bundleFileSizes(this.details)
    const origPaths = [...sizes.keys()].filter((path) => sizes.get(path) !== null)
    if (origPaths.length === 0) { this._status = 'empty'; return }
    this._reasons = bundleScopes(this.details, origPaths)
    if (!this._reasons.has(this._reason)) {
      this._reason = ''
      _reasonByBundle.delete(this.details.integrity)
    }
    const reasonFiles = this._reasons.files(this._reason)
    // Leaves are colored by Stasis package boundaries, so sibling workspace
    // packages stay apart (sourcemaps: by the path heuristic alone).
    const packageDirs = bundlePackageDirs(this.details)
    // The pill is offered by the whole bundle's files, not the scope's, so
    // picking a scope doesn't take it away.
    const kinds = bundleFileKinds(this.details)
    const isResource = (path) => kinds.get(path) === 'resource'
    const sized = origPaths.filter((path) => sizes.get(path) > 0)
    this._mixedKinds = sized.some(isResource) && !sized.every(isResource)
    const kind = this._mixedKinds ? this._kind : ''
    const { prefix, stripped } = stripCommonPathPrefix(origPaths)
    // Display-prefix stripping must not erase dependency boundaries.
    const pkgs = origPaths.map((path) => bundlePkgOf(path, { packageDir: packageDirs?.get(path) }))
    // A single package's files, which its color can't tell apart, are
    // colored by directory group instead, the largest group first.
    const { groups, ranks } = singlePackageGroups(pkgs, stripped, prefix, origPaths.map((path) => sizes.get(path)))
    const root = { name: '', children: new Map(), value: 0, isFile: false }
    let total = 0
    for (let i = 0; i < origPaths.length; i++) {
      if (reasonFiles && !reasonFiles.has(origPaths[i])) continue
      if (kind && isResource(origPaths[i]) !== (kind === 'resources')) continue
      const size = sizes.get(origPaths[i])
      if (size <= 0) continue
      const parts = stripped[i].split('/')
      // A directory node per segment but the last; a path that is both a
      // file and another's directory ("x" and "x/a.js") is skipped.
      let node = root
      for (let d = 0; node && d < parts.length - 1; d++) {
        if (!node.children.has(parts[d])) node.children.set(parts[d], { name: parts[d], children: new Map(), value: 0, isFile: false })
        const child = node.children.get(parts[d])
        node = child.isFile ? null : child
      }
      if (!node) continue
      const base = parts.at(-1)
      if (!node.children.has(base)) {
        node.children.set(base, { name: base, isFile: true, value: 0, origPath: origPaths[i], pkg: pkgs[i], group: groups.get(stripped[i]) ?? null,
          resource: isResource(origPaths[i]) || this.details.listedOnly === true })
      }
      const leaf = node.children.get(base)
      if (!leaf.isFile) continue
      leaf.value += size
      total += size
    }
    if (total === 0) { this._status = 'empty'; return }
    for (const c of root.children.values()) collapseNode(c)
    const dirByPath = new Map()
    finalize(root, '', null, dirByPath)
    this._groupRanks = ranks
    this._root = root
    this._dirByPath = dirByPath
    this._meta = { total, prefix }
    this._status = 'ok'
    const remembered = this.details?.integrity ? _focusPathByBundle.get(this.details.integrity) : null
    if (remembered) {
      const node = dirByPath.get(remembered)
      if (node) this._focus = this._chainTo(node)
      else _focusPathByBundle.delete(this.details.integrity)
    }
  }

  // The node filling the plot.
  get _focusNode() {
    return this._focus.length > 0 ? this._focus.at(-1) : this._root
  }

  // The focus chain down to `node`, the virtual root left out.
  _chainTo(node) {
    const chain = []
    for (let n = node; n && n !== this._root; n = n.parent) chain.push(n)
    chain.reverse()
    return chain
  }

  // Focus `chain`, remembered for the bundle (none at the root).
  _setFocus(chain) {
    this._focus = chain
    remember(_focusPathByBundle, this.details?.integrity, chain.at(-1)?.path)
    this._hideTooltip()
  }

  // Drill into a directory. Files and empty nodes aren't navigable.
  _drillInto(node) {
    if (node && !node.isFile && node.children?.size > 0) this._setFocus(this._chainTo(node))
  }

  // Jump to a breadcrumb, -1 the home crumb; the current one changes nothing.
  _focusTo(index) {
    const next = index < 0 ? [] : this._focus.slice(0, index + 1)
    if (next.length !== this._focus.length) this._setFocus(next)
  }

  _toggleMode() {
    this._mode = this._mode === 'sunburst' ? 'treemap' : 'sunburst'
    _sharedMode = this._mode
    this._hideTooltip()
  }

  // From all, a press narrows to its kind; any press while narrowed returns
  // to all.
  _toggleKind(kind) {
    this._kind = this._kind ? '' : kind
    _sharedKind = this._kind
  }

  _changeReason(e) {
    this._reason = e.detail.value
    remember(_reasonByBundle, this.details?.integrity, this._reason)
  }

  // Directory cells drill in; a file cell's click goes on to events.js.
  _onPlotClick(e) {
    const nav = e.target.closest('[data-treemap-into]')
    if (!nav) return
    const node = this._dirByPath.get(nav.dataset.treemapInto)
    if (node) this._drillInto(node)
  }

  // The home crumb, naming the projection, reads as the title at the root;
  // the current location is plain text. Home and ancestors sit in a
  // shrinkable, clipped lead group, so a deep drill-in clips the middle
  // ancestors while the current crumb keeps its room.
  _renderCrumbs() {
    const focus = this._focus
    const atRoot = focus.length === 0
    const lead = focus.slice(0, -1)
    const current = atRoot ? null : focus.at(-1)
    return html`<nav class="bundle-treemap-crumbs" aria-label="Treemap location">
      <span class="bundle-treemap-crumbs-lead">
        <button
          type="button"
          class=${classMap({ 'bundle-treemap-crumb-home': true, 'at-root': atRoot })}
          @click=${() => this._focusTo(-1)}
        >Source ${this._mode === 'sunburst' ? 'sunburst' : 'treemap'}</button>
        ${lead.map((node, i) => html`<span class="bundle-treemap-crumb-sep" aria-hidden="true">›</span><button
          type="button"
          class="bundle-treemap-crumb"
          @click=${() => this._focusTo(i)}
          data-tooltip-truncated data-tooltip=${node.path}
        >${node.name}</button>`)}
      </span>
      ${current ? html`<span class="bundle-treemap-crumb-sep" aria-hidden="true">›</span><span
        class="bundle-treemap-crumb-current"
        aria-current="location"
        data-tooltip-truncated data-tooltip=${current.path}
      >${current.name}</span>` : ''}
    </nav>`
  }

  // A node's fill, the name its tooltip gives it, and whether a directory's
  // tooltip names it: its directory group's where the treemap colors by
  // group, a node spanning groups neutral and unnamed; else its package's,
  // as the path heuristic has it for one spanning packages, unnamed.
  _paint(node) {
    if (this._groupRanks?.size > 0) {
      return node.group == null ? { color: mixedColor(), label: null, named: false }
        : { color: paletteColor(this._groupRanks.get(node.group) ?? 0), label: node.group, named: true }
    }
    const pkg = node.pkg ?? bundlePkgOf(node.path)
    return { color: pkgColor(pkg), label: pkgLabel(pkg), named: node.pkg != null }
  }

  // A cell: a directory's box (no package line: its children have theirs),
  // a capped directory's block, or a file. A directory's tooltip path ends
  // in a slash.
  _cell(c) {
    const { node, kind } = c
    const dir = kind === 'dir'
    const block = kind !== 'file'
    const pos = { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` }
    const { color, label } = dir ? {} : this._paint(node)
    return html`<div
      class=${`bundle-treemap-node bundle-treemap-${dir ? 'dir' : `leaf bundle-treemap-${kind}`}`}
      style=${styleMap(dir ? pos : { ...pos, background: color, color: readableTextOn(color) })}
      data-treemap-into=${block ? node.path : nothing}
      data-bundle-view-source=${block || node.resource ? nothing : node.origPath}
      data-tt-path=${block ? `${node.path}/` : node.path}
      data-tt-pkg=${label ?? nothing}
      data-tt-color=${dir ? nothing : color}
      data-tt-meta=${nodeMeta(node, this._meta.total)}
    ><span class=${dir ? 'bundle-treemap-dirname' : 'bundle-treemap-label'}>${kind === 'agg' ? `${node.name}/` : node.name}</span></div>`
  }

  // A sunburst arc, the radial `_cell`. Every arc paints its hue, as rings
  // don't overlap; a directory spanning packages keeps a fallback hue but
  // claims no package in its tooltip.
  _arc(node, d, total) {
    const { color, label, named } = this._paint(node)
    const dir = !node.isFile
    return svg`<path
      class="bundle-treemap-node bundle-treemap-arc"
      d=${d}
      fill=${color}
      data-treemap-into=${dir ? node.path : nothing}
      data-bundle-view-source=${dir || node.resource ? nothing : node.origPath}
      data-tt-path=${dir ? `${node.path}/` : node.path}
      data-tt-pkg=${dir && !named ? nothing : label ?? nothing}
      data-tt-color=${dir && !named ? nothing : color}
      data-tt-meta=${nodeMeta(node, total)}
    ></path>`
  }

  // Rings split the radius outside the center disc evenly over the focused
  // subtree's capped depth, each node's sweep its share of its parent's
  // bytes. Arcs too thin to see are dropped, their siblings still advancing
  // past them; a directory at the cap is an arc with nothing outside it,
  // re-rooting the rings on a click.
  _renderSunburst(focus) {
    const w = this._w
    const h = this._h
    const cx = w / 2
    const cy = h / 2
    const R = Math.min(w, h) / 2 - 6
    if (R < 30) return nothing
    const rings = levelsBelow(focus, MAX_DEPTH)
    const r0 = Math.min(Math.max(R * 0.18, 26), R * 0.45)
    const thick = (R - r0) / rings
    const total = this._meta.total || 1
    const arcs = []
    const add = (node, a0, a1, depth) => {
      const kids = [...node.children.values()].toSorted((a, b) => b.value - a.value)
      const span = a1 - a0
      let a = a0
      for (const k of kids) {
        const sweep = span * (k.value / node.value)
        const rIn = r0 + (depth - 1) * thick
        const rOut = rIn + thick
        if (sweep * rOut >= MIN_ARC) {
          arcs.push(this._arc(k, arcPath(cx, cy, rIn, rOut, a, a + sweep), total))
          if (!k.isFile && depth < rings && k.children.size > 0) add(k, a, a + sweep, depth + 1)
        }
        a += sweep
      }
    }
    add(focus, -Math.PI / 2, Math.PI * 1.5, 1)
    // The center disc is the focused directory: drilled in, a click zooms
    // out a level (the root's path '' resolving to the whole bundle); at the
    // root it is inert, the label's anchor.
    const focused = this._focus.length > 0
    const centerR = Math.max(r0 - 4, 10)
    const center = focused
      ? svg`<circle
          class="bundle-treemap-node bundle-treemap-center"
          cx=${cx} cy=${cy} r=${centerR}
          data-treemap-into=${focus.parent.path}
          data-tt-path=${`${focus.path}/`}
          data-tt-meta=${nodeMeta(focus, total)}
        ></circle>`
      : svg`<circle class="bundle-treemap-center" cx=${cx} cy=${cy} r=${centerR}></circle>`
    const label = svg`<text class="bundle-treemap-center-label" x=${cx} y=${cy} text-anchor="middle">
      ${focused
        ? svg`<tspan x=${cx} dy="-0.3em">${fitLabel(focus.name, centerR * 2 - 12)}</tspan><tspan class="bundle-treemap-center-sub" x=${cx} dy="1.5em">${formatBytes(focus.value)}</tspan>`
        : svg`<tspan x=${cx} dy="0.35em">${formatBytes(focus.value)}</tspan>`}
    </text>`
    return html`<svg class="bundle-treemap-sunburst" width=${w} height=${h} viewBox=${`0 0 ${w} ${h}`}>${arcs}${center}${label}</svg>`
  }

  render() {
    const focus = this._focusNode
    const sunburst = this._mode === 'sunburst'
    const ready = this._status === 'ok' && focus && focus.children && this._w > 0 && this._h > 0
    const cells = []
    if (ready && !sunburst) {
      const kids = [...focus.children.values()].toSorted((a, b) => b.value - a.value)
      for (const p of squarify(kids, { x: 0, y: 0, w: this._w, h: this._h })) {
        layout(p.node, p.x, p.y, p.w, p.h, 1, cells)
      }
    }
    const { prefix } = this._meta
    // What is on screen: the focused subtree's, none before the tree stands.
    const curFiles = focus ? focus.count : 0
    const curBytes = focus ? focus.value : 0
    return html`<header class="bundle-treemap-head">
        ${this._renderCrumbs()}
        <span class="bundle-treemap-head-right">
          <span class="bundle-treemap-sub">${curFiles} ${curFiles === 1 ? 'file' : 'files'} · ${formatBytes(curBytes)}${prefix ? html` · <span class="mono">${prefix}</span>` : ''}</span>
          ${this._reasons.ids.length > 0 ? html`<bundle-scope-selector compact
            .reasons=${scopeOptions(this._reasons)} .value=${this._reason} label="Filter files"
            @scope-change=${this._changeReason}
          ></bundle-scope-selector>` : nothing}
          ${this._mixedKinds ? html`<span class="bundle-treemap-kind" role="group" aria-label="Show only">
            ${[['code', 'Code'], ['resources', 'Resources']].map(([kind, label]) => html`<button
              type="button"
              aria-pressed=${String(this._kind === kind)}
              @click=${() => this._toggleKind(kind)}
            >${label}</button>`)}
          </span>` : nothing}
          <mode-switch compact
            label="Sunburst" .checked=${sunburst}
            accessible-label="Toggle sunburst view"
            @click=${this._toggleMode}
          ></mode-switch>
        </span>
      </header>
      <div class="bundle-treemap-plot" @click=${this._onPlotClick} @pointermove=${this._onPointerMove} @pointerleave=${this._onPointerLeave}>
        ${this._status === 'loading'
          ? html`<div class="bundle-treemap-empty">Loading…</div>`
          : this._status === 'empty'
            ? html`<div class="bundle-treemap-empty">${!this._mixedKinds || !this._kind
              ? "This bundle doesn't carry any source content."
              : this._kind === 'code' ? 'No code here, only resources.' : 'No resources here, only code.'}</div>`
            : sunburst
              ? (ready ? this._renderSunburst(focus) : nothing)
              : cells.map((c) => this._cell(c))}
        <div class="bundle-treemap-tooltip"></div>
      </div>`
  }
}

customElements.define('bundle-treemap', BundleTreemap)
