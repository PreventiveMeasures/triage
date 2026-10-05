// Codegen scans package manifests; those reads do not represent runtime
// dependency cycles. Match the original installation path, including nested
// node_modules, rather than a shortened display path or just a basename.
export function countsTowardsCycles(from, to) {
  return !(/(?:^|\/)node_modules\/react-native\/scripts\/codegen\/generate-artifacts-executor\.js$/u.test(from)
    && (to === 'package.json' || to.endsWith('/package.json')))
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
      if (to && countsTowardsCycles(from.origFile ?? file, to.origFile ?? target)) links.get(groupOf(from)).add(groupOf(to))
    }
  }
  return links
}
