import { placeWhyCycle } from './why-order.js'

export const WHY_CARD_WIDTH = 216
export const WHY_CARD_HEIGHT = 48
export const WHY_DIALOG_GUTTER = 32 // dialog borders, content padding and vertical scrollbar
const gapX = 20, gapY = 24, heading = 20, padding = 10

// Dense rows overlap cards horizontally, with at least 30% of each exposed.
// Expanded cycles keep their grid and gutters; only compact neighbors stack.
export function layoutWhyRow(row, maxWidth) {
  const compact = group => group && (group.collapsed || group.members.length === 1)
  const overlap = row.map((group, i) => row.length > 5 && compact(group) && compact(row[i + 1]))
  let fixed = 0, flexible = 0
  row.forEach((group, i) => {
    if (overlap[i]) flexible += group.width
    else fixed += group.width + (i === row.length - 1 ? 0 : gapX)
  })
  const available = Math.min(maxWidth, WHY_CARD_WIDTH * 5 + gapX * 4)
  const fraction = flexible ? Math.max(.3, Math.min(.9, (available - fixed) / flexible)) : 1
  let width = 0
  const groups = row.map((group, i) => {
    const visibleWidth = group.width * (overlap[i] ? fraction : 1)
    const placed = { ...group, x: width, visibleWidth, stacked: !!(overlap[i] || overlap[i - 1]) }
    width += visibleWidth + (overlap[i] || i === row.length - 1 ? 0 : gapX)
    return placed
  })
  return { groups, width, height: Math.max(...row.map(group => group.height)) }
}

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
const portOffset = ({ count, index }) => (index - (count - 1) / 2) * Math.min(8, 48 / Math.max(1, count - 1))
function importPort(box, id, incoming, port) {
  const node = box.packages.find(card => card.id === id)
  const offset = portOffset(port)
  const outerY = incoming ? box.y - 12 : box.rowBottom
  if (box.members.length === 1 || box.collapsed) {
    const x = box.x + box.visibleWidth / 2 + offset
    return [[x, incoming ? box.y - 5 : box.y + box.height], [x, outerY]]
  }
  const x = box.x + node.x + (incoming ? 0 : WHY_CARD_WIDTH)
  const y = box.y + node.y + WHY_CARD_HEIGHT / 2 + offset / 2
  const lane = x + (incoming ? -7 - port.lane * 6 : 3 + port.lane * 6)
  return [[x + (incoming ? -4 : 0), y], [lane, y], [lane, outerY]]
}

export function routeWhyEdges(boxes, edges) {
  const center = (edge, side) => {
    const box = boxes.get(edge[side]), node = box.packages.find(card => card.id === edge[`${side}Package`])
    if (box.members.length === 1 || box.collapsed) return [box.x + box.visibleWidth / 2, box.y + box.height / 2]
    return node ? [box.x + node.x + WHY_CARD_WIDTH / 2, box.y + node.y + WHY_CARD_HEIGHT / 2]
      : [box.x + box.width / 2, box.y + box.height / 2]
  }
  const ranks = (side, other, opposite = edge => center(edge, other)) => {
    const ports = new Map()
    const shared = Map.groupBy(edges, edge => {
      const box = boxes.get(edge[side])
      return box.collapsed ? box : edge[`${side}Package`]
    })
    for (const group of shared.values()) {
      // Ports follow the other cards' positions, not import insertion order.
      const sorted = group.toSorted((a, b) => {
        const [ax, ay] = opposite(a), [bx, by] = opposite(b)
        return (a.bypassLane ?? ax) - (b.bypassLane ?? bx) || ay - by
          || a[`${other}Package`].localeCompare(b[`${other}Package`]) || a[`${side}Package`].localeCompare(b[`${side}Package`])
      })
      sorted.forEach((edge, index) => ports.set(edge, { count: group.length, index }))
    }
    for (const group of Map.groupBy(edges, edge => edge[side]).values()) {
      // Cycle cards in the same column share a gutter. Longer vertical stems
      // go farther out so shorter stems do not cross them when leaving a card.
      const sorted = group.toSorted((a, b) => {
        const [ax, ay] = center(a, side), [bx, by] = center(b, side)
        return ax - bx || ay - by || portOffset(ports.get(a)) - portOffset(ports.get(b))
      })
      sorted.forEach((edge, index) => {
        const lane = index / Math.max(1, group.length - 1)
        ports.get(edge).lane = side === 'from' ? 1 - lane : lane
      })
    }
    return ports
  }
  const fromPorts = ranks('from', 'to')
  const toPorts = ranks('to', 'from', edge => {
    const port = importPort(boxes.get(edge.from), edge.fromPackage, false, fromPorts.get(edge))
    // Expanded-cycle routes approach from their column gutters, which need
    // not have the same left-to-right order as the source cards' centers.
    return [port.at(-1)[0], port[0][1]]
  })
  const routes = edges.map(edge => {
    const from = boxes.get(edge.from), to = boxes.get(edge.to)
    const start = importPort(from, edge.fromPackage, false, fromPorts.get(edge))
    const end = importPort(to, edge.toPackage, true, toPorts.get(edge))
    return { edge, end, start, rowBottom: from.rowBottom, x1: start.at(-1)[0], x2: edge.bypassLane ?? end.at(-1)[0] }
  })
  for (const row of Map.groupBy(routes, route => route.rowBottom).values()) {
    // Outer branches turn first. This keeps each fan's horizontal segments
    // clear of the inner branches' vertical stems on both sides of a card.
    for (const left of [true, false]) {
      const fan = row.filter(route => (route.x2 < route.x1) === left)
        .toSorted((a, b) => (left ? 1 : -1) * (a.x1 - b.x1 || a.x2 - b.x2))
      fan.forEach((route, index) => { route.bendY = route.rowBottom + 9 + 12 * index / Math.max(1, fan.length - 1) })
    }
  }
  return routes.map(({ edge, end, start, x1, x2, bendY }) => {
    // Only turn below the tallest group. Shortcuts go around intervening rows
    // before entering the destination gutter; cycle ports still name a card.
    const middle = [[x1, bendY], [x2, bendY]]
    const { bypassLane, ...connection } = edge
    if (bypassLane !== null) middle.push([x2, end.at(-1)[1]])
    return { ...connection, path: roundedPath([...start, ...middle, ...end.toReversed()]) }
  })
}

function cycleImportPath(a, b) {
  const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y)
  const h = WHY_CARD_HEIGHT, w = WHY_CARD_WIDTH
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
export function layoutWhyGroup(id, members, imports, maxWidth = 1184, collapsed = false) {
  if (collapsed) return { id, members, collapsed, packages: [], internalEdges: [], width: WHY_CARD_WIDTH + padding * 2, height: WHY_CARD_HEIGHT }
  const cyclic = members.length > 1
  const capacity = Math.max(1, Math.floor((maxWidth - padding * 2 + gapX) / (WHY_CARD_WIDTH + gapX)))
  const cols = cyclic ? Math.min(capacity, Math.max(2, Math.ceil(Math.sqrt(members.length / 2)))) : 1
  const pad = cyclic ? padding : 0, rows = Math.ceil(members.length / cols), top = cyclic ? heading : 0
  const placement = cyclic ? placeWhyCycle(members, imports, cols) : [{ id: members[0], col: 0, row: 0 }]
  const packages = placement.map(node => ({ id: node.id,
    x: pad + node.col * (WHY_CARD_WIDTH + gapX), y: pad + top + node.row * (WHY_CARD_HEIGHT + gapY) }))
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
    width: cols * WHY_CARD_WIDTH + (cols - 1) * gapX + pad * 2,
    height: rows * WHY_CARD_HEIGHT + (rows - 1) * gapY + pad * 2 + top }
}
