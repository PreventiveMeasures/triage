// Nodes scale with the viewport, while circles and labels in the compact
// renderer stay in screen pixels. Reserve both before solving for zoom.
export function fitCompactGraph(nodes, width, height, { statsHeight = 0, left = 0, right = left, top = 0, bottom = top } = {}) {
  const padX = Math.max(20, width * .04), padY = Math.max(20, height * .04)
  const availableW = Math.max(1, width - padX * 2 - left - right)
  const availableH = Math.max(1, height - padY * 2 - statsHeight - top - bottom)
  let maxX = -Infinity, maxY = -Infinity, minX = Infinity, minY = Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x)
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y)
  }
  if (nodes.length === 0) return { k: 1, tx: width / 2, ty: (height - statsHeight) / 2 }
  const k = Math.min(4, availableW / Math.max(20, maxX - minX), availableH / Math.max(20, maxY - minY))
  return {
    k,
    tx: padX + left + availableW / 2 - (minX + maxX) / 2 * k,
    ty: padY + top + availableH / 2 - (minY + maxY) / 2 * k,
  }
}
