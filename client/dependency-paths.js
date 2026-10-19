// Match whole path segments, using the same directory precedence as the
// findings dependency filter. Less-specific directory names can be own source.
export function isDependencyFile(file, directory) {
  if (typeof file !== 'string') return false
  const path = file.replaceAll('\\', '/')
  return path.startsWith(`${directory}/`) || path.includes(`/${directory}/`)
}

// A team's reports tell the one their tree names (`treeDependencies`) in place
// of the tree, which is asked for apart (server-managed/team-reports.ts).
export function dependencyDirectory(reports) {
  let vendor = false
  for (const report of reports) {
    for (const group of report.groups ?? []) {
      for (const finding of group) {
        if (isDependencyFile(finding.file, 'node_modules')) return 'node_modules'
        if (isDependencyFile(finding.file, 'vendor')) vendor = true
      }
    }
    const named = report.tree ? treeDependencyDirectory(report.tree) : report.treeDependencies
    if (named === 'node_modules') return 'node_modules'
    if (named === 'vendor') vendor = true
  }
  return vendor ? 'vendor' : 'dependencies'
}

// The dependency directory a report's file tree names: node_modules, else
// vendor, else none.
export function treeDependencyDirectory(tree) {
  let vendor = false
  for (const file of Object.keys(tree ?? {})) {
    if (isDependencyFile(file, 'node_modules')) return 'node_modules'
    if (isDependencyFile(file, 'vendor')) vendor = true
  }
  return vendor ? 'vendor' : null
}
