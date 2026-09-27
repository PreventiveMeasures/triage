import { bundleFileSizes } from './bundle-sources.js'

// Reason metadata attributes files to consumers (run, build plugins, etc.).
// It is informational and can be absent on older/single-consumer bundles.
export function bundleReasons(details, sourcePaths) {
  const reasons = new Map()
  const raw = details?.kind === 'stasis' ? details.bundle?.reason : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reasons
  const paths = new Set(sourcePaths ?? [...bundleFileSizes(details)].filter(([, size]) => size != null).map(([path]) => path))
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

