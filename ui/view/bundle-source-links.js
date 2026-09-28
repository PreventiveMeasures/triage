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

function buildIndex(details, sources) {
  const paths = new Map()
  for (const path of sources.keys()) {
    const normalized = normalizePath(path)
    if (normalized === null) continue
    // Distinct source keys with the same normalized path are ambiguous.
    paths.set(normalized, paths.has(normalized) ? null : path)
  }
  const imports = new Map()
  if (details?.kind === 'stasis') {
    for (const byParent of details.bundle?.imports?.values() ?? []) {
      for (const [parent, specifiers] of byParent) {
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
  return { paths, imports }
}

export function bundleSourceLinkResolver(details, parent) {
  const sources = bundleSourcesAsMap(details)
  let index = indexes.get(sources)
  if (!index) { index = buildIndex(details, sources); indexes.set(sources, index) }
  const recorded = index.imports.get(parent)
  const directory = parent.slice(0, parent.lastIndexOf('/') + 1)
  return (specifier) => {
    if (typeof specifier !== 'string' || /\p{Cc}/u.test(specifier)) return null
    if (recorded?.has(specifier)) return recorded.get(specifier)
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null
    const name = specifier.slice(specifier.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    if (dot <= 0 || dot === name.length - 1) return null
    return index.paths.get(normalizePath(directory + specifier)) ?? null
  }
}
