// Aggregate Findings/Files views must contain exactly the current team's
// reports, including newly visible reports that were never loaded before.
export function managedReportViewChanged(state, teams, changedReports) {
  // Management pages can retain the last report's state while it is hidden.
  // Catalog refreshes still invalidate its cache, but must not replace that page.
  if (state.currentView !== 'findings' && state.currentView !== 'files') return false
  if (!state.currentManagedTeam) return false
  const team = teams.find(entry => entry.id === state.currentManagedTeam)
  if (!team || state.managedReports.some(report => changedReports.has(report.id))) return true
  const available = new Set(team.reports.map(report => report.id))
  if (state.currentManagedReport !== null) return !available.has(state.currentManagedReport)
  const loaded = new Set(state.managedReports.map(report => report.id))
  return available.size !== loaded.size || [...available].some(id => !loaded.has(id))
}
