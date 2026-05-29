// Tree-walking finding counters + anchor IDs for the Files tab and
// the graph data-prep stage. Kept out of `graph/` (which holds only
// graph-rendering code) because none of these run in the graph's
// lazy chain: the count helpers run in the main bundle to assemble
// the `prep` object `attachGraphLayout` hands to the lazy graph
// module, and `treeAnchor` is the Files tab's in-page anchor ID
// generator (render-files.js tree cards + events.js scroll-to-file).

import { SEVERITIES } from './format.js'

// File path → in-page anchor id. Replaces every non-word char with
// an underscore so paths with `/` `.` `@` (node_modules / scoped
// packages) produce valid id attributes.
export function treeAnchor(file) {
  return 'tree-' + file.replaceAll(/[^\w-]+/gu, '_')
}

// Empty per-file counts seed used by both computeFindingCountsByFile
// and computeTransitiveCounts so tier additions only have to land in
// `SEVERITIES` (format.js).
const emptyCounts = () => Object.fromEntries(SEVERITIES.map((s) => [s, 0]))

// file → { critical, high, medium, low, … } finding-count map. Used
// by both the tree cards and the force-directed visualization to
// surface findings density per file at a glance. Counts INDIVIDUAL
// findings (not groups) so the numbers match the per-file stats a
// user would otherwise scan in the findings view.
export function computeFindingCountsByFile(allGroups) {
  const counts = new Map()
  for (const g of allGroups) {
    for (const f of g) {
      if (!counts.has(f.file)) counts.set(f.file, emptyCounts())
      const c = counts.get(f.file)
      if (c[f.severity] !== undefined) c[f.severity]++
    }
  }
  return counts
}

// Combine the per-report tree blobs from a workspace into a single
// unified file → {imports, size, …} map. Each report carries its
// own analyzer-emitted tree; workspace-level views (graph canvas,
// Files tab) want the union so every report's files and import
// edges are represented, not just the first. Files that appear in
// more than one report merge their imports lists (deduped); the
// first report wins on other entry fields, with later reports
// back-filling a missing `size`. Findings already merge across
// reports via `getMergedGroups()` (group.js — union-finds groups
// bound by cross-report dedup hints in state.workspaceMerges) —
// this is the matching merge on the tree side. Returns null when no
// report carries tree data so callers fall back to a tree-less layout.
export function mergeReportsTree(reports) {
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

// Transitive subtree finding counts: for each file, sum of own
// counts across every file reachable through its `imports`
// (recursively), excluding the file itself. Cycles handled by a
// visited set.
export function computeTransitiveCounts(tree, ownCounts) {
  const transitive = new Map()
  for (const file of Object.keys(tree)) {
    const visited = new Set()
    const stack = [...((tree[file].imports ?? []).filter((i) => tree[i]))]
    while (stack.length > 0) {
      const dep = stack.pop()
      if (visited.has(dep)) continue
      visited.add(dep)
      for (const next of (tree[dep]?.imports ?? [])) if (tree[next]) stack.push(next)
    }
    const sum = emptyCounts()
    for (const f of visited) {
      const c = ownCounts.get(f)
      if (c) for (const k of SEVERITIES) sum[k] += c[k] ?? 0
    }
    transitive.set(file, sum)
  }
  return transitive
}

// Has-issues predicate: own findings OR something in its subtree
// has findings. Used to filter out clean files when graph2.showAll
// is off.
export function fileHasFindings(file, ownCounts, transitiveCounts) {
  const own = ownCounts.get(file)
  const tr = transitiveCounts.get(file)
  return totalFindings(own) > 0 || totalFindings(tr) > 0
}

export function totalFindings(counts) {
  if (!counts) return 0
  let total = 0
  for (const k of SEVERITIES) total += counts[k] ?? 0
  return total
}
