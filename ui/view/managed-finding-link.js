import { computeLinkHint, isManagedUiMode, state } from '#client/index.js'
import { loadManagedFindings } from '../../common/managed/report-content.ts'
import { fetchReport } from './client-managed.js'
import { findLoadedFinding } from './finding-link.js'

// Resolve only within the signed-in user's team catalogue and permission-
// filtered report endpoint. E2E hints remain useful after importing a report;
// an unmatched workspace or renamed report falls back to its finding identity.
export async function locateManagedFinding(ref, { openManagedReport, readReport = fetchReport, isCurrent = () => true }) {
  const session = state.managedSession
  const current = () => isCurrent() && isManagedUiMode()
    && state.managedSession?.id === session?.id && state.managedSession?.role === session?.role
  const teams = state.managedTeams
  if (!current()) return null

  async function open(team, reportId) {
    if (!current()) return null
    if ((state.currentManagedTeam !== team.id || state.currentManagedReport !== reportId)
        && !await openManagedReport(team, reportId)) return null
    if (!current() || state.currentManagedTeam !== team.id || state.currentManagedReport !== reportId) return null
    return findLoadedFinding(ref.id)
  }

  // An explicit managed URL names the copy to open, even if another report
  // already contains that id. Missing/inaccessible routes cannot pick a copy.
  if (ref.teamId) {
    const team = teams.find(item => item.id === ref.teamId)
    if (!team || ref.reportId && !team.reports.some(report => report.id === ref.reportId)) return null
    return open(team, ref.reportId ?? null)
  }

  const candidates = teams.flatMap(team => team.reports.map(report => ({ team, report })))
  const checked = new Set()
  async function search(entries) {
    for (const { team, report } of entries) {
      if (!current()) return null
      if (checked.has(report.id)) continue
      checked.add(report.id)
      const content = await readReport(report.id)
      if (!current()) return null
      if (content == null) continue
      const parsed = await loadManagedFindings(content, report.filename)
      if (!current()) return null
      if (parsed?.findings.some(finding => finding.id === ref.id)) return open(team, report.id)
    }
    return null
  }

  if (ref.report) {
    const hints = await Promise.all(candidates.map(({ report }) => computeLinkHint('report', report.filename)))
    const hit = await search(candidates.filter((_, index) => hints[index] === ref.report))
    if (hit || !current()) return hit
  }
  if (ref.workspace) {
    const hints = await Promise.all(teams.map(team => computeLinkHint('workspace', `managed-team:${team.id}`)))
    const team = teams[hints.indexOf(ref.workspace)]
    if (team) {
      const hit = await open(team, null)
      if (hit || !current()) return hit
    }
  }
  if (!current()) return null
  const team = teams.find(item => item.id === state.currentManagedTeam)
  if (team && (state.currentManagedReport == null || team.reports.some(report => report.id === state.currentManagedReport))) {
    const hit = findLoadedFinding(ref.id)
    if (hit) return hit
  }
  return search(candidates)
}
