// Per-file finding counters and anchor IDs for the Files tab and the
// graph's data prep. Out of `graph/` because none of this runs in the
// graph's lazy chain: the counts assemble, in the main bundle, the `prep`
// that `attachGraphLayout` hands the lazy module.

import { SEVERITIES, displayedSeverity } from './format.js'

// File path → in-page anchor id, every non-word run an underscore (paths
// carry `/` `.` `@`). The Files tab's cards and events.js scroll to it.
export function treeAnchor(file) {
  return 'tree-' + file.replaceAll(/[^\w-]+/gu, '_')
}

const emptyCounts = () => Object.fromEntries(SEVERITIES.map((s) => [s, 0]))

// file → { critical, high, … }, counting INDIVIDUAL findings (not groups),
// as the per-file stats of the findings view would.
export function computeFindingCountsByFile(allGroups, mode) {
  const counts = new Map()
  for (const g of allGroups) {
    for (const f of g) {
      if (!counts.has(f.file)) counts.set(f.file, emptyCounts())
      const c = counts.get(f.file)
      const sev = displayedSeverity(f, mode)
      if (c[sev] !== undefined) c[sev]++
    }
  }
  return counts
}

// The loaded reports' trees as one file → { imports, size, … } map, so a
// workspace's graph and Files tab show every report's files and edges (the
// tree side of getMergedGroups' merge): imports union, deduped; the first
// report wins on other fields, later ones back-filling a missing `size`.
// Null when no report carries a tree.
//
// Kept by the trees it merged: render asks on every draw, and a report's
// tree never changes once ingested. Callers only read it.
let lastMerge = { trees: [], merged: null }
export function mergeReportsTree(reports) {
  const trees = reports.map((r) => r?.tree ?? null)
  if (trees.length === lastMerge.trees.length && trees.every((tree, i) => tree === lastMerge.trees[i])) return lastMerge.merged
  lastMerge = { trees, merged: mergeTrees(reports) }
  return lastMerge.merged
}

function mergeTrees(reports) {
  let merged = null
  for (const r of reports) {
    if (!r?.tree) continue
    if (!merged) merged = {}
    for (const file of Object.keys(r.tree)) {
      const entry = r.tree[file]
      if (!merged[file]) {
        merged[file] = { ...entry, imports: [...(entry.imports ?? [])] }
        continue
      }
      const seen = new Set(merged[file].imports)
      for (const imp of entry.imports ?? []) {
        if (!seen.has(imp)) { seen.add(imp); merged[file].imports.push(imp) }
      }
      if (merged[file].size == null && entry.size != null) merged[file].size = entry.size
    }
  }
  return merged
}

// For each finding-bearing file, walk its importers and add its counts once
// to every ancestor. Most files have no findings: walking outward from every
// file repeated the same reachability work tens of thousands of times.
// Numeric indices and visit stamps keep the traversal sparse without allocating
// a Set per walk. A cycle includes a file's own findings only when a non-empty
// import path reaches it again, matching the original forward traversal.
export function computeTransitiveCounts(tree, ownCounts) {
  const files = Object.keys(tree)
  const index = new Map(files.map((file, i) => [file, i]))
  const sums = files.map(() => emptyCounts())
  const importers = files.map(() => [])
  for (const [i, file] of files.entries()) {
    for (const target of tree[file].imports ?? []) {
      const to = index.get(target)
      if (to !== undefined) importers[to].push(i)
    }
  }
  const visited = new Uint32Array(files.length)
  let stamp = 0
  for (const [file, counts] of ownCounts) {
    const target = index.get(file)
    if (target === undefined || !counts) continue
    const values = SEVERITIES.map((severity) => [severity, counts[severity] ?? 0]).filter(([, value]) => value !== 0)
    if (values.length === 0) continue
    const currentStamp = ++stamp
    const stack = []
    const visit = (i) => {
      if (visited[i] !== currentStamp) { visited[i] = currentStamp; stack.push(i) }
    }
    for (const i of importers[target]) visit(i)
    while (stack.length > 0) {
      const i = stack.pop()
      for (const [severity, value] of values) sums[i][severity] += value
      for (const parent of importers[i]) visit(parent)
    }
  }
  return new Map(files.map((file, i) => [file, sums[i]]))
}

// Own findings, or some in its subtree: what keeps a file on the graph
// while `graph2.showAll` is off.
export function fileHasFindings(file, ownCounts, transitiveCounts) {
  return totalFindings(ownCounts.get(file)) > 0 || totalFindings(transitiveCounts.get(file)) > 0
}

export function totalFindings(counts) {
  return counts ? SEVERITIES.reduce((total, k) => total + (counts[k] ?? 0), 0) : 0
}
