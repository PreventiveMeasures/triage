import { esc } from '../format.js'
import { tree } from './state.js'
import {
  packageOf, fileHasFindings, totalFindings, indicatorFor,
  pkgColor, pkgColorAlpha, multiLineLabel, forceLayout, radiusOfNode,
} from './utils.js'

// Canvas-side theme palette. The ctx fills are baked into draw calls
// rather than read from CSS (a getComputedStyle round-trip per draw
// would be wasteful), so we duplicate the chrome's intent here. Pkg
// colors and severity tints come from utils.js and don't flip — they're
// vivid enough to read on either backdrop. The dark-mode values mirror
// what was hardcoded across draw(); the light-mode values invert
// foreground/background and swap the selection ring to the accent
// color (white-on-white wouldn't read).
const GRAPH_THEMES = {
  dark: {
    // Neutral grays for the canvas dark palette — same shift as the
    // CSS --graph-canvas-bg / --graph-divider in theme.css. Previous
    // values were near-blacks with a subtle blue cast (#060a0f /
    // rgba(20,30,50,...) / rgba(6,10,15,...)).
    bg: '#0c0c0c',
    centerTint: 'rgba(40, 40, 40, 0.5)',
    centerEdge: 'rgba(0, 0, 0, 0)',
    dimEdge: 'rgba(255, 255, 255, 0.03)',
    selectRing: '#fff',
    hoverRing: 'rgba(255, 255, 255, 0.6)',
    sevDotHalo: '#0c0c0c',
    labelShadow: 'rgba(12, 12, 12, 0.98)',
    labelOutline: 'rgba(12, 12, 12, 0.9)',
    labelDefault: 'rgba(200, 210, 225, 0.78)',
    labelHover: 'rgba(230, 237, 243, 0.95)',
    labelSelected: '#fff',
    // Edge / arrow alpha when not hovered. Vivid pkg colors at 0.22
    // alpha read clearly against a dark canvas; light mode needs much
    // more saturation to show up against #f6f8fa.
    edgeAlpha: 0.22,
    arrowAlpha: 0.4,
  },
  light: {
    bg: '#f6f8fa',
    centerTint: 'rgba(208, 222, 240, 0.4)',
    centerEdge: 'rgba(255, 255, 255, 0)',
    dimEdge: 'rgba(0, 0, 0, 0.04)',
    selectRing: '#0969da',
    hoverRing: 'rgba(0, 0, 0, 0.45)',
    sevDotHalo: '#f6f8fa',
    labelShadow: 'rgba(255, 255, 255, 0.95)',
    labelOutline: 'rgba(255, 255, 255, 0.9)',
    labelDefault: 'rgba(50, 60, 80, 0.85)',
    labelHover: 'rgba(20, 25, 35, 0.95)',
    labelSelected: '#000',
    edgeAlpha: 0.55,
    arrowAlpha: 0.75,
  },
}

function currentGraphTheme() {
  return document.body.classList.contains('theme-light') ? GRAPH_THEMES.light : GRAPH_THEMES.dark
}

// Force-directed canvas + toolbar. Filters out clean files when
// `tree.showAll` is off. Layout cached on (tree, showAll).
export function renderTreeCanvas(treeData, ownCounts, transitiveCounts) {
  const allFiles = Object.keys(treeData)
  const files = tree.showAll
    ? allFiles
    : allFiles.filter((f) => fileHasFindings(f, ownCounts, transitiveCounts))
  const fileSet = new Set(files)

  const importsOf = new Map()
  const importedBy = new Map()
  for (const f of files) {
    const imps = (treeData[f].imports ?? []).filter((i) => fileSet.has(i))
    importsOf.set(f, imps)
    for (const imp of imps) {
      if (!importedBy.has(imp)) importedBy.set(imp, [])
      importedBy.get(imp).push(f)
    }
  }

  const hiddenCount = allFiles.length - files.length
  let html = ''
  html += '<div class="tree-canvas-toolbar">'
  html += `<label><input type="checkbox" id="tree-show-all"${tree.showAll ? ' checked' : ''}> show all</label>`
  html += '<div class="toolbar-sep"></div>'
  html += '<span class="toolbar-stat"><strong>' + files.length + '</strong>/<strong>' + allFiles.length + '</strong> files'
  if (hiddenCount > 0) html += ' · <strong>' + hiddenCount + '</strong> clean hidden'
  html += '</span>'
  html += '<span class="spacer"></span>'
  html += '<span class="toolbar-hint">drag · scroll to zoom</span>'
  html += `<button type="button" id="tree-fullscreen" class="icon-btn" title="toggle fullscreen">⛶</button>`
  html += '</div>'
  if (files.length === 0) {
    html += '<div class="tree-canvas-scroll" style="display:flex;align-items:center;justify-content:center;color:rgba(139,148,158,.5);text-align:center;padding:3rem 1rem;font-size:.82rem;">No files match the current filter.<br>Toggle "show all" above.</div>'
    return html
  }

  // Force layout (cached). We store files/importsOf so attachTreeGraphInteraction
  // can run the actual layout once the canvas has real dimensions.
  let nodes = null
  if (tree.layoutCache && tree.layoutCache.tree === treeData && tree.layoutCache.showAll === tree.showAll) {
    nodes = tree.layoutCache.nodes
  }
  // nodes may still be null here — attachTreeGraphInteraction will compute it
  // after measuring the canvas. Store files+importsOf so it can do so.

  // Package legend data — sorted by node count desc, top 14.
  const pkgCounts = new Map()
  for (const f of files) {
    const p = packageOf(f) ?? '__own__'
    pkgCounts.set(p, (pkgCounts.get(p) ?? 0) + 1)
  }
  const topPkgs = [...pkgCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)

  tree.graphState = {
    nodes, edges: null, nodeByFile: new Map(), importsOf, importedBy,
    ownCounts, transitiveCounts, files, fileSet, topPkgs,
    _needsRefit: true, _hubsTab: tree.graphState?._hubsTab ?? 'issues',
    // Store for deferred layout (computed in attachTreeGraphInteraction with real canvas size)
    _layoutFiles: files, _layoutImportsOf: importsOf, _layoutTree: treeData, _layoutShowAll: tree.showAll,
  }

  html += '<div class="tree-canvas-scroll"><canvas class="tree-canvas-el" id="tree-canvas"></canvas></div>'
  html += '<div class="tree-zoom-controls">'
  html += '<button type="button" class="tree-zoom-btn" id="zoom-in" title="zoom in">+</button>'
  html += '<button type="button" class="tree-zoom-btn" id="zoom-out" title="zoom out">−</button>'
  html += '<button type="button" class="tree-zoom-btn" id="zoom-fit" title="fit to view" style="font-size:.65rem;letter-spacing:-.5px;">fit</button>'
  html += '</div>'
  html += '<div class="tree-node-tooltip" id="tree-tooltip"></div>'
  return html
}

// Attach all canvas interaction: draw loop, pan/zoom, hover, click.
// `refreshSidebar` is called after a selection change so callers can
// rebuild the sidebar HTML using their own `reports` state.
export function attachTreeGraphInteraction(container, refreshSidebar) {
  if (!tree.graphState) return
  const canvas = container.querySelector('#tree-canvas')
  const tooltip = container.querySelector('#tree-tooltip')
  if (!canvas) return

  const { importsOf, importedBy, ownCounts, transitiveCounts,
          _layoutFiles, _layoutImportsOf, _layoutTree, _layoutShowAll } = tree.graphState

  // nodes/edges/nodeByFile start from cache (may be null on first load).
  // ensureLayout() computes them with real canvas dimensions.
  let nodes = tree.graphState.nodes ?? null
  let edges = tree.graphState.edges ?? null
  let nodeByFile = tree.graphState.nodeByFile ?? new Map()

  let panX = 0, panY = 0, zoom = 1
  // Persist hoveredFile across re-renders so clicking a node doesn't
  // flash the hover away until the pointer actually leaves.
  let hoveredFile = tree.graphState._hoveredFile ?? null
  let dpr = window.devicePixelRatio || 1

  function ensureLayout(w, h) {
    const needsLayout = !nodes || nodes.length === 0
    const needsEdges = !edges || edges.length === 0

    if (needsLayout) {
      nodes = forceLayout(_layoutFiles, _layoutImportsOf, w, h)
      tree.layoutCache = { tree: _layoutTree, showAll: _layoutShowAll, nodes }
      tree.graphState.nodes = nodes
    }

    if (needsLayout || needsEdges) {
      // Build edges and nodeByFile from whatever nodes we now have.
      const edgeMap = new Map()
      for (const f of _layoutFiles) {
        for (const imp of _layoutImportsOf.get(f) ?? []) {
          if (f === imp) continue
          const [lo, hi] = f < imp ? [f, imp] : [imp, f]
          const key = `${lo}\0${hi}`
          let e = edgeMap.get(key)
          if (!e) { e = { lo, hi, fromLo: false, fromHi: false }; edgeMap.set(key, e) }
          if (f === lo) e.fromLo = true; else e.fromHi = true
        }
      }
      edges = [...edgeMap.values()]
      nodeByFile = new Map(nodes.map((n) => [n.file, n]))
      tree.graphState.edges = edges
      tree.graphState.nodeByFile = nodeByFile
    }
  }

  const R = (file) => radiusOfNode(file, importsOf, importedBy, ownCounts, transitiveCounts)

  function fitToView(w, h) {
    if (nodes.length === 0) return
    const pad = 80
    const minX = Math.min(...nodes.map((n) => n.x)) - pad
    const minY = Math.min(...nodes.map((n) => n.y)) - pad
    const maxX = Math.max(...nodes.map((n) => n.x)) + pad
    const maxY = Math.max(...nodes.map((n) => n.y)) + pad
    const gw = maxX - minX, gh = maxY - minY
    zoom = Math.min(w / gw, h / gh, 2.5)
    panX = (w - gw * zoom) / 2 - minX * zoom
    panY = (h - gh * zoom) / 2 - minY * zoom
  }

  let _resizeTimer = null
  function resize(refit) {
    const rect = canvas.parentElement.getBoundingClientRect()
    const w = Math.max(rect.width, 100), h = Math.max(rect.height, 100)
    dpr = window.devicePixelRatio || 1
    canvas.width = w * dpr; canvas.height = h * dpr
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px'
    // Compute layout with real dimensions now (first call only).
    ensureLayout(w, h)
    if (refit || tree.graphState._needsRefit) {
      fitToView(w, h)
      tree.graphState._needsRefit = false
    }
    draw()
  }

  function debouncedResize() {
    clearTimeout(_resizeTimer)
    _resizeTimer = setTimeout(() => resize(false), 60)
  }

  // ── Main draw ─────────────────────────────────────────────────────────────
  function draw() {
    if (!nodes || !nodes.length) return
    const T = currentGraphTheme()
    const w = canvas.width / dpr, h = canvas.height / dpr
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Background — flat fill in the theme's canvas color
    ctx.fillStyle = T.bg
    ctx.fillRect(0, 0, w, h)

    // Subtle center radial — adds depth without dominating
    const cg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.6)
    cg.addColorStop(0, T.centerTint)
    cg.addColorStop(1, T.centerEdge)
    ctx.fillStyle = cg; ctx.fillRect(0, 0, w, h)

    ctx.save()
    ctx.translate(panX, panY)
    ctx.scale(zoom, zoom)

    // Connected-files set for hover dimming
    const connectedFiles = new Set()
    if (hoveredFile) {
      connectedFiles.add(hoveredFile)
      for (const imp of importsOf.get(hoveredFile) ?? []) connectedFiles.add(imp)
      for (const imp of importedBy.get(hoveredFile) ?? []) connectedFiles.add(imp)
    }

    // ── Edges ───────────────────────────────────────────────────────────────
    for (const e of (edges || [])) {
      const loN = nodeByFile.get(e.lo), hiN = nodeByFile.get(e.hi)
      if (!loN || !hiN) continue

      const bidi = e.fromLo && e.fromHi
      const rev = !bidi && e.fromHi
      const a = rev ? hiN : loN
      const b = rev ? loN : hiN

      const isHov = hoveredFile && (a.file === hoveredFile || b.file === hoveredFile)
      const isDim = hoveredFile && !isHov

      // Edge color = source node's package color
      const srcPkg = packageOf(a.file) ?? '__own__'

      const ra = R(a.file), rb = R(b.file)
      const dx = b.x - a.x, dy = b.y - a.y
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      const ux = dx / len, uy = dy / len
      const sx = a.x + ux * (ra + 1.5), sy = a.y + uy * (ra + 1.5)
      const ex = b.x - ux * (rb + 3.5), ey = b.y - uy * (rb + 3.5)
      const off = Math.min(len * 0.15, 30)
      const qcx = (sx + ex) / 2 - uy * off
      const qcy = (sy + ey) / 2 + ux * off

      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.quadraticCurveTo(qcx, qcy, ex, ey)

      if (isHov) {
        ctx.strokeStyle = pkgColorAlpha(srcPkg, 0.9)
        ctx.lineWidth = 1.8 / zoom
      } else if (isDim) {
        ctx.strokeStyle = T.dimEdge
        ctx.lineWidth = 0.5 / zoom
      } else {
        ctx.strokeStyle = pkgColorAlpha(srcPkg, T.edgeAlpha)
        ctx.lineWidth = 0.85 / zoom
      }
      ctx.stroke()

      // Arrowhead at endpoint
      if (!isDim) {
        const arrowLen = Math.max(4.5, 6 / zoom)
        const arrowW = arrowLen * 0.42
        // Tangent at end of quadratic bezier
        const t = 0.9
        const tx = 2 * (1 - t) * (qcx - sx) + 2 * t * (ex - qcx)
        const ty2 = 2 * (1 - t) * (qcy - sy) + 2 * t * (ey - qcy)
        const tl = Math.sqrt(tx * tx + ty2 * ty2) || 1
        const tux = tx / tl, tuy = ty2 / tl
        ctx.beginPath()
        ctx.moveTo(ex, ey)
        ctx.lineTo(ex - tux * arrowLen + tuy * arrowW, ey - tuy * arrowLen - tux * arrowW)
        ctx.lineTo(ex - tux * arrowLen - tuy * arrowW, ey - tuy * arrowLen + tux * arrowW)
        ctx.closePath()
        ctx.fillStyle = isHov ? pkgColorAlpha(srcPkg, 0.9) : pkgColorAlpha(srcPkg, T.arrowAlpha)
        ctx.fill()

        // Bidi: back-arrow at start
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
          const dstPkg = packageOf(b.file) ?? '__own__'
          ctx.fillStyle = isHov ? pkgColorAlpha(dstPkg, 0.9) : pkgColorAlpha(dstPkg, T.arrowAlpha)
          ctx.fill()
        }
      }
    }

    // ── Nodes ────────────────────────────────────────────────────────────────
    for (const n of (nodes || [])) {
      const r = R(n.file)
      const pkg = packageOf(n.file) ?? '__own__'
      const col = pkgColor(pkg)
      const own = ownCounts.get(n.file)
      const findingColor = indicatorFor(own)
      const isSelected = n.file === tree.selected
      const isHov = n.file === hoveredFile
      const isDim = hoveredFile && !connectedFiles.has(n.file) && !isSelected

      ctx.globalAlpha = isDim ? 0.07 : 1

      // Glow ring for selected/hovered
      if (isSelected || isHov) {
        const glowR = r * 2.6
        const glow = ctx.createRadialGradient(n.x, n.y, r * 0.8, n.x, n.y, glowR)
        glow.addColorStop(0, pkgColorAlpha(pkg, isSelected ? 0.35 : 0.2))
        glow.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.beginPath(); ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2)
        ctx.fillStyle = glow; ctx.fill()
      }

      // Finding-severity outer pulse ring
      if (findingColor && !isDim) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 3.5 / zoom, 0, Math.PI * 2)
        ctx.strokeStyle = findingColor + '66'
        ctx.lineWidth = 2.5 / zoom
        ctx.stroke()
      }

      // Main circle — flat fill
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
      ctx.fillStyle = col
      ctx.fill()

      // Selection / hover stroke
      if (isSelected) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 1.5 / zoom, 0, Math.PI * 2)
        ctx.strokeStyle = T.selectRing
        ctx.lineWidth = 2 / zoom; ctx.stroke()
      } else if (isHov) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 1 / zoom, 0, Math.PI * 2)
        ctx.strokeStyle = T.hoverRing
        ctx.lineWidth = 1.5 / zoom; ctx.stroke()
      }

      // Severity dot (top-right corner, scaled with node)
      if (findingColor) {
        const br = Math.max(2.5, r * 0.36)
        const bx = n.x + r * 0.72, by = n.y - r * 0.72
        // Halo matches the canvas bg so the dot reads as cleanly cut
        // from the node circle, no matter what hue the node has.
        ctx.beginPath(); ctx.arc(bx, by, br + 1.2, 0, Math.PI * 2)
        ctx.fillStyle = T.sevDotHalo; ctx.fill()
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2)
        ctx.fillStyle = findingColor; ctx.fill()
      }

      ctx.globalAlpha = 1

      // Labels
      const conn = (importsOf.get(n.file)?.length ?? 0) + (importedBy.get(n.file)?.length ?? 0)
      const ownTotal = totalFindings(own)
      const showLabel = (conn >= 3 || ownTotal > 0 || isSelected || isHov || r > 12) && !isDim
      if (showLabel) {
        const baseSize = Math.min(11.5, Math.max(8.5, 9.5 / Math.max(zoom, 0.5)))
        ctx.font = `600 ${baseSize}px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif`
        ctx.textAlign = 'center'
        const lines = multiLineLabel(n.file, 22)
        const lineH = baseSize * 1.3
        const ty = n.y + r + baseSize + 2.5

        // Shadow/outline for readability on any background — same hue
        // as the canvas bg so labels read against both bg and a node.
        ctx.shadowColor = T.labelShadow; ctx.shadowBlur = 4
        ctx.strokeStyle = T.labelOutline; ctx.lineWidth = 3 / zoom
        ctx.lineJoin = 'round'
        ctx.strokeText(lines[0], n.x, ty)
        if (lines[1]) ctx.strokeText(lines[1], n.x, ty + lineH)

        ctx.shadowBlur = 0
        ctx.fillStyle = isSelected ? T.labelSelected : isHov ? T.labelHover : T.labelDefault
        lines.forEach((line, i) => ctx.fillText(line, n.x, ty + i * lineH))
      }
    }

    ctx.restore()
  }

  // ── Hit test ───────────────────────────────────────────────────────────────
  function canvasPos(e) {
    const rect = canvas.getBoundingClientRect()
    return { cx: e.clientX - rect.left, cy: e.clientY - rect.top }
  }
  function hitTest(cx, cy) {
    const wx = (cx - panX) / zoom, wy = (cy - panY) / zoom
    let best = null, bestD = Infinity
    for (const n of (nodes || [])) {
      const d = Math.hypot(n.x - wx, n.y - wy)
      if (d <= R(n.file) + 4 / zoom && d < bestD) { bestD = d; best = n }
    }
    return best
  }

  // ── Tooltip ────────────────────────────────────────────────────────────────
  function showTooltip(node, cx, cy) {
    if (!tooltip) return
    const own = ownCounts.get(node.file) ?? {}
    const pkg = packageOf(node.file) ?? '__own__'
    const col = pkgColor(pkg)
    const conn = (importsOf.get(node.file)?.length ?? 0) + (importedBy.get(node.file)?.length ?? 0)
    const base = node.file.split('/').pop()
    const pkgLabel = pkg === '__own__' ? 'own source' : pkg
    let html = `<div class="tt-name">${esc(base)}</div>`
    html += `<div class="tt-pkg"><span class="tt-pkg-dot" style="background:${esc(col)}"></span>${esc(pkgLabel)}</div>`
    const pathRest = node.file.length > base.length ? node.file.slice(0, -base.length - 1) : ''
    if (pathRest) html += `<div class="tt-path">${esc(pathRest)}</div>`
    const chips = []
    for (const sev of ['critical', 'high', 'medium', 'low']) {
      if (own[sev]) chips.push(`<span class="tt-chip ${sev}">${own[sev]} ${sev}</span>`)
    }
    if (chips.length) html += `<div class="tt-chips">${chips.join('')}</div>`
    html += `<div class="tt-stat">${conn} connection${conn !== 1 ? 's' : ''}</div>`
    tooltip.innerHTML = html
    tooltip.style.display = 'block'
    const rect = canvas.parentElement.getBoundingClientRect()
    let tx = cx + 14, ty = cy - 16
    if (tx + 250 > rect.width) tx = cx - 254
    if (ty + 140 > rect.height) ty = rect.height - 144
    if (ty < 4) ty = 4
    tooltip.style.left = tx + 'px'; tooltip.style.top = ty + 'px'
  }
  function hideTooltip() { if (tooltip) tooltip.style.display = 'none' }

  // ── Pan & zoom ──────────────────────────────────────────────────────────────
  let dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0
  const scroll = canvas.parentElement

  // Remove any stale window listeners from a previous render cycle.
  if (tree.graphState._cleanupListeners) tree.graphState._cleanupListeners()

  const onMouseMove = (e) => {
    if (dragging) {
      panX = panStartX + e.clientX - dragStartX
      panY = panStartY + e.clientY - dragStartY
      draw(); return
    }
    const { cx, cy } = canvasPos(e)
    const hit = hitTest(cx, cy)
    const prev = hoveredFile
    hoveredFile = hit?.file ?? null
    canvas.style.cursor = hit ? 'pointer' : 'grab'
    if (hoveredFile !== prev) {
      tree.graphState._hoveredFile = hoveredFile
      draw()
    }
    if (hit) showTooltip(hit, cx, cy); else hideTooltip()
  }
  const onMouseUp = () => { dragging = false }

  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)

  // Store cleanup so the next attachTreeGraphInteraction call removes these.
  tree.graphState._cleanupListeners = () => {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }

  scroll.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    dragging = true; dragStartX = e.clientX; dragStartY = e.clientY
    panStartX = panX; panStartY = panY; hideTooltip()
  })

  scroll.addEventListener('mouseleave', () => {
    if (hoveredFile !== null) {
      hoveredFile = null
      tree.graphState._hoveredFile = null
      hideTooltip()
      draw()
    }
  })

  scroll.addEventListener('wheel', (e) => {
    e.preventDefault()
    const { cx, cy } = canvasPos(e)
    const factor = e.deltaY < 0 ? 1.13 : 1 / 1.13
    const nz = Math.max(0.06, Math.min(10, zoom * factor))
    panX = cx - (cx - panX) * (nz / zoom)
    panY = cy - (cy - panY) * (nz / zoom)
    zoom = nz; draw()
  }, { passive: false })

  // Touch
  let touches = []
  scroll.addEventListener('touchstart', (e) => { e.preventDefault(); touches = [...e.touches] }, { passive: false })
  scroll.addEventListener('touchmove', (e) => {
    e.preventDefault()
    if (e.touches.length === 1 && touches.length === 1) {
      panX += e.touches[0].clientX - touches[0].clientX
      panY += e.touches[0].clientY - touches[0].clientY
    } else if (e.touches.length === 2 && touches.length === 2) {
      const d0 = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
      const d1 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
      if (d0 > 0) {
        const rect = canvas.getBoundingClientRect()
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
        const nz = Math.max(0.06, Math.min(10, zoom * d1 / d0))
        panX = mx - (mx - panX) * (nz / zoom); panY = my - (my - panY) * (nz / zoom); zoom = nz
      }
    }
    touches = [...e.touches]; draw()
  }, { passive: false })
  scroll.addEventListener('touchend', (e) => { touches = [...e.touches] }, { passive: false })

  // Click = select node
  scroll.addEventListener('click', (e) => {
    if (Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY) > 5) return
    const { cx, cy } = canvasPos(e)
    const hit = hitTest(cx, cy)
    tree.selected = hit?.file ?? null
    draw()
    refreshSidebar()
  })

  // Zoom buttons
  const doZoom = (factor) => {
    const w = canvas.width / dpr, h = canvas.height / dpr
    const cx = w / 2, cy = h / 2
    const nz = Math.max(0.06, Math.min(10, zoom * factor))
    panX = cx - (cx - panX) * (nz / zoom); panY = cy - (cy - panY) * (nz / zoom)
    zoom = nz; draw()
  }
  container.querySelector('#zoom-in')?.addEventListener('click', () => doZoom(1.35))
  container.querySelector('#zoom-out')?.addEventListener('click', () => doZoom(1 / 1.35))
  container.querySelector('#zoom-fit')?.addEventListener('click', () => {
    fitToView(canvas.width / dpr, canvas.height / dpr); draw()
  })

  // Init
  resize(true)
  const ro = new ResizeObserver(debouncedResize)
  ro.observe(canvas.parentElement)
  // Refit when fullscreen is toggled (body class change shifts layout)
  const fsObserver = new MutationObserver(() => {
    clearTimeout(_resizeTimer)
    _resizeTimer = setTimeout(() => resize(true), 80)
  })
  fsObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  canvas.addEventListener('tree-node-select', () => {
    // Update only the sidebar — don't rebuild the canvas DOM, which would
    // destroy hover state and trigger the mousemove-flash glitch.
    refreshSidebar()
  })

  // Extend cleanup to also disconnect observers.
  const prevCleanup = tree.graphState._cleanupListeners
  tree.graphState._cleanupListeners = () => {
    prevCleanup?.()
    ro.disconnect()
    fsObserver.disconnect()
  }
}
