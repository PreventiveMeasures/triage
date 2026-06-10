import { packageOf, pkgColor } from './utils.js'
import { totalFindings } from '../file-counts.js'
import { SEVERITIES, depsDirName } from '../format.js'

// Top-severity tier for a per-file count map. Walks SEVERITIES
// (highest-to-lowest order in format.js) and returns the first
// tier with a non-zero count, or null when clean. Reports the FULL
// 7-tier set the findings tab uses (critical, high, medium, low,
// high_bug, bug, informational) rather than collapsing bug/info
// into the nearest vuln tier, so the canvas matches the topbar
// pill row.
export function topIssueOf(counts) {
  if (!counts) return null
  for (const sev of SEVERITIES) {
    if ((counts[sev] ?? 0) > 0) return sev
  }
  return null
}

// Build the full v2 graph data structure from a treeData blob and
// per-file own-counts map, filtered to files with a tree entry.
// Returns: files (string[]), packages (string[] sorted by node
// count desc), pkgIndex (pkg → index), nodes (one per file), edges
// (intra/cross), adj (file → edge index list), ambassadors (file
// paths flagged as hubs). Side-effect free; positions are written
// into nodes by the caller's layout pass.
// `severitySets` / `colorSets` (both Map<file, Set<string>>): the
// distinct severities and triage-marker colors that appear on each
// file's own findings. Used by the canvas dim-logic + topbar chip
// counts so the graph mirrors the findings-tab filter semantics
// (any finding's severity / color counts, not just the file's
// top-severity tier). Either may be missing for a clean file.
//
// `fileFindings` (Map<file, Array<{severity, color}>>): per-finding
// {severity, color} pairs stamped on each node so callers (the
// Packages → Issues distribution) can count findings filtered by
// BOTH filters at once — set-based counts can't intersect across
// axes since a file with high+blue and low+red findings has BOTH
// severities in its set and BOTH colors in its set, but only some
// findings match a "high AND blue" filter.
//
// `opts.pkgOf(file)`: optional override for the per-file package
// classifier. Default is `packageOf` from ../graph/utils.js, which
// reads the global `depsDir` configured at the top of render() —
// that's correct for the findings-tab graph but wrong for the
// bundle graph in bundle-only sessions where state.reports doesn't
// carry node_modules paths and depsDir falls back to
// 'dependencies'. The bundle path passes its own `bundlePkgOf`
// (recognizes both `node_modules/` and `dependencies/`) so its
// `node_modules/foo/...` files bucket under `foo` instead of all
// piling under the literal `node_modules` top-level dir.
export function buildGraph(treeData, files, ownCounts, transitiveCounts, severitySets, colorSets, fileFindings, opts = {}) {
  const pkgOf = opts.pkgOf ?? packageOf
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
    const pkg = pkgOf(file) ?? '__own__'
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
      // Source-byte size from the analyzer's tree blob; null when
      // the dump didn't carry a `size` (older exports). Surfaces in
      // the selection card, tooltip, and Files tab via formatBytes.
      size: typeof treeData[file]?.size === 'number' ? treeData[file].size : null,
      severitySet: severitySets?.get(file) ?? null,
      colorSet: colorSets?.get(file) ?? null,
      findings: fileFindings?.get(file) ?? null,
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
  const packages = [...pkgCount.entries()].toSorted((a, b) => b[1] - a[1]).map(([p]) => p)

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
  assignHubs(graph)
  return graph
}

// Hub assignment — a file is a hub iff it sits at a package
// boundary. That means either:
//   - it has at least one incoming cross-package edge (some
//     other package imports it; it's part of this package's
//     public surface), OR
//   - it isn't imported by anything at all (= not imported
//     from within its own package, since the cross case above
//     is already covered). Catches package entry points like
//     CLI mains and top-level scripts that no internal file
//     pulls in.
export function assignHubs(graph) {
  for (const n of graph.nodes) n.isHub = false
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
}

// Package-level view of a buildGraph result — one node per package,
// edges aggregated from the file graph's cross-package edges. Used
// by the canvas when the bundle Graph tab's "Packages" toggle is on.
// Pure derivation: positions are seeded 0,0 for the canvas layout
// pass to overwrite, same contract as buildGraph's nodes.
//
// Shaped like a buildGraph result on purpose. The packages view
// mirrors the package-focus split — rich v1-style chrome up to 50
// packages, the default dot renderer past that — and the default
// path reads file-node fields, so package nodes carry them too:
//   file             — the package name doubles as the node id
//                      (hover / selection keys, position cache)
//   pkg / label      — group key (colors) and display name
//                      ('own source' for the synthetic __own__)
//   issue / own / totalIssues — aggregated finding counts, same
//                      fields a file node has so the severity ring,
//                      renderSevChips, and the tooltip reuse
//   severitySet / colorSet — unions across the package's files, so
//                      the topbar highlight filters dim packages
//                      with the same any-finding-matches semantics
//   pathText         — every member file path, lowercased, so the
//                      path filter matches the aggregate
//   isHub            — true: at package altitude every node sits on
//                      a package boundary by assignHubs' definition,
//                      so they get the hub chrome (ring, halo,
//                      mid-zoom labels)
//   fileCount / size — node weight + byte sum for the tooltip
//
// Edge shape mirrors a file edge ({a, b, cross, fromLo, fromHi} with
// a < b; always cross — intra edges collapse away) plus `count`, the
// number of file-level import pairs collapsed in, which the rich
// renderer maps to stroke width. Direction flags aggregate per side:
// fromLo = some file in `a` imports into `b`.
//
// `nodeByFile` / `byPkg` are the same Map (id IS the package);
// `adj` mirrors the file graph's node → edge-index lists.
// `importsOf` (pkg → [imported pkgs]) feeds the force layout, same
// signature the file-level solver consumes.
export function buildPackageGraph(graph) {
  const nodes = graph.packages.map((pkg) => {
    const files = graph.byPkg.get(pkg) ?? []
    const own = {}
    for (const sev of SEVERITIES) own[sev] = 0
    const severitySet = new Set()
    const colorSet = new Set()
    const paths = []
    let totalIssues = 0
    let size = 0
    let hasSize = false
    for (const n of files) {
      totalIssues += n.totalIssues
      if (n.own) for (const sev of SEVERITIES) own[sev] += n.own[sev] ?? 0
      if (n.severitySet) for (const s of n.severitySet) severitySet.add(s)
      if (n.colorSet) for (const c of n.colorSet) colorSet.add(c)
      if (typeof n.size === 'number') { size += n.size; hasSize = true }
      paths.push(n.file)
    }
    return {
      id: pkg,
      file: pkg,
      pkg,
      label: pkg === '__own__' ? 'own source' : pkg,
      fileCount: files.length,
      size: hasSize ? size : null,
      own,
      totalIssues,
      issue: topIssueOf(own),
      severitySet: severitySet.size > 0 ? severitySet : null,
      colorSet: colorSet.size > 0 ? colorSet : null,
      pathText: paths.join('\n').toLowerCase(),
      isHub: true,
      x: 0, y: 0,
      deg: 0,
    }
  })
  const byPkg = new Map(nodes.map((n) => [n.pkg, n]))

  const edgeMap = new Map()
  for (const e of graph.edges) {
    if (!e.cross) continue
    const pa = graph.nodeByFile.get(e.a)?.pkg
    const pb = graph.nodeByFile.get(e.b)?.pkg
    if (!pa || !pb || pa === pb) continue
    const [lo, hi] = pa < pb ? [pa, pb] : [pb, pa]
    const k = `${lo}\0${hi}`
    let edge = edgeMap.get(k)
    if (!edge) {
      edge = { a: lo, b: hi, cross: true, count: 0, fromLo: false, fromHi: false }
      edgeMap.set(k, edge)
      byPkg.get(lo).deg++
      byPkg.get(hi).deg++
    }
    edge.count++
    // File-edge direction flags are in lo/hi FILE order; map them
    // into lo/hi PACKAGE order (the packages may sort opposite to
    // their files). e.fromLo = file e.a imports e.b = pkg pa → pb.
    const paIsLo = pa === lo
    if (e.fromLo) { if (paIsLo) edge.fromLo = true; else edge.fromHi = true }
    if (e.fromHi) { if (paIsLo) edge.fromHi = true; else edge.fromLo = true }
  }
  const edges = [...edgeMap.values()]

  const adj = new Map()
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    if (!adj.has(e.a)) adj.set(e.a, [])
    if (!adj.has(e.b)) adj.set(e.b, [])
    adj.get(e.a).push(i)
    adj.get(e.b).push(i)
  }

  const importsOf = new Map(nodes.map((n) => [n.pkg, []]))
  for (const e of edges) {
    if (e.fromLo) importsOf.get(e.a).push(e.b)
    if (e.fromHi) importsOf.get(e.b).push(e.a)
  }

  return { nodes, byPkg, nodeByFile: byPkg, edges, adj, importsOf }
}

// Color helper — re-export so callers don't have to know about
// graph/utils.js's two-arg form when they already have a node.
export function nodeColor(n) {
  return pkgColor(n.pkg)
}

// Strip a file path's package anchor so callers can show
// "index.js" instead of "node_modules/foo/index.js" (npm) or
// "foo/bar.js" instead of "src/foo/bar.js" (own source).
// Mirrors packageOf / bundlePkgOf: packages anchor on either
// `node_modules/<pkg>/` or `dependencies/<pkg>/` — try both
// regardless of the report-driven depsDirName, since the bundle
// graph runs without a report (depsDirName falls back to
// 'dependencies' even when the bundle paths use node_modules).
// own source anchors on the top-level dir. For root files
// (pkg === '/') and the synthetic '__own__' bucket the file is
// returned as-is — there's no meaningful prefix to strip and
// consumers should fall back to the full path.
export function pkgRelative(file, pkg) {
  if (!pkg || pkg === '/' || pkg === '__own__') return file
  for (const dep of ['node_modules', 'dependencies', depsDirName()]) {
    const anchor = dep + '/' + pkg + '/'
    const idx = file.indexOf(anchor)
    if (idx >= 0) return file.slice(idx + anchor.length)
  }
  if (file.startsWith(pkg + '/')) return file.slice(pkg.length + 1)
  return file
}
