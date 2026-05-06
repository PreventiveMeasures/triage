import { packageOf, pkgColor, totalFindings } from '../graph/utils.js'
import { SEVERITIES } from '../format.js'
import { graph2 } from './state.js'

// Top-severity tier for a per-file count map. Walks SEVERITIES
// (already in highest-to-lowest order in format.js) and returns
// the first tier with a non-zero count, or null when clean.
// Returns the FULL 7-tier set the findings tab uses (critical,
// high, medium, low, high_bug, bug, informational) — earlier
// versions collapsed bug / info tiers into the closest vuln
// tier, but that hid information; the topbar pill row now
// shows all seven so the canvas should reflect them too.
export function topIssueOf(counts) {
  if (!counts) return null
  for (const sev of SEVERITIES) {
    if ((counts[sev] ?? 0) > 0) return sev
  }
  return null
}

// Build the full v2 graph data structure from a treeData blob and
// per-file own-counts map. Filters to files that actually have a
// tree entry. Returns: files (string[]), packages (string[] sorted
// by node count desc), pkgIndex (pkg → index), nodes (one per file),
// edges (intra/cross), adj (file → edge index list), ambassadors
// (file paths flagged as hubs). Side-effect free; all positions
// written into nodes by the caller's layout pass.
export function buildGraph(treeData, files, ownCounts, transitiveCounts) {
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
  // overwrite). own / subtree carry the FULL per-severity count
  // maps so the selection card and tooltip can render v1-style
  // chips ("4 MEDIUM" / "5 LOW") without re-deriving them; `issue`
  // and `totalIssues` are still derived for the canvas's severity
  // ring + visibility predicate, so all three views (canvas
  // ring, side-panel chips, tooltip chips) read from the same
  // ownCounts source.
  const nodes = files.map((file) => {
    const own = ownCounts.get(file)
    const subtree = transitiveCounts?.get(file) ?? null
    const totalIssues = totalFindings(own)
    const pkg = packageOf(file) ?? '__own__'
    const issue = topIssueOf(own)
    return {
      id: file,
      file,
      pkg,
      x: 0, y: 0,
      deg: 0,
      issue,
      totalIssues,
      own,
      subtree,
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
  const edgeMap = new Map()
  for (const f of files) {
    for (const imp of importsOf.get(f) ?? []) {
      const [lo, hi] = f < imp ? [f, imp] : [imp, f]
      const k = `${lo}\0${hi}`
      let edge = edgeMap.get(k)
      if (!edge) {
        const a = nodeByFile.get(lo), b = nodeByFile.get(hi)
        if (!a || !b) continue
        edge = { a: lo, b: hi, cross: a.pkg !== b.pkg, fromLo: false, fromHi: false }
        edgeMap.set(k, edge)
        a.deg++; b.deg++
      }
      // Track which endpoint(s) actually originate the import.
      // Both flags true = bidirectional (rare across packages, more
      // common within one). The Package-graph view uses these to
      // draw arrowheads; the spiral view ignores them.
      if (f === lo) edge.fromLo = true
      else edge.fromHi = true
    }
  }
  const edges = [...edgeMap.values()]

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

  // Packages-by-name lookup for the hub pass below.
  const byPkg = new Map()
  for (const n of nodes) {
    if (!byPkg.has(n.pkg)) byPkg.set(n.pkg, [])
    byPkg.get(n.pkg).push(n)
  }

  const graph = {
    files, nodes, nodeByFile, edges, adj,
    importsOf, importedBy, packages, pkgCount, byPkg,
  }
  assignHubs(graph, graph2.hubMode)
  return graph
}

// Hub assignment — split out so the topbar's hub-mode switch can
// recompute without rebuilding the whole graph (topology, layout,
// adjacency stays). Clears every node's `isHub` then re-runs the
// chosen strategy.
//
//   'top'   — top-degree file(s) per package, capped at min(3,
//             ceil(N/4)). Mirrors the v2 design's "ambassador"
//             concept; reads well when packages have a clear
//             internal lead.
//   'cross' — any file that's imported from a different package
//             OR not imported by anything at all (= not imported
//             from within its own package, since the cross case
//             is already covered). Picks out package entry
//             points: the public surface plus root files like
//             CLI mains that no internal file pulls in.
export function assignHubs(graph, mode) {
  for (const n of graph.nodes) n.isHub = false
  if (mode === 'cross') {
    // First pass: any file with an incoming cross-package edge.
    // The edge stores direction via fromLo / fromHi: if fromLo is
    // true the lo file imports hi (hi is the target), and vice
    // versa.
    for (const e of graph.edges) {
      if (!e.cross) continue
      if (e.fromLo) graph.nodeByFile.get(e.b).isHub = true
      if (e.fromHi) graph.nodeByFile.get(e.a).isHub = true
    }
    // Second pass: roots — files not imported by anyone. The
    // importedBy map is keyed only for files that have at least
    // one importer (built in buildGraph above), so a missing or
    // empty list means the file is a root.
    for (const n of graph.nodes) {
      const importers = graph.importedBy.get(n.file)
      if (!importers || importers.length === 0) n.isHub = true
    }
    return
  }
  // Default: top-degree per package, capped.
  for (const [, list] of graph.byPkg) {
    list.sort((a, b) => b.deg - a.deg)
    const limit = Math.max(1, Math.min(3, Math.ceil(list.length / 4)))
    for (let i = 0; i < Math.min(limit, list.length); i++) {
      if (list[i].deg > 0) list[i].isHub = true
    }
  }
}

// Color helper — re-export so callers don't have to know about
// graph/utils.js's two-arg form when they already have a node.
export function nodeColor(n) {
  return pkgColor(n.pkg)
}
