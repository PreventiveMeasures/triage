// @babel/runtime's helpers are imported by nearly every transpiled module.
// When that many edges lead into the package, its files and every edge that
// touches them bury the rest of the graph, so Graph and Size flow hide it.
const CROWDED_PACKAGES = new Set(['@babel/runtime'])
export const MAX_FILE_EDGES = 500
export const MAX_PACKAGE_EDGES = 100

// The listed packages that more than `limit` edges lead into from other
// packages. `edges` yields one [importer package, imported package] per edge.
export function crowdedPackages(edges, limit) {
  const counts = new Map()
  for (const [from, to] of edges) if (from !== to && CROWDED_PACKAGES.has(to)) counts.set(to, (counts.get(to) ?? 0) + 1)
  return new Set([...counts].filter(([, count]) => count > limit).map(([pkg]) => pkg))
}

// The same for a file or package graph ({ a, b, fromLo, fromHi } edges).
export function crowdedGraphPackages(graph, limit) {
  const pkg = id => graph.nodeByFile.get(id)?.pkg
  return crowdedPackages(graph.edges.flatMap(e => [...(e.fromLo ? [[pkg(e.a), pkg(e.b)]] : []), ...(e.fromHi ? [[pkg(e.b), pkg(e.a)]] : [])]), limit)
}
