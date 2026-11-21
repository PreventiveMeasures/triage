import { html, render } from 'lit'
import { styleMap } from '../style-map.js'
import { cleanupGraph2, graph2 } from './state.js'
import { layoutFilesVogel, layoutSpiral } from './layout.js'
import { renderSevChips } from './render.js'
import { buildPackageGraph, graphTerms, packageVersions, withoutPackages } from './data.js'
import { pkgLabel } from '../../../common/bundle-pkg-of.js'
import { pkgRelative } from './file-label.js'
import { pkgColor } from './utils.js'
import { GRAPH_BACKGROUNDS, graphTheme } from './colors.js'
import { forceLayout } from './force-layout.js'
import { fitCompactGraph, nodeBounds } from './fit.js'
import { graphZoomMetrics } from './zoom.js'
import { formatBytes } from '../format.js'
import { layoutDependencyLayers } from './layered-layout.js'
import { drawDependencyLayers } from './layered-render.js'
import { layoutPackageDependencies } from './dependency-layout.js'
import { DEPENDENCY_FONT, dependencyLabel, drawPackageDependencies } from './dependency-render.js'
import { dependencyFilesOn, dependencyNetwork } from './package-network.js'
import { circleOutside, createRenderCache, edgeGradient, edgeOutside, edgePaints, haloGradient, updateRenderCache } from './render-cache.js'
import { graphViewKey } from './view-key.js'
import { createNodePicker } from './node-picker.js'
import { outsideDamage, panDamage } from './pan-damage.js'
import { MAX_FILE_EDGES, MAX_PACKAGE_EDGES, crowdedGraphPackages } from './crowded-packages.js'

// Severity rings, theme-independent data colors: [color, gap past the node,
// stroke width]. Critical and high get a wider, thicker ring so they stand
// out without a time-driven pulse.
const SEV_RINGS = {
  critical: ['#ff5470', 4.2, 1.8],
  high: ['#ff9d4a', 3.4, 1.5],
  medium: ['#f4d35e', 2.8, 1.3],
  low: ['#67c2ff', 2.8, 1.1],
  high_bug: ['#a06c3f', 2.8, 1.1],
  bug: ['#7a6d62', 2.8, 1.1],
  informational: ['#218bff', 2.8, 1.1],
}

// Canvas palettes per theme (see graphTheme), in JS so a frame needs no
// getComputedStyle round-trip. The body-class observer below repaints on a
// theme switch.
const LIGHT_THEME = {
  bg: GRAPH_BACKGROUNDS.light,
  grid: 'rgba(0, 0, 0, 0.04)',
  selectRing: '#0969da',
  edgeIntra: (alpha) => `rgba(50, 70, 100, ${alpha})`,
  hubRing: (alpha) => `rgba(0, 0, 0, ${alpha})`,
  labelFill: 'rgba(40, 50, 70, 0.85)',
  labelShadow: 'rgba(255, 255, 255, 0.95)',
  labelOutline: 'rgba(255, 255, 255, 0.9)',
  labelDefault: 'rgba(50, 60, 80, 0.85)',
  labelHover: 'rgba(20, 25, 35, 0.95)',
  labelSelected: '#000',
}
const G2_THEMES = {
  dark: {
    bg: GRAPH_BACKGROUNDS.dark,
    grid: 'rgba(255, 255, 255, 0.022)',
    selectRing: '#ffffff',
    edgeIntra: (alpha) => `rgba(180, 195, 215, ${alpha})`,
    hubRing: (alpha) => `rgba(255, 255, 255, ${alpha})`,
    labelFill: 'rgba(230, 233, 238, 0.78)',
    labelShadow: 'rgba(12, 12, 12, 0.98)',
    labelOutline: 'rgba(12, 12, 12, 0.9)',
    labelDefault: 'rgba(200, 210, 225, 0.78)',
    labelHover: 'rgba(230, 237, 243, 0.95)',
    labelSelected: '#fff',
  },
  light: LIGHT_THEME,
  // Light's palette on a canvas one step lighter than the page's pink, so it
  // reads as a lifted panel rather than a grey island.
  pink: { ...LIGHT_THEME, bg: GRAPH_BACKGROUNDS.pink },
  paper: {
    ...LIGHT_THEME,
    bg: GRAPH_BACKGROUNDS.paper,
    selectRing: '#000',
    edgeIntra: (alpha) => `rgba(0, 0, 0, ${alpha})`,
    labelFill: '#000',
    labelShadow: '#fff',
    labelOutline: '#fff',
    labelDefault: '#000',
    labelHover: '#000',
  },
  // A white well, picked in the theme's navy.
  w95: { ...LIGHT_THEME, bg: GRAPH_BACKGROUNDS.w95, selectRing: '#000080' },
}
const currentTheme = () => G2_THEMES[graphTheme()]

const LABEL_FONT = '600 11px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'

// Screen-space AABB overlap test shared by the label collision passes.
const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

// Greedy label placement: highest `prio` first, dropping any candidate whose
// box overlaps one already placed. Sorts `candidates` in place.
function placeLabels(candidates) {
  candidates.sort((a, b) => b.prio - a.prio)
  const placed = []
  for (const c of candidates) if (!placed.some((p) => overlaps(c, p))) placed.push(c)
  return placed
}

// Precomputed so hot node/halo/arrow loops only round, clamp and index.
const ALPHA_HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))
const alphaHex = (a) => ALPHA_HEX[Math.max(0, Math.min(255, Math.round(a * 255)))]

// Rich renderers' node radius, constant in screen space: a focused package's
// files, and packages, whose area tracks their file count (sqrt, capped).
const focusNodeRadius = (n) => (n.isHub ? 6 : 4) * graph2.nodeSize
const pkgNodeRadius = (p) => Math.min(26, 5 + Math.sqrt(p.fileCount) * 1.7) * graph2.nodeSize

// Bidirectional pairs get arrows at both ends, others at the import's target
// (data.js records which ends import: fromLo / fromHi).
function directed(e, na, nb) {
  const bidi = e.fromLo && e.fromHi
  return !bidi && e.fromHi ? { a: nb, b: na, bidi } : { a: na, b: nb, bidi }
}

// Nothing hides nodes: the render cache and picker take an always-true
// visibility predicate.
const shown = () => true

// Wire up the canvas: layout (deferred to the first resize so it gets real
// dimensions), draw loop, hover / click hit-testing, pan / zoom and the zoom
// readout. `refreshSidebar` rebuilds the selection card after a click;
// `refreshTopPkgs` (optional) repaints the Packages list when a click changes
// the solo'd package.
export function attachGraph2Interaction(container, graph, refreshSidebar, refreshTopPkgs) {
  // Callers pass the slot holding `<graph-layout>`; the canvas, overlays and
  // zoom controls live in its shadow root.
  const root = container.querySelector('graph-layout')?.shadowRoot
  if (!root) return
  const canvas = root.querySelector('#g2-canvas')
  const tooltip = root.querySelector('#g2-tooltip')
  const stage = root.querySelector('.graph2-stage')
  const statsEl = root.querySelector('.g2-stage-stats')
  const zoomEl = root.querySelector('#g2-zoom-pct')
  if (!canvas) return

  // Every render() while the graph shows calls this, so drop the previous
  // attachment's listeners and observers first, keeping its pan and zoom.
  cleanupGraph2({ keepViewport: true })
  // A re-attach of the view already on screen restores that pan and zoom,
  // laying out in the previous pixel space so positions match (layouts are
  // deterministic in their inputs). Any other graph or view refits.
  const viewKey = graphViewKey(graph)
  let restore = graph2.keptViewport?.key === viewKey ? graph2.keptViewport : null
  graph2.keptViewport = null

  const ctx = canvas.getContext('2d')
  let dpr = window.devicePixelRatio || 1
  let H = 0
  let W = 0
  let statsSafeHeight = 0
  const viewport = { tx: 0, ty: 0, k: 1 }
  let hovered = null
  let layoutH = restore?.layoutH ?? 0
  let layoutW = restore?.layoutW ?? 0
  let needsLayout = true
  let needsFit = !restore
  let renderCaches = new WeakMap()
  let nodePicker = null
  let paintedFrame = null
  let paintBounds = null

  // Layers and Dependencies are package-level layouts of bundle graphs, off
  // while a package is focused (a file-level mode). The Graph layout shows
  // packages when the Packages toggle is on and the graph qualifies
  // (`canPackagesView`, so a toggle persisted from another bundle can't
  // engage), and always for a graph of packages alone.
  const layoutOn = (id) => graph.supportsLayers && graph2.bundleLayout === id && !graph2.focusedPkg
  const layersOn = () => layoutOn('layers')
  const dependenciesOn = () => layoutOn('dependencies')
  const dependencyPackagesOn = () => dependenciesOn() && !dependencyFilesOn(graph, graph2.dependencyPackagesView)
  const pkgViewOn = () => layersOn() || (graph2.bundleLayout === 'graph'
    && (graph.packagesOnly || graph2.packagesView && (graph.canPackagesView ?? false)) && !graph2.focusedPkg)
  // At package altitude, graph2.solo is the selection: the package card's
  // slot, which the Packages rows write too.
  const selectsPackages = () => pkgViewOn() || dependencyPackagesOn()
  let layers = null
  let dependencyLayout = null
  // The file and package graphs leave out crowded packages (see
  // crowded-packages.js) before layout, so layouts arrange only what's drawn.
  const fileGraph = withoutPackages(graph, crowdedGraphPackages(graph, MAX_FILE_EDGES))

  // Built on first use: the file graph is fixed for the attachment, so its
  // aggregate is too.
  let pkgGraph = null
  function getPkgGraph() {
    if (pkgGraph) return pkgGraph
    const crowded = crowdedGraphPackages(buildPackageGraph(graph), MAX_PACKAGE_EDGES)
    pkgGraph = buildPackageGraph(withoutPackages(graph, crowded))
    if (layersOn() && graph.layerRoots?.appImports.length > 0) {
      if (!pkgGraph.byPkg.has('__own__')) {
        const app = { file: '__own__', pkg: '__own__', label: 'App (source not bundled)', size: null, fileCount: 0, totalIssues: 0 }
        pkgGraph.nodes.push(app)
        pkgGraph.byPkg.set('__own__', app)
      }
      pkgGraph.importsOf.set('__own__', [...new Set([
        ...(pkgGraph.importsOf.get('__own__') ?? []), ...graph.layerRoots.appImports.filter((pkg) => !crowded.has(pkg)),
      ])])
    }
    return pkgGraph
  }
  const activeGraph = () => pkgViewOn() ? getPkgGraph() : fileGraph
  const getDependencyGraph = () => dependencyNetwork(graph, graph2.dependencyPackagesView)

  const layerLabel = (id) => id === '__own__' ? 'App' : layers?.depth.get(id) === 0 ? `App · ${pkgLabel(id)}` : pkgLabel(id)

  // Copy solved positions onto the live nodes, matched by `file` (which
  // doubles as the package name on package aggregates).
  function copyPositions(nodes, pos) {
    for (const n of nodes) {
      const p = pos.get(n.file)
      if (p) { n.x = p.x; n.y = p.y }
    }
  }

  // A focused package's files, or few packages: force-directed while its
  // O(N²) iterations stay interactive (it clusters by import structure), past
  // 50 nodes a Vogel sunflower with an edge-length-optimized assignment.
  function layoutCompact(g, ids, options) {
    if (g.nodes.length > 50) return layoutFilesVogel(g, layoutW, layoutH)
    copyPositions(g.nodes, new Map(forceLayout(ids, g.importsOf, layoutW, layoutH, options).map((s) => [s.file, s])))
  }

  // ── Layout (deferred until we have real canvas dimensions) ─────
  function ensureLayout() {
    if (!needsLayout) return
    paintedFrame = null
    paintBounds = null
    nodePicker = null
    layOut()
    needsLayout = false
  }
  function layOut() {
    if (layersOn()) {
      const pg = getPkgGraph()
      layers = layoutDependencyLayers(pg.nodes.map((n) => ({ id: n.pkg, size: n.size })), pg.importsOf, graph.layerRoots?.roots ?? ['__own__'], {
        width: Math.max(360, layoutW - 190),
      })
      return
    }
    if (dependenciesOn()) {
      const pg = getDependencyGraph()
      dependencyLayout = layoutPackageDependencies(pg.nodes.map((n) => n.file), pg.importsOf, pg.fileLevel ? [] : graph.layerRoots?.roots ?? [], {
        width: layoutW, height: layoutH, cycleImportsOf: pg.cycleImportsOf,
      })
      return
    }
    const cache = graph2.layoutCache
    const focused = graph2.focusedPkg
    const pkgView = pkgViewOn()
    const nodes = activeGraph().nodes
    if (cache && cache.files === graph.files && cache.w === layoutW && cache.h === layoutH
        && cache.focused === focused && (cache.pkgView ?? false) === pkgView) {
      copyPositions(nodes, cache.pos)
      return
    }
    // Package ids are names, which force-layout's default packageOf
    // clustering would mis-bucket: singleton groups disable its centroid pull.
    if (pkgView) layoutCompact(getPkgGraph(), getPkgGraph().nodes.map((n) => n.pkg), { groupOf: (id) => id })
    else if (focused) layoutCompact(fileGraph, fileGraph.files)
    else layoutSpiral(fileGraph, layoutW, layoutH)
    graph2.layoutCache = { files: graph.files, w: layoutW, h: layoutH, pos: new Map(nodes.map((n) => [n.file, { x: n.x, y: n.y }])), focused, pkgView }
  }

  // (k, tx, ty) fitting what's on screen into the viewport above one stats
  // line. Pure: the wheel handler uses it for the min-zoom floor and the
  // re-centering target.
  function computeFit() {
    const fitScale = (w, h, padShare, max) => {
      const pad = Math.max(20, Math.min(W, H) * padShare)
      return Math.max(0.05, Math.min((W - pad * 2) / w, (H - pad * 2 - statsSafeHeight) / h, max))
    }
    if (dependenciesOn() && dependencyLayout) {
      const deps = getDependencyGraph()
      if (deps.nodes.length <= 100) {
        let side = 12
        ctx.save()
        ctx.font = DEPENDENCY_FONT
        for (const n of deps.nodes) side = Math.max(side, ctx.measureText(dependencyLabel(n)).width / 2 + 4)
        ctx.restore()
        return fitCompactGraph([...dependencyLayout.nodes.values()], W, H, { statsHeight: statsSafeHeight, left: side, top: 12, bottom: 27 })
      }
      const k = fitScale(dependencyLayout.width, dependencyLayout.height, 0.04, 2.5)
      return { k, tx: (W - dependencyLayout.width * k) / 2, ty: (H - statsSafeHeight - dependencyLayout.height * k) / 2 }
    }
    if (layersOn() && layers) {
      const k = Math.max(0.05, Math.min((W - 24) / (layers.width + 185), (H - 70) / (layers.height + layers.gap), 1.5))
      return { k, tx: (W - (layers.width + 185) * k) / 2 + 145 * k,
        ty: 24 + Math.max(0, (H - 70 - (layers.height + layers.gap) * k) / 2) }
    }
    const nodes = activeGraph().nodes
    if (nodes.length <= 50) {
      // Include the screen-space circles, halos and always-on labels: fitting
      // centers alone clips disconnected packages pushed to the layout edges.
      let bottom = 0, side = 0, top = 0
      ctx.save()
      ctx.font = LABEL_FONT
      for (const n of nodes) {
        const r = pkgViewOn() ? pkgNodeRadius(n) : focusNodeRadius(n)
        const halo = r * 1.85 + 5
        side = Math.max(side, halo, ctx.measureText(n.label).width / 2 + 6)
        top = Math.max(top, halo)
        bottom = Math.max(bottom, halo, r + 4 + 13 + 4)
      }
      ctx.restore()
      return fitCompactGraph(nodes, W, H, { statsHeight: statsSafeHeight, left: side, top, bottom })
    }
    const { x0, y0, x1, y1 } = nodeBounds(nodes)
    // The large overview takes the tighter fit; a focused package's sparse
    // nodes need room for labels and arrows.
    const k = fitScale(Math.max(20, x1 - x0), Math.max(20, y1 - y0), graph2.focusedPkg ? 0.04 : 0.03, 4)
    return { k, tx: W / 2 - (x0 + x1) / 2 * k, ty: (H - statsSafeHeight) / 2 - (y0 + y1) / 2 * k }
  }

  function fitToView() {
    const fit = computeFit()
    viewport.k = fit.k
    viewport.tx = fit.tx
    viewport.ty = fit.ty
  }

  function updateZoomLabel() {
    if (!dependenciesOn()) {
      if (zoomEl) zoomEl.textContent = `${Math.round(viewport.k * 100)}%`
      return
    }
    const metrics = graphZoomMetrics(viewport.k, computeFit().k, true)
    if (zoomEl) zoomEl.textContent = `${metrics.percent}%`
    if (zOut) zOut.disabled = viewport.k <= metrics.min * 1.0001
    if (zIn) zIn.disabled = viewport.k >= metrics.max * .9999
  }

  const worldToScreen = (x, y) => [x * viewport.k + viewport.tx, y * viewport.k + viewport.ty]
  const screenToWorld = (sx, sy) => [(sx - viewport.tx) / viewport.k, (sy - viewport.ty) / viewport.k]

  function fillCircle(x, y, r) {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  function strokeCircle(x, y, r, color, width) {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.stroke()
  }

  function drawIssueRing(sx, sy, r, issue, dim) {
    const [color, gap, width] = SEV_RINGS[issue]
    ctx.globalAlpha = dim
    strokeCircle(sx, sy, r + gap, color, width)
    ctx.globalAlpha = 1
  }

  // A radial glow from 0.6 r out to `haloR`, fading to transparent.
  function drawHalo(sx, sy, r, haloR, color, alpha) {
    const grad = ctx.createRadialGradient(sx, sy, r * 0.6, sx, sy, haloR)
    grad.addColorStop(0, color + alphaHex(alpha))
    grad.addColorStop(1, color + '00')
    ctx.fillStyle = grad
    fillCircle(sx, sy, haloR)
  }

  // The rich renderers' edge: a quadratic curve bowed to one side, from the
  // rim of `a` to just short of `b` (room for the arrowhead).
  function curve(a, b, ra, rb) {
    const [ax, ay] = worldToScreen(a.x, a.y)
    const [bx, by] = worldToScreen(b.x, b.y)
    const dx = bx - ax, dy = by - ay
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const ux = dx / len, uy = dy / len
    const sx = ax + ux * (ra + 1.5), sy = ay + uy * (ra + 1.5)
    const ex = bx - ux * (rb + 3.5), ey = by - uy * (rb + 3.5)
    const off = Math.min(len * 0.15, 30)
    return { sx, sy, ex, ey, qcx: (sx + ex) / 2 - uy * off, qcy: (sy + ey) / 2 + ux * off }
  }
  function strokeCurve(c) {
    ctx.beginPath()
    ctx.moveTo(c.sx, c.sy)
    ctx.quadraticCurveTo(c.qcx, c.qcy, c.ex, c.ey)
    ctx.stroke()
  }

  // Trace the arrowhead triangle at one end of the curve. The tangent comes
  // from the Bezier derivative at t=0.9 (target end) / t=0.1 (source end), just
  // inside the endpoint so the arrow doesn't overshoot.
  function traceArrowhead({ sx, sy, qcx, qcy, ex, ey }, atStart) {
    const arrowLen = 7
    const arrowW = arrowLen * 0.42
    const t = atStart ? 0.1 : 0.9
    const tx = 2 * (1 - t) * (qcx - sx) + 2 * t * (ex - qcx)
    const ty = 2 * (1 - t) * (qcy - sy) + 2 * t * (ey - qcy)
    const tl = Math.sqrt(tx * tx + ty * ty) || 1
    const tux = tx / tl, tuy = ty / tl
    ctx.beginPath()
    if (atStart) {
      ctx.moveTo(sx, sy)
      ctx.lineTo(sx + tux * arrowLen - tuy * arrowW, sy + tuy * arrowLen + tux * arrowW)
      ctx.lineTo(sx + tux * arrowLen + tuy * arrowW, sy + tuy * arrowLen - tux * arrowW)
    } else {
      ctx.moveTo(ex, ey)
      ctx.lineTo(ex - tux * arrowLen + tuy * arrowW, ey - tuy * arrowLen - tux * arrowW)
      ctx.lineTo(ex - tux * arrowLen - tuy * arrowW, ey - tuy * arrowLen + tux * arrowW)
    }
    ctx.closePath()
  }
  function drawArrows(c, bidi, endColor, startColor = endColor) {
    traceArrowhead(c, false)
    ctx.fillStyle = endColor
    ctx.fill()
    if (!bidi) return
    traceArrowhead(c, true)
    ctx.fillStyle = startColor
    ctx.fill()
  }

  // The rich renderers' labels: centered under every node, outlined and
  // shadowed to read on any backdrop, claiming space by `priority`.
  function drawRichLabels(T, nodes, selected, radius, priority, alpha) {
    ctx.font = LABEL_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'
    const candidates = nodes.map((n) => {
      const [sx, sy] = worldToScreen(n.x, n.y)
      const ty = sy + radius(n) + 4
      const halfW = ctx.measureText(n.label).width / 2 + 2
      return { n, sx, ty, prio: priority(n), x0: sx - halfW, x1: sx + halfW, y0: ty, y1: ty + 13 }
    })
    for (const { n, sx, ty } of placeLabels(candidates)) {
      ctx.globalAlpha = alpha(n)
      ctx.shadowColor = T.labelShadow
      ctx.shadowBlur = 4
      ctx.strokeStyle = T.labelOutline
      ctx.lineWidth = 3
      ctx.strokeText(n.label, sx, ty)
      ctx.shadowBlur = 0
      ctx.fillStyle = n.file === selected ? T.labelSelected : n.file === hovered ? T.labelHover : T.labelDefault
      ctx.fillText(n.label, sx, ty)
      ctx.globalAlpha = 1
    }
  }

  // Soft-dim predicate: a node renders at 0.1 opacity unless it passes every
  // active filter — severity and mark color (any of its findings matching,
  // as in the findings tab), the solo'd package, and the path filter (file
  // path, package name or label containing the text).
  function nodeIsDimmed(n) {
    const misses = (filter, values) => filter.size > 0 && !(values && [...filter].some((v) => values.has(v)))
    if (!graph.issuesHidden && (misses(graph2.selectedSeverities, n.severitySet) || misses(graph2.selectedColors, n.colorSet))) return true
    // At package altitude solo is the selection, emphasized by neighbor
    // dimming instead; this dim on top would gray its neighbors.
    if (graph2.solo && n.pkg !== graph2.solo && !selectsPackages()) return true
    const q = graph2.pathFilter.toLowerCase()
    if (!q) return false
    // Package nodes carry their member paths, lowercased, as `pathText`; the
    // label covers the `__own__` → "own source" naming gap.
    const matchesFile = n.pathText ? n.pathText.includes(q) : n.file.toLowerCase().includes(q)
    return !matchesFile && !(n.pkg && n.pkg.toLowerCase().includes(q)) && !(n.label && n.label.toLowerCase().includes(q))
  }

  // The dot renderer's radius: hubs 1.4× members, growing with zoom up to a point.
  const nodeRadius = (n) => (n.isHub ? 4.9 : 3.5) * graph2.nodeSize * Math.max(0.6, Math.min(1.6, viewport.k))

  // ── Resize / DPR handling ─────────────────────────────────────
  function resize() {
    const rect = stage.getBoundingClientRect()
    const prevH = H
    const prevW = W
    W = Math.max(80, rect.width)
    H = Math.max(80, rect.height)
    // Reserve one stats line plus a gap, even when the stats wrap.
    statsSafeHeight = statsEl ? (parseFloat(getComputedStyle(statsEl).lineHeight) || 0) + 8 : 0
    dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr; canvas.height = H * dpr
    paintedFrame = null
    // Resizing resets the context (and may change DPR): paint objects made
    // under the old transform must be rebuilt.
    renderCaches = new WeakMap()
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // Lay out in the pixel space the canvas paints in, so package disk and
    // ring radii track the viewport.
    if (layoutW === 0 || layoutH === 0) {
      layoutW = W; layoutH = H; needsLayout = true
    }
    ensureLayout()
    // Refit on the first resize or a substantial change (a fullscreen
    // toggle), not on 1px reflows from sub-pixel rounding.
    const sizeChanged = prevW > 0 && (Math.abs(W - prevW) / prevW > 0.15 || Math.abs(H - prevH) / prevH > 0.15)
    if (restore) {
      // Keep the view centered when the stage changed size between
      // attachments (e.g. the bundle issue-controls row came or went).
      viewport.k = restore.k
      viewport.tx = restore.tx + (W - restore.W) / 2
      viewport.ty = restore.ty + (H - restore.H) / 2
      restore = null
    } else if (needsFit || sizeChanged) { fitToView(); needsFit = false }
    // Setting the canvas size cleared it.
    requestDraw()
  }

  // ── Draw ──────────────────────────────────────────────────────
  // On demand only (pan, zoom, hover, selection, layout, theme, resize):
  // nothing animates, and changes within a frame coalesce into one draw.
  let rafId = null
  let destroyed = false
  function requestDraw() {
    if (rafId !== null || destroyed) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      if (!destroyed) draw()
    })
  }

  function draw() {
    const G = activeGraph()
    // Only the dense dot renderer, below its label threshold, is invariant
    // under translation. Label collision/placement depends on viewport edges.
    if (paintBounds?.graph !== G) paintBounds = { graph: G, ...nodeBounds(G.nodes) }
    // Canvas backends can rasterize clipped strokes differently. Keep the
    // fast path to overviews containing the entire graph (including halos);
    // once a primitive reaches an edge, use the ordinary renderer.
    const margin = nodeRadius({ isHub: true }) * 6 + 8
    const contained = paintBounds.x0 * viewport.k + viewport.tx > margin
      && paintBounds.y0 * viewport.k + viewport.ty > margin
      && paintBounds.x1 * viewport.k + viewport.tx < W - margin
      && paintBounds.y1 * viewport.k + viewport.ty < H - margin
    const canReuse = contained && viewport.k <= 1.4 && G.nodes.length > 50 && !layersOn() && !dependenciesOn()
    const next = { tx: viewport.tx, ty: viewport.ty, key: JSON.stringify([
      viewport.k, currentTheme().bg, graph2.nodeSize, graph2.edgeOpacity,
      hovered, graph2.selected, graph2.solo, graph2.focusedPkg, pkgViewOn(),
      graph2.showAll, graph2.pathFilter, [...graph2.selectedSeverities], [...graph2.selectedColors],
    ]) }
    const damage = canReuse ? panDamage(paintedFrame, next, W, H, dpr) : null
    ctx.save()
    try {
      if (damage) {
        // Self-blit has snapshot semantics: overlapping source/destination is
        // safe and needs no additional full-size offscreen canvas allocation.
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalCompositeOperation = 'copy'
        ctx.drawImage(canvas, damage.dx, damage.dy)
        ctx.restore()
        ctx.beginPath()
        for (const r of damage.rects) ctx.rect(r.x, r.y, r.w, r.h)
        ctx.clip()
      }
      paint(damage)
      updateZoomLabel()
      paintedFrame = canReuse ? next : null
    } finally { ctx.restore() }
  }

  function paint(damage) {
    const T = currentTheme()
    ctx.fillStyle = T.bg
    ctx.fillRect(0, 0, W, H)
    drawGrid(T)

    // The selection key, normalized through the node lookup so a stale key
    // from another bundle can't dim everything against a ghost node.
    const pkgView = pkgViewOn()
    const G = dependenciesOn() ? getDependencyGraph() : activeGraph()
    const selKey = selectsPackages() ? graph2.solo : graph2.selected
    const sel = selKey ? G.nodeByFile.get(selKey) : null
    const selected = sel ? selKey : null

    if (dependenciesOn()) {
      drawPackageDependencies(ctx, dependencyLayout, G, {
        theme: T, viewport, width: W, height: H, colorOf: pkgColor,
        selected, hovered, query: graph2.pathFilter, dimmed: nodeIsDimmed,
      })
    } else if (layersOn()) {
      ctx.save()
      ctx.translate(viewport.tx, viewport.ty)
      ctx.scale(viewport.k, viewport.k)
      drawDependencyLayers(ctx, layers, {
        theme: T, scale: viewport.k, selected, hovered,
        colorOf: pkgColor,
        labelOf: layerLabel,
        sizeLabel: (value) => formatBytes(typeof value === 'number' ? value : G.byPkg.get(value).size) || 'Size unknown',
        dimmed: (id) => nodeIsDimmed(G.byPkg.get(id)),
      })
      ctx.restore()
    // Up to 50 packages, or a focused package's files, get the rich chrome:
    // curved edges, arrowheads, always-on labels. Past that the arrows and
    // labels stop reading, and the dot renderer draws them.
    } else if (pkgView && G.nodes.length <= 50) drawPackagesGraph(T, G, selected, sel)
    else if (graph2.focusedPkg && G.nodes.length <= 50) drawPackageView(T, selected, sel)
    else drawDots(T, G, damage, selected, sel)
  }

  function drawDots(T, G, damage, selected, sel) {
    if (!renderCaches.has(G)) renderCaches.set(G, createRenderCache(G))
    const frame = renderCaches.get(G)
    const paintKey = JSON.stringify([viewport.k, viewport.tx, viewport.ty, graph2.nodeSize, T.bg,
      graph2.solo, graph2.pathFilter, [...graph2.selectedSeverities], [...graph2.selectedColors]])
    updateRenderCache(frame, { viewport, selected, paintKey, visible: shown, dimmed: nodeIsDimmed, radius: nodeRadius, color: pkgColor })

    // ── Edges (back layer): cross-package ones a gradient between the
    // package hues, intra-package ones the theme's neutral gray.
    const paints = edgePaints(frame, graph2.edgeOpacity, T.edgeIntra, !!selected)
    const focus = selected || hovered
    const crossWidth = 0.85 / viewport.k, intraWidth = 0.55 / viewport.k
    let lastAlpha = null, lastStroke = null, lastWidth = null
    ctx.save()
    ctx.translate(viewport.tx, viewport.ty)
    ctx.scale(viewport.k, viewport.k)
    for (const entry of frame.edges) {
      const { edge: e, a, b } = entry
      if (!a.visible || !b.visible || edgeOutside(a, b, W, H)) continue
      if (outsideDamage(damage, Math.min(a.x, b.x) - 2, Math.min(a.y, b.y) - 2, Math.max(a.x, b.x) + 2, Math.max(a.y, b.y) + 2)) continue

      const touches = focus && (e.a === focus || e.b === focus)
      // Between two filtered-out nodes an edge fades hard, so the matching
      // subgraph stands out; one matching end keeps it legible to trace.
      const style = a.dimmed && b.dimmed
        ? (touches ? paints.emphasisDim : paints.baseDim)
        : (touches ? paints.emphasis : paints.base)

      // Skip repeated native setters for runs sharing a style, without
      // batching/reordering translucent strokes (which would change overlaps).
      const stroke = e.cross ? edgeGradient(entry, ctx) : style.neutral
      const alpha = e.cross ? style.opacity : 1
      const width = e.cross ? crossWidth : intraWidth
      if (stroke !== lastStroke) { ctx.strokeStyle = stroke; lastStroke = stroke }
      if (alpha !== lastAlpha) { ctx.globalAlpha = alpha; lastAlpha = alpha }
      if (width !== lastWidth) { ctx.lineWidth = width; lastWidth = width }

      ctx.beginPath()
      ctx.moveTo(a.node.x, a.node.y)
      ctx.lineTo(b.node.x, b.node.y)
      ctx.stroke()
    }
    ctx.restore()

    // ── Halos: hubs, hover and selection, though not on filtered-out hubs.
    for (const entry of frame.nodes) {
      if (!entry.visible) continue
      const n = entry.node
      const isHov = n.file === hovered
      const isSel = n.file === selected
      if (!isHov && !isSel && (!n.isHub || entry.dimmed)) continue
      const r = entry.radius, sx = entry.x, sy = entry.y
      const haloR = r * (isSel ? 6 : isHov ? 4.5 : 3)
      if (circleOutside(sx, sy, haloR, W, H)) continue
      if (outsideDamage(damage, sx - haloR - 2, sy - haloR - 2, sx + haloR + 2, sy + haloR + 2)) continue
      ctx.fillStyle = haloGradient(entry, haloR, ctx)
      fillCircle(sx, sy, haloR)
    }

    // ── Nodes ───────────────────────────────────────────────────
    for (const entry of frame.nodes) {
      if (!entry.visible) continue
      const n = entry.node
      const r = entry.radius, sx = entry.x, sy = entry.y
      // Includes the widest severity ring and its stroke.
      if (circleOutside(sx, sy, r + 6, W, H)) continue
      if (outsideDamage(damage, sx - r - 8, sy - r - 8, sx + r + 8, sy + r + 8)) continue
      // Beside a selection, unconnected nodes dim to 0.25; filtered-out ones
      // to 0.1 (stacking via min); the selection itself never dims.
      let dim = 1
      const isExplicitlySelected = selected && n.file === selected
      if (selected && !isExplicitlySelected) dim = frame.neighbors.has(n.file) ? 1 : 0.25
      if (!isExplicitlySelected && entry.dimmed) dim = Math.min(dim, 0.1)

      ctx.fillStyle = entry.color + alphaHex(dim)
      fillCircle(sx, sy, r)
      if (n.isHub) {
        // Maximum contrast against the package-colored fill.
        ctx.strokeStyle = T.hubRing(0.55 * dim)
        ctx.lineWidth = 0.8
        ctx.stroke()
      }
      if (n.issue) drawIssueRing(sx, sy, r, n.issue, dim)
    }

    if (viewport.k > 1.4) drawDotLabels(T, G, selected)

    // Selection ring on top so neighbors never hide it.
    if (sel) {
      const [sx, sy] = worldToScreen(sel.x, sel.y)
      strokeCircle(sx, sy, nodeRadius(sel) + 5, T.selectRing, 1.5)
    }
  }

  // Dot labels past 140% zoom: hubs only below 240%, every node from there,
  // thinned by a collision pass. They show when forced (showLabels), at 900%
  // and up, or with fewer than 50 nodes on screen.
  function drawDotLabels(T, G, selected) {
    if (viewport.k < 9 && !graph2.showLabels) {
      let onScreen = 0
      for (const n of G.nodes) {
        const [sx, sy] = worldToScreen(n.x, n.y)
        if (!(sx < 0 || sx > W || sy < 0 || sy > H) && ++onScreen >= 50) return
      }
    }
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'
    ctx.fillStyle = T.labelFill
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    // Nodes more than 250px off screen (past the longest label) can neither
    // place a label nor block one. Skipping them keeps measureText and the
    // O(candidates × boxes) collision pass to the viewport.
    const boxes = [], candidates = []
    for (const n of G.nodes) {
      const [sx, sy] = worldToScreen(n.x, n.y)
      if (!(sx > -250 && sx < W + 250 && sy > -250 && sy < H + 250)) continue
      const r = nodeRadius(n)
      boxes.push({ file: n.file, x0: sx - r, x1: sx + r, y0: sy - r, y1: sy + r })
      if (!n.isHub && viewport.k < 2.4) continue
      const tx = sx + r + 4, ty = sy + 1
      const w = ctx.measureText(n.label).width + 2
      const prio = n.file === selected ? 3 : n.file === hovered ? 2 : (n.isHub ? 1 : 0)
      candidates.push({ file: n.file, n, tx, ty, prio, x0: tx - 2, x1: tx + w, y0: ty - 11 / 2, y1: ty + 11 / 2 })
    }
    // A label may not cover another node's circle (its own sits beside it).
    const placed = placeLabels(candidates.filter((c) => !boxes.some((nb) => nb.file !== c.file && overlaps(c, nb))))
    for (const c of placed) ctx.fillText(c.n.label, c.tx, c.ty)
  }

  function drawGrid(T) {
    if (viewport.k < 0.4) return
    const step = 80
    const ox = ((viewport.tx % step) + step) % step
    const oy = ((viewport.ty % step) + step) % step
    ctx.strokeStyle = T.grid
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = ox; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H) }
    for (let y = oy; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y) }
    ctx.stroke()
  }

  // A focused package's files in one hue: curved edges with arrowheads,
  // labels on every node, hover dimming what's unconnected.
  function drawPackageView(T, selected, sel) {
    const color = pkgColor(graph2.focusedPkg)
    const hubRing = T.hubRing(0.55)
    const connected = new Set()
    if (hovered) {
      connected.add(hovered)
      for (const ei of (fileGraph.adj.get(hovered) ?? [])) {
        const e = fileGraph.edges[ei]
        connected.add(e.a); connected.add(e.b)
      }
    }
    const active = selected || hovered

    for (const e of fileGraph.edges) {
      const na = fileGraph.nodeByFile.get(e.a)
      const nb = fileGraph.nodeByFile.get(e.b)
      if (!na || !nb) continue
      const { a, b, bidi } = directed(e, na, nb)
      const isHov = hovered && (e.a === hovered || e.b === hovered)
      const isSel = selected && (e.a === selected || e.b === selected)
      const isDim = active && !isHov && !isSel
      const c = curve(a, b, focusNodeRadius(a), focusNodeRadius(b))
      const alpha = isSel ? 0.9 : isHov ? 0.85 : isDim ? 0.05 : Math.min(0.85, graph2.edgeOpacity * 3)
      ctx.strokeStyle = color + alphaHex(alpha)
      ctx.lineWidth = isSel || isHov ? 1.5 : 0.85
      strokeCurve(c)
      if (!isDim) drawArrows(c, bidi, color + alphaHex(Math.min(1, alpha + 0.15)))
    }

    for (const n of fileGraph.nodes) {
      const [sx, sy] = worldToScreen(n.x, n.y)
      const r = focusNodeRadius(n)
      const isHov = n.file === hovered
      const isSel = n.file === selected
      const dim = active && !connected.has(n.file) && !isSel ? 0.15 : 1
      ctx.globalAlpha = dim
      // Halos weigh selection, hover and hubs without changing the radius
      // (which would shift the edges' rim anchors).
      if (isSel || isHov || n.isHub) drawHalo(sx, sy, r, r * (isSel ? 4 : isHov ? 3 : 2.4), color, isSel ? 0.4 : 0.25)
      ctx.fillStyle = color
      fillCircle(sx, sy, r)
      if (n.isHub) {
        ctx.strokeStyle = hubRing
        ctx.lineWidth = 0.9
        ctx.stroke()
      }
      if (n.issue) drawIssueRing(sx, sy, r, n.issue, dim)
      ctx.globalAlpha = 1
    }

    drawRichLabels(T, fileGraph.nodes, selected, focusNodeRadius,
      (n) => n.file === selected ? 3 : n.file === hovered ? 2 : (n.isHub ? 1 : 0),
      (n) => active && !connected.has(n.file) && n.file !== selected ? 0.2 : 1)

    if (sel) {
      const [sx, sy] = worldToScreen(sel.x, sel.y)
      strokeCircle(sx, sy, focusNodeRadius(sel) + 4, T.selectRing, 1.8)
    }
  }

  // One node per package, the focused view's chrome in per-package hues:
  // each edge a gradient importer → importee, so direction reads from color
  // before the arrowhead, its width growing with the file imports it merges.
  function drawPackagesGraph(T, pg, selected, sel) {
    // The neighborhood of the hover, else of the selection.
    const focus = hovered ?? selected
    const connected = new Set()
    if (focus) {
      connected.add(focus)
      for (const e of pg.edges) {
        if (e.a === focus) connected.add(e.b)
        else if (e.b === focus) connected.add(e.a)
      }
    }
    // Hover and selection at full opacity; otherwise the out-of-neighborhood
    // dim stacks with the filter dim, as in the file views.
    const dimOf = (p) => p.file === selected || p.file === hovered ? 1
      : Math.min(focus && !connected.has(p.file) ? 0.2 : 1, nodeIsDimmed(p) ? 0.1 : 1)

    for (const e of pg.edges) {
      const na = pg.byPkg.get(e.a)
      const nb = pg.byPkg.get(e.b)
      if (!na || !nb) continue
      const { a, b, bidi } = directed(e, na, nb)
      const touches = focus !== null && (e.a === focus || e.b === focus)
      // Edges between two filtered-out packages fade with them, arrowheads
      // too: +0.15 over a 0.05 body would keep them visibly arrowed.
      const bothDimmed = nodeIsDimmed(na) && nodeIsDimmed(nb)
      const isDim = (focus !== null && !touches) || bothDimmed
      const c = curve(a, b, pkgNodeRadius(a), pkgNodeRadius(b))
      const alpha = bothDimmed ? 0.05 : touches ? 0.9 : isDim ? 0.06 : 0.5
      const grad = ctx.createLinearGradient(c.sx, c.sy, c.ex, c.ey)
      grad.addColorStop(0, pkgColor(a.pkg) + alphaHex(alpha))
      grad.addColorStop(1, pkgColor(b.pkg) + alphaHex(alpha))
      ctx.strokeStyle = grad
      ctx.lineWidth = Math.min(3.5, 0.8 + Math.sqrt(e.count) * 0.3) * (touches ? 1.3 : 1)
      strokeCurve(c)
      // Each arrowhead takes the color of the node it lands on.
      const arrowAlpha = alphaHex(Math.min(1, alpha + 0.15))
      if (!isDim) drawArrows(c, bidi, pkgColor(b.pkg) + arrowAlpha, pkgColor(a.pkg) + arrowAlpha)
    }

    for (const p of pg.nodes) {
      const [sx, sy] = worldToScreen(p.x, p.y)
      const r = pkgNodeRadius(p)
      const isSel = p.file === selected
      const color = pkgColor(p.pkg)
      const dim = dimOf(p)
      if (isSel || p.file === hovered) drawHalo(sx, sy, r, r * (isSel ? 2.6 : 2.2), color, isSel ? 0.4 : 0.25)
      ctx.fillStyle = color + alphaHex(dim)
      fillCircle(sx, sy, r)
      if (p.issue) drawIssueRing(sx, sy, r, p.issue, dim)
    }

    // Bigger packages claim label space first. A dimmed package's name stays
    // at 0.25 or more, legible enough to tell why a filter skipped it.
    drawRichLabels(T, pg.nodes, selected, pkgNodeRadius,
      (p) => p.file === selected ? Infinity : p.file === hovered ? 1e9 : p.fileCount,
      (p) => Math.max(0.25, dimOf(p)))

    if (sel) {
      const [sx, sy] = worldToScreen(sel.x, sel.y)
      strokeCircle(sx, sy, pkgNodeRadius(sel) + 4, T.selectRing, 1.8)
    }
  }

  // ── Hit test ──────────────────────────────────────────────────
  // On the node set on screen, with the radius its renderer draws: rim clicks
  // must land.
  function pickNode(sx, sy) {
    if (dependenciesOn()) {
      const [x, y] = screenToWorld(sx, sy)
      let best = null, bestD = Infinity
      for (const [id, p] of dependencyLayout.nodes) {
        const d = (p.x - x) ** 2 + (p.y - y) ** 2
        if (d < bestD && d < (14 / Math.max(viewport.k, 0.1)) ** 2) { bestD = d; best = getDependencyGraph().nodeByFile.get(id) }
      }
      return best
    }
    if (layersOn()) {
      const [x, y] = screenToWorld(sx, sy)
      const rect = [...layers.rects.values()].find((r) => r.width > 0 && x >= r.x && x < r.x + r.width && y >= r.y && y <= r.y + r.height)
      return rect ? getPkgGraph().byPkg.get(rect.id) : null
    }
    const G = activeGraph()
    if (G.nodes.length > 50) {
      nodePicker ??= createNodePicker(G.nodes)
      return nodePicker(sx, sy, viewport, nodeRadius({ isHub: true }), nodeRadius, shown)
    }
    const radius = pkgViewOn() ? pkgNodeRadius : nodeRadius
    let best = null, bestD = Infinity
    for (const n of G.nodes) {
      const [nx, ny] = worldToScreen(n.x, n.y)
      const dx = nx - sx, dy = ny - sy
      const d = dx * dx + dy * dy
      const r = radius(n) + 6
      if (d < r * r && d < bestD) { bestD = d; best = n }
    }
    return best
  }

  // A file's path in its package, its package, and its finding chips. Lit
  // escapes the report's paths.
  function showTooltip(n, cx, cy) {
    if (!tooltip) return
    render(html`
      <div class="g2-tt-path">${pkgRelative(n.file, n.pkg)}</div>
      <div class="g2-tt-head">
        <span class="g2-tt-dot" style=${styleMap({ background: pkgColor(n.pkg) })}></span>
        <span class="g2-tt-pkg">${pkgLabel(n.pkg)}</span>
      </div>
      ${n.totalIssues > 0 ? renderSevChips(n.own) : null}
    `, tooltip)
    placeTooltip(cx, cy)
  }

  // A package's file count and bytes, its finding chips; for a graph of
  // packages alone, whose members are installed copies, their versions.
  function showPkgTooltip(p, cx, cy) {
    if (!tooltip) return
    const sizeText = formatBytes(p.size)
    const versions = graph.packagesOnly ? packageVersions(graph, p.pkg) : []
    const members = graph.packagesOnly
      ? versions.length > 1 ? `${versions.length} versions` : versions[0] ?? ''
      : `${p.fileCount} ${p.fileCount === 1 ? 'file' : 'files'}${sizeText ? ` · ${sizeText}` : ''}`
    render(html`
      <div class="g2-tt-path">${layersOn() ? layerLabel(p.pkg) : p.label}</div>
      ${dependenciesOn() || graph.packagesOnly ? html`<div class="g2-tt-pkg">${getDependencyGraph().importedBy.get(p.pkg)?.length ?? 0} ${graphTerms(graph).importers} · ${getDependencyGraph().importsOf.get(p.pkg)?.length ?? 0} dependencies</div>` : null}
      ${layersOn() ? html`<div class="g2-tt-pkg">${layers.depth.has(p.pkg)
        ? `Level ${layers.depth.get(p.pkg)} · shortest import distance from App`
        : 'No known import path from App'}</div>` : null}
      <div class="g2-tt-head">
        <span class="g2-tt-dot" style=${styleMap({ background: pkgColor(p.pkg) })}></span>
        <span class="g2-tt-pkg">${members}</span>
      </div>
      ${p.totalIssues > 0 ? renderSevChips(p.own) : null}
    `, tooltip)
    placeTooltip(cx, cy)
  }

  // 12px below-right of the cursor, flipped at the stage's right and bottom
  // edges, kept 4px inside its top-left.
  function placeTooltip(cx, cy) {
    const stageRect = stage.getBoundingClientRect()
    // Shown before measuring: a hidden tooltip has no layout.
    tooltip.classList.add('show')
    const ttH = tooltip.offsetHeight, ttW = tooltip.offsetWidth
    const sx = cx - stageRect.left, sy = cy - stageRect.top
    let tx = sx + 12
    if (tx + ttW > stageRect.width - 4) tx = sx - ttW - 12
    if (tx < 4) tx = 4
    let ty = sy + 12
    if (ty + ttH > stageRect.height - 4) ty = sy - ttH - 12
    if (ty < 4) ty = 4
    tooltip.style.left = `${tx}px`
    tooltip.style.top = `${ty}px`
  }
  function hideTooltip() { if (tooltip) tooltip.classList.remove('show') }

  // ── Pan / zoom / click ────────────────────────────────────────
  let dragging = false
  let dragStart = null
  let dragMoved = false
  const stagePoint = (e) => {
    const rect = stage.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  const onMouseDown = (e) => {
    if (e.button !== 0) return
    // Presses on the corner overlays (back, zoom, focus-package buttons) are
    // theirs: a canvas click would clear the selection and re-render the
    // overlay slot, detaching the button before its click handler runs.
    if (e.target.closest('.g2-stage-overlay, .g2-stage-overlay-tr, .g2-zoom-ctrl')) return
    dragging = true
    dragMoved = false
    dragStart = { x: e.clientX, y: e.clientY, tx: viewport.tx, ty: viewport.ty }
  }
  const onMouseMove = (e) => {
    if (dragging) {
      const dx = e.clientX - dragStart.x
      const dy = e.clientY - dragStart.y
      if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true
      viewport.tx = dragStart.tx + dx
      viewport.ty = dragStart.ty + dy
      hideTooltip()
      requestDraw()
      return
    }
    // Keyed by the active node set's `file` (the package name at package
    // altitude). Mode flips re-attach, so a key never leaks across modes.
    const hit = pickNode(...stagePoint(e))
    const prev = hovered
    hovered = hit?.file ?? null
    canvas.style.cursor = 'default'
    if (hit) (selectsPackages() ? showPkgTooltip : showTooltip)(hit, e.clientX, e.clientY)
    else if (prev) hideTooltip()
    if (hovered !== prev) requestDraw()
  }
  const onMouseUp = (e) => {
    if (dragging && !dragMoved) {
      const hit = pickNode(...stagePoint(e))
      if (selectsPackages()) {
        // Toggle the package selection; empty space deselects.
        graph2.solo = hit && graph2.solo !== hit.pkg ? hit.pkg : null
        graph2.selected = null
        refreshSidebar()
        refreshTopPkgs?.()
      } else {
        graph2.selected = hit?.file ?? null
        refreshSidebar()
      }
      requestDraw()
    }
    dragging = false
  }
  const onMouseLeave = () => {
    const wasHovered = hovered !== null
    hovered = null
    hideTooltip()
    if (wasHovered) requestDraw()
  }

  // Zoom to `k` within the fit floor and the 999% ceiling, keeping the screen
  // point (sx, sy) in place. Dependencies measures zoom from its fit, so
  // small graphs still get the full range.
  function zoomAt(k, sx, sy, fitK = computeFit().k) {
    const metrics = graphZoomMetrics(viewport.k, fitK, dependenciesOn())
    const [wx, wy] = screenToWorld(sx, sy)
    viewport.k = Math.max(metrics.min, Math.min(metrics.max, k))
    viewport.tx = sx - wx * viewport.k
    viewport.ty = sy - wy * viewport.k
    requestDraw()
  }
  const onWheel = (e) => {
    e.preventDefault()
    const [sx, sy] = stagePoint(e)
    const factor = Math.exp(-e.deltaY * 0.0015)
    const fit = computeFit()
    // Zooming out past the fit re-centers instead: each step lerps toward
    // the fitted position, in proportion to the wheel's magnitude, so
    // trackpads glide and mouse wheels snap without overshooting.
    if (factor < 1 && viewport.k <= fit.k * 1.0001) {
      viewport.k = fit.k
      const step = Math.min(0.4, (1 - factor) * 3)
      viewport.tx += (fit.tx - viewport.tx) * step
      viewport.ty += (fit.ty - viewport.ty) * step
      requestDraw()
      return
    }
    zoomAt(viewport.k * factor, sx, sy, fit.k)
  }

  stage.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  stage.addEventListener('mouseleave', onMouseLeave)
  stage.addEventListener('wheel', onWheel, { passive: false })

  const zIn = root.querySelector('#g2-zoom-in')
  const zOut = root.querySelector('#g2-zoom-out')
  const zFit = root.querySelector('#g2-zoom-fit')
  zIn?.addEventListener('click', () => zoomAt(viewport.k * 1.4, W / 2, H / 2))
  zOut?.addEventListener('click', () => zoomAt(viewport.k / 1.4, W / 2, H / 2))
  zFit?.addEventListener('click', () => { fitToView(); requestDraw() })

  // A resized stage (sidebar collapse, window resize) refits the viewport
  // but keeps the layout: relaying out on every drag of a window edge would
  // jitter the graph.
  resize()
  const ro = new ResizeObserver(() => resize())
  ro.observe(stage)

  // Body-class changes: a fullscreen toggle lays out again for the new
  // viewport (layout constants scale with the canvas) once the
  // ResizeObserver reports, with a fallback for when the size ends up the
  // same; any other change (a theme) repaints.
  const fsObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if ((m.oldValue || '').includes('report-fullscreen') !== document.body.classList.contains('report-fullscreen')) {
        layoutW = 0
        layoutH = 0
        needsLayout = true
        needsFit = true
        graph2.layoutCache = null
        setTimeout(() => resize(), 80)
        return
      }
      requestDraw()
    }
  })
  fsObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
    attributeOldValue: true,
  })

  graph2.graphState = {
    requestDraw,
    _cleanup: ({ keepViewport = false } = {}) => {
      // Keep only a viewport fitted to a laid-out stage: while the graph
      // is being replaced its stage can collapse, and resize() then refits
      // to the 80px floor, which would hand the next attach a near-zero zoom.
      const stageBox = stage.getBoundingClientRect()
      graph2.keptViewport = keepViewport && stageBox.width > 0 && stageBox.height > 0
        ? { key: viewKey, k: viewport.k, tx: viewport.tx, ty: viewport.ty, W, H, layoutW, layoutH }
        : null
      destroyed = true
      cancelAnimationFrame(rafId)
      ro.disconnect()
      fsObserver.disconnect()
      stage.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      stage.removeEventListener('mouseleave', onMouseLeave)
      stage.removeEventListener('wheel', onWheel)
    },
  }
}
