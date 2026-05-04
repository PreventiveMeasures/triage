import { esc } from '../format.js'
import { renderTreeSidebarFull } from './sidebar.js'
import { SEV_COLORS, treeAnchor, svgNodeLabel, svgNodeId, byBary } from './utils.js'

// renderTreeSidebar replaced by renderTreeSidebarFull. Stub so any
// stale reference doesn't hard-crash; should never be called.
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
// force-directed `renderTreeCanvas` in canvas.js; this layered renderer
// is no longer reachable from render() but left in source as a fallback
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

  const indicatorFor = (counts) => {
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
    const indicator = indicatorFor(counts)
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
