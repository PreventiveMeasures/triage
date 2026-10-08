// Count exact reachable bytes for many overlapping DAG closures without
// retaining a quadratic matrix of per-node reachable sets. One bit represents
// one component in the current batch; unions propagate in reverse topological
// order. Equal masks share their weighted sum, which is common in chains and
// diamonds. Working memory remains proportional to the graph.
export function batchedReachability(next, order, weights, unknown, remaining) {
  const masks = new Int32Array(next.length)
  const totals = remaining.map(() => ({ size: 0, missing: 0 }))
  for (let base = 0; base < next.length; base += 32) {
    const count = Math.min(32, next.length - base)
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i]
      const bit = id - base
      let mask = bit >= 0 && bit < count ? 1 << bit : 0
      for (const child of next[id]) mask |= masks[child]
      masks[id] = mask
    }
    const sums = new Map()
    for (let i = 0; i < remaining.length; i++) {
      const mask = masks[remaining[i]]
      if (!mask) continue
      let sum = sums.get(mask)
      if (!sum) {
        sum = { size: 0, missing: 0 }
        for (let bits = mask; bits; bits &= bits - 1) {
          const id = base + 31 - Math.clz32(bits & -bits)
          sum.size += weights[id]; sum.missing += unknown[id]
        }
        sums.set(mask, sum)
      }
      totals[i].size += sum.size; totals[i].missing += sum.missing
    }
  }
  return remaining.map((id, i) => [id, totals[i]])
}
