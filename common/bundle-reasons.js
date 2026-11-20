import { bundleFileSizes } from './bundle-sources.js'
import { bundleImportsAsMap } from './bundle-imports.js'
import { stripCommonPathPrefix } from './bundle-pkg-of.js'

const ENTRY = 'entry:', REASON = 'reason:'

// A scope's id: a reason's by its name, an entry point's by its path. '' is
// every file.
export const reasonScope = (reason) => `${REASON}${reason}`
export const entryScope = (entry) => `${ENTRY}${entry}`

// What a scope id names: `{ reason }` or `{ entry }`, neither for any other.
export function scopeParts(id) {
  if (typeof id !== 'string') return {}
  if (id.startsWith(REASON)) return { reason: id.slice(REASON.length) }
  return id.startsWith(ENTRY) ? { entry: id.slice(ENTRY.length) } : {}
}

// Each consumer's files as recorded, a malformed one left out.
function recordedReasons(details) {
  const raw = details?.kind === 'stasis' ? details.bundle?.reason : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.entries(raw).filter(([reason, files]) => reason && Array.isArray(files))
}

// Reason metadata attributes files to consumers (run, build plugins, etc.).
// It is informational and can be absent on older/single-consumer bundles.
function reasonsOf(recorded, paths) {
  const reasons = new Map()
  for (const [reason, files] of recorded.toSorted(([a], [b]) => a.localeCompare(b))) {
    const present = new Set(files.filter((file) => typeof file === 'string' && paths.has(file)))
    if (present.size > 0) reasons.set(reason, present)
  }
  // A reason is only useful as a filter if it changes the set of files.
  // Keep all named options when at least one differs, otherwise hide the
  // selector (and discard any stale selection) in every visualization.
  if (![...reasons.values()].some((files) => files.size < paths.size)) reasons.clear()
  return reasons
}

// An entry point is a filter too, the alternative to a reason: the files it
// reaches through the recorded imports. Offered only where some reason
// records more than one entry point: with one each, a reason's files already
// are its entry point's. A bundle recording no reasons counts as one, whole.
// Only an entry point the bundle holds the file of is one to filter by.
function entryPointsOf(recordedEntries, recorded, paths) {
  const entries = new Set(recordedEntries.filter((entry) => typeof entry === 'string' && paths.has(entry)))
  if (entries.size < 2) return []
  const several = (files) => new Set(files.filter((file) => entries.has(file))).size > 1
  if (recorded.length > 0 && !recorded.some(([, files]) => several(files))) return []
  return [...entries].toSorted((a, b) => a.localeCompare(b))
}

// The imports by number, for walks from many entry points: each file's index,
// those of the files it imports, and its path where it is one of `paths`.
function importGraph(imports, paths) {
  const held = [], index = new Map(), targets = []
  const at = (file) => {
    if (!index.has(file)) { index.set(file, index.size); targets.push(null); held.push(paths.has(file) ? file : null) }
    return index.get(file)
  }
  for (const [parent, files] of imports) targets[at(parent)] = [...files].map((file) => at(file))
  return { held, index, targets }
}

// The files of `paths` that `entry` reaches, itself among them. A file the
// bundle doesn't hold is still walked through, by the imports recorded of it.
function reachedFrom({ held, index, targets }, entry, paths) {
  if (!index.has(entry)) return new Set(paths.has(entry) ? [entry] : [])
  const queue = [index.get(entry)], seen = new Uint8Array(index.size)
  seen[queue[0]] = 1
  for (let i = 0; i < queue.length; i++) {
    for (const to of targets[queue[i]] ?? []) {
      if (!seen[to]) { seen[to] = 1; queue.push(to) }
    }
  }
  return new Set(queue.map((at) => held[at]).filter((file) => file !== null))
}

// What a bundle's views filter by: one of its reasons or one of its entry
// points, never both, each by its id (`ids`: the reasons', then the entry
// points'). An entry point's files are worked out as asked for, each time: a
// bundle may record a hundred of them, most of its files each. A bundle
// recording neither reasons nor several entry points has no scopes, and its
// files are not read.
export function bundleScopes(details, sourcePaths) {
  const recorded = recordedReasons(details)
  const recordedEntries = details?.kind === 'stasis' ? [...details.bundle?.entries ?? []] : []
  const scoped = recorded.length > 0 || recordedEntries.length > 1
  const paths = new Set(scoped ? sourcePaths ?? [...bundleFileSizes(details)].filter(([, size]) => size != null).map(([path]) => path) : [])
  const reasons = reasonsOf(recorded, paths)
  const entries = entryPointsOf(recordedEntries, recorded, paths)
  const ids = [...[...reasons.keys()].map(reasonScope), ...entries.map(entryScope)]
  const offered = new Set(ids)
  let graph
  return {
    reasons, entries, ids,
    has: (id) => offered.has(id),
    // Null for every file: '' and whatever is no scope of this bundle, so a
    // hidden selector never keeps filtering.
    files(id) {
      if (!offered.has(id)) return null
      const { entry, reason } = scopeParts(id)
      if (reason !== undefined) return reasons.get(reason)
      return reachedFrom(graph ??= importGraph(bundleImportsAsMap(details), paths), entry, paths)
    },
  }
}

// The scope selector's options (ui/view/bundle-scope-selector.js): a reason
// by its name, an entry point by its path, less the directories all of them
// share (stripCommonPathPrefix).
export function bundleScopeOptions({ reasons, entries }) {
  const labels = stripCommonPathPrefix(entries).stripped
  return {
    reasons: [...reasons.keys()].map((reason) => ({ id: reasonScope(reason), label: reason })),
    entries: entries.map((entry, i) => ({ id: entryScope(entry), label: labels[i] })),
  }
}
