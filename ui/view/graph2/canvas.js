import { graph2 } from './state.js'
import { layoutFilesVogel, layoutSpiral } from './layout.js'
import { renderSevChips } from './render.js'
import { forceLayout, pkgColor } from '../graph/utils.js'

// Severity palette baked into the canvas. Vivid hot colors for
// critical/high so they pop above the package hue, calmer tones
// for medium/low; bug-class tiers (high_bug, bug) use earthy
// browns to differentiate them from the saturated vuln palette;
// informational uses a saturated blue. Theme-independent — they
// read as data colors regardless of chrome lightness. Critical
// rings get a slightly larger radius + thicker stroke (see the
// ringR / lw branches in draw) so they stand out without
// needing the time-driven pulse the design originally used.
//
// Tier set matches format.js SEVERITIES so the topbar pill row
// can display every tier the findings tab can produce.
const SEV_COLORS = {
  critical: '#ff5470',
  high: '#ff9d4a',
  medium: '#f4d35e',
  low: '#67c2ff',
  high_bug: '#a06c3f',
  bug: '#7a6d62',
  informational: '#218bff',
}

// Theme-aware canvas palette. Mirrors graph v1's GRAPH_THEMES
// pattern (./view/graph/canvas.js): values baked into the JS
// rather than read from CSS so the per-frame draw doesn't pay a
// getComputedStyle round-trip. The chrome around the canvas (panels,
// toolbar, tooltip) is plain CSS using the shared --bg / --surface /
// etc. vars so it flips with the user's theme; canvas-internal
// fills flip alongside via currentTheme().
const G2_THEMES = {
  dark: {
    bg: '#0c0c0c',
    grid: 'rgba(255, 255, 255, 0.022)',
    selectRing: '#ffffff',
    edgeIntra: 'rgba(180, 195, 215, ALPHA)',
    hubRing: 'rgba(255, 255, 255, ALPHA)',
    labelFill: 'rgba(230, 233, 238, 0.78)',
    // Package-view label palette — mirrors graph v1's colors so
    // labels read against the canvas backdrop without bleeding
    // into adjacent nodes.
    labelShadow: 'rgba(12, 12, 12, 0.98)',
    labelOutline: 'rgba(12, 12, 12, 0.9)',
    labelDefault: 'rgba(200, 210, 225, 0.78)',
    labelHover: 'rgba(230, 237, 243, 0.95)',
    labelSelected: '#fff',
  },
  light: {
    bg: '#f6f8fa',
    grid: 'rgba(0, 0, 0, 0.04)',
    selectRing: '#0969da',
    edgeIntra: 'rgba(50, 70, 100, ALPHA)',
    hubRing: 'rgba(0, 0, 0, ALPHA)',
    labelFill: 'rgba(40, 50, 70, 0.85)',
    labelShadow: 'rgba(255, 255, 255, 0.95)',
    labelOutline: 'rgba(255, 255, 255, 0.9)',
    labelDefault: 'rgba(50, 60, 80, 0.85)',
    labelHover: 'rgba(20, 25, 35, 0.95)',
    labelSelected: '#000',
  },
}

function currentTheme() {
  return document.body.classList.contains('theme-light') ? G2_THEMES.light : G2_THEMES.dark
}

// 0..1 → 2-digit hex alpha — appended to a 6-digit hex color so we
// can compose `'#ffaa00' + alphaHex(0.3)` cheaply in inner draw
// loops without ctx.globalAlpha bookkeeping.
function alphaHex(a) {
  const v = Math.max(0, Math.min(255, Math.round(a * 255)))
  return v.toString(16).padStart(2, '0')
}

// Wire up the v2 canvas: layout (deferred to first resize so the
// solver gets real dimensions), draw loop, hover/click hit-test,
// pan/zoom, and all the live counters in the corner readouts.
// The container is the .graph2-stage element; refresh is a
// function the renderer passes in to rebuild the right-panel
// selection card after a click (it already owns the data context
// the card needs).
export function attachGraph2Interaction(container, graph, refreshSidebar) {
  const canvas = container.querySelector('#g2-canvas')
  const tooltip = container.querySelector('#g2-tooltip')
  const stage = container.querySelector('.graph2-stage')
  const zoomEl = container.querySelector('#g2-zoom-pct')

  if (!canvas) return

  const ctx = canvas.getContext('2d')
  let dpr = window.devicePixelRatio || 1
  let W = 0, H = 0
  let viewport = { tx: 0, ty: 0, k: 1 }
  let hovered = null
  let layoutW = 0, layoutH = 0
  let needsLayout = true
  let needsFit = true

  // Keep a reference to the current selected file in a local for
  // fast access in draw — the renderer mutates graph2.selected on
  // click, but reading it through the import is fine since modules
  // are live-bound.

  // ── Layout (deferred until we have real canvas dimensions) ─────
  function ensureLayout() {
    if (!needsLayout) return
    const cache = graph2.layoutCache
    const focused = graph2.focusedPkg
    if (cache && cache.files === graph.files && cache.w === layoutW && cache.h === layoutH && cache.focused === focused) {
      // Reuse cached positions — copy back into the live nodes.
      for (const n of graph.nodes) {
        const p = cache.pos.get(n.file)
        if (p) { n.x = p.x; n.y = p.y }
      }
    } else {
      if (focused) {
        // Package-focus mode: graph v1's force-directed solver
        // shines on small subgraphs (a few dozen files) and
        // gives the structural-cluster look the user expects
        // from v1, but it's O(N²) per iteration and locks up
        // the UI on packages with hundreds of files. Switch to
        // a file-level Vogel sunflower past 50 files — instant,
        // visually consistent with the spiral view, hubs still
        // land at center via the degree-desc sort.
        if (graph.nodes.length > 50) {
          layoutFilesVogel(graph, layoutW, layoutH)
        } else {
          const sol = forceLayout(graph.files, graph.importsOf, layoutW, layoutH)
          const idx = new Map(sol.map((s) => [s.file, s]))
          for (const n of graph.nodes) {
            const p = idx.get(n.file)
            if (p) { n.x = p.x; n.y = p.y }
          }
        }
      } else {
        layoutSpiral(graph, layoutW, layoutH)
      }
      const pos = new Map()
      for (const n of graph.nodes) pos.set(n.file, { x: n.x, y: n.y })
      graph2.layoutCache = { files: graph.files, w: layoutW, h: layoutH, pos, focused }
    }
    needsLayout = false
  }

  // Computes the (k, tx, ty) that would fit the graph's
  // bounding box into the viewport with 10% padding. Pure
  // function — doesn't mutate viewport. Used by fitToView()
  // and by the wheel handler to clamp min-zoom and to know
  // where "centered" is for the pan-to-center fallback.
  function computeFit() {
    if (graph.nodes.length === 0) {
      return { k: 1, tx: W / 2, ty: H / 2 }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of graph.nodes) {
      if (n.x < minX) minX = n.x
      if (n.y < minY) minY = n.y
      if (n.x > maxX) maxX = n.x
      if (n.y > maxY) maxY = n.y
    }
    const w = Math.max(20, maxX - minX), h = Math.max(20, maxY - minY)
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    const pad = Math.min(W, H) * 0.1
    const rawK = Math.min((W - pad * 2) / w, (H - pad * 2) / h, 4)
    const k = Math.max(0.05, rawK)
    return { k, tx: W / 2 - cx * k, ty: H / 2 - cy * k }
  }

  function fitToView() {
    const fit = computeFit()
    viewport.k = fit.k
    viewport.tx = fit.tx
    viewport.ty = fit.ty
  }

  function worldToScreen(x, y) {
    return [x * viewport.k + viewport.tx, y * viewport.k + viewport.ty]
  }
  function screenToWorld(sx, sy) {
    return [(sx - viewport.tx) / viewport.k, (sy - viewport.ty) / viewport.k]
  }

  // Visibility predicate — only the legacy package-hide set,
  // which nothing currently writes to. Solo and the severity
  // filter are NOT here on purpose: they dim non-matching nodes
  // to 0.1 instead of hiding them, so they still occupy space
  // and read as context (the user can see "where" the matching
  // subgraph sits inside the larger picture).
  function nodeVisible(n) {
    if (graph2.hidden.has(n.pkg)) return false
    return true
  }

  // Soft-dim predicate. Returns true when a node should be
  // rendered at reduced opacity (0.1) — triggered by any of:
  //   - severity filter: 1+ severities selected and this
  //     node's issue isn't in the set
  //   - package-solo: a package is solo'd and this node isn't
  //     in it
  //   - path/package filter: non-empty, and neither the file
  //     path nor the package name case-insensitively contains
  //     the filter text
  // All three are independent and AND-combine — a node passes
  // only when it satisfies every active filter.
  function nodeIsDimmed(n) {
    if (graph2.selectedSeverities.size > 0 && !(n.issue && graph2.selectedSeverities.has(n.issue))) return true
    if (graph2.solo && n.pkg !== graph2.solo) return true
    const pathQ = graph2.pathFilter
    if (pathQ) {
      const q = pathQ.toLowerCase()
      const matchesFile = n.file.toLowerCase().includes(q)
      const matchesPkg = n.pkg && n.pkg.toLowerCase().includes(q)
      if (!matchesFile && !matchesPkg) return true
    }
    return false
  }

  function nodeRadius(n) {
    const base = (n.isHub ? 6 : 3.5) * graph2.nodeSize
    const z = Math.max(0.6, Math.min(1.6, viewport.k))
    return base * z
  }

  // ── Resize / DPR handling ─────────────────────────────────────
  function resize() {
    const rect = stage.getBoundingClientRect()
    const prevW = W, prevH = H
    W = Math.max(80, rect.width)
    H = Math.max(80, rect.height)
    dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr; canvas.height = H * dpr
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // Layout in the same pixel space the canvas paints in, so
    // the layout's per-package disk and ring radii track the
    // viewport.
    if (layoutW === 0 || layoutH === 0) {
      layoutW = W; layoutH = H; needsLayout = true
    }
    ensureLayout()
    // Refit on first resize OR when the viewport changed substantially
    // (e.g. fullscreen toggle: stage went from ~600×500 to ~1400×900).
    // Without this, the existing pan/zoom keeps the old framing and
    // the canvas opens with a slice of the graph off-screen. The 15%
    // threshold avoids re-fitting on cosmetic 1px reflows from sub-
    // pixel rounding when DPR changes.
    const sizeChanged = prevW > 0 && (Math.abs(W - prevW) / prevW > 0.15 || Math.abs(H - prevH) / prevH > 0.15)
    if (needsFit || sizeChanged) { fitToView(); needsFit = false }
    // Always redraw on resize: the canvas pixel buffer was just
    // resized via canvas.width/.height, which clears it. Without
    // an explicit draw the canvas would render blank until the
    // next user interaction.
    requestDraw()
  }

  // ── Draw ──────────────────────────────────────────────────────
  // On-demand scheduling: the canvas redraws only when something
  // changes (pan / zoom / hover / selection / layout / theme /
  // resize). An earlier version ran requestAnimationFrame(draw)
  // continuously to support the time-driven critical-issue
  // pulse, but the pulse is gone and a 12k-file canvas at 60fps
  // is wasteful. requestDraw() sets a dirty flag and coalesces
  // multiple state changes within a frame into a single draw
  // call via rAF.
  let rafId = null
  let needsDraw = true
  let drawScheduled = false
  let destroyed = false
  function requestDraw() {
    needsDraw = true
    if (drawScheduled || destroyed) return
    drawScheduled = true
    rafId = requestAnimationFrame(() => {
      drawScheduled = false
      if (needsDraw && !destroyed) {
        needsDraw = false
        draw()
      }
    })
  }

  function draw() {
    const T = currentTheme()
    ctx.fillStyle = T.bg
    ctx.fillRect(0, 0, W, H)

    // Subtle grid — dimmed at low zoom so it doesn't fight the data.
    drawGrid(T)

    const selected = graph2.selected
    const sel = selected ? graph.nodeByFile.get(selected) : null

    // Package-focus mode has two render paths matching the
    // layout split. Small packages (≤ 50 files) get the v1
    // graph treatment — curved edges, arrowheads, file labels
    // on every node — because the file count is low enough
    // that the chrome reads cleanly. Larger packages reuse
    // the spiral renderer below: straight edges, opt-in
    // labels (zoom > 1.4 via showLabels), no per-node text
    // crowding, just the Vogel-laid-out subgraph rendered
    // as a subset of the main canvas.
    if (graph2.focusedPkg && graph.nodes.length <= 50) {
      drawPackageView(T, selected, sel)
      return
    }

    // ── Edges (back layer) — always drawn, cross/intra still
    // get distinct visual treatment (cross = gradient between
    // package hues, intra = neutral structural gray) so the
    // axis is still readable without a topbar toggle.
    for (const e of graph.edges) {
      const na = graph.nodeByFile.get(e.a)
      const nb = graph.nodeByFile.get(e.b)
      if (!na || !nb) continue
      if (!nodeVisible(na) || !nodeVisible(nb)) continue

      let alpha = graph2.edgeOpacity
      if (selected) {
        const touches = e.a === selected || e.b === selected
        alpha = touches ? 0.85 : graph2.edgeOpacity * 0.25
      } else if (hovered) {
        const touches = e.a === hovered || e.b === hovered
        if (touches) alpha = Math.min(0.9, alpha + 0.5)
      }
      // Soft-dim when neither endpoint passes the active
      // filter set (severity highlight + package solo). The
      // edge connects two "context" nodes in that case; fade
      // it hard so the matching subgraph stands out. When at
      // least one endpoint matches, keep the edge legible
      // so the user can trace what the matching node
      // connects to.
      if (nodeIsDimmed(na) && nodeIsDimmed(nb)) {
        alpha = Math.min(alpha, 0.04)
      }

      const [ax, ay] = worldToScreen(na.x, na.y)
      const [bx, by] = worldToScreen(nb.x, nb.y)

      if (e.cross) {
        // Gradient between package colors so the eye can trace
        // who's on which side of a cross-package import without
        // having to chase node colors visually.
        const grad = ctx.createLinearGradient(ax, ay, bx, by)
        grad.addColorStop(0, pkgColor(na.pkg) + alphaHex(alpha))
        grad.addColorStop(1, pkgColor(nb.pkg) + alphaHex(alpha))
        ctx.strokeStyle = grad
        ctx.lineWidth = 0.85
      } else {
        // Intra-package edges use the theme's neutral edge color
        // so they read as "structural" rather than competing
        // with the vivid cross-package gradients.
        ctx.strokeStyle = T.edgeIntra.replace('ALPHA', String(alpha * 0.7))
        ctx.lineWidth = 0.55
      }

      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.stroke()
    }

    // ── Halos (hubs / hover / selected) ─────────────────────────
    if (graph2.showHalos) {
      for (const n of graph.nodes) {
        if (!nodeVisible(n)) continue
        const isHov = n.file === hovered
        const isSel = n.file === selected
        if (!n.isHub && !isHov && !isSel) continue
        // Skip halos for filter-dimmed nodes (severity or
        // package-solo) unless they're the hover / selection
        // target — those should always read clearly.
        if (nodeIsDimmed(n) && !isHov && !isSel) continue
        const [sx, sy] = worldToScreen(n.x, n.y)
        const r = nodeRadius(n)
        const haloR = r * (isSel ? 6 : isHov ? 4.5 : 3)
        const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, haloR)
        const col = pkgColor(n.pkg)
        grad.addColorStop(0, col + '55')
        grad.addColorStop(1, col + '00')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(sx, sy, haloR, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // ── Nodes ───────────────────────────────────────────────────
    for (const n of graph.nodes) {
      if (!nodeVisible(n)) continue
      const [sx, sy] = worldToScreen(n.x, n.y)
      const r = nodeRadius(n)
      let dim = 1
      const isExplicitlySelected = selected && n.file === selected
      if (selected && !isExplicitlySelected) {
        const touches = (graph.adj.get(selected) ?? []).some((ei) => {
          const e = graph.edges[ei]; return e.a === n.file || e.b === n.file
        })
        dim = touches ? 1 : 0.25
      }
      // Filter dim — severity-filter-out OR package-solo-out
      // nodes drop to 0.1 so the highlighted subgraph reads
      // as the focus. Skipped for the explicitly-selected node
      // (always full opacity) and stacks with file-selection
      // dim via Math.min, so a non-matching non-touching node
      // ends up at min(0.25, 0.1) = 0.1.
      if (!isExplicitlySelected && nodeIsDimmed(n)) {
        dim = Math.min(dim, 0.1)
      }

      ctx.fillStyle = pkgColor(n.pkg) + alphaHex(dim)
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.fill()

      if (n.isHub && graph2.highlightHubs) {
        // White ring on dark, near-black on light — the hub marker
        // needs maximum contrast against the package-colored fill.
        ctx.strokeStyle = T.hubRing.replace('ALPHA', String(0.55 * dim))
        ctx.lineWidth = 0.8
        ctx.stroke()
      }

      if (n.issue) {
        const sevColor = SEV_COLORS[n.issue]
        const ringR = r + (n.issue === 'critical' ? 4.2 : n.issue === 'high' ? 3.4 : 2.8)
        const lw = n.issue === 'critical' ? 1.8 : n.issue === 'high' ? 1.5 : n.issue === 'medium' ? 1.3 : 1.1
        ctx.strokeStyle = sevColor
        ctx.globalAlpha = dim
        ctx.lineWidth = lw
        ctx.beginPath()
        ctx.arc(sx, sy, ringR, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = 1
      }
    }

    // ── Labels (high zoom only) ──────────────────────────────────
    if (graph2.showLabels && viewport.k > 1.4) {
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'
      ctx.fillStyle = T.labelFill
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      for (const n of graph.nodes) {
        if (!nodeVisible(n)) continue
        if (!n.isHub && viewport.k < 2.4) continue
        const [sx, sy] = worldToScreen(n.x, n.y)
        const r = nodeRadius(n)
        ctx.fillText(n.label, sx + r + 4, sy + 1)
      }
    }

    // Selection ring on top so it never gets hidden by neighbors.
    // White on dark canvas, accent-blue on light — same swap graph
    // v1's GRAPH_THEMES.selectRing makes.
    if (sel && nodeVisible(sel)) {
      const [sx, sy] = worldToScreen(sel.x, sel.y)
      const r = nodeRadius(sel)
      ctx.strokeStyle = T.selectRing
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(sx, sy, r + 5, 0, Math.PI * 2)
      ctx.stroke()
    }

    if (zoomEl) zoomEl.textContent = `${Math.round(viewport.k * 100)}%`
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

  // Package-focus rendering — v1-style: curved edges with
  // arrowheads, file labels on every node, single hue (the
  // focused package's color). Operates on the same nodes/edges
  // as the spiral view, but with the assumption that the layout
  // pass produced a force-directed arrangement.
  function drawPackageView(T, selected, sel) {
    const baseColor = pkgColor(graph2.focusedPkg)
    // Connected-files set for hover dimming (mirrors v1's pattern)
    const connected = new Set()
    if (hovered) {
      connected.add(hovered)
      for (const ei of (graph.adj.get(hovered) ?? [])) {
        const e = graph.edges[ei]
        connected.add(e.a); connected.add(e.b)
      }
    }
    // Nodes' display radius — bigger than spiral's tight dots
    // since the package view zooms into a small subgraph and
    // can afford to read at a coarser grain.
    const nodeR = (n) => {
      const base = (n.isHub ? 6 : 4) * graph2.nodeSize
      return base
    }

    // ── Edges with curves + arrowheads ────────────────────────
    for (const e of graph.edges) {
      const na = graph.nodeByFile.get(e.a)
      const nb = graph.nodeByFile.get(e.b)
      if (!na || !nb) continue
      if (!nodeVisible(na) || !nodeVisible(nb)) continue
      // Direction: bidi (both directions present) → arrows on
      // both ends; unidirectional → arrow on the target end.
      // `fromLo/fromHi` was set in data.js from the original
      // imports relation before edge dedup.
      const bidi = e.fromLo && e.fromHi
      const reversed = !bidi && e.fromHi
      const a = reversed ? nb : na
      const b = reversed ? na : nb
      const isHov = hovered && (e.a === hovered || e.b === hovered)
      const isSel = selected && (e.a === selected || e.b === selected)
      const isDim = (selected || hovered) && !isHov && !isSel

      const ra = nodeR(a), rb = nodeR(b)
      const [ax, ay] = worldToScreen(a.x, a.y)
      const [bx, by] = worldToScreen(b.x, b.y)
      const dx = bx - ax, dy = by - ay
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      const ux = dx / len, uy = dy / len
      // Inset endpoints by node radius so the curve starts on
      // the rim of the source and ends on the rim of the target.
      const sx = ax + ux * (ra + 1.5), sy = ay + uy * (ra + 1.5)
      const ex = bx - ux * (rb + 3.5), ey = by - uy * (rb + 3.5)
      const off = Math.min(len * 0.15, 30)
      const qcx = (sx + ex) / 2 - uy * off
      const qcy = (sy + ey) / 2 + ux * off

      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.quadraticCurveTo(qcx, qcy, ex, ey)
      let edgeAlpha
      if (isSel) edgeAlpha = 0.9
      else if (isHov) edgeAlpha = 0.85
      else if (isDim) edgeAlpha = 0.05
      else edgeAlpha = Math.min(0.85, graph2.edgeOpacity * 3)
      ctx.strokeStyle = baseColor + alphaHex(edgeAlpha)
      ctx.lineWidth = isSel || isHov ? 1.5 : 0.85
      ctx.stroke()

      if (isDim) continue
      // Arrowhead at the curve's endpoint. Tangent direction
      // computed from the quadratic Bezier derivative at t=0.9
      // (just before the end so the arrow doesn't overshoot).
      const arrowLen = Math.max(5, 7)
      const arrowW = arrowLen * 0.42
      const t = 0.9
      const tx = 2 * (1 - t) * (qcx - sx) + 2 * t * (ex - qcx)
      const ty = 2 * (1 - t) * (qcy - sy) + 2 * t * (ey - qcy)
      const tl = Math.sqrt(tx * tx + ty * ty) || 1
      const tux = tx / tl, tuy = ty / tl
      ctx.beginPath()
      ctx.moveTo(ex, ey)
      ctx.lineTo(ex - tux * arrowLen + tuy * arrowW, ey - tuy * arrowLen - tux * arrowW)
      ctx.lineTo(ex - tux * arrowLen - tuy * arrowW, ey - tuy * arrowLen + tux * arrowW)
      ctx.closePath()
      ctx.fillStyle = baseColor + alphaHex(Math.min(1, edgeAlpha + 0.15))
      ctx.fill()

      if (bidi) {
        // Back-arrow at the start of the curve for bidi pairs.
        const t0 = 0.1
        const tx0 = 2 * (1 - t0) * (qcx - sx) + 2 * t0 * (ex - qcx)
        const ty0 = 2 * (1 - t0) * (qcy - sy) + 2 * t0 * (ey - qcy)
        const tl0 = Math.sqrt(tx0 * tx0 + ty0 * ty0) || 1
        const tux0 = tx0 / tl0, tuy0 = ty0 / tl0
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.lineTo(sx + tux0 * arrowLen - tuy0 * arrowW, sy + tuy0 * arrowLen + tux0 * arrowW)
        ctx.lineTo(sx + tux0 * arrowLen + tuy0 * arrowW, sy + tuy0 * arrowLen - tux0 * arrowW)
        ctx.closePath()
        ctx.fill()
      }
    }

    // ── Nodes ─────────────────────────────────────────────────
    for (const n of graph.nodes) {
      if (!nodeVisible(n)) continue
      const [sx, sy] = worldToScreen(n.x, n.y)
      const r = nodeR(n)
      const isHov = n.file === hovered
      const isSel = n.file === selected
      const dim = (selected || hovered) && !connected.has(n.file) && !isSel ? 0.15 : 1

      ctx.globalAlpha = dim
      // Halo for selected / hovered / hubs — gives them visual
      // weight without changing radius (which would shift the
      // edge rim-anchors).
      if (graph2.showHalos && (isSel || isHov || n.isHub)) {
        const haloR = r * (isSel ? 4 : isHov ? 3 : 2.4)
        const grad = ctx.createRadialGradient(sx, sy, r * 0.6, sx, sy, haloR)
        grad.addColorStop(0, baseColor + alphaHex(isSel ? 0.4 : 0.25))
        grad.addColorStop(1, baseColor + '00')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(sx, sy, haloR, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.fillStyle = baseColor
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.fill()

      if (n.isHub && graph2.highlightHubs) {
        ctx.strokeStyle = T.hubRing.replace('ALPHA', '0.55')
        ctx.lineWidth = 0.9
        ctx.stroke()
      }

      if (n.issue) {
        const sevColor = SEV_COLORS[n.issue]
        const ringR = r + (n.issue === 'critical' ? 4.2 : n.issue === 'high' ? 3.4 : 2.8)
        const lw = n.issue === 'critical' ? 1.8 : n.issue === 'high' ? 1.5 : n.issue === 'medium' ? 1.3 : 1.1
        ctx.strokeStyle = sevColor
        ctx.lineWidth = lw
        ctx.beginPath()
        ctx.arc(sx, sy, ringR, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    // ── Labels (always visible in package view) ───────────────
    ctx.font = `600 11px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'
    for (const n of graph.nodes) {
      if (!nodeVisible(n)) continue
      const [sx, sy] = worldToScreen(n.x, n.y)
      const r = nodeR(n)
      const ty = sy + r + 4
      const isSel = n.file === selected
      const isHov = n.file === hovered
      const dim = (selected || hovered) && !connected.has(n.file) && !isSel ? 0.2 : 1
      ctx.globalAlpha = dim
      // Outline + shadow for legibility on any backdrop.
      ctx.shadowColor = T.labelShadow
      ctx.shadowBlur = 4
      ctx.strokeStyle = T.labelOutline
      ctx.lineWidth = 3
      ctx.strokeText(n.label, sx, ty)
      ctx.shadowBlur = 0
      ctx.fillStyle = isSel ? T.labelSelected : isHov ? T.labelHover : T.labelDefault
      ctx.fillText(n.label, sx, ty)
      ctx.globalAlpha = 1
    }

    // Selection ring on top.
    if (sel && nodeVisible(sel)) {
      const [sx, sy] = worldToScreen(sel.x, sel.y)
      const r = nodeR(sel)
      ctx.strokeStyle = T.selectRing
      ctx.lineWidth = 1.8
      ctx.beginPath()
      ctx.arc(sx, sy, r + 4, 0, Math.PI * 2)
      ctx.stroke()
    }

    if (zoomEl) zoomEl.textContent = `${Math.round(viewport.k * 100)}%`
  }

  // ── Hit test ──────────────────────────────────────────────────
  function pickNode(sx, sy) {
    let best = null, bestD = Infinity
    const tol = 6
    for (const n of graph.nodes) {
      if (!nodeVisible(n)) continue
      const [nx, ny] = worldToScreen(n.x, n.y)
      const dx = nx - sx, dy = ny - sy
      const d = dx * dx + dy * dy
      const r = nodeRadius(n) + tol
      if (d < r * r && d < bestD) { bestD = d; best = n }
    }
    return best
  }

  function showTooltip(n, cx, cy) {
    if (!tooltip) return
    const stageRect = stage.getBoundingClientRect()
    const col = pkgColor(n.pkg)
    const pkgLabel = n.pkg === '__own__' ? 'own source' : n.pkg
    // Header carries the file label; the chip block below shows
    // the full per-severity breakdown ("3 HIGH" / "2 MEDIUM").
    // Type / Degree / Intra / Cross rows used to live here but
    // were dropped — the canvas already encodes that info (hub
    // halo, edge density), and the chips give the actionable
    // signal. Keeps the two graph tabs visually consistent.
    let html = `
      <div class="g2-tt-head">
        <span class="g2-tt-dot" style="background:${col}"></span>
        <span class="g2-tt-id">${escapeHtml(n.label)}</span>
      </div>
      <dl class="g2-tt-grid">
        <dt>Package</dt><dd>${escapeHtml(pkgLabel)}</dd>
      </dl>`
    if (n.totalIssues > 0) html += renderSevChips(n.own)
    tooltip.innerHTML = html
    // Show first, THEN measure — the browser doesn't compute layout
    // for `display: none` / opacity: 0 elements and we need the real
    // width/height to do edge-flip correctly. Adding the .show class
    // bumps opacity, which is enough to get a reliable bbox.
    tooltip.classList.add('show')
    const ttW = tooltip.offsetWidth
    const ttH = tooltip.offsetHeight
    const sx = cx - stageRect.left
    const sy = cy - stageRect.top
    const stageW = stageRect.width
    const stageH = stageRect.height
    // Default: 12px to the right and below the cursor (matches v1's
    // intent of "near the cursor, not under it"). Flip horizontally
    // when it would overshoot the right edge — same logic v1 uses
    // (`tx = cx - 254` style flip, sized to the actual tooltip
    // width here so the flip holds for any content). Flip vertically
    // when too close to the bottom; clamp at top so the tooltip
    // doesn't scroll out of view when hovering near the top edge.
    const PAD = 12
    let tx = sx + PAD
    if (tx + ttW > stageW - 4) tx = sx - ttW - PAD
    if (tx < 4) tx = 4
    let ty = sy + PAD
    if (ty + ttH > stageH - 4) ty = sy - ttH - PAD
    if (ty < 4) ty = 4
    tooltip.style.left = `${tx}px`
    tooltip.style.top = `${ty}px`
  }
  function hideTooltip() { if (tooltip) tooltip.classList.remove('show') }

  function escapeHtml(s) {
    const el = document.createElement('span'); el.textContent = String(s ?? ''); return el.innerHTML
  }

  // ── Pan / zoom / click ────────────────────────────────────────
  let dragging = false
  let dragStart = null
  let dragMoved = false

  const onMouseDown = (e) => {
    if (e.button !== 0) return
    dragging = true
    dragMoved = false
    dragStart = { x: e.clientX, y: e.clientY, tx: viewport.tx, ty: viewport.ty }
  }
  const onMouseMove = (e) => {
    const rect = stage.getBoundingClientRect()
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top
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
    const hit = pickNode(sx, sy)
    const prev = hovered
    hovered = hit?.file ?? null
    canvas.style.cursor = hit ? 'pointer' : 'grab'
    if (hit) showTooltip(hit, e.clientX, e.clientY)
    else if (prev) hideTooltip()
    if (hovered !== prev) requestDraw()
  }
  const onMouseUp = (e) => {
    if (dragging && !dragMoved) {
      const rect = stage.getBoundingClientRect()
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top
      const hit = pickNode(sx, sy)
      graph2.selected = hit?.file ?? null
      refreshSidebar()
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
  const onWheel = (e) => {
    e.preventDefault()
    const rect = stage.getBoundingClientRect()
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top
    const factor = Math.exp(-e.deltaY * 0.0015)
    const fit = computeFit()
    // Trying to zoom out further than the fit zoom doesn't
    // make the graph any smaller — instead, re-center the
    // viewport. Each scroll-out step lerps current tx/ty
    // toward the fit-centered position; repeated scrolls
    // converge on center. Step size proportional to wheel
    // magnitude so trackpad ticks feel smooth and mouse-wheel
    // ticks feel decisive without overshooting.
    if (factor < 1 && viewport.k <= fit.k * 1.0001) {
      viewport.k = fit.k
      const step = Math.min(0.4, (1 - factor) * 3)
      viewport.tx += (fit.tx - viewport.tx) * step
      viewport.ty += (fit.ty - viewport.ty) * step
      requestDraw()
      return
    }
    // Normal cursor-anchored zoom. Min = fit.k (no zooming
    // out past it), max = 9.99 (~999% in the readout).
    const [wx, wy] = screenToWorld(sx, sy)
    const nk = Math.max(fit.k, Math.min(9.99, viewport.k * factor))
    viewport.k = nk
    viewport.tx = sx - wx * viewport.k
    viewport.ty = sy - wy * viewport.k
    requestDraw()
  }

  stage.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  stage.addEventListener('mouseleave', onMouseLeave)
  stage.addEventListener('wheel', onWheel, { passive: false })

  // Zoom buttons — each mutation requestDraws so the next
  // animation frame paints with the new viewport. Min = fit
  // zoom (same floor the wheel handler enforces), max = 9.99.
  function zoomTo(nk) {
    const fitK = computeFit().k
    nk = Math.max(fitK, Math.min(9.99, nk))
    const cx = W / 2, cy = H / 2
    const [wx, wy] = screenToWorld(cx, cy)
    viewport.k = nk
    viewport.tx = cx - wx * viewport.k
    viewport.ty = cy - wy * viewport.k
    requestDraw()
  }
  const zIn = container.querySelector('#g2-zoom-in')
  const zOut = container.querySelector('#g2-zoom-out')
  const zFit = container.querySelector('#g2-zoom-fit')
  zIn?.addEventListener('click', () => zoomTo(viewport.k * 1.4))
  zOut?.addEventListener('click', () => zoomTo(viewport.k / 1.4))
  zFit?.addEventListener('click', () => { fitToView(); requestDraw() })

  // Resize observer — handles container resize (sidebar collapse,
  // window resize, tab switch with different available space). The
  // relayout-on-resize is intentionally off: even cheap closed-form
  // passes would jitter the graph on every drag of the window edge.
  // The canvas just
  // refits its viewport so the existing positions stay centered.
  resize()
  const ro = new ResizeObserver(() => resize())
  ro.observe(stage)

  // Body-class observer — handles two distinct triggers:
  //   - Fullscreen toggle: the layout needs to retune to the new
  //     viewport (forceLayout's k constant scales with canvas
  //     dimensions), so invalidate layoutW/H + cache and let
  //     ResizeObserver fire resize() against the new size.
  //   - Theme toggle: canvas-internal palette changes (bg, grid,
  //     edge colors) — needs a redraw but no layout / cache work.
  // attributeOldValue lets us distinguish the two by comparing the
  // old class string against the new one.
  const fsObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      const wasFs = (m.oldValue || '').includes('report-fullscreen')
      const isFs = document.body.classList.contains('report-fullscreen')
      if (wasFs !== isFs) {
        layoutW = 0
        layoutH = 0
        needsLayout = true
        needsFit = true
        graph2.layoutCache = null
        // ResizeObserver should fire shortly with the new size and
        // run resize() (which itself requestDraws). setTimeout is
        // a fallback for the rare case where the size change ends
        // up identical (e.g. the sidebar was already collapsed),
        // so RO doesn't fire but we still want a fresh layout.
        setTimeout(() => resize(), 80)
        return
      }
      // Non-fullscreen body-class change (theme toggle, others) —
      // just redraw with the current theme palette.
      requestDraw()
    }
  })
  fsObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
    attributeOldValue: true,
  })

  // Kick the first draw — resize() above already requestDraws,
  // but in case it was a no-op (canvas size unchanged across
  // re-attach), force one paint so the canvas isn't blank.
  requestDraw()

  graph2.graphState = {
    requestDraw,
    // Expose the active graph so external handlers (e.g. the
    // hub-mode switch in events.js) can mutate node flags without
    // re-attaching the canvas.
    graph,
    // Re-run the layout pass right now. Positions depend on
    // isHub — hubs sit closer to package anchors — so any
    // state that changes the hub set has to invalidate the
    // cache and reflow. ensureLayout itself is normally only
    // called from resize(); we invoke it directly here so the
    // caller doesn't have to fake a resize event.
    relayout: () => {
      graph2.layoutCache = null
      needsLayout = true
      if (layoutW > 0 && layoutH > 0) ensureLayout()
      requestDraw()
    },
    _cleanup: () => {
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
