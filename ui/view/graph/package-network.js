import { buildPackageGraph } from './data.js'
import { cycleImportsOf } from './cycle-imports.js'
import { MAX_FILE_EDGES, MAX_PACKAGE_EDGES, crowdedPackages } from './crowded-packages.js'

const cache = new WeakMap()
const fileCache = new WeakMap()

export function dependencyFilesOn(graph, packagesView) {
  return graph.nodes.length <= 100 && !packagesView
}

// Leave crowded packages (see crowded-packages.js) out of a network: their
// nodes, every import into or out of them, and their cycle links. `pkgOf`
// names the package of a node id.
function withoutCrowded(network, limit, pkgOf) {
  const hidden = crowdedPackages([...network.importsOf].flatMap(([from, targets]) => targets.map(to => [pkgOf(from), pkgOf(to)])), limit)
  if (hidden.size === 0) return network
  const shown = id => !hidden.has(pkgOf(id))
  const nodes = network.nodes.filter(n => shown(n.file))
  return { ...network, nodes, nodeByFile: new Map(nodes.map(n => [n.file, n])),
    importsOf: new Map([...network.importsOf].filter(([id]) => shown(id)).map(([id, targets]) => [id, targets.filter(shown)])),
    cycleImportsOf: new Map([...network.cycleImportsOf].filter(([id]) => shown(id)).map(([id, targets]) => [id, new Set([...targets].filter(shown))])) }
}

export function dependencyNetwork(graph, packagesView) {
  if (!dependencyFilesOn(graph, packagesView)) return packageNetwork(graph)
  if (fileCache.has(graph)) return fileCache.get(graph)
  const importsOf = new Map(graph.nodes.map((n) => [n.file, [...new Set(graph.importsOf.get(n.file) ?? [])]]))
  const network = withoutCrowded({ ...graph, importsOf, cycleImportsOf: cycleImportsOf(graph), fileLevel: true },
    MAX_FILE_EDGES, file => graph.nodeByFile.get(file)?.pkg)
  network.directedEdges = []
  for (const [from, targets] of network.importsOf) {
    for (const to of targets) network.directedEdges.push({ from, to })
  }
  fileCache.set(graph, network)
  return network
}

// One directed edge per package pair, including the recorded imports of an
// unbundled entry. Keep this separate from file and byte-weighted graph modes.
export function packageNetwork(graph) {
  if (cache.has(graph)) return cache.get(graph)
  let pg = buildPackageGraph(graph)
  pg.cycleImportsOf = cycleImportsOf(graph, node => node.pkg)
  if (graph.layerRoots?.appImports?.length > 0) {
    if (!pg.byPkg.has('__own__')) {
      const node = { file: '__own__', pkg: '__own__', label: 'own source', fileCount: 0, size: null, totalIssues: 0, deg: 0, x: 0, y: 0 }
      pg.nodes.push(node); pg.byPkg.set(node.pkg, node)
    }
    pg.importsOf.set('__own__', [...new Set([...(pg.importsOf.get('__own__') ?? []), ...graph.layerRoots.appImports])].filter((id) => id !== '__own__' && pg.byPkg.has(id)))
    pg.cycleImportsOf.set('__own__', new Set([...(pg.cycleImportsOf.get('__own__') ?? []), ...graph.layerRoots.appImports]
      .filter(id => id !== '__own__' && pg.byPkg.has(id))))
  }
  pg = withoutCrowded(pg, MAX_PACKAGE_EDGES, pkg => pkg)
  pg.byPkg = pg.nodeByFile
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
