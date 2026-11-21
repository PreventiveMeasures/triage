// Packages imported from nearly everywhere: @babel/runtime's helpers by every
// transpiled module, minimalistic-assert by the crypto stacks, react by every
// component, reselect by every selector module. When that many edges lead into
// one, its files and every edge that touches them bury the rest of the graph,
// so every bundle graph but Matrix hides it.
const CROWDED_PACKAGES = new Set(['@babel/runtime', 'minimalistic-assert', 'react', 'reselect'])
export const MAX_FILE_EDGES = 300
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
  const pkg = file => graph.nodeByFile.get(file)?.pkg
  function* imports() {
    for (const e of graph.edges) {
      if (e.fromLo) yield [pkg(e.a), pkg(e.b)]
      if (e.fromHi) yield [pkg(e.b), pkg(e.a)]
    }
  }
  return crowdedPackages(imports(), limit)
}
