import { placeDependencyCycle } from './dependency-chain-order.js'

export const DEPENDENCY_CARD_WIDTH = 216
export const DEPENDENCY_CARD_HEIGHT = 54
export const DEPENDENCY_DIALOG_GUTTER = 32 // dialog borders, content padding and vertical scrollbar
const gapX = 20, gapY = 24, heading = 20, padding = 10

function roundedPath(points) {
  let path = `M${points[0].join(',')}`
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i], [ax, ay] = points[i - 1], [bx, by] = points[i + 1]
    const after = Math.hypot(bx - x, by - y), before = Math.hypot(x - ax, y - ay)
    if (!before || !after) continue
    const radius = Math.min(6, before / 2, after / 2)
    path += ` L${x - (x - ax) / before * radius},${y - (y - ay) / before * radius} Q${x},${y} ${x + (bx - x) / after * radius},${y + (by - y) / after * radius}`
  }
  return `${path} L${points.at(-1).join(',')}`
}

// Expanded cycles expose the actual importing/imported card. Follow a column
// gutter out of the group so an edge never cuts through its other packages.
function importPort(box, id, incoming, index) {
  const node = box.packages.find(card => card.id === id)
  const track = index % 4
  const offset = [0, 8, -8, 16][track]
  const outerY = incoming ? box.y - 12 : box.rowBottom + 9 + track * 3
  if (box.members.length === 1 || box.collapsed) {
    const x = box.x + box.width / 2 + offset
    return [[x, incoming ? box.y - 5 : box.y + box.height], [x, outerY]]
  }
  const x = box.x + node.x + (incoming ? 0 : DEPENDENCY_CARD_WIDTH)
  const y = box.y + node.y + DEPENDENCY_CARD_HEIGHT / 2 + (incoming ? offset / 2 : 0)
  const lane = x + (incoming ? -7 - track * 2 : 3 + track * 2)
  return [[x + (incoming ? -4 : 0), y], [lane, y], [lane, outerY]]
}

export function dependencyImportPath(from, fromPackage, to, toPackage, { bypassLane, fromIndex, toIndex }) {
  const end = importPort(to, toPackage, true, toIndex), start = importPort(from, fromPackage, false, fromIndex)
  const [, y1] = start.at(-1), [x2, y2] = end.at(-1)
  // Only turn after leaving the tallest group in the source row. Shortcuts
  // also go around intervening rows before entering the destination gutter.
  const middle = bypassLane === null ? [[x2, y1]] : [[bypassLane, y1], [bypassLane, y2]]
  return roundedPath([...start, ...middle, ...end.toReversed()])
}

function cycleImportPath(a, b) {
  const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y)
  const h = DEPENDENCY_CARD_HEIGHT, w = DEPENDENCY_CARD_WIDTH
  // Opposite directions get distinct ports, so both arrowheads remain visible.
  if (dy === 0 && Math.abs(b.x - a.x) === w + gapX) {
    const y = a.y + h / 2 - dx * 6
    return `M${a.x + (dx > 0 ? w : 0)},${y} L${b.x + (dx > 0 ? -4 : w + 4)},${y}`
  }
  if (dx === 0 && Math.abs(b.y - a.y) === h + gapY) {
    const x = a.x + w / 2 + dy * 8
    return `M${x},${a.y + (dy > 0 ? h : 0)} L${x},${b.y + (dy > 0 ? -4 : h + 4)}`
  }
  // Longer links travel through the grid gutters instead of crossing cards.
  // Use separate lanes for the return edge of a reciprocal import.
  const side = dx || dy, x = a.x + (side > 0 ? w : 0), y = a.y + h / 2
  const lane = x + side * (gapX / 2 - 3)
  const targetX = b.x + w / 2 + side * 8
  const above = dy > 0 || (dy === 0 && dx > 0)
  const gutter = b.y + (above ? -10 : h + 10), targetY = b.y + (above ? -4 : h + 4)
  return roundedPath([[x, y], [lane, y], [lane, gutter], [targetX, gutter], [targetX, targetY]])
}

// Cycles are small two-dimensional graphs, not stacks whose height grows with
// every package. Keep fixed card dimensions and route edges between grid cells.
export function layoutDependencyGroup(id, members, imports, maxWidth = 1184, collapsed = false) {
  if (collapsed) return { id, members, collapsed, packages: [], internalEdges: [], width: DEPENDENCY_CARD_WIDTH + padding * 2, height: DEPENDENCY_CARD_HEIGHT }
  const cyclic = members.length > 1
  const capacity = Math.max(1, Math.floor((maxWidth - padding * 2 + gapX) / (DEPENDENCY_CARD_WIDTH + gapX)))
  const cols = cyclic ? Math.min(capacity, Math.max(2, Math.ceil(Math.sqrt(members.length / 2)))) : 1
  const pad = cyclic ? padding : 0, rows = Math.ceil(members.length / cols), top = cyclic ? heading : 0
  const placement = cyclic ? placeDependencyCycle(members, imports, cols) : [{ id: members[0], col: 0, row: 0 }]
  const packages = placement.map(node => ({ id: node.id,
    x: pad + node.col * (DEPENDENCY_CARD_WIDTH + gapX), y: pad + top + node.row * (DEPENDENCY_CARD_HEIGHT + gapY) }))
  const positions = new Map(packages.map(node => [node.id, node]))
  const internalEdges = []
  if (cyclic) {
    for (const from of members) {
      for (const to of imports.get(from) ?? []) {
        if (from !== to && positions.has(to)) internalEdges.push({ from, to, path: cycleImportPath(positions.get(from), positions.get(to)) })
      }
    }
  }
  return { id, members, collapsed, packages, internalEdges,
    width: cols * DEPENDENCY_CARD_WIDTH + (cols - 1) * gapX + pad * 2,
    height: rows * DEPENDENCY_CARD_HEIGHT + (rows - 1) * gapY + pad * 2 + top }
}
