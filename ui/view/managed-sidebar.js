export function managedRepositoryPath(item) {
  return item.repoFullName ? `${item.repoFullName}${item.repoDirectory ? `/${item.repoDirectory}` : ''}` : ''
}

export function managedBundleStats(bundle) {
  const summary = bundle.summary
  return summary && [summary.files, summary.lines].every(value => Number.isSafeInteger(value) && value >= 0)
    ? `${summary.files.toLocaleString()} files · ${summary.lines.toLocaleString()} LoC` : ''
}

// Filter only the loaded catalogue. Keep the original team for click handlers
// so opening a team still loads all of its reports, not just the search results.
export function filterManagedTeams(teams, query = '') {
  const needle = query.trim().toLowerCase()
  const matches = name => String(name ?? '').toLowerCase().includes(needle)
  return (Array.isArray(teams) ? teams : []).flatMap(team => {
    const reports = (team.reports ?? []).filter(report => matches(report.filename))
    const bundles = (team.bundles ?? []).filter(bundle => matches(bundle.filename))
    return matches(team.name) || reports.length > 0 || bundles.length > 0 ? [{ team, reports, bundles }] : []
  })
}
