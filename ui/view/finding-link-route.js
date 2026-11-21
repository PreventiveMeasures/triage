// Where a link's finding is: its report or workspace, resolved before what
// is loaded is looked in, as the same id can show in a workspace and each
// of its reports, and a loaded copy must not override the one the link
// names.
import { computeLinkHint, findReportWithFinding, isManagedUiMode, reportForHint, state, workspaceForHint } from '#client/index.js'
import { loadManagedFindings } from '../../common/managed/report-content.ts'
import { fetchTeamReports } from './client-managed.js'
import { findLoadedFinding, reportWorkspaceFor } from './finding-link.js'

// Report chips carry their server identity separately from the display name.
// Never fall back to local storage for a managed report (or a stale managed
// chip after switching to local), even if a local filename happens to match.
export async function locateReportFinding(id, reportName, managedReportId, { openReport, openManagedReport }) {
  if (isManagedUiMode()) {
    const team = state.managedTeams.find((t) => t.id === state.currentManagedTeam)
    if (!managedReportId || !team?.reports.some((r) => r.id === managedReportId)) return null
    if ((state.currentManagedReport !== managedReportId || state.currentWorkspace)
        && !await openManagedReport(team, managedReportId)) return null
    if (!isManagedUiMode() || state.currentManagedTeam !== team.id
        || state.currentManagedReport !== managedReportId || state.currentWorkspace) return null
  } else {
    if (managedReportId) return null
    if (state.currentFile !== reportName || state.currentWorkspace) await openReport(reportName)
    if (isManagedUiMode() || state.currentFile !== reportName || state.currentWorkspace) return null
  }
  return findLoadedFinding(id)
}

// Navigation is supplied by the DOM layer so these rules can be tested
// against real stored reports without constructing the whole page.
export async function locateLinkedFinding(ref, navigation) {
  if (isManagedUiMode()) return locateManagedFinding(ref, navigation)
  const { openReport, openWorkspace } = navigation
  const [name, ws] = await Promise.all([
    reportForHint(ref.report),
    workspaceForHint(ref.workspace),
  ])

  async function inReport(reportName) {
    const workspaceId = reportWorkspaceFor(reportName, ws?.id)
    if (state.currentFile !== reportName || state.currentWorkspace
        || state.currentReportWorkspace !== workspaceId) {
      await openReport(reportName, undefined, { workspaceId })
    }
    return findLoadedFinding(ref.id)
  }

  // Both hints mean workspace → report → finding. Only a workspace
  // hint means workspace → finding. Report-only links also remain
  // report links when the local file has since joined a workspace.
  if (name) {
    const hit = await inReport(name)
    if (hit) return hit
  }
  if (ws) {
    if (state.currentWorkspace !== ws.id) await openWorkspace(ws.id)
    const hit = findLoadedFinding(ref.id)
    if (hit) return hit
  }
  const loadedHit = findLoadedFinding(ref.id)
  if (loadedHit) return loadedHit

  // Hints can be stale or unavailable on this browser. Fall back to a
  // local scan, without forcing an unrelated workspace's merged view.
  const loaded = state.reports.map((r) => r.fileName).filter(Boolean)
  const found = await findReportWithFinding(ref.id, { skip: loaded })
  return found ? await inReport(found) : null
}

// A managed link resolves only within the signed-in user's team catalogue
// and permission-filtered report endpoint. Only the finding has to match: a
// managed URL's team and report, like E2E hints, say which copy to prefer,
// and an unmatched one falls back to the finding's identity.
async function locateManagedFinding(ref, { openManagedReport, readTeam = fetchTeamReports, isCurrent = () => true }) {
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
  // user's, or without the finding, the nearest copy does: another report of
  // its team; then its report in another team; then any, as a link naming
  // neither finds one below.
  if (ref.teamId || ref.reportId) {
    const named = teams.find(team => team.id === ref.teamId)
    const holders = teams.filter(team => ref.reportId && team.reports.some(report => report.id === ref.reportId))
    const load = async team => {
      const hit = await open(team, ref.reportId ?? null)
      checked.add(`${team.id}:${ref.reportId}`)
      return hit
    }
    for (const step of [
      () => named && (ref.teamOnly || holders.includes(named)) ? load(named) : null,
      () => named && !ref.teamOnly ? search(candidates.filter(({ team }) => team === named)) : null,
      ...holders.filter(team => team !== named).map(team => () => load(team)),
    ]) {
      const hit = await step()
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
