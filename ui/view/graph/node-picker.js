// Layout positions stay fixed while the viewport pans/zooms. Index world-space
// cells once per layout so pointer movement only visits nearby nodes.
export function createNodePicker(nodes) {
  const cellSize = 32, columns = new Map()
  for (const [index, node] of nodes.entries()) {
    const x = Math.floor(node.x / cellSize), y = Math.floor(node.y / cellSize)
    if (!columns.has(x)) columns.set(x, new Map())
    const column = columns.get(x)
    if (!column.has(y)) column.set(y, [])
    column.get(y).push({ node, index })
  }
  return (sx, sy, viewport, maxRadius, radius, visible) => {
    const { k, tx, ty } = viewport
    // Small slack only broadens the candidate search; the final distance
    // comparison is the original screen-space test, including strict edges.
    const pad = (maxRadius + 6) / k + 1e-7
    const wx = (sx - tx) / k, wy = (sy - ty) / k
    const x0 = Math.floor((wx - pad) / cellSize), x1 = Math.floor((wx + pad) / cellSize)
    const y0 = Math.floor((wy - pad) / cellSize), y1 = Math.floor((wy + pad) / cellSize)
    let best = null, bestD = Infinity, bestIndex = Infinity
    for (let x = x0; x <= x1; x++) {
      const column = columns.get(x)
      if (!column) continue
      for (let y = y0; y <= y1; y++) {
        for (const { node, index } of column.get(y) ?? []) {
          if (!visible(node)) continue
          const dx = node.x * k + tx - sx, dy = node.y * k + ty - sy
          const d = dx * dx + dy * dy, r = radius(node) + 6
          // Equal distances still favor original node order, regardless of
          // which spatial cell was visited first.
          if (d < r * r && (d < bestD || (d === bestD && index < bestIndex))) {
            best = node; bestD = d; bestIndex = index
          }
        }
      }
    }
    return best
  }
}
