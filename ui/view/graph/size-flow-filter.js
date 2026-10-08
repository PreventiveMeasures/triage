import { stronglyConnected } from './matrix-model.js'

// Preserve one real entry-point path to every retained file/package. The
// file-level BFS supplies short witness paths; removing a redundant importer
// must never remove the last path to a significant dependency.
//
// Package members can have different parents, even in other packages. Keep
// all those witness paths when retaining a package. Their grouped parent
// links can form cycles, so propagate maxima through the condensed DAG.
// This is O(files + links + packages), with no per-threshold graph traversal.
export function filterSizes(rows, parents, idOf) {
  const links = new Map([...rows.keys()].map(id => [id, new Set()]))
  for (const [file, parent] of parents) {
    const child = idOf(file), from = idOf(parent)
    if (child !== from) links.get(child).add(from)
  }
  const { groups, componentOf } = stronglyConnected([...rows.keys()], links)
  const sizes = groups.map(group => group.reduce((max, id) => {
    const node = rows.get(id)
    return Math.max(max, node.own, node.removable)
  }, 0))
  const incoming = groups.map(() => 0), next = groups.map(() => new Set())
  for (const [child, ancestors] of links) { for (const parent of ancestors) {
    const a = componentOf.get(child), b = componentOf.get(parent)
    if (a !== b && !next[a].has(b)) { next[a].add(b); incoming[b]++ }
  } }
  const queue = []
  incoming.forEach((count, i) => { if (!count) queue.push(i) })
  for (const child of queue) { for (const parent of next[child]) {
    sizes[parent] = Math.max(sizes[parent], sizes[child])
    if (--incoming[parent] === 0) queue.push(parent)
  } }
  for (const [id, node] of rows) node.filterSize = sizes[componentOf.get(id)]
}
