// Aggregate Findings/Files views must contain exactly the current team's
// reports, including newly visible reports that were never loaded before.
export function managedReportViewChanged(state, teams, changedReports) {
  // Management pages can retain the last report's state while it is hidden.
  // Catalog refreshes still invalidate its cache, but must not replace that page.
  if (state.currentView !== 'findings' && state.currentView !== 'files' && state.currentView !== 'links') return false
  if (!state.currentManagedTeam) return false
  const team = teams.find(entry => entry.id === state.currentManagedTeam)
  if (changedReports.has(`team:${state.currentManagedTeam}`)) return true
  if (!team || state.managedReports.some(report => changedReports.has(report.id))) return true
  const available = new Set(team.reports.map(report => report.id))
  if (state.currentManagedReport !== null) return !available.has(state.currentManagedReport)
  const loaded = new Set(state.managedReports.map(report => report.id))
  return available.size !== loaded.size || [...available].some(id => !loaded.has(id))
}

export function managedBundleViewChanged(state, previousTeams, teams, changedReports) {
  const id = state.currentView === 'bundles' ? state.bundleDetails?.managedId : null
  if (!id || !changedReports.has(`bundle:${id}`)) return false
  if (state.currentManagedTeam != null || previousTeams.some(team => team.bundles?.some(bundle => bundle.id === id))) return true
  // Creation can open a Manage bundle before the team catalogue includes it.
  // Discovering the same bundle adds access without changing the loaded view.
  const bundle = teams.flatMap(team => team.bundles ?? []).find(entry => entry.id === id)
  const entry = state.bundles?.find(candidate => candidate.managedId === id)
  return !bundle || !entry || bundle.integrity !== entry.integrity || bundle.filename !== entry.name
    || bundle.repoId !== entry.repoId || bundle.repoFullName !== entry.repoFullName
    || (bundle.repoDirectory ?? '') !== (entry.repoDirectory ?? '')
}
