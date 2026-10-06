import { orderCyclicGroup } from './graph/matrix-order.js'

function clusteredOrder(ids, neighbors) {
  const ranked = new Map(ids.map(id => [id, [...neighbors.get(id)].map(([to, weight]) => {
    const a = neighbors.get(id), b = neighbors.get(to), small = a.size < b.size ? a : b
    let overlap = 0, steps = 0
    for (const shared of small.keys()) {
      if (a.has(shared) && b.has(shared)) overlap++
      if (++steps === 32) break
    }
    return { to, score: weight * 2 + overlap }
  }).toSorted((a, b) => b.score - a.score || neighbors.get(a.to).size - neighbors.get(b.to).size || a.to.localeCompare(b.to))]))
  const order = [], seen = new Set()
  for (const start of ids) {
    const stack = [start]
    while (stack.length > 0) {
      const id = stack.pop()
      if (seen.has(id)) continue
      seen.add(id); order.push(id)
      for (const { to } of ranked.get(id).toReversed()) if (!seen.has(to)) stack.push(to)
    }
  }
  return order
}

// Start with the graph's dependency order, then keep connected packages close
// on the grid. Bounded local swaps avoid an all-pairs force simulation for big
// cycles; only the edges touching the two swapped packages need re-scoring.
export function placeWhyCycle(members, imports, cols) {
  const ids = members.toSorted(), known = new Set(ids)
  const cells = new Map(), neighbors = new Map(ids.map(id => [id, new Map()]))
  for (const from of ids) {
    cells.set(from, new Map())
    for (const to of imports.get(from) ?? []) {
      if (from === to || !known.has(to)) continue
      cells.get(from).set(to, { to, count: 1 })
      neighbors.get(from).set(to, (neighbors.get(from).get(to) ?? 0) + 1)
      neighbors.get(to).set(from, (neighbors.get(to).get(from) ?? 0) + 1)
    }
  }
  const ordered = orderCyclicGroup(ids, cells)
  const slots = ids.map((_, i) => ({ col: i % cols, row: Math.floor(i / cols) }))
  const snake = slots.map(({ col, row }) => ({ col: row % 2 ? cols - col - 1 : col, row }))
  const distance = (a, b) => Math.abs(a.col - b.col) + Math.abs(a.row - b.row)
  const score = positions => ids.reduce((sum, id) => sum + [...neighbors.get(id)].reduce((s, [to, weight]) => s + weight * distance(positions.get(id), positions.get(to)), 0), 0)
  let positions = new Map(ids.map((id, i) => [id, slots[i]]))
  let best = score(positions)
  for (const order of [ordered, clusteredOrder(ids, neighbors)]) {for (const grid of [slots, snake]) {
    const candidate = new Map(order.map((id, i) => [id, grid[i]])), next = score(candidate)
    if (next < best) { positions = candidate; best = next }
  }}
  const key = ({ col, row }) => `${col},${row}`
  const occupant = new Map([...positions].map(([id, slot]) => [key(slot), id]))
  const cost = (id, at, other, otherAt) => {
    let value = 0
    for (const [to, weight] of neighbors.get(id)) value += weight * distance(at, to === other ? otherAt : positions.get(to))
    return value
  }
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    for (const id of ids) {
      const at = positions.get(id), connected = neighbors.get(id)
      let col = 0, row = 0, weightSum = 0
      for (const [to, weight] of connected) {
        col += positions.get(to).col * weight; row += positions.get(to).row * weight; weightSum += weight
      }
      if (!weightSum) continue
      const candidates = new Set()
      for (const center of [at, { col: Math.round(col / weightSum), row: Math.round(row / weightSum) }]) {
        for (let dx = -1; dx <= 1; dx++) {for (let dy = -1; dy <= 1; dy++) {
          const peer = occupant.get(`${center.col + dx},${center.row + dy}`)
          if (peer !== undefined && peer !== id) candidates.add(peer)
        }}
      }
      let improvement = 0, swap = null
      for (const peer of candidates) {
        const there = positions.get(peer)
        const delta = cost(id, there, peer, at) + cost(peer, at, id, there) - cost(id, at, peer, there) - cost(peer, there, id, at)
        if (delta < improvement) { improvement = delta; swap = peer }
      }
      if (swap !== null) {
        const there = positions.get(swap)
        positions.set(id, there); positions.set(swap, at)
        occupant.set(key(there), id); occupant.set(key(at), swap); changed = true
      }
    }
    if (!changed) break
  }
  return ids.map(id => ({ id, ...positions.get(id) })).toSorted((a, b) => a.row - b.row || a.col - b.col)
}
