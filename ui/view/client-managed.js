// Lazy proxy for managed API calls and Manage custom elements.
// Mirrors view/client-sync.js: the heavy module is dynamically imported via a
// variable path so esbuild keeps it — and any future managed payload — out of
// the main view bundle. The browser resolves the path against the page URL.
import { state } from '#client/index.js'
import { managedHistory } from './managed-history.js'
import { canViewFindingHistory } from './finding-history.js'

let loadPromise = null
let managedModule = null

// Synchronous reads/reset never load the chunk on an E2E or standalone visit.
export function getPreviewRole() { return managedModule?.getPreviewRole() ?? null }
export function clearPreviewRole() { managedModule?.setPreviewRole(null) }
export function resetManagedAppState() { managedModule?.resetManagedAppState() }
export function setManagedAppSession(session) { managedModule?.setManagedAppSession(session) }
export function setManagedReportCatalog(teams) { return managedModule?.setManagedReportCatalog(teams) ?? new Set() }
export function readReportSources(id, teamId = state.currentManagedTeam) { return managedModule?.readReportSources(id, teamId) }
export function clearReportSources() {
  managedModule?.clearReportSources()
  managedModule?.clearFindingHistory()
}
export async function fetchReportSources(id, teamId = state.currentManagedTeam) { return (await loadManagedBundle()).fetchReportSources(id, teamId) }

export function loadManagedBundle() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const path = './client-managed.js'
    try {
      managedModule = await import(path)
      return managedModule
    } catch (err) {
      // Don't pin a rejected promise — a transient failure would replay
      // forever; reset so the next call retries from scratch.
      loadPromise = null
      throw err
    }
  })()
  return loadPromise
}

export async function probeSession(options) {
  return (await loadManagedBundle()).probeSession(options)
}

export async function probeTeams(options) {
  return (await loadManagedBundle()).probeTeams(options)
}

export async function fetchManagedBundleCatalog(options) {
  return (await loadManagedBundle()).fetchManagedBundleCatalog(options)
}

export async function openManagedShareDialog(team) {
  return (await loadManagedBundle()).openManagedShareDialog(team, '', state.managedSession)
}

export async function openManagedIssueDialog(props) {
  const isCurrent = () => state.managedSession?.id === props.session.id
    && state.managedSession?.csrfToken === props.session.csrfToken && state.currentManagedTeam === props.teamId
  const managed = await loadManagedBundle()
  if (!isCurrent()) return null
  return managed.openManagedIssueDialog({ ...props, isCurrent })
}

export async function openFindingHistoryDialog(finding) {
  if (!canViewFindingHistory(finding)) return null
  const reports = state.reports, session = state.managedSession, teamId = state.currentManagedTeam
  const isCurrent = () => canViewFindingHistory(finding) && state.managedSession === session
    && state.currentManagedTeam === teamId && state.reports === reports
  const managed = await loadManagedBundle()
  if (!isCurrent()) return null
  return managed.openFindingHistoryDialog({ finding, teamId, isCurrent })
}

export async function fetchReport(id) {
  return (await loadManagedBundle()).fetchReport(id)
}

export async function fetchReports(ids) {
  return (await loadManagedBundle()).fetchReports(ids)
}

export async function fetchTeamAnnotations(teamId, options) {
  return (await loadManagedBundle()).fetchTeamAnnotations(teamId, options)
}

export async function fetchReportTriage(id, teamId = state.currentManagedTeam, options) {
  return (await loadManagedBundle()).fetchReportTriage(id, teamId, options)
}

export async function fetchFixes(teamId, signal, reportId) {
  return (await loadManagedBundle()).fetchFixes(teamId, signal, reportId)
}

export async function fetchReportComments(id, teamId = state.currentManagedTeam, options) {
  return (await loadManagedBundle()).fetchReportComments(id, teamId, options)
}

export async function saveReportComment(reportId, entry, csrfToken, teamId = state.currentManagedTeam) {
  return (await loadManagedBundle()).saveReportComment(reportId, entry, csrfToken, teamId)
}

export async function deleteReportComment(reportId, commentId, version, csrfToken, teamId = state.currentManagedTeam) {
  return (await loadManagedBundle()).deleteReportComment(reportId, commentId, version, csrfToken, teamId)
}

export async function pushReportTriage(id, entries, csrfToken, teamId = state.currentManagedTeam) {
  return (await loadManagedBundle()).pushReportTriage(id, entries, csrfToken, teamId)
}

export async function login(loginPath) {
  if (loginPath) managedHistory?.rememberFinding()
  return (await loadManagedBundle()).login(loginPath)
}

export async function logout(csrfToken) {
  return (await loadManagedBundle()).logout(csrfToken)
}

export async function fetchBundleMetadata(id, options) {
  return (await loadManagedBundle()).fetchBundleMetadata(id, options)
}

export async function fetchBundleContents(id, options) {
  return (await loadManagedBundle()).fetchBundleContents(id, options)
}

export async function fetchTeamReports(teamId, options) { return (await loadManagedBundle()).fetchTeamReports(teamId, options) }

export async function watchTeamFeed(teamId, options) {
  return (await loadManagedBundle()).watchTeamFeed(teamId, options)
}

export async function fetchBundleAdvisories(id, teamId = state.currentManagedTeam, reason = '', repoAdvisories = false, details = false) {
  return (await loadManagedBundle()).fetchBundleAdvisories(id, teamId, reason, repoAdvisories, details)
}
