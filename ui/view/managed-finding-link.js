import { computeLinkHint, isManagedUiMode, state } from '#client/index.js'
import { loadManagedFindings } from '../../common/managed/report-content.ts'
import { fetchTeamReports } from './client-managed.js'
import { findLoadedFinding } from './finding-link.js'

// Resolve only within the signed-in user's team catalogue and permission-
// filtered report endpoint. Only the finding has to match: a managed URL's
// team and report, like E2E hints, which remain useful after importing a
// report, say which copy to prefer, and an unmatched one falls back to the
// finding's identity.
export async function locateManagedFinding(ref, { openManagedReport, readTeam = fetchTeamReports, isCurrent = () => true }) {
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

  const candidates = teams.flatMap(team => team.reports.map(report => ({ team, report })))
  const checked = new Set(), loadedTeams = new Map()
  // The first of `entries` whose report holds the finding, opened: that
  // report, or, for a link to a team's own findings (`teamOnly`), its team.
  async function search(entries) {
    for (const { team, report } of entries) {
      if (!current()) return null
      if (checked.has(`${team.id}:${report.id}`)) continue
      checked.add(`${team.id}:${report.id}`)
      if (!loadedTeams.has(team.id)) loadedTeams.set(team.id, await readTeam(team.id))
      const content = loadedTeams.get(team.id)?.find(entry => entry.id === report.id)
      if (!current()) return null
      if (content == null) continue
      // The endpoint returns parsed data; the finding loader takes text and
      // backfills IDs on its own copy, leaving the shared report cache intact.
      const parsed = await loadManagedFindings(JSON.stringify(content.data), report.filename)
      if (!current()) return null
      if (parsed?.findings.some(finding => finding.id === ref.id)) return open(team, ref.teamOnly ? null : report.id)
    }
    return null
  }

  // A managed URL names the copy to open, a report's in a team or the team's
  // own (common/managed/routes.js resolveManagedRoute), and that copy opens
  // even if another report holds the id too. Where it is gone, not this
  // user's to open, or without the finding, the nearest copy does: its report
  // in another team, the same findings and annotations, read as the link's
  // own is, by the loader, which reads a hidden report too; then another
  // report of its team; then any, as a link naming neither finds one below.
  if (ref.teamId || ref.reportId) {
    const named = teams.find(team => team.id === ref.teamId)
    const copies = ref.teamOnly ? teams.filter(team => team === named)
      : teams.filter(team => ref.reportId && team.reports.some(report => report.id === ref.reportId)).toSorted((a, b) => (b === named) - (a === named))
    for (const team of copies) {
      const hit = await open(team, ref.reportId ?? null)
      if (hit || !current()) return hit
      checked.add(`${team.id}:${ref.reportId}`)
    }
    if (named && !ref.teamOnly) {
      const hit = await search(candidates.filter(({ team }) => team === named))
      if (hit || !current()) return hit
    }
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
