import { graph2 } from './state.js'

// What a canvas attachment shows: the data it came from (`graph.viewId`,
// e.g. the bundle's integrity, so two builds with the same file list
// stay apart), the node set (hashed, so a long file list costs one pass
// rather than a stored copy) and every view switch that changes
// positions. Equal keys mean a re-attach may keep the previous pan and
// zoom (see attachGraph2Interaction).
export function graphViewKey(graph) {
  let hash = 0x811c9dc5
  for (const file of graph.files) {
    for (let i = 0; i < file.length; i++) hash = Math.imul(hash ^ file.codePointAt(i), 0x01000193)
    hash = Math.imul(hash ^ 10, 0x01000193)
  }
  return [graph.viewId ?? '', hash >>> 0, graph.files.length, graph.edges.length, graph2.bundleLayout, graph2.packagesView,
    graph2.dependencyPackagesView, graph2.focusedPkg, graph2.showAll].join('|')
}
