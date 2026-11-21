import { packageOf } from './utils.js'
import { pkgLabel } from '../../../common/bundle-pkg-of.js'
import { totalFindings } from '../file-counts.js'
import { SEVERITIES } from '../format.js'

// Node id → indices of its edges, for neighbor lookups.
function buildAdj(edges) {
  const adj = new Map()
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    if (!adj.has(e.a)) adj.set(e.a, [])
    if (!adj.has(e.b)) adj.set(e.b, [])
    adj.get(e.a).push(i)
    adj.get(e.b).push(i)
  }
  return adj
}

// The highest severity tier with findings, of all seven the findings tab
// shows, or null when clean.
const topIssueOf = (counts) => counts ? SEVERITIES.find((sev) => (counts[sev] ?? 0) > 0) ?? null : null

// The graph of `files` (each with a `treeData` entry): nodes (one per file,
// positioned later by the canvas layouts) and `nodeByFile`, deduplicated
// edges, `adj`, `importsOf` / `importedBy`, and `packages` (by file count,
// descending) with `pkgCount` / `byPkg`.
//
// `ownCounts` / `transitiveCounts` hold per-severity counts for the chips;
// `severitySets` / `colorSets` the severities and mark colors among a
// file's findings, for the filters' any-finding-matches dimming;
// `fileFindings` the {severity, color} pairs, so a count can apply both
// filters to one finding. Any may lack a clean file.
//
// `opts.pkgOf(file)` overrides the package classifier: `packageOf` reads the
// report's deps dir, which a bundle-only session lacks. `opts.packageInfoOf`
// keeps a bundle's recorded install directory and version per file.
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

  const nodes = files.map((file) => {
    const own = ownCounts.get(file)
    return {
      id: file,
      file,
      pkg: pkgOf(file) ?? '__own__',
      packageInfo: opts.packageInfoOf?.(file),
      x: 0, y: 0,
      deg: 0,
      issue: topIssueOf(own),
      totalIssues: totalFindings(own),
      own,
      subtree: transitiveCounts?.get(file) ?? null,
      // Null when the analyzer recorded no size.
      size: typeof treeData[file]?.size === 'number' ? treeData[file].size : null,
      severitySet: severitySets?.get(file) ?? null,
      colorSet: colorSets?.get(file) ?? null,
      findings: fileFindings?.get(file) ?? null,
      isHub: false,
      label: file.split('/').pop() ?? file,
    }
  })
  const nodeByFile = new Map(nodes.map((n) => [n.file, n]))

  // One edge per pair (a < b), whichever ends import: fromLo / fromHi say
  // which (both for a bidirectional pair), for arrowheads and hubs. `cross`
  // joins two packages.
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
      if (f === lo) edge.fromLo = true
      else edge.fromHi = true
    }
  }
  const edges = [...edgeMap.values()]

  const byPkg = Map.groupBy(nodes, (n) => n.pkg)
  const pkgCount = new Map([...byPkg].map(([pkg, members]) => [pkg, members.length]))
  const packages = [...pkgCount.entries()].toSorted((a, b) => b[1] - a[1]).map(([p]) => p)

  const graph = {
    files, nodes, nodeByFile, edges, adj: buildAdj(edges),
    importsOf, importedBy, packages, pkgCount, byPkg,
  }
  assignHubs(graph)
  return graph
}

// A file is a hub when it sits at a package boundary: another package
// imports it (its package's public surface), or nothing imports it at all
// (an entry point, like a CLI main).
export function assignHubs(graph) {
  for (const n of graph.nodes) n.isHub = false
  for (const e of graph.edges) {
    if (!e.cross) continue
    // fromLo: the lo file `a` imports `b`.
    if (e.fromLo) graph.nodeByFile.get(e.b).isHub = true
    if (e.fromHi) graph.nodeByFile.get(e.a).isHub = true
  }
  for (const n of graph.nodes) {
    const importers = graph.importedBy.get(n.file)
    if (!importers || importers.length === 0) n.isHub = true
  }
}

// One node per package, its edges the file graph's cross-package ones merged,
// shaped like a buildGraph result so the file renderers draw it: a node's
// `file` is its package name; it carries summed finding counts (`own`,
// `issue`, `totalIssues`), the union of its files' severity and color sets,
// their paths lowercased (`pathText`, for the path filter), `fileCount` and
// summed `size`, and is a hub (every package sits on a boundary). An edge
// counts the file imports it merges (`count`), its fromLo / fromHi in
// package order. `importsOf` (package → packages) feeds the force layout.
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
      file: pkg,
      pkg,
      label: pkgLabel(pkg),
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
    // The file edge's flags are in file order (e.fromLo: file e.a, of package
    // pa, imports e.b); the packages may sort the other way.
    const paIsLo = pa === lo
    if (e.fromLo) { if (paIsLo) edge.fromLo = true; else edge.fromHi = true }
    if (e.fromHi) { if (paIsLo) edge.fromHi = true; else edge.fromLo = true }
  }
  const edges = [...edgeMap.values()]

  const importsOf = new Map(nodes.map((n) => [n.pkg, []]))
  for (const e of edges) {
    if (e.fromLo) importsOf.get(e.a).push(e.b)
    if (e.fromHi) importsOf.get(e.b).push(e.a)
  }

  return { nodes, byPkg, nodeByFile: byPkg, edges, adj: buildAdj(edges), importsOf,
    ownSourcePackages: graph.ownSourcePackages, entryPackages: graph.entryPackages }
}

// The graph without the given packages' files and every edge touching them,
// for views that lay out only what they draw. Nodes are shared, so positions a
// layout writes land on the same node objects.
export function withoutPackages(graph, hidden) {
  if (hidden.size === 0) return graph
  const nodes = graph.nodes.filter((n) => !hidden.has(n.pkg))
  const nodeByFile = new Map(nodes.map((n) => [n.file, n]))
  const kept = (file) => nodeByFile.has(file)
  const edges = graph.edges.filter((e) => kept(e.a) && kept(e.b))
  const keptLinks = (links) => new Map([...links].filter(([file]) => kept(file)).map(([file, targets]) => [file, targets.filter(kept)]))
  const packages = graph.packages.filter((pkg) => !hidden.has(pkg))
  return {
    ...graph, files: graph.files.filter(kept), nodes, nodeByFile, edges, adj: buildAdj(edges),
    importsOf: keptLinks(graph.importsOf), importedBy: keptLinks(graph.importedBy), packages,
    pkgCount: new Map(packages.map((pkg) => [pkg, graph.pkgCount.get(pkg)])), byPkg: new Map(packages.map((pkg) => [pkg, graph.byPkg.get(pkg)])),
  }
}

// What links a graph's nodes: a bundle's files import each other; a
// lockfile's packages depend on each other through their installed copies,
// which have no source to open or size to sum (`packagesOnly`).
const FILE_TERMS = { links: 'imports', cellLinks: 'file imports', link: 'Import', linked: 'imports', members: 'files',
  mostImported: 'Most imported', outgoing: 'Imports', incoming: 'Imported by', importers: 'importers', cellHeading: 'File imports' }
const PACKAGE_TERMS = { links: 'dependencies', cellLinks: 'dependencies', link: 'Dependency', linked: 'depends on', members: 'versions',
  mostImported: 'Most depended on', outgoing: 'Dependencies', incoming: 'Dependents', importers: 'dependents', cellHeading: 'Copies' }
export const graphTerms = graph => graph.packagesOnly ? PACKAGE_TERMS : FILE_TERMS

// The versions a package's members record (`packageInfo`), each once, in
// version order: a lockfile's copies of one package (lockfile-graph-inputs.js).
export function packageVersions(graph, pkg) {
  const versions = new Set()
  for (const n of graph.byPkg.get(pkg) ?? []) if (n.packageInfo?.version !== undefined) versions.add(n.packageInfo.version)
  return [...versions].toSorted((a, b) => a.localeCompare(b, 'en', { numeric: true }))
}
