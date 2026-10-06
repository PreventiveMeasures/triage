import { getWeakEdge } from '@preventive/upstream/weak-edges.js'
import { bundlePkgOf } from '../bundle-pkg-of.js'

// Convert original paths, never graph display labels, to upstream coordinates.
// The innermost installation owns nested dependencies, including pnpm copies.
function weakEdgeFile(file, ownSource) {
  const installed = file.split(/(?:^|\/)node_modules\//u).slice(1).at(-1)
  const parts = installed?.match(/^(@[^/]+\/[^/]+|[^/]+)\/(.+)$/u)
  return {
    package: parts?.[1],
    path: parts?.[2] ?? file.replace(/^\/+/u, ''),
    ownSource: ownSource ?? bundlePkgOf(file, { splitOwnDirs: false }) === '__own__',
  }
}

// Both ends carry authoritative ownership when available. The upstream catalog
// alone decides which loads are weak, for cycles and dependency explanations.
export function countsTowardsCycles(from, to, toOwnSource, fromOwnSource) {
  return !getWeakEdge(weakEdgeFile(from, fromOwnSource), weakEdgeFile(to, toOwnSource))
}

// Filter before grouping files into packages: another ordinary import between
// the same packages must still participate in cycle detection.
export function cycleImportsOf(graph, groupOf = node => node.file) {
  const nodes = new Map(graph.nodes.map(node => [node.file, node]))
  const links = new Map(graph.nodes.map(node => [groupOf(node), new Set()]))
  for (const [file, targets] of graph.importsOf) {
    const from = nodes.get(file)
    if (!from) continue
    for (const target of targets) {
      const to = nodes.get(target)
      if (to && countsTowardsCycles(from.origFile ?? file, to.origFile ?? target,
        graph.ownSourceFiles?.has(target), graph.ownSourceFiles?.has(file))) links.get(groupOf(from)).add(groupOf(to))
    }
  }
  return links
}
