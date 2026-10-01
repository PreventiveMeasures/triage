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

// Keep the full resolution identity: collapsing to graph edges would lose
// specifier, condition/import-attribute, and Metro platform changes.
export function bundleCompareResolutions(details, scope = '') {
  const result = new Map()
  if (details?.kind !== 'stasis' || !details.bundle) return result
  const files = scope ? bundleFilesAsMap(details) : null
  const selected = scope ? bundleCompareFiles(details, scope) : null
  for (const [conditions, byParent] of details.bundle.imports) {
    for (const [parent, specifiers] of byParent) {
      for (const [specifier, resolved] of specifiers) {
        const targets = typeof resolved === 'string' ? [[null, resolved]] : resolved
        for (const [platform, target] of targets) {
          // Include imports from scoped files, plus imports into the scope
          // from uncaptured parents (e.g. an app in a dependencies-only bundle).
          if (selected && !selected.has(parent) && (files.has(parent) || !selected.has(target))) continue
          const key = JSON.stringify([parent, specifier, conditions, platform])
          result.set(key, { key, parent, specifier, conditions, platform, target })
        }
      }
    }
  }
  return result
}
