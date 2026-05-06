import { packageOf, pkgColor, totalFindings } from '../graph/utils.js'
import { SEVERITY_ORDER, SEVERITIES } from '../format.js'

// Map a per-file own-counts object to the four-tier issue bucket the
// v2 chrome speaks. The chrome's severity rows (critical/high/medium/
// low) don't carry slots for high_bug / bug / informational — folding
// the bug tiers into the closest vuln tier preserves the visual
// signal (a file with a bug still gets a ring) without inventing two
// new chrome rows. high_bug → high, bug → medium, informational → low.
// Returns the highest-severity tier present, or null when clean.
export function topIssueOf(counts) {
  if (!counts) return null
  const map = { critical: 'critical', high: 'high', high_bug: 'high', medium: 'medium', bug: 'medium', low: 'low', informational: 'low' }
  let best = null, bestRank = -1
  for (const sev of SEVERITIES) {
    if ((counts[sev] ?? 0) === 0) continue
    const rank = SEVERITY_ORDER[sev]
    if (rank > bestRank) { bestRank = rank; best = map[sev] ?? sev }
  }
  return best
}

// Short summary text for the selection card / tooltip — "3 critical
// · 1 high" etc. Skips zero-count tiers and drops the bug / info
// tiers into the same fold-down map as topIssueOf so the strings
// match the bucket the visualization paints.
export function issueSummary(counts) {
  if (!counts) return ''
  const buckets = { critical: 0, high: 0, medium: 0, low: 0 }
  const map = { critical: 'critical', high: 'high', high_bug: 'high', medium: 'medium', bug: 'medium', low: 'low', informational: 'low' }
  for (const sev of SEVERITIES) buckets[map[sev]] += counts[sev] ?? 0
  return ['critical', 'high', 'medium', 'low']
    .filter((s) => buckets[s] > 0)
    .map((s) => `${buckets[s]} ${s}`)
    .join(' · ')
}

// Build the full v2 graph data structure from a treeData blob and
// per-file own-counts map. Filters to files that actually have a
// tree entry. Returns: files (string[]), packages (string[] sorted
// by node count desc), pkgIndex (pkg → index), nodes (one per file),
// edges (intra/cross), adj (file → edge index list), ambassadors
// (file paths flagged as hubs). Side-effect free; all positions
// written into nodes by the caller's layout pass.
export function buildGraph(treeData, files, ownCounts) {
  const fileSet = new Set(files)
  const importsOf = new Map()
  const importedBy = new Map()
  for (const f of files) {
    const imps = (treeData[f].imports ?? []).filter((i) => fileSet.has(i))
    importsOf.set(f, imps)
    for (const imp of imps) {
      if (!importedBy.has(imp)) importedBy.set(imp, [])
      importedBy.get(imp).push(f)
    }
  }

  // Node objects: position seeded to 0,0 (layoutSpiral/Radial/Grid
  // overwrite). issue / issueText derived from ownCounts so the same
  // map drives the canvas rings, the severity row counts, and the
  // tooltip text — single source of truth.
  const nodes = files.map((file) => {
    const own = ownCounts.get(file)
    const totalIssues = totalFindings(own)
    const pkg = packageOf(file) ?? '__own__'
    const issue = topIssueOf(own)
    const issueText = issue ? issueSummary(own) : ''
    return {
      id: file,
      file,
      pkg,
      x: 0, y: 0,
      deg: 0,
      issue,
      issueText,
      totalIssues,
      isHub: false,
      label: file.split('/').pop() ?? file,
    }
  })
  const nodeByFile = new Map(nodes.map((n) => [n.file, n]))

  // Edges: build once over the imports relation. `cross` is true
  // when the two endpoints belong to different packages — that's the
  // axis the topbar's edge segmented control uses to filter the
  // canvas. Edge direction (lo → hi) is normalized so the same pair
  // doesn't appear twice when both sides import each other; bidi
  // links collapse to a single record (the canvas doesn't draw
  // arrows in v2 so direction doesn't matter for rendering, only the
  // cross/intra classification).
  const edges = []
  const seen = new Set()
  for (const f of files) {
    for (const imp of importsOf.get(f) ?? []) {
      const [lo, hi] = f < imp ? [f, imp] : [imp, f]
      const k = `${lo}\0${hi}`
      if (seen.has(k)) continue
      seen.add(k)
      const a = nodeByFile.get(lo), b = nodeByFile.get(hi)
      if (!a || !b) continue
      edges.push({ a: lo, b: hi, cross: a.pkg !== b.pkg })
      a.deg++; b.deg++
    }
  }

  // adjacency map: file → edge indices. Used by selection rendering
  // (find neighbors) and hover-edge dimming on the canvas. Map
  // instead of plain object so file paths with dots don't trip up
  // property semantics.
  const adj = new Map()
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    if (!adj.has(e.a)) adj.set(e.a, [])
    if (!adj.has(e.b)) adj.set(e.b, [])
    adj.get(e.a).push(i)
    adj.get(e.b).push(i)
  }

  // Packages sorted by file count descending. The palette grid and
  // distribution bar both walk this list so they read in matching
  // order (most populous first); the legend chip in selection card
  // looks up by name so order there is irrelevant.
  const pkgCount = new Map()
  for (const n of nodes) pkgCount.set(n.pkg, (pkgCount.get(n.pkg) ?? 0) + 1)
  const packages = [...pkgCount.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)

  // Hubs = top-degree node per package, plus any second node that
  // also lands in the package's degree-top-third. Bounded to keep
  // small graphs from flagging every node as a hub. Mirrors the v2
  // design's "ambassador" concept (load-bearing nodes in a cluster);
  // we use it to drive halos + the hub-highlight toggle.
  const byPkg = new Map()
  for (const n of nodes) {
    if (!byPkg.has(n.pkg)) byPkg.set(n.pkg, [])
    byPkg.get(n.pkg).push(n)
  }
  for (const [, list] of byPkg) {
    list.sort((a, b) => b.deg - a.deg)
    const limit = Math.max(1, Math.min(3, Math.ceil(list.length / 4)))
    for (let i = 0; i < Math.min(limit, list.length); i++) {
      if (list[i].deg > 0) list[i].isHub = true
    }
  }

  return {
    files, nodes, nodeByFile, edges, adj,
    importsOf, importedBy, packages, pkgCount,
  }
}

// Color helper — re-export so callers don't have to know about
// graph/utils.js's two-arg form when they already have a node.
export function nodeColor(n) {
  return pkgColor(n.pkg)
}
