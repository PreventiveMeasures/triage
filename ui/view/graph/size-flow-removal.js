// Call `visit(i)` for each set bit i of a 32-bit mask, lowest first.
export function eachBit(mask, visit) {
  for (let bits = mask; bits; bits &= bits - 1) visit(31 - Math.clz32(bits & -bits))
}

// The member files of the flow's rows (`rows`: id → { files }), indexed:
// `paths[i]`, its row's index `groups[i]`, and `next[i]` the members it links to.
export function memberGraph(links, rows) {
  const ids = [...rows.keys()]
  const groupOf = new Map()
  ids.forEach((id, group) => { for (const file of rows.get(id).files) groupOf.set(file, group) })
  const paths = [...groupOf.keys()]
  const index = new Map(paths.map((file, i) => [file, i]))
  return { ids, paths, index, groups: paths.map(file => groupOf.get(file)), next: paths.map(file => [...links.get(file)].map(to => index.get(to))) }
}

// Spread each member's `reached` bits along `next`, kept to `allowed` bits
// (every bit when omitted), until nothing changes. Masks only grow, so
// cycles settle without condensation. The queue is circular and holds each
// member at most once.
export function maskSpreader(next) {
  const queue = new Int32Array(next.length), queued = new Uint8Array(next.length)
  return (reached, starts, allowed = null) => {
    let head = 0, pending = 0, tail = 0
    const enqueue = i => {
      if (queued[i]) return
      queued[i] = 1; queue[tail] = i; tail = (tail + 1) % queue.length; pending++
    }
    for (const i of starts) if (reached[i]) enqueue(i)
    while (pending > 0) {
      const from = queue[head]
      head = (head + 1) % queue.length; pending--; queued[from] = 0
      for (const to of next[from]) {
        const added = reached[from] & (allowed ? allowed[to] : -1) & ~reached[to]
        if (!added) continue
        reached[to] |= added; enqueue(to)
      }
    }
  }
}

// Simulate deleting each displayed file/package from the original file graph.
// One bit per deletion lets 32 simulations share a traversal. Keep only the
// current batch's reachability, not a files × packages matrix or closure sets.
// `run(visit)` calls `visit(base, mask, reached)` per batch: bit b of
// `reached[i]` is set when `paths[i]` stays reachable from the roots once row
// `base + b` is deleted.
function removalSimulation(links, roots, rows) {
  const { ids, paths, index, groups, next } = memberGraph(links, rows)
  const starts = roots.map(file => index.get(file))
  const allowed = new Int32Array(paths.length), reached = new Int32Array(paths.length)
  const spread = maskSpreader(next)
  const run = visit => {
    for (let base = 0; base < ids.length; base += 32) {
      const count = Math.min(32, ids.length - base), mask = count === 32 ? -1 : (1 << count) - 1
      reached.fill(0)
      for (let i = 0; i < paths.length; i++) {
        const bit = groups[i] - base
        allowed[i] = bit >= 0 && bit < count ? mask & ~(1 << bit) : mask
      }
      for (const i of starts) reached[i] = allowed[i]
      spread(reached, starts, allowed)
      visit(base, mask, reached)
    }
  }
  return { ids, paths, groups, run }
}

// Bytes each deletion removes. Grouping loss masks avoids summing each
// descendant separately for every ancestor in deep chains.
export function removalSizes(files, links, roots, rows) {
  const { ids, paths, run } = removalSimulation(links, roots, rows)
  const weights = paths.map(file => {
    const node = files.get(file)
    return { size: Number.isFinite(node.size) && node.size >= 0 ? node.size : 0,
      missing: Number(!node.virtual && node.size == null) }
  })
  const totals = ids.map(() => ({ removable: 0, removableMissing: 0 }))
  run((base, mask, reached) => {
    const losses = new Map()
    for (let i = 0; i < paths.length; i++) {
      const lost = mask & ~reached[i]
      if (!lost) continue
      let total = losses.get(lost)
      if (!total) { total = { size: 0, missing: 0 }; losses.set(lost, total) }
      total.size += weights[i].size; total.missing += weights[i].missing
    }
    for (const [lost, total] of losses) {
      eachBit(lost, bit => { totals[base + bit].removable += total.size; totals[base + bit].removableMissing += total.missing })
    }
  })
  ids.forEach((id, i) => Object.assign(rows.get(id), totals[i]))
}

// Rows each deletion removes, the deleted one included: a row is gone once
// none of its files (a package's files, or a lockfile's copies of it) stays
// reachable. A row still reached through any one member stays.
export function removalCounts(links, roots, rows) {
  const { ids, paths, groups, run } = removalSimulation(links, roots, rows)
  const counts = ids.map(() => 0), lost = new Int32Array(ids.length)
  run((base, mask, reached) => {
    lost.fill(mask)
    for (let i = 0; i < paths.length; i++) lost[groups[i]] &= ~reached[i]
    for (const gone of lost) eachBit(gone, bit => { counts[base + bit]++ })
  })
  ids.forEach((id, i) => Object.assign(rows.get(id), { removable: counts[i], removableMissing: 0 }))
}
