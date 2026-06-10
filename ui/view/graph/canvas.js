import { html, render } from '../frontend-global.js'
import { cleanupGraph2, graph2 } from './state.js'
import { layoutFilesVogel, layoutSpiral } from './layout.js'
import { renderSevChips } from './render.js'
import { buildPackageGraph, pkgRelative } from './data.js'
import { pkgColor } from './utils.js'
import { forceLayout } from './force-layout.js'
import { formatBytes } from '../format.js'

// Severity palette baked into the canvas. Vivid hot colors for
// critical/high pop above the package hue; calmer tones for
// medium/low; bug-class tiers (high_bug, bug) use earthy browns to
// distinguish them from the saturated vuln palette; informational
// is a saturated blue. Theme-independent — they read as data colors
// regardless of chrome lightness. Critical rings get a larger
// radius + thicker stroke (see ringR / lw in draw) so they stand
// out without a time-driven pulse. Tier set matches format.js
// SEVERITIES so the topbar pill row shows every tier the findings
// tab can produce.
const SEV_COLORS = {
  critical: '#ff5470',
  high: '#ff9d4a',
  medium: '#f4d35e',
  low: '#67c2ff',
  high_bug: '#a06c3f',
  bug: '#7a6d62',
  informational: '#218bff',
}

// Theme-aware canvas palette. Baked into JS rather than read from
// CSS so the per-frame draw doesn't pay a getComputedStyle
// round-trip. Chrome around the canvas (panels, toolbar, tooltip)
// is plain CSS on the shared --bg / --surface / etc. vars so it
// flips with the theme; canvas-internal fills flip alongside via
// currentTheme().
const G2_THEMES = {
  dark: {
    bg: '#0c0c0c',
    grid: 'rgba(255, 255, 255, 0.022)',
    selectRing: '#ffffff',
    edgeIntra: 'rgba(180, 195, 215, ALPHA)',
    hubRing: 'rgba(255, 255, 255, ALPHA)',
    labelFill: 'rgba(230, 233, 238, 0.78)',
    // Package-view label palette — tuned so labels read against
    // the canvas backdrop without bleeding into adjacent nodes.
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
  // Pink mirrors light — the package palette, label colours, edge
  // hue and select ring all already read well on a soft pink wash —
  // but pulls the canvas fill toward the body's pink so the graph
  // surface doesn't read as a grey island inside the pink chrome.
  // Same hue/saturation as --bg (HSL ≈330° 100%) but one step
  // lighter (97% vs the body's 96%) so the canvas reads as a
  // lifted panel sitting above the page.
  pink: {
    bg: '#fff0f7',
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
  // Each named light-style theme picks its own G2_THEMES entry so
  // the canvas fill matches the surrounding page chrome; anything
  // unmatched (default dark, theme-green) falls through to dark.
  // The body-class observer in attachGraph2Interaction requestDraws
  // on any class swap, so theme changes repaint with the new palette.
  const c = document.body.classList
  if (c.contains('theme-pink')) return G2_THEMES.pink
  if (c.contains('theme-light')) return G2_THEMES.light
  return G2_THEMES.dark
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
// pan/zoom, and the live corner-readout counters. refreshSidebar
// is passed in by the renderer to rebuild the right-panel
// selection card after a click (it owns the card's data context);
// refreshTopPkgs (optional) re-paints the Packages list when a
// click changes the solo'd package (packages view only — file
// clicks don't touch solo).
export function attachGraph2Interaction(container, graph, refreshSidebar, refreshTopPkgs) {
  // Pierce the `<graph-layout>` shadow root — the canvas + corner
  // overlays + zoom controls all live inside it. Callers pass the
  // outer slot (`#findings-graph-slot` / `#bundle-graph-slot` /
  // the `#report` host); finding the shadow host here keeps the
  // call site free of shadow-DOM knowledge.
  const host = container.querySelector('graph-layout')
  const root = host?.shadowRoot
  if (!root) return
  const canvas = root.querySelector('#g2-canvas')
  const tooltip = root.querySelector('#g2-tooltip')
  const stage = root.querySelector('.graph2-stage')
  const zoomEl = root.querySelector('#g2-zoom-pct')

  if (!canvas) return

  // render.js calls this on every render() while viewMode==='graph',
  // not just on the transition in — a triageSync push or any
  // unrelated re-render mid-graph would otherwise stack window
  // listeners + ResizeObserver + MutationObserver on top of the
  // previous set, leaking handlers. Tear down any prior attachment
  // before re-wiring.
  cleanupGraph2()

  const ctx = canvas.getContext('2d')
  let dpr = window.devicePixelRatio || 1
  let H = 0
  let W = 0
  let viewport = { tx: 0, ty: 0, k: 1 }
  let hovered = null
  let layoutH = 0
  let layoutW = 0
  let needsLayout = true
  let needsFit = true

  // Package-level view (the bundle Graph tab's "Packages" toggle).
  // Effective only when the graph qualifies — 3+ packages, stamped
  // as `canPackagesView` by buildGraphFromPrep, so a toggle value
  // persisted from another bundle can't engage on a graph whose
  // topbar doesn't even offer the switch — and outside a package-
  // focus drill-in, which is a file-level mode and takes priority
  // (back out of focus and the packages view resumes).
  const pkgViewOn = () => graph2.packagesView && (graph.canPackagesView ?? false) && !graph2.focusedPkg
  // Derived once per attach on first use; the file graph is
  // immutable for the attachment's lifetime, so the aggregate is
  // too. Lazy so the findings tab / file views never pay for it.
  let _pkgGraph = null
  function getPkgGraph() {
    if (!_pkgGraph) _pkgGraph = buildPackageGraph(graph)
    return _pkgGraph
  }

  // Package-node layout — same split the package-focus mode makes
  // for files, at the same 50-node limit: force-directed while the
  // O(N²)-per-iteration solver stays interactive (clusters by
  // import structure), degree-sorted Vogel sunflower past it
  // (most-connected packages land at center). The package graph's
  // `importsOf` already has the (ids, imports-map) shape the
  // file-level solver consumes, and layoutFilesVogel only reads
  // `.nodes` / `.deg`, which the package graph also carries.
  function layoutPackages(pg, w, h) {
    if (pg.nodes.length > 50) {
      layoutFilesVogel(pg, w, h)
      return
    }
    const sol = forceLayout(pg.nodes.map((n) => n.pkg), pg.importsOf, w, h)
    const idx = new Map(sol.map((s) => [s.file, s]))
    for (const n of pg.nodes) {
      const p = idx.get(n.pkg)
      if (p) { n.x = p.x; n.y = p.y }
    }
  }

  // ── Layout (deferred until we have real canvas dimensions) ─────
  function ensureLayout() {
    if (!needsLayout) return
    const cache = graph2.layoutCache
    const focused = graph2.focusedPkg
    const pkgView = pkgViewOn()
    // Positions land on (and cache under) the active node set —
    // package aggregates in packages view (their `file` is the
    // package name), files otherwise.
    const nodes = pkgView ? getPkgGraph().nodes : graph.nodes
    if (cache && cache.files === graph.files && cache.w === layoutW && cache.h === layoutH
        && cache.focused === focused && (cache.pkgView ?? false) === pkgView) {
      // Reuse cached positions — copy back into the live nodes.
      for (const n of nodes) {
        const p = cache.pos.get(n.file)
        if (p) { n.x = p.x; n.y = p.y }
      }
    } else {
      if (pkgView) {
        layoutPackages(getPkgGraph(), layoutW, layoutH)
      } else if (focused) {
        // Package-focus mode: the force-directed solver gives the
        // structural-cluster look on small subgraphs (a few dozen
        // files), but it's O(N²) per iteration and locks up the UI
        // on packages with hundreds of files. Switch to a
        // file-level Vogel sunflower past 50 files — instant,
        // consistent with the spiral view, hubs still land at
        // center via the degree-desc sort.
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
      for (const n of nodes) pos.set(n.file, { x: n.x, y: n.y })
      graph2.layoutCache = { files: graph.files, w: layoutW, h: layoutH, pos, focused, pkgView }
    }
    needsLayout = false
  }

  // (k, tx, ty) that fits the graph's bounding box into the
  // viewport with 10% padding. Pure — doesn't mutate viewport.
  // Used by fitToView() and by the wheel handler to clamp
  // min-zoom and locate "centered" for the pan-to-center fallback.
  // Bounds come from whichever node set is on screen — package
  // aggregates in packages view, files otherwise.
  function computeFit() {
    const nodes = pkgViewOn() ? getPkgGraph().nodes : graph.nodes
    if (nodes.length === 0) {
      return { k: 1, tx: W / 2, ty: H / 2 }
    }
    let maxX = -Infinity
    let maxY = -Infinity
    let minX = Infinity
    let minY = Infinity
    for (const n of nodes) {
      if (n.x < minX) minX = n.x
      if (n.y < minY) minY = n.y
      if (n.x > maxX) maxX = n.x
      if (n.y > maxY) maxY = n.y
    }
    const h = Math.max(20, maxY - minY)
    const w = Math.max(20, maxX - minX)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
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
  // to 0.1 instead of hiding them, so they still occupy space and
  // read as context (where the matching subgraph sits in the whole).
  function nodeVisible(n) {
    if (graph2.hidden.has(n.pkg)) return false
    return true
  }

  // Soft-dim predicate — true when a node should render at reduced
  // opacity (0.1). Triggered by any of:
  //   - severity filter: 1+ severities selected, no finding matches
  //   - color filter: 1+ marker colors selected, no finding carries
  //     one (union within each axis; severity/color combine
  //     independently — same semantics as the findings tab, so the
  //     canvas highlight tracks the table's view)
  //   - package-solo: a package is solo'd and this node isn't in it
  //   - path filter: non-empty and neither file path nor package
  //     name case-insensitively contains the text
  // All filters AND-combine — a node passes only when it satisfies
  // every active filter.
  function nodeIsDimmed(n) {
    if (graph2.selectedSeverities.size > 0) {
      const sevs = n.severitySet
      if (!sevs) return true
      let hit = false
      for (const s of graph2.selectedSeverities) if (sevs.has(s)) { hit = true; break }
      if (!hit) return true
    }
    if (graph2.selectedColors.size > 0) {
      const cols = n.colorSet
      if (!cols) return true
      let hit = false
      for (const c of graph2.selectedColors) if (cols.has(c)) { hit = true; break }
      if (!hit) return true
    }
    // Solo is a package FILTER in the file views; in the packages
    // view it IS the selection (the package card's slot), and the
    // selected-neighbor dimming handles emphasis there — the hard
    // 0.1 filter dim on top would gray the selection's neighbors.
    if (graph2.solo && n.pkg !== graph2.solo && !pkgViewOn()) return true
    const pathQ = graph2.pathFilter
    if (pathQ) {
      const q = pathQ.toLowerCase()
      // Package nodes carry `pathText` (member file paths, pre-
      // lowercased) so a path fragment matches the aggregate the
      // same way it matches files in the file views; the label
      // covers the `__own__` → "own source" naming gap.
      const matchesFile = n.pathText ? n.pathText.includes(q) : n.file.toLowerCase().includes(q)
      const matchesPkg = n.pkg && n.pkg.toLowerCase().includes(q)
      const matchesLabel = n.label && n.label.toLowerCase().includes(q)
      if (!matchesFile && !matchesPkg && !matchesLabel) return true
    }
    return false
  }

  function nodeRadius(n) {
    // Hub : member radius ratio = 1.4× — clear read without
    // overpowering the cluster. A larger ratio (~1.71×) was too
    // dominant once cross-imported mode lit up many more hubs.
    const base = (n.isHub ? 4.9 : 3.5) * graph2.nodeSize
    const z = Math.max(0.6, Math.min(1.6, viewport.k))
    return base * z
  }

  // ── Resize / DPR handling ─────────────────────────────────────
  function resize() {
    const rect = stage.getBoundingClientRect()
    const prevH = H
    const prevW = W
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
    // Refit on first resize OR a substantial viewport change (e.g.
    // fullscreen toggle: ~600×500 → ~1400×900). Without this the
    // old pan/zoom framing leaves the canvas opening on a slice of
    // the graph. The 15% threshold avoids re-fitting on cosmetic
    // 1px reflows from sub-pixel rounding when DPR changes.
    const sizeChanged = prevW > 0 && (Math.abs(W - prevW) / prevW > 0.15 || Math.abs(H - prevH) / prevH > 0.15)
    if (needsFit || sizeChanged) { fitToView(); needsFit = false }
    // Always redraw on resize: the canvas pixel buffer was just
    // resized via canvas.width/.height, which clears it. Without
    // an explicit draw the canvas would render blank until the
    // next user interaction.
    requestDraw()
  }

  // ── Draw ──────────────────────────────────────────────────────
  // On-demand scheduling: redraw only on change (pan / zoom / hover
  // / selection / layout / theme / resize). Continuous rAF would be
  // wasteful on a 12k-file canvas at 60fps and nothing animates
  // per-frame. requestDraw() sets a dirty flag and coalesces changes
  // within a frame into a single rAF draw.
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

    // Packages view (bundle Graph tab toggle) — one node per
    // package. G swaps the node/edge source for the default
    // renderer below; the selection key swaps to graph2.solo (the
    // package card's slot — canvas clicks and the Packages rows
    // both write it). Normalized through the node lookup so a
    // stale key from another bundle can't dim everything against
    // a ghost node.
    const pkgView = pkgViewOn()
    const G = pkgView ? getPkgGraph() : graph
    const selKey = pkgView ? graph2.solo : graph2.selected
    const sel = selKey ? G.nodeByFile.get(selKey) : null
    const selected = sel ? selKey : null

    // Packages view, few packages (≤ 50): v1-style package chrome —
    // curved edges, arrowheads, always-on labels — the same split
    // the package-focus mode makes for files, at the same limit.
    // Past 50 the arrows + label soup stop reading, so the default
    // dot renderer below takes over with G as its node source: one
    // plain dot per package, spiral-view visual language.
    if (pkgView && G.nodes.length <= 50) {
      drawPackagesGraph(T)
      return
    }

    // Package-focus mode has two render paths matching the
    // layout split. Small packages (≤ 50 files) get the v1
    // graph treatment — curved edges, arrowheads, file labels
    // on every node — because the file count is low enough
    // that the chrome reads cleanly. Larger packages reuse
    // the spiral renderer below: straight edges, opt-in
    // labels (zoom > 1.4 via showLabels), no per-node text
    // crowding, just the Vogel-laid-out subgraph rendered
    // as a subset of the main canvas.
    if (graph2.focusedPkg && G.nodes.length <= 50) {
      drawPackageView(T, selected, sel)
      return
    }

    // ── Edges (back layer) — always drawn, cross/intra still
    // get distinct visual treatment (cross = gradient between
    // package hues, intra = neutral structural gray) so the
    // axis is still readable without a topbar toggle.
    for (const e of G.edges) {
      const na = G.nodeByFile.get(e.a)
      const nb = G.nodeByFile.get(e.b)
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
    {
      for (const n of G.nodes) {
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
    for (const n of G.nodes) {
      if (!nodeVisible(n)) continue
      const [sx, sy] = worldToScreen(n.x, n.y)
      const r = nodeRadius(n)
      let dim = 1
      const isExplicitlySelected = selected && n.file === selected
      if (selected && !isExplicitlySelected) {
        const touches = (G.adj.get(selected) ?? []).some((ei) => {
          const e = G.edges[ei]; return e.a === n.file || e.b === n.file
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

      if (n.isHub) {
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

    // ── Labels (auto-on at high zoom or low on-screen count,
    // collision-avoidant) ──────────────────────────────────────
    // Auto-enable when zoom ≥ 900% (detailed inspection) OR fewer
    // than 50 nodes visible in the viewport (labels fit without
    // much overlap). graph2.showLabels force-ons regardless.
    //
    // Zoom legibility brackets, enforced however labels were
    // turned on:
    //   - zoom ≤ 1.4: none (text too small vs layout density).
    //   - 1.4 < zoom < 2.4: hubs only (load-bearing nodes get
    //     priority screen real estate).
    //   - zoom ≥ 2.4: all visible nodes are candidates; the
    //     collision pass thins them by priority.
    if (viewport.k > 1.4) {
      const VISIBLE_THRESHOLD = 50
      let onScreenCount = 0
      if (viewport.k < 9 && !graph2.showLabels) {
        // Only count when needed to decide auto-on; cap at the
        // threshold so we exit early on dense graphs.
        for (const n of G.nodes) {
          if (!nodeVisible(n)) continue
          const [sx, sy] = worldToScreen(n.x, n.y)
          if (sx < 0 || sx > W || sy < 0 || sy > H) continue
          onScreenCount++
          if (onScreenCount >= VISIBLE_THRESHOLD) break
        }
      }
      const labelsAutoOn = viewport.k >= 9 || onScreenCount < VISIBLE_THRESHOLD
      if (graph2.showLabels || labelsAutoOn) {
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'
        ctx.fillStyle = T.labelFill
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        const lineH = 11
        const pad = 2
        // Nodes more than `LABEL_MARGIN` px outside the viewport
        // can't contribute to either the placement candidates (text
        // renders offscreen) or the collision-target boxes (their
        // circles aren't drawn). Skipping them is a big speedup: the
        // candidates loop calls `ctx.measureText` per node (expensive)
        // and the collision pass is O(candidates × nodeBoxes), so
        // trimming both by viewport cuts cost super-linearly. Margin
        // covers the longest label (~200px) plus a node-radius of
        // slack, so labels for nodes JUST offscreen can still place
        // against on-screen neighbours.
        const LABEL_MARGIN = 250
        const inLabelBounds = (sx, sy) =>
          sx > -LABEL_MARGIN && sx < W + LABEL_MARGIN &&
          sy > -LABEL_MARGIN && sy < H + LABEL_MARGIN
        // Pre-build AABBs for every visible node circle. The label
        // collision pass checks against these so a label can't
        // straddle a neighbour's dot (not just other labels).
        const nodeBoxes = []
        for (const n of G.nodes) {
          if (!nodeVisible(n)) continue
          const [sx, sy] = worldToScreen(n.x, n.y)
          if (!inLabelBounds(sx, sy)) continue
          const r = nodeRadius(n)
          nodeBoxes.push({
            file: n.file,
            x0: sx - r, x1: sx + r,
            y0: sy - r, y1: sy + r,
          })
        }
        const candidates = []
        for (const n of G.nodes) {
          if (!nodeVisible(n)) continue
          // Hubs-only filter for the 1.4 < zoom < 2.4 bracket.
          if (!n.isHub && viewport.k < 2.4) continue
          const [sx, sy] = worldToScreen(n.x, n.y)
          if (!inLabelBounds(sx, sy)) continue
          const r = nodeRadius(n)
          const tx = sx + r + 4
          const ty = sy + 1
          const w = ctx.measureText(n.label).width + pad
          const isSel = n.file === selected
          const isHov = n.file === hovered
          const prio = isSel ? 3 : isHov ? 2 : (n.isHub ? 1 : 0)
          candidates.push({
            file: n.file, n, tx, ty, prio,
            x0: tx - pad, x1: tx + w,
            y0: ty - lineH / 2, y1: ty + lineH / 2,
          })
        }
        candidates.sort((a, b) => b.prio - a.prio)
        const placed = []
        const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
        for (const c of candidates) {
          let collide = false
          // Reject if the label box would cover another node's
          // circle (skip the candidate's own node — its label
          // sits adjacent to its own dot by design).
          for (const nb of nodeBoxes) {
            if (nb.file === c.file) continue
            if (overlaps(c, nb)) { collide = true; break }
          }
          if (!collide) {
            for (const p of placed) {
              if (overlaps(c, p)) { collide = true; break }
            }
          }
          if (!collide) placed.push(c)
        }
        for (const c of placed) ctx.fillText(c.n.label, c.tx, c.ty)
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
  // arrowheads, file labels on every node, single hue (the focused
  // package's color). Same nodes/edges as the spiral view, but
  // assumes the layout pass produced a force-directed arrangement.
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
      if (isSel || isHov || n.isHub) {
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

      if (n.isHub) {
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

    // ── Labels (collision-avoidant) ───────────────────────────
    // Walk nodes in a priority order so the most important labels
    // claim screen real-estate first; subsequent labels are
    // dropped when their AABB overlaps any already-placed one.
    // Priority: selected > hovered > hubs > rest. The selected /
    // hovered slot is reserved unconditionally — those always
    // render even if a hub label would collide with them.
    ctx.font = `600 11px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'
    const labelLineHeight = 13
    const labelPad = 2
    // Pre-measure every label so the overlap test below is a
    // pure rect-vs-rect compare. measureText() runs once per node
    // per frame; cheap on the typical <50-node focus view.
    const labelCandidates = []
    for (const n of graph.nodes) {
      if (!nodeVisible(n)) continue
      const [sx, sy] = worldToScreen(n.x, n.y)
      const r = nodeR(n)
      const ty = sy + r + 4
      const halfW = ctx.measureText(n.label).width / 2 + labelPad
      const isSel = n.file === selected
      const isHov = n.file === hovered
      // Priority: selected (3) > hovered (2) > hub (1) > rest (0).
      const prio = isSel ? 3 : isHov ? 2 : (n.isHub ? 1 : 0)
      labelCandidates.push({
        n, sx, ty, halfW, isSel, isHov, prio,
        // AABB in screen space.
        x0: sx - halfW, x1: sx + halfW,
        y0: ty, y1: ty + labelLineHeight,
      })
    }
    labelCandidates.sort((a, b) => b.prio - a.prio)
    const placed = []
    const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
    for (const cand of labelCandidates) {
      let collide = false
      for (const p of placed) {
        if (overlaps(cand, p)) { collide = true; break }
      }
      if (!collide) placed.push(cand)
    }
    for (const cand of placed) {
      const { n, sx, ty, isSel, isHov } = cand
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

  // Package-node radius — area tracks file count (sqrt growth,
  // capped) so a 100-file package reads clearly bigger than a
  // 4-file one without dwarfing the canvas. Constant in screen
  // space, like the package-focus view's nodes.
  function pkgNodeRadius(p) {
    return Math.min(26, 5 + Math.sqrt(p.fileCount) * 1.7) * graph2.nodeSize
  }

  // Packages-view rendering — one node per package, curved edges
  // with arrowheads aggregated from the cross-package imports.
  // Borrows the package-focus view's chrome (curves, arrows,
  // always-on collision-avoidant labels) but keeps per-package
  // hues: each edge runs a gradient importer → importee so
  // direction reads from color before the arrowhead resolves, and
  // stroke width scales with how many file-level imports collapsed
  // into it. graph2.solo doubles as the package selection here
  // (canvas clicks and the right panel's Packages rows both set
  // it), so the package card and the ring highlight always agree.
  function drawPackagesGraph(T) {
    const pg = getPkgGraph()
    const soloPkg = graph2.solo && pg.byPkg.has(graph2.solo) ? graph2.solo : null
    // Neighborhood highlight follows the hover when present, else
    // the selected package.
    const focusPkg = hovered ?? soloPkg
    const connected = new Set()
    if (focusPkg) {
      connected.add(focusPkg)
      for (const e of pg.edges) {
        if (e.a === focusPkg) connected.add(e.b)
        else if (e.b === focusPkg) connected.add(e.a)
      }
    }
    // Hover / selection always read at full opacity; otherwise
    // out-of-neighborhood soft-dim stacks with filter dim
    // (nodeIsDimmed — package nodes carry the aggregated sets it
    // reads) via min, mirroring the file views.
    const dimOf = (p) => {
      if (p.pkg === soloPkg || p.pkg === hovered) return 1
      let dim = 1
      if (focusPkg && !connected.has(p.pkg)) dim = 0.2
      if (nodeIsDimmed(p)) dim = Math.min(dim, 0.1)
      return dim
    }

    // ── Edges (curves + arrowheads, width ∝ √link count) ────────
    for (const e of pg.edges) {
      const na = pg.byPkg.get(e.a)
      const nb = pg.byPkg.get(e.b)
      if (!na || !nb) continue
      // Direction handling mirrors drawPackageView: bidi pairs get
      // arrows on both ends, unidirectional ones an arrow at the
      // import target.
      const bidi = e.fromLo && e.fromHi
      const reversed = !bidi && e.fromHi
      const a = reversed ? nb : na
      const b = reversed ? na : nb
      const touches = focusPkg !== null && (e.a === focusPkg || e.b === focusPkg)
      const isDim = focusPkg !== null && !touches

      const ra = pkgNodeRadius(a), rb = pkgNodeRadius(b)
      const [ax, ay] = worldToScreen(a.x, a.y)
      const [bx, by] = worldToScreen(b.x, b.y)
      const dx = bx - ax, dy = by - ay
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      const ux = dx / len, uy = dy / len
      const sx = ax + ux * (ra + 1.5), sy = ay + uy * (ra + 1.5)
      const ex = bx - ux * (rb + 3.5), ey = by - uy * (rb + 3.5)
      const off = Math.min(len * 0.15, 30)
      const qcx = (sx + ex) / 2 - uy * off
      const qcy = (sy + ey) / 2 + ux * off

      let edgeAlpha
      if (touches) edgeAlpha = 0.9
      else if (isDim) edgeAlpha = 0.06
      else edgeAlpha = 0.5
      if (nodeIsDimmed(na) && nodeIsDimmed(nb)) edgeAlpha = Math.min(edgeAlpha, 0.05)

      const grad = ctx.createLinearGradient(sx, sy, ex, ey)
      grad.addColorStop(0, pkgColor(a.pkg) + alphaHex(edgeAlpha))
      grad.addColorStop(1, pkgColor(b.pkg) + alphaHex(edgeAlpha))
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.quadraticCurveTo(qcx, qcy, ex, ey)
      ctx.strokeStyle = grad
      ctx.lineWidth = Math.min(3.5, 0.8 + Math.sqrt(e.count) * 0.3) * (touches ? 1.3 : 1)
      ctx.stroke()

      if (isDim) continue
      // Arrowhead at the target end; tangent from the quadratic
      // Bezier derivative just before the endpoint, same math as
      // drawPackageView. Colored by the endpoint it lands on so it
      // visually fuses with the target node.
      const arrowLen = 7
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
      ctx.fillStyle = pkgColor(b.pkg) + alphaHex(Math.min(1, edgeAlpha + 0.15))
      ctx.fill()

      if (bidi) {
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
        ctx.fillStyle = pkgColor(a.pkg) + alphaHex(Math.min(1, edgeAlpha + 0.15))
        ctx.fill()
      }
    }

    // ── Nodes ───────────────────────────────────────────────────
    for (const p of pg.nodes) {
      const [sx, sy] = worldToScreen(p.x, p.y)
      const r = pkgNodeRadius(p)
      const isHov = p.pkg === hovered
      const isSel = p.pkg === soloPkg
      const col = pkgColor(p.pkg)
      const dim = dimOf(p)

      if (isSel || isHov) {
        const haloR = r * (isSel ? 2.6 : 2.2)
        const grad = ctx.createRadialGradient(sx, sy, r * 0.6, sx, sy, haloR)
        grad.addColorStop(0, col + alphaHex(isSel ? 0.4 : 0.25))
        grad.addColorStop(1, col + '00')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(sx, sy, haloR, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.fillStyle = col + alphaHex(dim)
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.fill()

      if (p.issue) {
        const sevColor = SEV_COLORS[p.issue]
        const ringR = r + (p.issue === 'critical' ? 4.2 : p.issue === 'high' ? 3.4 : 2.8)
        const lw = p.issue === 'critical' ? 1.8 : p.issue === 'high' ? 1.5 : p.issue === 'medium' ? 1.3 : 1.1
        ctx.strokeStyle = sevColor
        ctx.globalAlpha = dim
        ctx.lineWidth = lw
        ctx.beginPath()
        ctx.arc(sx, sy, ringR, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = 1
      }
    }

    // ── Labels (always candidates — package counts are small;
    // collision pass thins by priority) ─────────────────────────
    ctx.font = `600 11px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'
    const labelLineHeight = 13
    const labelPad = 2
    const labelCandidates = []
    for (const p of pg.nodes) {
      const [sx, sy] = worldToScreen(p.x, p.y)
      const r = pkgNodeRadius(p)
      const ty = sy + r + 4
      const halfW = ctx.measureText(p.label).width / 2 + labelPad
      const isSel = p.pkg === soloPkg
      const isHov = p.pkg === hovered
      // Priority: selected > hovered > bigger packages.
      const prio = isSel ? Infinity : isHov ? 1e9 : p.fileCount
      labelCandidates.push({
        p, sx, ty, isSel, isHov, prio,
        x0: sx - halfW, x1: sx + halfW,
        y0: ty, y1: ty + labelLineHeight,
      })
    }
    labelCandidates.sort((a, b) => b.prio - a.prio)
    const placed = []
    const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
    for (const cand of labelCandidates) {
      let collide = false
      for (const pl of placed) {
        if (overlaps(cand, pl)) { collide = true; break }
      }
      if (!collide) placed.push(cand)
    }
    for (const cand of placed) {
      const { p, sx, ty, isSel, isHov } = cand
      // Labels never drop below 0.25 — a dimmed package's name
      // stays legible enough to explain why a filter skipped it.
      ctx.globalAlpha = Math.max(0.25, dimOf(p))
      ctx.shadowColor = T.labelShadow
      ctx.shadowBlur = 4
      ctx.strokeStyle = T.labelOutline
      ctx.lineWidth = 3
      ctx.strokeText(p.label, sx, ty)
      ctx.shadowBlur = 0
      ctx.fillStyle = isSel ? T.labelSelected : isHov ? T.labelHover : T.labelDefault
      ctx.fillText(p.label, sx, ty)
      ctx.globalAlpha = 1
    }

    // Selection ring on top so neighbors can't hide it.
    if (soloPkg) {
      const p = pg.byPkg.get(soloPkg)
      const [sx, sy] = worldToScreen(p.x, p.y)
      ctx.strokeStyle = T.selectRing
      ctx.lineWidth = 1.8
      ctx.beginPath()
      ctx.arc(sx, sy, pkgNodeRadius(p) + 4, 0, Math.PI * 2)
      ctx.stroke()
    }

    if (zoomEl) zoomEl.textContent = `${Math.round(viewport.k * 100)}%`
  }

  // ── Hit test ──────────────────────────────────────────────────
  // Operates on the active node set (package aggregates in the
  // packages view). The radius source follows the renderer's ≤ 50
  // split: the rich package path draws bigger weighted nodes, the
  // dot paths draw nodeRadius-sized ones — picking must agree with
  // what's on screen or rim clicks miss.
  function pickNode(sx, sy) {
    const pkgView = pkgViewOn()
    const G = pkgView ? getPkgGraph() : graph
    const rich = pkgView && G.nodes.length <= 50
    let best = null, bestD = Infinity
    const tol = 6
    for (const n of G.nodes) {
      if (!nodeVisible(n)) continue
      const [nx, ny] = worldToScreen(n.x, n.y)
      const dx = nx - sx, dy = ny - sy
      const d = dx * dx + dy * dy
      const r = (rich ? pkgNodeRadius(n) : nodeRadius(n)) + tol
      if (d < r * r && d < bestD) { bestD = d; best = n }
    }
    return best
  }

  function showTooltip(n, cx, cy) {
    if (!tooltip) return
    const col = pkgColor(n.pkg)
    const pkgLabel = n.pkg === '__own__' ? 'own source' : n.pkg
    const relPath = pkgRelative(n.file, n.pkg)
    // Three-line layout:
    //   1. file path relative to package root (monospace, primary
    //      text colour) — the main node identifier.
    //   2. dot + package name — secondary context.
    //   3. per-severity chips when n.totalIssues > 0 — same block
    //      the selection card uses.
    // Lit's `html` interpolation auto-escapes `relPath`/`pkgLabel`
    // (both user-provided — file paths from a loaded report).
    render(html`
      <div class="g2-tt-path">${relPath}</div>
      <div class="g2-tt-head">
        <span class="g2-tt-dot" style=${`background:${col}`}></span>
        <span class="g2-tt-pkg">${pkgLabel}</span>
      </div>
      ${n.totalIssues > 0 ? renderSevChips(n.own) : null}
    `, tooltip)
    placeTooltip(cx, cy)
  }

  // Packages-view tooltip — same chrome, package-level facts:
  // name, file count + summed source bytes, severity chips.
  function showPkgTooltip(p, cx, cy) {
    if (!tooltip) return
    const col = pkgColor(p.pkg)
    const sizeText = formatBytes(p.size)
    render(html`
      <div class="g2-tt-path">${p.label}</div>
      <div class="g2-tt-head">
        <span class="g2-tt-dot" style=${`background:${col}`}></span>
        <span class="g2-tt-pkg">${p.fileCount} ${p.fileCount === 1 ? 'file' : 'files'}${sizeText ? ` · ${sizeText}` : ''}</span>
      </div>
      ${p.totalIssues > 0 ? renderSevChips(p.own) : null}
    `, tooltip)
    placeTooltip(cx, cy)
  }

  function placeTooltip(cx, cy) {
    const stageRect = stage.getBoundingClientRect()
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
    // Default: 12px right and below the cursor (near it, not under
    // it). Flip horizontally when it would overshoot the right edge
    // (sized to the actual tooltip width so the flip holds for any
    // content). Flip vertically when too close to the bottom; clamp
    // at top so it doesn't scroll out of view near the top edge.
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

  // ── Pan / zoom / click ────────────────────────────────────────
  let dragging = false
  let dragStart = null
  let dragMoved = false

  const onMouseDown = (e) => {
    if (e.button !== 0) return
    // Bail when the press originates inside one of the canvas's
    // corner overlays (back button, zoom controls, focus-pkg
    // icon). Without this, mousedown sets dragging=true →
    // mouseup picks a node at the overlay's corner (none, so
    // selection clears) → refreshSidebar replaces the overlay
    // slot → the original button is detached → its click
    // handler never runs. The overlay's own click handlers
    // already do the right thing; the canvas just needs to
    // stay out of their way.
    if (e.target.closest('.g2-stage-overlay, .g2-stage-overlay-tr, .g2-zoom-ctrl')) return
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
    // `hovered` is keyed by the active node set's `file` — the
    // package name doubles as it in packages view. Mode flips
    // always go through a canvas teardown + re-attach, so a key
    // from one mode never leaks into the other's draw.
    const hit = pickNode(sx, sy)
    const prev = hovered
    hovered = hit?.file ?? null
    canvas.style.cursor = hit ? 'default' : 'grab'
    if (hit) {
      if (pkgViewOn()) showPkgTooltip(hit, e.clientX, e.clientY)
      else showTooltip(hit, e.clientX, e.clientY)
    } else if (prev) hideTooltip()
    if (hovered !== prev) requestDraw()
  }
  const onMouseUp = (e) => {
    if (dragging && !dragMoved) {
      const rect = stage.getBoundingClientRect()
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top
      const hit = pickNode(sx, sy)
      if (pkgViewOn()) {
        // Package click — toggle the selection through graph2.solo,
        // the same slot the right panel's Packages rows write, so
        // the package card, the row highlight, and the canvas ring
        // all track one source of truth. Empty space deselects.
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
  const zIn = root.querySelector('#g2-zoom-in')
  const zOut = root.querySelector('#g2-zoom-out')
  const zFit = root.querySelector('#g2-zoom-fit')
  zIn?.addEventListener('click', () => zoomTo(viewport.k * 1.4))
  zOut?.addEventListener('click', () => zoomTo(viewport.k / 1.4))
  zFit?.addEventListener('click', () => { fitToView(); requestDraw() })

  // Resize observer — handles container resize (sidebar collapse,
  // window resize, tab switch with different available space).
  // Relayout-on-resize is intentionally off: even cheap closed-form
  // passes would jitter the graph on every drag of the window edge.
  // The canvas just refits its viewport so positions stay centered.
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
