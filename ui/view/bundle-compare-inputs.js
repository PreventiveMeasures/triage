import { bundleFilesAsMap } from './bundle-sources.js'

// Use the union of named trees. A tree absent from one side contains no files
// there; falling back to all files would invent additions/removals. Unlike a
// single-bundle graph, retain a scope that includes every file on one side.
export function bundleCompareScopes(...details) {
  const names = new Set()
  for (const item of details) {
    const files = bundleFilesAsMap(item)
    for (const [name, paths] of Object.entries(item?.bundle?.reason ?? {})) {
      if (Array.isArray(paths) && paths.some(path => files.has(path))) names.add(name)
    }
  }
  return [...names].toSorted().map(name => ({ id: `reason:${name}`, label: name }))
}

export function bundleCompareFiles(details, scope = '') {
  const files = bundleFilesAsMap(details)
  if (!scope) return files
  const paths = details?.bundle?.reason?.[scope.replace(/^reason:/u, '')]
  const selected = new Set(Array.isArray(paths) ? paths : [])
  return new Map([...files].filter(([path]) => selected.has(path)))
}
