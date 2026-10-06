import { bundlePkgOf } from '../bundle-pkg-of.js'

// Known build-tool discovery loads do not represent runtime dependency cycles.
// Match original installation paths, including nested node_modules, rather than
// display paths. ownSource supplies authoritative ownership when available.
export function countsTowardsCycles(from, to, ownSource) {
  if (/(?:^|\/)node_modules\/react-native\/scripts\/codegen\/generate-artifacts-executor\.js$/u.test(from)
    && /(?:^|\/)(?:package\.json|react-native\.config\.js)$/u.test(to)) return false
  if (/(?:^|\/)node_modules\/@babel\/core\/lib\/config\//u.test(from)
    && /(?:^|\/)babel\.config\.js$/u.test(to)) return false
  // Bundles do not distinguish literal imports from computed loads. Match
  // known dynamic entry points, keeping dependencies such as preset-typescript.
  if (/(?:^|\/)node_modules\/@babel\/core\/lib\/config\/files\/(?:module-types|plugins)\.js$/u.test(from)
    && /(?:^|\/)node_modules\/(?:@react-native\/babel-preset\/index\.js|(?:@[^/]+\/)?react-native-reanimated\/plugin\/index\.js)$/u.test(to)) return false
  if (to.endsWith('.config.js') && (ownSource ?? bundlePkgOf(to, { splitOwnDirs: false }) === '__own__')) {
    // The last installation boundary excludes import-fresh's nested dependencies.
    const installedSource = from.split(/(?:^|\/)node_modules\//u).slice(1).at(-1)
    if (installedSource === 'cosmiconfig/dist/loaders.js' || installedSource?.startsWith('import-fresh/')) return false
  }
  return true
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
      if (to && countsTowardsCycles(from.origFile ?? file, to.origFile ?? target, graph.ownSourceFiles?.has(target))) links.get(groupOf(from)).add(groupOf(to))
    }
  }
  return links
}
