// Conservative Bezier bounds include both control points, including return
// ribbons that bend below their endpoints. Never cull a crossing by its ends.
export function flowEdgeBounds(edge) {
  const bend = edge.returning ? Math.max(edge.y1, edge.y2) + 35 : (edge.y1 + edge.y2) / 2
  return { left: Math.min(edge.x1, edge.x2), right: Math.max(edge.x1 + edge.width1, edge.x2 + edge.width2),
    top: Math.min(edge.y1, edge.y2, bend), bottom: Math.max(edge.y1, edge.y2, bend) }
}

export function flowOutside(box, view) {
  return box.right < view.left || box.left > view.right || box.bottom < view.top || box.top > view.bottom
}

// Linear retained memory, without inserting a long ribbon into every crossed
// grid cell. Bounds narrow pointer hits before the exact cached Path2D test.
export function flowHitIndex(entries) {
  if (entries.length === 0) return null
  const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
  for (const entry of entries) {
    bounds.left = Math.min(bounds.left, entry.left); bounds.right = Math.max(bounds.right, entry.right)
    bounds.top = Math.min(bounds.top, entry.top); bounds.bottom = Math.max(bounds.bottom, entry.bottom)
  }
  if (entries.length <= 12) return { ...bounds, entries }
  const horizontal = bounds.right - bounds.left > bounds.bottom - bounds.top
  const center = entry => horizontal ? entry.left + entry.right : entry.top + entry.bottom
  const sorted = entries.toSorted((a, b) => center(a) - center(b))
  const mid = sorted.length >>> 1
  return { ...bounds, children: [flowHitIndex(sorted.slice(0, mid)), flowHitIndex(sorted.slice(mid))] }
}

export function flowHitCandidates(index, x, y) {
  const candidates = [], point = { left: x, right: x, top: y, bottom: y }, stack = index ? [index] : []
  while (stack.length > 0) {
    const node = stack.pop()
    if (flowOutside(node, point)) continue
    if (node.entries) {
      for (const entry of node.entries) if (!flowOutside(entry, point)) candidates.push(entry)
    } else stack.push(...node.children)
  }
  // Bars cover ribbons; later ribbons cover earlier ribbons, as in the SVG.
  return candidates.toSorted((a, b) => b.order - a.order)
}
