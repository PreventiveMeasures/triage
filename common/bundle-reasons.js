import { bundleFileSizes } from './bundle-sources.js'
import { bundleImportsAsMap } from './bundle-imports.js'

const sizedPaths = (details) => [...bundleFileSizes(details)].filter(([, size]) => size != null).map(([path]) => path)

// Reason metadata attributes files to consumers (run, build plugins, etc.).
// It is informational and can be absent on older/single-consumer bundles.
export function bundleReasons(details, sourcePaths) {
  const reasons = new Map()
  const raw = details?.kind === 'stasis' ? details.bundle?.reason : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reasons
  const paths = new Set(sourcePaths ?? sizedPaths(details))
  for (const [reason, files] of Object.entries(raw).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!reason || !Array.isArray(files)) continue
    const present = new Set(files.filter((file) => typeof file === 'string' && paths.has(file)))
    if (present.size > 0) reasons.set(reason, present)
  }
  // A reason is only useful as a filter if it changes the set of files.
  // Keep all named options when at least one differs, otherwise hide the
  // selector (and discard any stale selection) in every visualization.
  if (![...reasons.values()].some((files) => files.size < paths.size)) reasons.clear()
  return reasons
}

// What a bundle's views filter by, each by its id: a reason (`reason:<name>`),
// or one of its entry points instead (`entry:<path>`), by the files it reaches
// through the recorded imports. Entry points are offered only where some
// reason records more than one of them, a bundle recording no reasons
// counting as one: with one each, a reason's files already are its entry
// point's.
export function bundleScopes(details, sourcePaths) {
  const given = sourcePaths && [...sourcePaths]
  const reasons = bundleReasons(details, given)
  const recorded = details?.kind === 'stasis' ? [...details.bundle?.entries ?? []] : []
  const paths = new Set(recorded.length > 1 ? given ?? sizedPaths(details) : [])
  const entries = new Set(recorded.filter((entry) => paths.has(entry)))
  const lists = Object.values(details?.bundle?.reason ?? {}).filter(Array.isArray)
  const several = (files) => new Set(files.filter((file) => entries.has(file))).size > 1
  if (entries.size < 2 || (lists.length > 0 && !lists.some(several))) entries.clear()
  const ids = [...[...reasons.keys()].map((reason) => `reason:${reason}`), ...[...entries].toSorted().map((entry) => `entry:${entry}`)]
  return {
    ids,
    has: (id) => ids.includes(id),
    // A scope's files; null, for every file, for an id that is none of them.
    files(id) {
      if (!ids.includes(id)) return null
      if (id.startsWith('reason:')) return reasons.get(scopeLabel(id))
      const imports = bundleImportsAsMap(details), reached = new Set([scopeLabel(id)])
      // A Set is walked through what is added to it on the way.
      for (const file of reached) for (const target of imports.get(file) ?? []) reached.add(target)
      return new Set([...reached].filter((file) => paths.has(file)))
    },
  }
}

// A scope's name as shown: its reason's, or its entry point's path.
export const scopeLabel = (id) => id.slice(id.indexOf(':') + 1)
export const scopeOptions = (scopes) => scopes.ids.map((id) => ({ id, label: scopeLabel(id) }))
