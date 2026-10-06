import { bundlePkgOf } from '../bundle-pkg-of.js'

// Use the innermost installation so nested dependencies remain separate.
function installedModulePath(file) {
  return file.split(/(?:^|\/)node_modules\//u).slice(1).at(-1)
}

// Known build-tool discovery loads do not represent runtime dependency cycles.
// Match original installation paths, including nested node_modules, rather than
// display paths. ownSource supplies authoritative ownership when available.
export function countsTowardsCycles(from, to, ownSource) {
  if (/(?:^|\/)node_modules\/react-native\/scripts\/codegen\/generate-artifacts-executor\.js$/u.test(from)
    && /(?:^|\/)(?:package\.json|react-native\.config\.js)$/u.test(to)) return false
  if (/(?:^|\/)node_modules\/@react-native-community\/cli-tools\/build\/releaseChecker\/index\.js$/u.test(from)
    && /(?:^|\/)node_modules\/react-native\/package\.json$/u.test(to)) return false
  // React Native's config loads platform CLIs supplied by the host project.
  if (/(?:^|\/)node_modules\/react-native\/react-native\.config\.js$/u.test(from)
    && /(?:^|\/)node_modules\/@react-native-community\/cli-platform-(?:android|ios)\/build\/index\.js$/u.test(to)) return false
  const installedSource = installedModulePath(from)
  if (installedSource?.startsWith('@babel/core/lib/config/')
    && (/(?:^|\/)babel\.config\.js$/u.test(to) || installedModulePath(to)?.startsWith('@babel/preset-typescript/'))) return false
  // Bundles do not distinguish literal imports from computed loads. Match
  // the other known config entry points at their specific loaders.
  if (/(?:^|\/)node_modules\/@babel\/core\/lib\/config\/files\/(?:module-types|plugins)\.js$/u.test(from)
    && /(?:^|\/)node_modules\/(?:@babel\/plugin-transform-[^/]+\/lib\/index\.js|@react-native\/babel-preset\/(?:src\/)?index\.js|(?:@[^/]+\/)?react-native-reanimated\/plugin\/index\.js)$/u.test(to)) return false
  if (to.endsWith('.config.js')) {
    if (installedSource === 'cosmiconfig/dist/loaders.js') return false
    if (installedSource?.startsWith('import-fresh/') && (ownSource ?? bundlePkgOf(to, { splitOwnDirs: false }) === '__own__')) return false
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
