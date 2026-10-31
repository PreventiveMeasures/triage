// Simulate deleting each displayed file/package from the original file graph.
// One bit per deletion lets 32 simulations share a traversal. Keep only the
// current batch's reachability, not a files × packages matrix or closure sets.
// Cycles need no special treatment or condensation. `run(visit)` calls
// `visit(base, mask, reached)` per batch: bit b of `reached[i]` is set when
// `paths[i]` stays reachable from the roots once row `base + b` is deleted.
function removalSimulation(links, roots, rows) {
  const ids = [...rows.keys()]
  const groupOf = new Map()
  ids.forEach((id, group) => { for (const file of rows.get(id).files) groupOf.set(file, group) })
  const paths = [...groupOf.keys()]
  const index = new Map(paths.map((file, i) => [file, i]))
  const groups = paths.map(file => groupOf.get(file))
  const next = paths.map(file => [...links.get(file)].map(to => index.get(to)))
  const starts = roots.map(file => index.get(file))
  const allowed = new Int32Array(paths.length), reached = new Int32Array(paths.length)
  const queue = new Int32Array(paths.length), queued = new Uint8Array(paths.length)
  const run = visit => {
    for (let base = 0; base < ids.length; base += 32) {
      const count = Math.min(32, ids.length - base), mask = count === 32 ? -1 : (1 << count) - 1
      reached.fill(0); queued.fill(0)
      for (let i = 0; i < paths.length; i++) {
        const bit = groups[i] - base
        allowed[i] = bit >= 0 && bit < count ? mask & ~(1 << bit) : mask
      }
      let head = 0, pending = 0, tail = 0
      const enqueue = i => {
        if (queued[i]) return
        queued[i] = 1; queue[tail] = i; tail = (tail + 1) % queue.length; pending++
      }
      for (const i of starts) {
        reached[i] = allowed[i]
        if (reached[i]) enqueue(i)
      }
      while (pending > 0) {
        const from = queue[head]
        head = (head + 1) % queue.length; pending--; queued[from] = 0
        for (const to of next[from]) {
          const added = reached[from] & allowed[to] & ~reached[to]
          if (!added) continue
          reached[to] |= added; enqueue(to)
        }
      }
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
      for (let bits = lost; bits; bits &= bits - 1) {
        const group = base + 31 - Math.clz32(bits & -bits)
        totals[group].removable += total.size; totals[group].removableMissing += total.missing
      }
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
    for (const gone of lost) {
      for (let bits = gone; bits; bits &= bits - 1) counts[base + 31 - Math.clz32(bits & -bits)]++
    }
  })
  ids.forEach((id, i) => Object.assign(rows.get(id), { removable: counts[i], removableMissing: 0 }))
}
