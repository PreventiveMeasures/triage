export function nodeBounds(nodes) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const n of nodes) {
    x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x)
    y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y)
  }
  return { x0, y0, x1, y1 }
}

// Nodes scale with the viewport, while circles and labels in the compact
// renderer stay in screen pixels. Reserve both before solving for zoom.
export function fitCompactGraph(nodes, width, height, { statsHeight = 0, left = 0, right = left, top = 0, bottom = top } = {}) {
  const padX = Math.max(20, width * .04), padY = Math.max(20, height * .04)
  const availableW = Math.max(1, width - padX * 2 - left - right)
  const availableH = Math.max(1, height - padY * 2 - statsHeight - top - bottom)
  if (nodes.length === 0) return { k: 1, tx: width / 2, ty: (height - statsHeight) / 2 }
  const { x0, y0, x1, y1 } = nodeBounds(nodes)
  const k = Math.min(4, availableW / Math.max(20, x1 - x0), availableH / Math.max(20, y1 - y0))
  return {
    k,
    tx: padX + left + availableW / 2 - (x0 + x1) / 2 * k,
    ty: padY + top + availableH / 2 - (y0 + y1) / 2 * k,
  }
}
