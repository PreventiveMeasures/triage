import { buildPackageGraph } from './data.js'

const cache = new WeakMap()
const fileCache = new WeakMap()

export function dependencyFilesOn(graph, packagesView) {
  return graph.nodes.length <= 100 && !packagesView
}

export function dependencyNetwork(graph, packagesView) {
  if (!dependencyFilesOn(graph, packagesView)) return packageNetwork(graph)
  if (fileCache.has(graph)) return fileCache.get(graph)
  const importsOf = new Map(graph.nodes.map((n) => [n.file, [...new Set(graph.importsOf.get(n.file) ?? [])]]))
  const directedEdges = []
  for (const [from, targets] of importsOf) {
    for (const to of targets) directedEdges.push({ from, to })
  }
  const network = { ...graph, importsOf, directedEdges, fileLevel: true }
  fileCache.set(graph, network)
  return network
}

// One directed edge per package pair, including the recorded imports of an
// unbundled entry. Keep this separate from file and byte-weighted graph modes.
export function packageNetwork(graph) {
  if (cache.has(graph)) return cache.get(graph)
  const pg = buildPackageGraph(graph)
  if (graph.layerRoots?.appImports?.length > 0) {
    if (!pg.byPkg.has('__own__')) {
      const node = { file: '__own__', pkg: '__own__', label: 'own source', fileCount: 0, size: null, totalIssues: 0, deg: 0, x: 0, y: 0 }
      pg.nodes.push(node); pg.byPkg.set(node.pkg, node)
    }
    pg.importsOf.set('__own__', [...new Set([...(pg.importsOf.get('__own__') ?? []), ...graph.layerRoots.appImports])].filter((id) => id !== '__own__' && pg.byPkg.has(id)))
  }
  pg.importedBy = new Map(pg.nodes.map((n) => [n.pkg, []]))
  pg.directedEdges = []
  for (const [from, targets] of pg.importsOf) {for (const to of targets) {
    pg.importedBy.get(to).push(from)
    pg.directedEdges.push({ from, to })
  }}
  for (const n of pg.nodes) n.deg = (pg.importsOf.get(n.pkg)?.length ?? 0) + pg.importedBy.get(n.pkg).length
  cache.set(graph, pg)
  return pg
}
