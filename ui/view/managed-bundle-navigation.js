import { bundleSourceOrder, bundleSourcesAsMap } from '../../common/bundle-sources.js'
import { managedRouteForIds } from '../../common/managed/routes.js'

export function managedBundleEntry(bundle) {
  return { managedId: bundle.id, slug: bundle.slug, integrity: bundle.integrity,
    kind: bundle.kind, summary: bundle.summary, commitInfo: bundle.commitInfo ?? null,
    name: bundle.filename, size: bundle.byteSize, repoId: bundle.repoId, repoFullName: bundle.repoFullName, repoDirectory: bundle.repoDirectory ?? '' }
}

// Keep the clicked team when a bundle belongs to several teams. Manage can
// also open an upload that has no accessible team (including unattached ones).
// `location` places the tab: Code's open file, `{ file, line, endLine }`,
// numbered from 1 (see managedRoutePath), or Compare's
// `{ compareId, compareMode }`, the bundle compared with among `entries`.
export function managedBundleRoute(teams, entry, teamId, bundleTab = 'overview', location = null, entries = [entry]) {
  if (!entry?.managedId) return null
  const team = teams.find(candidate => candidate.id === teamId && candidate.bundles?.some(bundle => bundle.id === entry.managedId))
  if (teamId != null && !team) return null
  const known = [entry, ...entries.filter(other => other.managedId && other.managedId === location?.compareId)]
  return managedRouteForIds({ view: 'bundles', teamId: team?.id ?? null, bundleId: entry.managedId, bundleTab, ...location },
    teams, known.map(bundle => ({ id: bundle.managedId, slug: bundle.slug })))
}

// Where a route for the open bundle puts its Code tab, so a rewrite of that
// route keeps it: the file shown, by number, with its marked lines, or while
// the sources a link numbers still load, the file and lines it asked for. A
// file asked for by path has no number until they do.
export function managedCodeLocation(state, tab = state.bundleDetailsTab) {
  if (tab !== 'code') return null
  const request = state.bundleCodeFileRequest
  if (request?.bundle === state.selectedBundle) {
    if (request.file == null) return null
    const { bundle: _bundle, ...location } = request
    return location
  }
  if (!state.bundleSourceFile || state.bundleDetails?.integrity !== state.selectedBundle) return null
  const file = bundleSourceOrder(bundleSourcesAsMap(state.bundleDetails)).numbers.get(state.bundleSourceFile)
  if (file == null) return null
  const target = state.bundleSourceTargetLine
  if (target?.bundle !== state.selectedBundle || target.path !== state.bundleSourceFile) return { file }
  return { file, line: target.line, ...(target.end > target.line ? { endLine: target.end } : {}) }
}

// Where a route for the open bundle puts its Compare tab: the bundle it
// compares with, as Compare last told (`state.bundleCompare`) or a link asked
// for, and `code` while it reviews the changes as a diff.
export function managedCompareLocation(state, tab = state.bundleDetailsTab) {
  const compare = state.bundleCompare
  if (tab !== 'compare' || !compare?.target || compare.bundle !== state.selectedBundle) return null
  const target = (state.bundles ?? []).find(bundle => bundle.integrity === compare.target)
  if (!target?.managedId) return null
  return { compareId: target.managedId, ...(compare.mode === 'code' ? { compareMode: 'code' } : {}) }
}

// The open bundle's tab location, whichever tab names one (Code, Compare).
export function managedTabLocation(state, tab = state.bundleDetailsTab) {
  return managedCodeLocation(state, tab) ?? managedCompareLocation(state, tab)
}

export function managedTeamBundleEntries(teams) {
  return [...new Map(teams.flatMap(team => team.bundles ?? []).map(bundle => [bundle.id, managedBundleEntry(bundle)])).values()]
}
