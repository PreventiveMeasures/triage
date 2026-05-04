import {
  esc, packageOf, fileHasFindings, totalFindings, indicatorFor,
  pkgColor, pkgColorAlpha, multiLineLabel, forceLayout, radiusOfNode,
  treeAnchor, svgNodeLabel, svgNodeId, byBary, SEV_COLORS,
} from './utils.js'

// Mutable tree-tab state. Owned here, but writable from view.js so the
// outer click handlers / drop handlers can reset selection and discard
// the cached force layout when the active report changes.
//   showAll      — include clean files in the force graph (toolbar toggle)
//   selected     — currently-selected file in the right sidebar
//   layoutCache  — cached forceLayout result, keyed off (tree, showAll)
//   graphState   — per-render canvas state (nodes, edges, listeners)
export const tree = {
  showAll: false,
  selected: null,
  layoutCache: null,
  graphState: null,
}

// Tear down the active canvas's listeners + observers and forget the
// per-render state. Called from view.js whenever the report changes
// (drop / switch / delete) and from this module before re-attaching.
export function cleanupGraphInteraction() {
  if (tree.graphState?._cleanupListeners) tree.graphState._cleanupListeners()
  tree.graphState = null
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

// Build the right-sidebar HTML (legend + hubs + node detail).
export function renderTreeSidebarFull(file, treeData, ownCounts, transitiveCounts) {
  const allFiles = Object.keys(treeData)
  const files = tree.showAll
    ? allFiles
    : allFiles.filter((f) => fileHasFindings(f, ownCounts, transitiveCounts))

  const importsOf = new Map()
  const importedBy = new Map()
  for (const f of files) {
    const imps = (treeData[f].imports ?? []).filter((i) => new Set(files).has(i))
    importsOf.set(f, imps)
    for (const imp of imps) {
      if (!importedBy.has(imp)) importedBy.set(imp, [])
      importedBy.get(imp).push(f)
    }
  }

  // Package legend
  const pkgCounts = new Map()
  for (const f of files) {
    const p = packageOf(f) ?? '__own__'
    pkgCounts.set(p, (pkgCounts.get(p) ?? 0) + 1)
  }
  const topPkgs = [...pkgCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
  const selectedPkg = file ? (packageOf(file) ?? '__own__') : null

  let html = ''

  // Package legend section
  if (topPkgs.length > 0) {
    html += '<div class="tree-legend">'
    html += '<div class="tree-legend-title">Packages</div>'
    html += '<ul class="tree-legend-list">'
    for (const [pkg, count] of topPkgs) {
      const col = pkgColor(pkg)
      const dimmed = selectedPkg && pkg !== selectedPkg ? ' dimmed' : ''
      const label = pkg === '__own__' ? 'own source' : pkg
      html += `<li class="tree-legend-item${dimmed}" data-pkg-select="${esc(pkg)}">`
      html += `<span class="tree-legend-dot" style="background:${esc(col)}"></span>`
      html += `<span class="tree-legend-name">${esc(label)}</span>`
      html += `<span class="tree-legend-count">${count}</span>`
      html += `</li>`
    }
    html += '</ul></div>'
  }

  // Top hubs section — sorted by issues (own findings) by default.
  // The tab state is stored on the sidebar element via data-hubs-tab.
  const hubsTab = tree.graphState._hubsTab ?? 'issues'

  const hubsByIssues = [...files].sort((a, b) => {
    const ca = totalFindings(ownCounts.get(a)), cb = totalFindings(ownCounts.get(b))
    if (cb !== ca) return cb - ca
    const ia = (importsOf.get(a)?.length ?? 0) + (importedBy.get(a)?.length ?? 0)
    const ib = (importsOf.get(b)?.length ?? 0) + (importedBy.get(b)?.length ?? 0)
    return ib - ia
  }).filter((f) => totalFindings(ownCounts.get(f)) > 0).slice(0, 7)

  const hubsByImports = [...files].sort((a, b) => {
    const ca = (importsOf.get(a)?.length ?? 0) + (importedBy.get(a)?.length ?? 0)
    const cb = (importsOf.get(b)?.length ?? 0) + (importedBy.get(b)?.length ?? 0)
    return cb - ca
  }).slice(0, 7)

  const hubsSorted = hubsTab === 'issues' ? hubsByIssues : hubsByImports

  if (hubsByIssues.length > 0 || hubsByImports.length > 0) {
    html += '<div class="tree-hubs">'
    html += '<div class="tree-hubs-header">'
    html += '<div class="tree-hubs-title">Top hubs</div>'
    html += '<div class="tree-hubs-tabs">'
    html += `<button type="button" class="tree-hubs-tab${hubsTab === 'issues' ? ' active' : ''}" data-hubs-tab="issues">Issues</button>`
    html += `<button type="button" class="tree-hubs-tab${hubsTab === 'imports' ? ' active' : ''}" data-hubs-tab="imports">Imports</button>`
    html += '</div>'
    html += '</div>'
    if (hubsSorted.length === 0) {
      html += '<div style="color:rgba(139,148,158,.35);font-size:.75rem;padding:.2rem .3rem;font-style:italic;">None in current view</div>'
    }
    for (const f of hubsSorted) {
      const col = pkgColor(packageOf(f) ?? '__own__')
      const base = f.split('/').pop() ?? f
      const val = hubsTab === 'issues'
        ? totalFindings(ownCounts.get(f))
        : (importsOf.get(f)?.length ?? 0) + (importedBy.get(f)?.length ?? 0)
      const valColor = hubsTab === 'issues' ? (indicatorFor(ownCounts.get(f)) ?? 'rgba(139,148,158,.45)') : 'rgba(139,148,158,.45)'
      html += `<div class="tree-hub-item" data-select-file="${esc(f)}">`
      html += `<span class="tree-hub-dot" style="background:${esc(col)}"></span>`
      html += `<span class="tree-hub-name">${esc(base)}</span>`
      html += `<span class="tree-hub-conn" style="color:${esc(valColor)}">${val}</span>`
      html += `</div>`
    }
    html += '</div>'
  }

  // Node detail
  if (!file || !treeData[file]) {
    html += '<div class="tree-info-empty"><div class="tree-info-empty-icon">↗</div>Click a node to inspect it</div>'
    return html
  }

  const entry = treeData[file]
  const own = ownCounts.get(file) ?? { critical: 0, high: 0, medium: 0, low: 0 }
  const trans = transitiveCounts.get(file) ?? { critical: 0, high: 0, medium: 0, low: 0 }
  const pkg = packageOf(file) ?? '__own__'
  const pkgCol = pkgColor(pkg)

  const renderChips = (counts) => {
    const present = Object.entries(counts).filter(([, n]) => n > 0)
    if (present.length === 0) return '<div class="tree-info-empty-list">none</div>'
    return '<div class="tree-count-chips">' +
      present.map(([sev, n]) => `<span class="tree-count-chip ${esc(sev)}">${n} ${esc(sev)}</span>`).join('') +
      '</div>'
  }

  const importers = []
  for (const [other, e] of Object.entries(treeData)) {
    if ((e.imports ?? []).includes(file)) importers.push(other)
  }
  importers.sort()
  const imports = (entry.imports ?? []).slice().sort()

  const renderList = (items) => {
    if (items.length === 0) return '<div class="tree-info-empty-list">none</div>'
    let h = '<ul class="tree-info-list">'
    for (const i of items) {
      if (treeData[i]) h += `<li><button type="button" data-select-file="${esc(i)}">${esc(i)}</button></li>`
      else h += `<li><span class="external" title="${esc(i)}">${esc(i)}</span></li>`
    }
    h += '</ul>'
    return h
  }

  html += '<div class="tree-info-content">'
  html += '<div class="tree-info-header">'
  html += `<div class="tree-info-pkg-badge"><span class="tree-info-pkg-dot" style="background:${esc(pkgCol)}"></span>${esc(pkg === '__own__' ? 'own source' : pkg)}</div>`
  html += `<div class="tree-info-title">${esc(file)}</div>`
  html += '<div class="tree-info-jumps">'
  const hasOwnFindings = totalFindings(own) > 0
  if (hasOwnFindings) {
    html += `<button type="button" class="tree-info-jump" data-jump-findings="${esc(file)}">Findings →</button>`
  }
  html += `<button type="button" class="tree-info-jump" data-jump-file="${esc(file)}">Files →</button>`
  html += '</div>'
  html += '</div>'
  html += '<div class="tree-info-section"><div class="tree-info-label">Own findings</div>' + renderChips(own) + '</div>'
  html += '<div class="tree-info-section"><div class="tree-info-label">Subtree findings</div>' + renderChips(trans) + '</div>'
  html += `<div class="tree-info-section"><div class="tree-info-label">Imported by (${importers.length})</div>` + renderList(importers) + '</div>'
  html += `<div class="tree-info-section"><div class="tree-info-label">Imports (${imports.length})</div>` + renderList(imports) + '</div>'
  html += '</div>'
  return html
}

// Attach all canvas interaction: draw loop, pan/zoom, hover, click.
// `refreshSidebar` is called after a selection change so view.js can
// rebuild the sidebar HTML using its own `reports` state.
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
    const w = canvas.width / dpr, h = canvas.height / dpr
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Background — very dark navy
    ctx.fillStyle = '#060a0f'
    ctx.fillRect(0, 0, w, h)

    // Subtle center radial
    const cg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.6)
    cg.addColorStop(0, 'rgba(20,30,50,0.5)')
    cg.addColorStop(1, 'rgba(0,0,0,0)')
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
        ctx.strokeStyle = 'rgba(255,255,255,0.03)'
        ctx.lineWidth = 0.5 / zoom
      } else {
        ctx.strokeStyle = pkgColorAlpha(srcPkg, 0.22)
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
        ctx.fillStyle = isHov ? pkgColorAlpha(srcPkg, 0.9) : pkgColorAlpha(srcPkg, 0.4)
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
          ctx.fillStyle = isHov ? pkgColorAlpha(dstPkg, 0.9) : pkgColorAlpha(dstPkg, 0.4)
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
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2 / zoom; ctx.stroke()
      } else if (isHov) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 1 / zoom, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'
        ctx.lineWidth = 1.5 / zoom; ctx.stroke()
      }

      // Severity dot (top-right corner, scaled with node)
      if (findingColor) {
        const br = Math.max(2.5, r * 0.36)
        const bx = n.x + r * 0.72, by = n.y - r * 0.72
        // Dark halo
        ctx.beginPath(); ctx.arc(bx, by, br + 1.2, 0, Math.PI * 2)
        ctx.fillStyle = '#060a0f'; ctx.fill()
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

        // Shadow/outline for readability on any background
        ctx.shadowColor = 'rgba(6,10,15,0.98)'; ctx.shadowBlur = 4
        ctx.strokeStyle = 'rgba(6,10,15,0.9)'; ctx.lineWidth = 3 / zoom
        ctx.lineJoin = 'round'
        ctx.strokeText(lines[0], n.x, ty)
        if (lines[1]) ctx.strokeText(lines[1], n.x, ty + lineH)

        ctx.shadowBlur = 0
        ctx.fillStyle = isSelected ? '#fff' : isHov ? 'rgba(230,237,243,0.95)' : 'rgba(200,210,225,0.78)'
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

// renderTreeSidebar replaced by renderTreeSidebarFull (inline in renderTreeCanvas block above).
// Keeping a stub so any old reference doesn't hard-crash; it should never be called.
export function renderTreeSidebar(file, treeData, ownCounts, transitiveCounts) {
  return renderTreeSidebarFull(file, treeData, ownCounts, transitiveCounts)
}

// Layered-DAG SVG of the import tree. Roots (no one imports them) sit
// at the top; depth grows downward via "1 + max depth of importers"
// (cycles are broken by the visiting-set guard).
//
// Within each layer, nodes are ordered by the BARYCENTER heuristic —
// average position of neighbors in the adjacent layer, alternating
// down-then-up passes. A handful of iterations is usually enough to
// reach a near-minimum-crossing arrangement; this is what makes the
// graph readable with more than a dozen files (alphabetical ordering
// produces a spaghetti tangle).
//
// (Kept for reference — the active tree-tab visualization is the
// force-directed `renderTreeCanvas` above; this layered renderer is
// no longer reachable from render() but left in source as a fallback
// option.)
export function renderTreeGraph(treeData, findingCounts) {
  const files = Object.keys(treeData)
  if (files.length === 0) return ''

  // Build adjacency (filter out edges whose target isn't in the tree —
  // they're dead ends for layout / hover purposes).
  const importedBy = new Map()
  const importsOf = new Map()
  for (const f of files) {
    const imps = (treeData[f].imports ?? []).filter((i) => treeData[i])
    importsOf.set(f, imps)
    for (const imp of imps) {
      const arr = importedBy.get(imp) ?? []
      arr.push(f)
      importedBy.set(imp, arr)
    }
  }

  // Layer assignment: depth(f) = longest importer chain ending at f.
  const depth = new Map()
  const visiting = new Set()
  const computeDepth = (file) => {
    if (depth.has(file)) return depth.get(file)
    if (visiting.has(file)) return 0
    visiting.add(file)
    const importers = importedBy.get(file) ?? []
    let d = 0
    for (const imp of importers) d = Math.max(d, computeDepth(imp) + 1)
    visiting.delete(file)
    depth.set(file, d)
    return d
  }
  for (const f of files) computeDepth(f)

  const maxDepth = Math.max(0, ...depth.values())
  const layers = []
  for (let d = 0; d <= maxDepth; d++) layers.push([])
  for (const f of files) layers[depth.get(f)].push(f)
  for (const layer of layers) layer.sort()

  // Position map (column index within layer). Updated after every pass.
  const pos = new Map()
  const refresh = () => {
    pos.clear()
    for (const layer of layers) layer.forEach((f, i) => pos.set(f, i))
  }
  refresh()

  // Barycenter: average position of a node's neighbors in `adj` (the
  // adjacent layer's adjacency map). Falls back to current position
  // for isolated nodes so they don't drift to 0.
  const meanPos = (neighbors) => {
    if (neighbors.length === 0) return null
    let sum = 0, n = 0
    for (const x of neighbors) { const p = pos.get(x); if (p !== undefined) { sum += p; n++ } }
    return n === 0 ? null : sum / n
  }
  // Six passes (3 down + 3 up) — plenty for typical graphs without
  // burning time on the rare degenerate case.
  for (let pass = 0; pass < 6; pass++) {
    const downward = pass % 2 === 0
    const range = downward
      ? Array.from({ length: maxDepth }, (_, i) => i + 1)            // 1..maxDepth
      : Array.from({ length: maxDepth }, (_, i) => maxDepth - 1 - i) // maxDepth-1..0
    for (const d of range) {
      const layer = layers[d]
      const bary = new Map()
      for (const f of layer) {
        const neighbors = downward ? (importedBy.get(f) ?? []) : (importsOf.get(f) ?? [])
        const m = meanPos(neighbors)
        bary.set(f, m === null ? pos.get(f) : m)
      }
      layer.sort(byBary(bary))
    }
    refresh()
  }

  // Layout coords.
  const NODE_W = 170, NODE_H = 36
  const COL_GAP = 28, ROW_GAP = 56
  const colW = NODE_W + COL_GAP
  const rowH = NODE_H + ROW_GAP
  const xy = new Map()
  for (let d = 0; d <= maxDepth; d++) {
    layers[d].forEach((f, i) => xy.set(f, { x: 24 + i * colW, y: 24 + d * rowH }))
  }
  const maxLayerSize = Math.max(1, ...layers.map((l) => l.length))
  const width = 48 + maxLayerSize * colW - COL_GAP
  const height = 48 + layers.length * rowH - ROW_GAP

  const localIndicatorFor = (counts) => {
    if (!counts) return null
    for (const sev of ['critical', 'high', 'medium', 'low']) {
      if (counts[sev] > 0) return SEV_COLORS[sev]
    }
    return null
  }

  let svg = `<svg class="tree-graph-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`

  // Edges first so they render under the nodes. data-from / data-to
  // feed the post-render hover-highlight wiring.
  svg += '<g class="edges">'
  for (const f of files) {
    const a = xy.get(f)
    if (!a) continue
    const ax = a.x + NODE_W / 2
    const ay = a.y + NODE_H
    for (const imp of importsOf.get(f)) {
      const b = xy.get(imp)
      if (!b) continue
      const bx = b.x + NODE_W / 2
      const by = b.y
      const midY = (ay + by) / 2
      svg += `<path data-from="${esc(svgNodeId(f))}" data-to="${esc(svgNodeId(imp))}" d="M ${ax} ${ay} C ${ax} ${midY}, ${bx} ${midY}, ${bx} ${by}" />`
    }
  }
  svg += '</g>'

  // Nodes with severity indicator strip + total-findings corner badge.
  svg += '<g class="nodes">'
  for (const f of files) {
    const p = xy.get(f)
    if (!p) continue
    const counts = findingCounts.get(f)
    const total = counts ? counts.critical + counts.high + counts.medium + counts.low : 0
    const indicator = localIndicatorFor(counts)
    const label = svgNodeLabel(f)
    svg += `<g class="tree-node" id="${esc(svgNodeId(f))}" transform="translate(${p.x}, ${p.y})">`
    svg += `<a href="#${esc(treeAnchor(f))}">`
    svg += `<title>${esc(f)}${total > 0 ? ` (${total} finding${total === 1 ? '' : 's'})` : ''}</title>`
    svg += `<rect class="node-bg" width="${NODE_W}" height="${NODE_H}" rx="6" ry="6" />`
    if (indicator) svg += `<rect class="node-strip" x="0" y="0" width="4" height="${NODE_H}" fill="${indicator}" />`
    svg += `<text x="${indicator ? 12 : NODE_W / 2}" y="${NODE_H / 2 + 4}" text-anchor="${indicator ? 'start' : 'middle'}">${esc(label)}</text>`
    if (total > 0) {
      const r = 9
      svg += `<circle cx="${NODE_W - r - 6}" cy="${r + 4}" r="${r}" fill="${indicator}" />`
      svg += `<text x="${NODE_W - r - 6}" y="${r + 4 + 3}" text-anchor="middle" class="badge-text">${total}</text>`
    }
    svg += '</a></g>'
  }
  svg += '</g>'
  svg += '</svg>'
  return svg
}

// Render the per-file import tree as a flat list of cards. Each card
// shows imports (linked to their target's anchor when the target is in
// the tree), the inverse "imported by", exports, the hashes, and a
// finding-count badge row when the file has any findings.
export function renderTreeView(treeData, findingCounts) {
  const files = Object.keys(treeData).sort()
  // Inverse adjacency: file → list of files that import it.
  const importedBy = new Map()
  for (const f of files) {
    for (const imp of (treeData[f].imports ?? [])) {
      const arr = importedBy.get(imp) ?? []
      arr.push(f)
      importedBy.set(imp, arr)
    }
  }
  const linkOrText = (target) => treeData[target]
    ? `<a href="#${esc(treeAnchor(target))}"><span class="name">${esc(target)}</span></a>`
    : `<span class="name">${esc(target)}</span>`
  let html = '<div class="tree-view">'
  for (const file of files) {
    const entry = treeData[file]
    html += `<section class="tree-file" id="${esc(treeAnchor(file))}">`
    html += '<div class="tree-file-header">'
    html += `<span class="name">${esc(file)}</span>`
    const counts = findingCounts.get(file)
    if (counts) {
      const present = Object.entries(counts).filter(([, n]) => n > 0)
      if (present.length > 0) {
        html += '<span class="tree-count-chips">'
        for (const [sev, n] of present) {
          html += `<span class="tree-count-chip ${esc(sev)}">${n} ${esc(sev)}</span>`
        }
        html += '</span>'
      }
    }
    html += '</div>'
    if (entry.fileHash || entry.treeHash) {
      const parts = []
      if (entry.fileHash) parts.push(`file: ${esc(entry.fileHash)}`)
      if (entry.treeHash) parts.push(`tree: ${esc(entry.treeHash)}`)
      html += `<div class="tree-hashes hashes">${parts.join(' | ')}</div>`
    }
    if (entry.imports?.length > 0) {
      html += '<div class="tree-section"><span class="tree-section-label">imports</span><ul>'
      for (const imp of entry.imports) html += `<li>${linkOrText(imp)}</li>`
      html += '</ul></div>'
    }
    const incoming = importedBy.get(file) ?? []
    if (incoming.length > 0) {
      html += '<div class="tree-section"><span class="tree-section-label">imported by</span><ul>'
      for (const f of incoming) html += `<li>${linkOrText(f)}</li>`
      html += '</ul></div>'
    }
    if (entry.exports?.length > 0) {
      html += '<div class="tree-section"><span class="tree-section-label">exports</span><ul>'
      for (const ex of entry.exports) html += `<li><span class="name">${esc(ex)}</span></li>`
      html += '</ul></div>'
    }
    html += '</section>'
  }
  html += '</div>'
  return html
}
