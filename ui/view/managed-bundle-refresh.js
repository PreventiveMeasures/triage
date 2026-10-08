import { managedBundleEntry, managedBundleRoute, managedTeamBundleEntries } from './managed-bundle-navigation.js'

// Bundle contents are immutable. Refresh their authorized catalogue entries
// without resetting the loaded sources, tab, search, graph or file history.
export async function refreshManagedBundleView(state, teams, { fetchCatalog, isCurrent, render, replaceRoute }) {
  const id = state.currentView === 'bundles' ? state.bundleDetails?.managedId : null
  if (!id || !isCurrent()) return true
  const canManage = ['admin', 'manage'].includes(state.managedSession?.role)
  let entries, team = null
  if (state.currentManagedTeam != null || !canManage) {
    const containsBundle = candidate => candidate.bundles?.some(bundle => bundle.id === id)
    team = teams.find(candidate => candidate.id === state.currentManagedTeam && containsBundle(candidate))
      ?? teams.find(containsBundle)
  }
  if (team) entries = managedTeamBundleEntries(teams)
  else if (canManage) {
    // Manage also includes uploads outside the user's teams. Its own fresh
    // catalogue must confirm access, including after a bundle is detached.
    try { entries = (await fetchCatalog()).map(managedBundleEntry) }
    catch (err) {
      if (err.status !== 401 && err.status !== 403) throw err
      entries = []
    }
  } else entries = []
  if (!isCurrent()) return true
  const entry = entries.find(candidate => candidate.managedId === id)
  if (!entry) return false
  state.bundles = entries
  state.currentManagedTeam = team?.id ?? null
  render()
  // Rendering can fall back from Advisories when security access is lost.
  replaceRoute(managedBundleRoute(teams, entry, state.currentManagedTeam, state.bundleDetailsTab))
  return true
}
