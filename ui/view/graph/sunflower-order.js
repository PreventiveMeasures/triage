// Improve a sunflower's assignment, never its geometry. Every accepted swap
// reduces the sum of Euclidean lengths of the drawn (undirected) edges. Groups
// preserve disks, priority tiers and hub/member bands; edges to other groups
// still contribute to cost. Degree ordering only seeds each group's assignment.
//
// Try slots near each node's neighbour centroid plus a deterministic spread of
// other slots. The centroid proposes candidates; the acceptance test uses edge
// lengths, not squared distances or distance to that centroid. Limit both slot
// searches and edge visits so dense/large graphs cannot start an unbounded
// all-pairs search. Storage is O(nodes + edges), with no distance matrix.
const NEAR = 12, PASSES = 8, SCATTERED = 12
const MAX_EDGE_VISITS = 8_000_000, MAX_SLOT_VISITS = 8_000_000

export function optimizeSunflowerOrder(graph, groups) {
  const nodes = graph.nodes
  if (nodes.length < 2 || graph.edges.length === 0) return
  const index = new Map(nodes.map((node, i) => [node.file, i]))
  const xs = Float64Array.from(nodes, node => node.x), ys = Float64Array.from(nodes, node => node.y)
  const nodeAtSlot = Int32Array.from(nodes, (_, i) => i), slotOfNode = nodeAtSlot.slice()
  const adjacent = Array.from(nodes, () => [])
  for (const edge of graph.edges) {
    const a = index.get(edge.a), b = index.get(edge.b)
    if (a === undefined || b === undefined || a === b) continue
    adjacent[a].push(b); adjacent[b].push(a)
  }
  const slotGroups = groups.map(group => group.map(node => index.get(node.file))).filter(group => group.length > 1)
  const candidates = new Int32Array(NEAR + SCATTERED), nearestDistances = new Float64Array(NEAR)
  let edgeVisits = 0, seed = 0x6d2b79f5, slotVisits = 0
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  const distance = (a, b) => {
    const dx = xs[a] - xs[b], dy = ys[a] - ys[b]
    return Math.sqrt(dx * dx + dy * dy)
  }

  passes: for (let pass = 0; pass < PASSES; pass++) {
    let improved = false
    for (const group of slotGroups) {
      for (let i = 0; i < group.length; i++) {
        // Alternate direction so the same end of a disk does not always move
        // first. Isolated nodes can still trade places as the other endpoint.
        const a = group[pass % 2 ? group.length - i - 1 : i]
        if (adjacent[a].length === 0) continue
        if (slotVisits + group.length > MAX_SLOT_VISITS) break passes
        slotVisits += group.length
        const sa = slotOfNode[a]
        let bx = 0, by = 0
        for (const b of adjacent[a]) { bx += xs[slotOfNode[b]]; by += ys[slotOfNode[b]] }
        bx /= adjacent[a].length; by /= adjacent[a].length

        let count = 0
        if (group.length <= candidates.length) {
          for (const slot of group) candidates[count++] = slot
        } else {
          // Keep only the nearest slots, reusing scratch arrays instead of
          // allocating/sorting a candidate list for every node on every pass.
          for (const slot of group) {
            const dx = xs[slot] - bx, dy = ys[slot] - by
            const d = dx * dx + dy * dy
            if (count === NEAR && d >= nearestDistances[count - 1]) continue
            let j = Math.min(count, NEAR - 1)
            while (j > 0 && d < nearestDistances[j - 1]) {
              candidates[j] = candidates[j - 1]; nearestDistances[j] = nearestDistances[j - 1]; j--
            }
            candidates[j] = slot; nearestDistances[j] = d
            if (count < NEAR) count++
          }
          for (let j = 0; j < SCATTERED; j++) candidates[count++] = group[random() % group.length]
        }

        let best = -1, bestDelta = -1e-7, exhausted = false
        for (let j = 0; j < count; j++) {
          const sb = candidates[j]
          const b = nodeAtSlot[sb]
          if (a === b) continue
          const work = adjacent[a].length + adjacent[b].length
          if (edgeVisits + work > MAX_EDGE_VISITS) { exhausted = true; break }
          edgeVisits += work
          // Only incident edges change. The a–b edge keeps the same length
          // under a swap, so omit it from both sums (as well as self-loops).
          let delta = 0
          for (const c of adjacent[a]) if (c !== b) delta += distance(sb, slotOfNode[c]) - distance(sa, slotOfNode[c])
          for (const c of adjacent[b]) if (c !== a) delta += distance(sa, slotOfNode[c]) - distance(sb, slotOfNode[c])
          if (delta < bestDelta) { best = b; bestDelta = delta }
        }
        if (best !== -1) {
          const sb = slotOfNode[best]
          slotOfNode[a] = sb; slotOfNode[best] = sa; nodeAtSlot[sa] = best; nodeAtSlot[sb] = a
          improved = true
        }
        if (exhausted) break passes
      }
    }
    if (!improved) break
  }
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].x = xs[slotOfNode[i]]; nodes[i].y = ys[slotOfNode[i]]
  }
}
