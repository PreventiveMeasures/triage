import { displayName } from '../../common/report-display-name.js'
import { formatBytes } from '../scan/metrics.js'
import { shownManagedBundleId } from './managed-bundle-navigation.js'

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
    const reports = (team.reports ?? []).filter(report => matches(report.filename) || matches(displayName(report.filename ?? '')))
    const bundles = (team.bundles ?? []).filter(bundle => matches(bundle.filename))
    return matches(team.name) || reports.length > 0 || bundles.length > 0 ? [{ team, reports, bundles }] : []
  })
}

// Collapse a team whose reports are all one kind: an App team, or one none of
// whose reports open in App mode alone (the catalog's `appReports`). A team
// mixing the two lists its reports. So, deliberately, does a team whose reports
// each open as App while their combined workspace does not: it has App
// findings that fail to combine, which expanded is where it shows. Local
// workspaces keep their own rule.
export function managedTeamCollapses(app, reportCount) {
  return app?.appMode === true || (app?.appReports === 0 && reportCount > 0)
}

// The findings a collapsed team's badge counts: an App team's App findings,
// any other team's rows. Null when the catalog sent none.
export function managedTeamFindings(app) {
  return (app?.appMode ? app.appFindings : app?.findings) ?? null
}

// Which sections of a compact (App) team or workspace are expanded: revealed
// on navigation to the selection inside them, kept through repaints (a user
// can collapse the selected one), and all shown while a search lasts.
export class SectionExpansion {
  expanded = new Map()
  focus = ''
  // Expand `section` of each id, only when the selection (`focus`) moved.
  reveal(focus, ids, section, force) {
    if (!force && focus === this.focus) return
    this.focus = focus
    for (const id of ids) this.sectionsOf(id).add(section)
  }
  sectionsOf(id) {
    if (!this.expanded.has(id)) this.expanded.set(id, new Set())
    return this.expanded.get(id)
  }
  toggle(id, section) {
    const expanded = this.sectionsOf(id)
    if (!expanded.delete(section)) expanded.add(section)
  }
  shown(id, section, compact, search) {
    return !compact || search || this.expanded.get(id)?.has(section) === true
  }
}

// The teams' sections, reset with the account and pruned of teams gone.
export class ManagedTeamSections extends SectionExpansion {
  sync(state, force = false) {
    const owner = JSON.stringify([state.managedSession?.id, state.managedSession?.role, state.managedSession?.csrfToken])
    if (owner !== this.owner) { this.expanded.clear(); this.focus = ''; this.owner = owner }
    const teams = state.managedTeams ?? []
    for (const id of this.expanded.keys()) if (!teams.some(team => team.id === id)) this.expanded.delete(id)
    const bundle = shownManagedBundleId(state)
    const report = ['findings', 'files', 'links'].includes(state.currentView) ? state.currentManagedReport : null
    const section = bundle ? 'bundles' : 'reports'
    const team = teams.find(candidate => candidate.id === state.currentManagedTeam
      && (bundle ? candidate.bundles?.some(b => b.id === bundle) : candidate.reports?.some(r => r.id === report)))
    this.reveal(JSON.stringify([section, bundle || report, team?.id]), team ? [team.id] : [], section, force)
  }
}
