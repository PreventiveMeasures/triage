import { bundleSourceOrder, bundleSourcesAsMap } from '../../common/bundle-sources.js'
import { compareModeField, managedRouteForIds } from '../../common/managed/routes.js'
import { bundleComparisonCandidates } from './bundle-comparison-candidates.js'

export function managedBundleEntry(bundle) {
  return { managedId: bundle.id, slug: bundle.slug, integrity: bundle.integrity,
    kind: bundle.kind, summary: bundle.summary, commitInfo: bundle.commitInfo ?? null,
    name: bundle.filename, size: bundle.byteSize, repoId: bundle.repoId, repoFullName: bundle.repoFullName, repoDirectory: bundle.repoDirectory ?? '' }
}

// The managed bundle the bundles view shows: its details', or until its
// metadata arrives, the catalogue entry it opened from.
export function shownManagedBundleId(state) {
  if (state.currentView !== 'bundles') return null
  if (state.bundleDetails) return state.bundleDetails.managedId ?? null
  return state.bundles?.find(entry => entry.integrity === state.selectedBundle)?.managedId ?? null
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
// for, and `code` while it reviews the changes as a diff. Only while Compare
// still offers it: a refreshed catalogue can move either bundle to another
// repository.
export function managedCompareLocation(state, tab = state.bundleDetailsTab) {
  const compare = state.bundleCompare
  if (tab !== 'compare' || !compare?.target || compare.bundle !== state.selectedBundle) return null
  // An npm package version compares with another version, by its number.
  if (state.bundles?.find(bundle => bundle.integrity === state.selectedBundle)?.npm) {
    return { compareSpec: compare.target, ...compareModeField(compare.mode) }
  }
  const target = bundleComparisonCandidates(state.bundles ?? [], state.selectedBundle).find(bundle => bundle.integrity === compare.target)
  if (!target?.managedId) return null
  return { compareId: target.managedId, ...compareModeField(compare.mode) }
}

// The open bundle's tab location, whichever tab names one (Code, Compare).
export function managedTabLocation(state, tab = state.bundleDetailsTab) {
  const npm = state.bundles?.find(entry => entry.integrity === state.selectedBundle)?.npm
  const review = state.npmReview?.bundle === state.selectedBundle ? state.npmReview : null
  const compare = state.bundleCompare?.bundle === state.selectedBundle ? state.bundleCompare : null
  if (npm && tab === 'review' && state.bundleDetailsTab === 'compare' && compare?.target
    && !(review?.started && review.user === state.managedSession?.id)) {
    return { reviewPackage: npm.name, reviewSpec: compare.target, ...(compare.mode === 'diff' ? { reviewMode: 'diff' } : {}) }
  }
  if (npm && tab === 'compare' && state.bundleDetailsTab === 'review' && review?.reviewPackage === npm.name) {
    return { compareSpec: review.reviewSpec, ...compareModeField(review.reviewMode === 'diff' ? 'diff' : compare?.mode ?? 'code') }
  }
  if (tab === 'review' && review) {
    const { bundle: _bundle, started: _started, user: _user, resume: _resume, ...location } = review
    return location
  }
  return managedCodeLocation(state, tab) ?? managedCompareLocation(state, tab)
}

// Tab clicks change state before persisting their route. Carry the comparison
// across that boundary, keeping an already-started review's original base.
export function prepareNpmReviewTab(state, tab) {
  if (!state.bundles?.find(entry => entry.integrity === state.selectedBundle)?.npm || tab === state.bundleDetailsTab) return
  const location = managedTabLocation(state, tab)
  if (tab === 'review') {
    const kept = state.npmReview?.bundle === state.selectedBundle && state.npmReview.started && state.npmReview.user === state.managedSession?.id
    state.npmReview = { ...(kept ? state.npmReview : { bundle: state.selectedBundle, ...location }), resume: true }
  }
  if (tab === 'compare' && state.bundleDetailsTab === 'review' && location?.compareSpec) {
    state.bundleCompare = { bundle: state.selectedBundle, target: location.compareSpec, mode: location.compareMode ?? 'overview' }
  }
}

export function managedTeamBundleEntries(teams) {
  return [...new Map(teams.flatMap(team => team.bundles ?? []).map(bundle => [bundle.id, managedBundleEntry(bundle)])).values()]
}
