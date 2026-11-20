import { bundleSourcemapImports } from './bundle-sourcemap.js'

// Include every recorded platform/condition variant; a Metro resolution can
// be a platform -> file map instead of a single resolved path. A sourcemap
// records no imports: its edges are what bundle-sourcemap.js reads of it.
export function bundleImportsAsMap(details) {
  if (details?.kind === 'sourcemap') return bundleSourcemapImports(details)
  const result = new Map()
  if (details?.kind !== 'stasis' || !details.bundle) return result
  for (const byParent of details.bundle.imports.values()) {
    for (const [parent, specMap] of byParent) {
      if (!result.has(parent)) result.set(parent, new Set())
      for (const resolved of specMap.values()) {
        const targets = typeof resolved === 'string' ? [resolved] : resolved instanceof Map ? resolved.values() : []
        for (const target of targets) if (typeof target === 'string') result.get(parent).add(target)
      }
    }
  }
  return result
}
