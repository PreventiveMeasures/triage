// Packages imported from nearly everywhere: @babel/runtime's helpers by every
// transpiled module, minimalistic-assert by the crypto stacks, react by every
// component, reselect by every selector module. When that many edges lead into
// one, its files and every edge that touches them bury the rest of the graph,
// so every bundle graph but Matrix hides it.
const CROWDED_PACKAGES = new Set(['@babel/runtime', 'minimalistic-assert', 'react', 'reselect'])
export const MAX_FILE_EDGES = 300
export const MAX_PACKAGE_EDGES = 100

function over(counts, limit) {
  return new Set([...counts].filter(([, count]) => count > limit).map(([pkg]) => pkg))
}

// The listed packages that more than `limit` edges lead into from other
// packages. `edges` yields one [importer package, imported package] per edge.
export function crowdedPackages(edges, limit) {
  const counts = new Map()
  for (const [from, to] of edges) if (from !== to && CROWDED_PACKAGES.has(to)) counts.set(to, (counts.get(to) ?? 0) + 1)
  return over(counts, limit)
}

// The same for a file or package graph ({ a, b, fromLo, fromHi } edges).
export function crowdedGraphPackages(graph, limit) {
  const counts = new Map()
  const count = (from, to) => {
    const imported = graph.nodeByFile.get(to)?.pkg, importer = graph.nodeByFile.get(from)?.pkg
    if (importer !== imported && CROWDED_PACKAGES.has(imported)) counts.set(imported, (counts.get(imported) ?? 0) + 1)
  }
  for (const e of graph.edges) {
    if (e.fromLo) count(e.a, e.b)
    if (e.fromHi) count(e.b, e.a)
  }
  return over(counts, limit)
}
