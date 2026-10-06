import { formatBytes } from '../scan/metrics.js'

export function managedRepositoryPath(item) {
  return item.repoFullName ? `${item.repoFullName}${item.repoDirectory ? `/${item.repoDirectory}` : ''}` : ''
}

export function managedBundleStats(bundle) {
  const summary = bundle.summary
  const parts = []
  if (Number.isSafeInteger(bundle.byteSize) && bundle.byteSize >= 0) parts.push(formatBytes(bundle.byteSize))
  if (summary && [summary.files, summary.lines].every(value => Number.isSafeInteger(value) && value >= 0)) {
    parts.push(`${summary.files.toLocaleString()} files`, `${summary.lines.toLocaleString()} LoC`)
  }
  return parts.join(' · ')
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

// Match local workspace section behavior: reveal selection on navigation,
// preserve manual collapse on repaint, and reveal search results temporarily.
export class ManagedTeamSections {
  constructor() { this.expanded = new Map() }
  sync(state, force = false) {
    const owner = JSON.stringify([state.managedSession?.id, state.managedSession?.role, state.managedSession?.csrfToken])
    if (owner !== this.owner) { this.expanded.clear(); this.focus = ''; this.owner = owner }
    const teams = state.managedTeams ?? []
    for (const id of this.expanded.keys()) if (!teams.some(team => team.id === id)) this.expanded.delete(id)
    const bundle = state.currentView === 'bundles' ? state.bundleDetails?.managedId : null
    const report = ['findings', 'files', 'links'].includes(state.currentView) ? state.currentManagedReport : null
    const section = bundle ? 'bundles' : 'reports'
    const team = teams.find(candidate => candidate.id === state.currentManagedTeam
      && (bundle ? candidate.bundles?.some(b => b.id === bundle) : candidate.reports?.some(r => r.id === report)))
    const focus = JSON.stringify([section, bundle || report, team?.id])
    if (!force && focus === this.focus) return
    this.focus = focus
    if (team) {
      const expanded = this.expanded.get(team.id) ?? new Set()
      expanded.add(section)
      this.expanded.set(team.id, expanded)
    }
  }
  toggle(id, section) {
    const expanded = this.expanded.get(id) ?? new Set()
    if (expanded.has(section)) expanded.delete(section)
    else expanded.add(section)
    this.expanded.set(id, expanded)
  }
  shown(id, section, compact, search) {
    return !compact || search || this.expanded.get(id)?.has(section) === true
  }
}
