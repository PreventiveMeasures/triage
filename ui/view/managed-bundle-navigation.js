import { managedRouteForIds } from '../../common/managed/routes.js'

export function managedBundleEntry(bundle) {
  return { managedId: bundle.id, slug: bundle.slug, integrity: bundle.integrity,
    kind: bundle.kind, summary: bundle.summary,
    name: bundle.filename, size: bundle.byteSize, repoId: bundle.repoId, repoFullName: bundle.repoFullName, repoDirectory: bundle.repoDirectory ?? '' }
}

// Keep the clicked team when a bundle belongs to several teams. Manage can
// also open an upload that has no accessible team (including unattached ones).
export function managedBundleRoute(teams, entry, teamId, bundleTab = 'overview') {
  if (!entry?.managedId) return null
  const team = teams.find(candidate => candidate.id === teamId && candidate.bundles?.some(bundle => bundle.id === entry.managedId))
  if (teamId != null && !team) return null
  return managedRouteForIds({ view: 'bundles', teamId: team?.id ?? null, bundleId: entry.managedId, bundleTab },
    teams, [{ id: entry.managedId, slug: entry.slug }])
}

export function managedTeamBundleEntries(teams) {
  return [...new Map(teams.flatMap(team => team.bundles ?? []).map(bundle => [bundle.id, managedBundleEntry(bundle)])).values()]
}
