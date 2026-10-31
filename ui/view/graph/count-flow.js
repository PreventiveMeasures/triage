import { removalCounts } from './size-flow-removal.js'

// Package flow: the size flow weighed in packages rather than bytes. Each
// package counts once, however many files or installed copies it has, and
// counting runs on those members, never on links merged per package: a package
// is reached when one of its members is, so grouping never invents a path
// (a's copy 1 depending on b doesn't make a's copy 2 bring b along).

// For each source (a list of member indices), how many groups have a member it
// reaches, its own included. One bit per source lets 32 sources share a pass;
// masks only grow, so cycles settle without condensation.
function distinctReach(next, groups, groupCount, sources) {
  const counts = sources.map(() => 0)
  const groupMasks = new Int32Array(groupCount), reached = new Int32Array(next.length)
  const queue = new Int32Array(next.length), queued = new Uint8Array(next.length)
  for (let base = 0; base < sources.length; base += 32) {
    const count = Math.min(32, sources.length - base)
    reached.fill(0); queued.fill(0)
    let head = 0, pending = 0, tail = 0
    const enqueue = i => {
      if (queued[i]) return
      queued[i] = 1; queue[tail] = i; tail = (tail + 1) % queue.length; pending++
    }
    for (let bit = 0; bit < count; bit++) {
      for (const i of sources[base + bit]) { reached[i] |= 1 << bit; enqueue(i) }
    }
    while (pending > 0) {
      const from = queue[head]
      head = (head + 1) % queue.length; pending--; queued[from] = 0
      for (const to of next[from]) {
        const added = reached[from] & ~reached[to]
        if (!added) continue
        reached[to] |= added; enqueue(to)
      }
    }
    groupMasks.fill(0)
    for (let i = 0; i < next.length; i++) groupMasks[groups[i]] |= reached[i]
    for (const mask of groupMasks) {
      for (let bits = mask; bits; bits &= bits - 1) counts[base + 31 - Math.clz32(bits & -bits)]++
    }
  }
  return counts
}

// Package counts for the size flow's package rows and edges (buildSizeFlow):
//   own       — 1, the package itself
//   size      — packages reachable from its members: itself and its dependencies
//   removable — packages deleting it removes from every root, itself included
// and on each edge, `size`: the packages reachable from the members it leads
// to. Nothing goes missing as a byte size can, so the missing counts are 0.
export function packageCounts(links, roots, rows, edges) {
  const ids = [...rows.keys()], members = []
  const groupOf = new Map()
  ids.forEach((id, group) => { for (const file of rows.get(id).files) { groupOf.set(file, group); members.push(file) } })
  const index = new Map(members.map((file, i) => [file, i]))
  const next = members.map(file => [...links.get(file)].map(to => index.get(to)))
  const groups = members.map(file => groupOf.get(file))
  const sources = [...ids.map(id => rows.get(id).files), ...edges.map(edge => [...edge.targets])]
  const counts = distinctReach(next, groups, ids.length, sources.map(files => files.map(file => index.get(file))))
  ids.forEach((id, i) => Object.assign(rows.get(id), { own: 1, size: counts[i], missing: 0 }))
  edges.forEach((edge, i) => Object.assign(edge, { size: counts[ids.length + i], missing: 0 }))
  removalCounts(links, roots, rows)
}
