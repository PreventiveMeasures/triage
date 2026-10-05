import { bundleFilesAsMap, bundleSourcesAsMap } from './bundle-sources.js'

const indexes = new WeakMap()
const manifests = new WeakMap()

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

function packageScope(sources, index, parent) {
  const normalized = normalizePath(parent)
  if (normalized === null) return null
  let directory = normalized.slice(0, normalized.lastIndexOf('/') + 1)
  let cache = manifests.get(sources)
  if (!cache) { cache = new Map(); manifests.set(sources, cache) }
  for (;;) {
    // A dependency without a captured manifest cannot inherit the app's imports.
    if (directory.endsWith('node_modules/')) return null
    const path = `${directory}package.json`
    if (index.has(path)) {
      if (!cache.has(path)) {
        let imports = null
        try { imports = JSON.parse(sources.get(index.get(path)))?.imports ?? null } catch {}
        cache.set(path, imports && typeof imports === 'object' && !Array.isArray(imports) ? imports : null)
      }
      // The nearest package defines the scope, including absent/invalid imports.
      return { directory, imports: cache.get(path) }
    }
    if (!directory || directory === '/' || directory.endsWith('../') || /^[a-z][a-z\d+.-]*:\/\/[^/]*\/?$/iu.test(directory)) return null
    const trimmed = directory.slice(0, -1)
    directory = trimmed.slice(0, trimmed.lastIndexOf('/') + 1)
  }
}

function importMapping(imports, specifier) {
  if (!imports) return null
  if (Object.hasOwn(imports, specifier) && !specifier.includes('*')) return { value: imports[specifier], wildcard: null }
  let best = null
  for (const pattern of Object.keys(imports)) {
    const star = pattern.indexOf('*')
    if (!pattern.startsWith('#') || star === -1 || pattern.indexOf('*', star + 1) !== -1) continue
    const prefix = pattern.slice(0, star), suffix = pattern.slice(star + 1)
    if (specifier.length <= prefix.length + suffix.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue
    // Node's pattern precedence: longest prefix, then longest complete key.
    if (!best || star > best.star || star === best.star && pattern.length > best.pattern.length) best = { pattern, star, suffix }
  }
  return best ? { value: imports[best.pattern], wildcard: specifier.slice(best.star, specifier.length - best.suffix.length) } : null
}

function importTargets(value, wildcard, depth = 0) {
  if (depth > 16) return [null]
  if (typeof value === 'string') return [wildcard === null ? value : value.replaceAll('*', wildcard)]
  // The viewer combines recorded conditions. Conditional/array mappings link
  // only when every possible target agrees; a blocked branch stays blocked.
  if (value && typeof value === 'object') return Object.values(value).flatMap(target => importTargets(target, wildcard, depth + 1))
  return [null]
}

function mappedSource(target, scope, sources, index, recorded, directory) {
  if (typeof target !== 'string' || /[\\\p{Cc}]/u.test(target) || /%2f|%5c/iu.test(target)) return null
  const relative = target.startsWith('./')
  let file = null
  if (relative) {
    let decoded
    try { decoded = decodeURIComponent(target.slice(2)) } catch { return null }
    if (/[\\\p{Cc}]/u.test(decoded) || decoded.split('/').some(part => ['.', '..', 'node_modules'].includes(part.toLowerCase()))) return null
    file = normalizePath(scope.directory + decoded)
  } else if (target.startsWith('../') || target.startsWith('/') || target.startsWith('#') || target.includes(':')) return null
  const keys = new Set([target])
  // Captures may retain the package-relative rewritten spelling or express
  // that same path relative to a nested importing file.
  if (relative) {
    for (const key of recorded?.keys() ?? []) {
      if ((key.startsWith('./') || key.startsWith('../')) && normalizePath(directory + key) === file) keys.add(key)
    }
  }
  let found = false, resolved = null
  for (const key of keys) {
    if (!recorded?.has(key)) continue
    const current = recorded.get(key)
    if (typeof current !== 'string' || !sources.has(current) || found && current !== resolved) return null
    found = true
    resolved = current
  }
  // Exact captured files are useful too, but never guess an extension/index.
  return found ? resolved : relative ? index.get(file) ?? null : null
}

function resolvePackageImport(scope, specifier, sources, index, recorded, directory) {
  const mapping = importMapping(scope?.imports, specifier)
  if (!mapping) return null
  const targets = importTargets(mapping.value, mapping.wildcard)
  let result = null
  for (const target of targets) {
    const resolved = mappedSource(target, scope, sources, index, recorded, directory)
    if (!resolved || result && resolved !== result) return null
    result = resolved
  }
  return result
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

export function sourceLinkResolver(sources, parent, imports = null, packageFiles = sources) {
  let index = indexes.get(sources)
  if (!index) { index = buildIndex(sources); indexes.set(sources, index) }
  let packageIndex = indexes.get(packageFiles)
  if (!packageIndex) { packageIndex = buildIndex(packageFiles); indexes.set(packageFiles, packageIndex) }
  const recorded = imports?.get(parent)
  const directory = parent.slice(0, parent.lastIndexOf('/') + 1)
  const scope = imports ? packageScope(packageFiles, packageIndex, parent) : null
  return (specifier) => {
    if (typeof specifier !== 'string' || /\p{Cc}/u.test(specifier)) return null
    if (recorded?.has(specifier)) {
      const target = recorded.get(specifier)
      return typeof target === 'string' && sources.has(target) ? target : null
    }
    if (specifier.startsWith('#')) return resolvePackageImport(scope, specifier, sources, index, recorded, directory)
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
  return sourceLinkResolver(sources, parent, imports, bundleFilesAsMap(details))
}
