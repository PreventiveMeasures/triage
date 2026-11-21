// The control height of a ribbon's curves: past its lower end for a return
// ribbon, midway otherwise.
export const flowBend = edge => edge.returning ? Math.max(edge.y1, edge.y2) + 35 : (edge.y1 + edge.y2) / 2

// Conservative Bezier bounds include both control points, including return
// ribbons that bend below their endpoints. Never cull a crossing by its ends.
export function flowEdgeBounds(edge) {
  const bend = flowBend(edge)
  return { left: Math.min(edge.x1, edge.x2), right: Math.max(edge.x1 + edge.width1, edge.x2 + edge.width2),
    top: Math.min(edge.y1, edge.y2, bend), bottom: Math.max(edge.y1, edge.y2, bend) }
}

export function flowOutside(box, view) {
  return box.right < view.left || box.left > view.right || box.bottom < view.top || box.top > view.bottom
}

// The box around all of `boxes`.
export const flowUnion = boxes => boxes.reduce((area, box) => ({ left: Math.min(area.left, box.left), right: Math.max(area.right, box.right),
  top: Math.min(area.top, box.top), bottom: Math.max(area.bottom, box.bottom) }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity })

// Linear retained memory, without inserting a long ribbon into every crossed
// grid cell. Bounds narrow pointer hits before the exact cached Path2D test.
export function flowHitIndex(entries) {
  if (entries.length === 0) return null
  const bounds = flowUnion(entries)
  if (entries.length <= 12) return { ...bounds, entries }
  const horizontal = bounds.right - bounds.left > bounds.bottom - bounds.top
  const center = entry => horizontal ? entry.left + entry.right : entry.top + entry.bottom
  const sorted = entries.toSorted((a, b) => center(a) - center(b))
  const mid = sorted.length >>> 1
  return { ...bounds, children: [flowHitIndex(sorted.slice(0, mid)), flowHitIndex(sorted.slice(mid))] }
}

function* entriesWithin(index, box) {
  const stack = index ? [index] : []
  while (stack.length > 0) {
    const node = stack.pop()
    if (flowOutside(node, box)) continue
    if (!node.entries) { stack.push(...node.children); continue }
    for (const entry of node.entries) if (!flowOutside(entry, box)) yield entry
  }
}

// Bars cover ribbons; later ribbons cover earlier ribbons, as in the SVG.
export function flowHitCandidates(index, x, y) {
  return [...entriesWithin(index, { left: x, right: x, top: y, bottom: y })].toSorted((a, b) => b.order - a.order)
}

// Bound the work for live zoom redraws. A dense view uses its complete cached
// image; null signals that fallback, never a truncated list of ribbons.
export function flowVisibleRibbons(index, view, limit) {
  const ribbons = []
  for (const entry of entriesWithin(index, view)) {
    if (!entry.edge) continue
    ribbons.push(entry)
    if (ribbons.length > limit) return null
  }
  return ribbons.toSorted((a, b) => a.order - b.order)
}
