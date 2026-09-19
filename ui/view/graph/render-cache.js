// The graph is immutable during a canvas attachment. Resolve edge endpoints
// once, then reuse per-node drawing data across all edges, halos, and dots.
export function createRenderCache(graph) {
  const nodes = graph.nodes.map((node) => ({ node }))
  const byFile = new Map(nodes.map((entry) => [entry.node.file, entry]))
  const edges = graph.edges.flatMap((edge) => {
    const a = byFile.get(edge.a), b = byFile.get(edge.b)
    return a && b ? [{ edge, a, b }] : []
  })
  return { nodes, edges, graph, selected: undefined, neighbors: new Set() }
}

export function updateRenderCache(cache, { viewport, selected, visible, dimmed, radius, color, paintKey }) {
  if (cache.k !== viewport.k || cache.tx !== viewport.tx || cache.ty !== viewport.ty) {
    cache.k = viewport.k; cache.tx = viewport.tx; cache.ty = viewport.ty
    cache.geometryVersion = (cache.geometryVersion ?? 0) + 1
  }
  // Hover and file selection don't change these values. The caller's key
  // includes viewport, sizing, theme, and every filter (including Set contents).
  if (paintKey === undefined || cache.paintKey !== paintKey) {
    const colors = new Map()
    for (const entry of cache.nodes) {
      const n = entry.node
      entry.visible = visible(n)
      if (!entry.visible) continue
      entry.x = n.x * viewport.k + viewport.tx
      entry.y = n.y * viewport.k + viewport.ty
      entry.radius = radius(n)
      entry.dimmed = dimmed(n)
      if (!colors.has(n.pkg)) colors.set(n.pkg, color(n.pkg))
      entry.color = colors.get(n.pkg)
    }
    cache.paintKey = paintKey
  }
  if (cache.selected !== selected) {
    cache.selected = selected
    cache.neighbors.clear()
    for (const i of cache.graph.adj.get(selected) ?? []) {
      const edge = cache.graph.edges[i]
      cache.neighbors.add(edge.a)
      cache.neighbors.add(edge.b)
    }
  }
}

export function edgeGradient(entry, frame, alpha, ctx, alphaHex) {
  const { a, b } = entry
  if (!entry.gradient || entry.geometryVersion !== frame.geometryVersion || entry.alpha !== alpha
      || entry.colorA !== a.color || entry.colorB !== b.color) {
    entry.gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
    entry.gradient.addColorStop(0, a.color + alphaHex(alpha))
    entry.gradient.addColorStop(1, b.color + alphaHex(alpha))
    entry.geometryVersion = frame.geometryVersion
    entry.alpha = alpha; entry.colorA = a.color; entry.colorB = b.color
  }
  return entry.gradient
}

export function haloGradient(entry, radius, ctx) {
  if (!entry.halo || entry.haloX !== entry.x || entry.haloY !== entry.y || entry.haloRadius !== radius || entry.haloColor !== entry.color) {
    entry.halo = ctx.createRadialGradient(entry.x, entry.y, 0, entry.x, entry.y, radius)
    entry.halo.addColorStop(0, entry.color + '55')
    entry.halo.addColorStop(1, entry.color + '00')
    entry.haloX = entry.x; entry.haloY = entry.y; entry.haloRadius = radius; entry.haloColor = entry.color
  }
  return entry.halo
}

// Conservative screen-space bounds: include stroke/antialiasing slack and
// retain segments crossing the viewport even when both endpoints are outside.
export function edgeOutside(a, b, width, height) {
  return (a.x < -2 && b.x < -2) || (a.x > width + 2 && b.x > width + 2)
    || (a.y < -2 && b.y < -2) || (a.y > height + 2 && b.y > height + 2)
}

export function circleOutside(x, y, radius, width, height) {
  return x + radius < -2 || x - radius > width + 2 || y + radius < -2 || y - radius > height + 2
}
