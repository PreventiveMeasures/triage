import { bundleFileSizes } from './bundle-sources.js'
import { bundleImportsAsMap } from './bundle-imports.js'

// The files a scope can name, read once and only when something asks:
// `sourcePaths` may be an iterator, and a bundle without scopes needs none.
function pathsOf(details, sourcePaths) {
  let paths
  return () => paths ??= new Set(sourcePaths ?? [...bundleFileSizes(details)].filter(([, size]) => size != null).map(([path]) => path))
}

// Each consumer's files as recorded, a malformed one left out.
function recordedReasons(details) {
  const raw = details?.kind === 'stasis' ? details.bundle?.reason : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.entries(raw).filter(([reason, files]) => reason && Array.isArray(files))
}

// Reason metadata attributes files to consumers (run, build plugins, etc.).
// It is informational and can be absent on older/single-consumer bundles.
export function bundleReasons(details, sourcePaths) {
  return reasonsOf(details, pathsOf(details, sourcePaths))
}

function reasonsOf(details, readPaths) {
  const reasons = new Map()
  const recorded = recordedReasons(details)
  if (recorded.length === 0) return reasons
  const paths = readPaths()
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
export function bundleEntryPoints(details, sourcePaths) {
  return entryPointsOf(details, pathsOf(details, sourcePaths))
}

function entryPointsOf(details, readPaths) {
  const recordedEntries = details?.kind === 'stasis' ? [...details.bundle?.entries ?? []] : []
  if (recordedEntries.length < 2) return []
  const paths = readPaths()
  const entries = new Set(recordedEntries.filter((entry) => typeof entry === 'string' && paths.has(entry)))
  if (entries.size < 2) return []
  const recorded = recordedReasons(details)
  const several = (files) => new Set(files.filter((file) => entries.has(file))).size > 1
  if (recorded.length > 0 && !recorded.some(([, files]) => several(files))) return []
  return [...entries].toSorted((a, b) => a.localeCompare(b))
}

// The files of `paths` that `entry` reaches, itself among them. A file the
// bundle doesn't hold is still walked through, by the imports recorded of it.
function reachedFrom(imports, entry, paths) {
  const files = new Set(), queue = [entry], seen = new Set([entry])
  for (let i = 0; i < queue.length; i++) {
    if (paths.has(queue[i])) files.add(queue[i])
    for (const target of imports.get(queue[i]) ?? []) {
      if (!seen.has(target)) { seen.add(target); queue.push(target) }
    }
  }
  return files
}

const ENTRY = 'entry:', REASON = 'reason:'

// What a bundle's views filter by: one of its reasons or one of its entry
// points, never both. A scope's id is `reason:<name>` or `entry:<path>`, and
// '' is every file. An entry point's files are worked out as asked for, each
// time: a bundle may record a hundred of them, most of its files each.
export function bundleScopes(details, sourcePaths) {
  const paths = pathsOf(details, sourcePaths)
  const reasons = reasonsOf(details, paths)
  const entries = entryPointsOf(details, paths)
  const offered = new Set(entries)
  let imports
  const has = (id) => typeof id === 'string'
    && (id.startsWith(REASON) ? reasons.has(id.slice(REASON.length)) : id.startsWith(ENTRY) && offered.has(id.slice(ENTRY.length)))
  return {
    reasons, entries, has,
    // Null for every file: '' and whatever is no scope of this bundle, so a
    // hidden selector never keeps filtering.
    files(id) {
      if (!has(id)) return null
      if (id.startsWith(REASON)) return reasons.get(id.slice(REASON.length))
      return reachedFrom(imports ??= bundleImportsAsMap(details), id.slice(ENTRY.length), paths())
    },
  }
}

// The scope selector's options (ui/view/bundle-scope-selector.js): a reason
// by its name, an entry point by its path, less the directories all of them
// share. As display paths elsewhere, a package's own name is never cut.
export function bundleScopeOptions({ reasons, entries }) {
  const parts = entries.map((entry) => entry.split('/'))
  let shared = 0
  while (parts.length > 1 && parts.every((path) => shared < path.length - 1 && path[shared] === parts[0][shared])) shared++
  if (shared > 0 && parts[0][shared - 1].startsWith('@')) shared--
  if (shared > 0 && parts[0][shared - 1] === 'node_modules') shared--
  return {
    reasons: [...reasons.keys()].map((reason) => ({ id: `${REASON}${reason}`, label: reason })),
    entries: entries.map((entry, i) => ({ id: `${ENTRY}${entry}`, label: parts[i].slice(shared).join('/') })),
  }
}
