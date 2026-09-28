import { bundleSourcesAsMap } from './bundle-sources.js'

const indexes = new WeakMap()

// Normalize only path segments. Keep sourcemap URL roots (webpack:/// etc.)
// and leading ../ segments, and never guess extensions or basename matches.
function normalizePath(path) {
  const match = /^([a-z][a-z\d+.-]*:\/\/[^/]*)(.*)$/iu.exec(path)
  const prefix = match?.[1] ?? ''
  const rest = match?.[2] ?? path
  const absolute = rest.startsWith('/')
  const parts = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') parts.pop()
    else if (part === '..' && absolute && parts.length === 0) return null
    else parts.push(part)
  }
  return prefix + (absolute ? '/' : '') + parts.join('/')
}

function buildIndex(sources) {
  const paths = new Map()
  for (const path of sources.keys()) {
    const normalized = normalizePath(path)
    if (normalized === null) continue
    // Distinct source keys with the same normalized path are ambiguous.
    paths.set(normalized, paths.has(normalized) ? null : path)
  }
  return paths
}

// Merge conditions before linking. When exporting a restricted source set,
// include only visible parents and replace every unavailable target with null:
// its path must not leak, and relative fallback must still remain blocked.
export function bundleSourceImports(details, sources = bundleSourcesAsMap(details)) {
  const imports = new Map()
  if (details?.kind === 'stasis') {
    for (const byParent of details.bundle?.imports?.values() ?? []) {
      for (const [parent, specifiers] of byParent) {
        if (!sources.has(parent)) continue
        if (!imports.has(parent)) imports.set(parent, new Map())
        const merged = imports.get(parent)
        for (const [specifier, target] of specifiers) {
          const resolved = typeof target === 'string' && sources.has(target) ? target : null
          // A platform object, missing file, or disagreement under any
          // condition permanently blocks this specifier, including fallback.
          merged.set(specifier, merged.has(specifier) && merged.get(specifier) !== resolved ? null : resolved)
        }
      }
    }
  }
  return imports
}

export function sourceLinkResolver(sources, parent, imports = null) {
  let index = indexes.get(sources)
  if (!index) { index = buildIndex(sources); indexes.set(sources, index) }
  const recorded = imports?.get(parent)
  const directory = parent.slice(0, parent.lastIndexOf('/') + 1)
  return (specifier) => {
    if (typeof specifier !== 'string' || /\p{Cc}/u.test(specifier)) return null
    if (recorded?.has(specifier)) {
      const target = recorded.get(specifier)
      return typeof target === 'string' && sources.has(target) ? target : null
    }
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null
    const name = specifier.slice(specifier.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    if (dot <= 0 || dot === name.length - 1) return null
    return index.get(normalizePath(directory + specifier)) ?? null
  }
}

const bundleImports = new WeakMap()

export function bundleSourceLinkResolver(details, parent) {
  const sources = bundleSourcesAsMap(details)
  let imports = bundleImports.get(sources)
  if (!imports) { imports = bundleSourceImports(details, sources); bundleImports.set(sources, imports) }
  return sourceLinkResolver(sources, parent, imports)
}
