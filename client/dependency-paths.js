// Match whole path segments, using the same directory precedence as the
// findings dependency filter. Less-specific directory names can be own source.
export function isDependencyFile(file, directory) {
  if (typeof file !== 'string') return false
  const path = file.replaceAll('\\', '/')
  return path.startsWith(`${directory}/`) || path.includes(`/${directory}/`)
}

export function dependencyDirectory(reports) {
  let vendor = false
  for (const report of reports) {
    for (const group of report.groups ?? []) {
      for (const finding of group) {
        if (isDependencyFile(finding.file, 'node_modules')) return 'node_modules'
        if (isDependencyFile(finding.file, 'vendor')) vendor = true
      }
    }
    for (const file of Object.keys(report.tree ?? {})) {
      if (isDependencyFile(file, 'node_modules')) return 'node_modules'
      if (isDependencyFile(file, 'vendor')) vendor = true
    }
  }
  return vendor ? 'vendor' : 'dependencies'
}
