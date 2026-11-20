import { bundleSourcemapImports } from './bundle-sourcemap.js'

// The files a resolution names: a single resolved path, or each of a Metro
// platform -> file map's.
function resolvedFiles(resolved) {
  const targets = typeof resolved === 'string' ? [resolved] : resolved instanceof Map ? [...resolved.values()] : []
  return targets.filter((target) => typeof target === 'string')
}

// Include every recorded platform/condition variant (resolvedFiles). A
// sourcemap records no imports: its edges are what bundle-sourcemap.js reads
// of it.
export function bundleImportsAsMap(details) {
  if (details?.kind === 'sourcemap') return bundleSourcemapImports(details)
  const result = new Map()
  if (details?.kind !== 'stasis' || !details.bundle) return result
  for (const byParent of details.bundle.imports.values()) {
    for (const [parent, specMap] of byParent) {
      if (!result.has(parent)) result.set(parent, new Set())
      const targets = result.get(parent)
      for (const resolved of specMap.values()) resolvedFiles(resolved).forEach((target) => targets.add(target))
    }
  }
  return result
}
