// Lazy proxy for managed API calls and Manage custom elements.
// Mirrors view/client-sync.js: the heavy module is dynamically imported via a
// variable path so esbuild keeps it — and any future managed payload — out of
// the main view bundle. The browser resolves the path against the page URL.
import { state } from '#client/index.js'
import { managedHistory } from './managed-history.js'
import { canViewFindingHistory } from './finding-history.js'
import { applyManagedIssues } from './managed-issues.js'
import { invalidateManagedFixes } from './managed-pull-requests.js'
import { forgetGithubUsers, knowingGithubUsers } from './github-users.js'

let loadPromise = null
let managedModule = null

// Synchronous reads/reset never load the chunk on an E2E or standalone visit.
export function getPreviewRole() { return managedModule?.getPreviewRole() ?? null }
export function clearPreviewRole() { managedModule?.setPreviewRole(null) }
export function resetManagedAppState() { forgetGithubUsers(); githubUsersSession = null; managedModule?.resetManagedAppState() }
// The session the GitHub users kept came to: another user's, or another
// role's, forgets them.
let githubUsersSession = null
export function setManagedAppSession(session) {
  const key = session ? `${session.id}\0${session.role}` : null
  if (key !== githubUsersSession) { forgetGithubUsers(); githubUsersSession = key }
  managedModule?.setManagedAppSession(session)
}
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

export async function fetchNpmPackage(name, version, options) {
  return (await loadManagedBundle()).fetchNpmPackage(name, version, options)
}

export async function fetchRepositoryCode(repoId, ref, path, options) {
  return (await loadManagedBundle()).fetchRepositoryCode(repoId, ref, path, options)
}

export async function fetchBrowsableRepositories(options) {
  return (await loadManagedBundle()).fetchBrowsableRepositories(options)
}

export async function fetchRepositoryRefs(repoId, options) {
  return (await loadManagedBundle()).fetchRepositoryRefs(repoId, options)
}

export async function fetchRepositoryContents(repoId, ref, path, options) {
  return (await loadManagedBundle()).fetchRepositoryContents(repoId, ref, path, options)
}

export function fetchRepositoryHistory(repoId, ref, path, options) {
  return knowingGithubUsers(async () => (await loadManagedBundle()).fetchRepositoryHistory(repoId, ref, path, options))
}

export async function fetchRepositoryChanges(repoId, path, shas, options) {
  return (await loadManagedBundle()).fetchRepositoryChanges(repoId, path, shas, options)
}

export async function fetchRepositoryTree(repoId, path, commit, options) {
  return (await loadManagedBundle()).fetchRepositoryTree(repoId, path, commit, options)
}

export function fetchRepositoryAgents(repoId, options) {
  return knowingGithubUsers(async () => (await loadManagedBundle()).fetchRepositoryAgents(repoId, options))
}

export function fetchRepositoryIssues(repoId, kind, options) {
  return knowingGithubUsers(async () => (await loadManagedBundle()).fetchRepositoryIssues(repoId, kind, options))
}

export function fetchRepositoryItem(repoId, number, options) {
  return knowingGithubUsers(async () => (await loadManagedBundle()).fetchRepositoryItem(repoId, number, options))
}

export function fetchRepositoryPulse(repoId, weeks, options) {
  return knowingGithubUsers(async () => (await loadManagedBundle()).fetchRepositoryPulse(repoId, weeks, options))
}

export async function fetchNpmVersions(name, options) {
  return (await loadManagedBundle()).fetchNpmVersions(name, options)
}

export async function fetchNpmStats(name, options) {
  return (await loadManagedBundle()).fetchNpmStats(name, options)
}

export async function fetchNpmAdvisories(name, options) {
  return (await loadManagedBundle()).fetchNpmAdvisories(name, options)
}

export async function fetchNpmTags(name, version, options) {
  return (await loadManagedBundle()).fetchNpmTags(name, version, options)
}

export async function fetchNpmRisk(name, version, otherVersion, options) {
  return (await loadManagedBundle()).fetchNpmRisk(name, version, otherVersion, options)
}

export async function fetchNpmSocket(name, version, options) {
  return (await loadManagedBundle()).fetchNpmSocket(name, version, options)
}

export async function fetchNpmProvenance(name, version, options) {
  return (await loadManagedBundle()).fetchNpmProvenance(name, version, options)
}

export async function fetchPrettyBundleFile(id, path, hash, options) {
  return (await loadManagedBundle()).fetchPrettyBundleFile(id, path, hash, options)
}

export async function fetchPrettyNpmFiles(name, version, onLine, options) {
  return (await loadManagedBundle()).fetchPrettyNpmFiles(name, version, onLine, options)
}

export async function fetchPrettyNpmFile(name, version, path, hash, options) {
  return (await loadManagedBundle()).fetchPrettyNpmFile(name, version, path, hash, options)
}

export async function fetchPrettyBundleChanges(id, other, onLine, options) {
  return (await loadManagedBundle()).fetchPrettyBundleChanges(id, other, onLine, options)
}

export async function fetchPrettyNpmChanges(name, version, otherVersion, onLine, options) {
  return (await loadManagedBundle()).fetchPrettyNpmChanges(name, version, otherVersion, onLine, options)
}

export async function fetchBundleRenameDiff(id, other, params, options) {
  return (await loadManagedBundle()).fetchBundleRenameDiff(id, other, params, options)
}

export async function fetchNpmRenameDiff(name, version, otherVersion, params, options) {
  return (await loadManagedBundle()).fetchNpmRenameDiff(name, version, otherVersion, params, options)
}

export async function fetchBundleRenameDiffs(id, other, onLine, options) {
  return (await loadManagedBundle()).fetchBundleRenameDiffs(id, other, onLine, options)
}

export async function fetchNpmRenameDiffs(name, version, otherVersion, onLine, options) {
  return (await loadManagedBundle()).fetchNpmRenameDiffs(name, version, otherVersion, onLine, options)
}

export async function fetchBundleTypeOnly(id, other, onLine, options) {
  return (await loadManagedBundle()).fetchBundleTypeOnly(id, other, onLine, options)
}

export async function fetchNpmTypeOnly(name, version, otherVersion, onLine, options) {
  return (await loadManagedBundle()).fetchNpmTypeOnly(name, version, otherVersion, onLine, options)
}

export async function fetchBundleComparison(id, other, options) {
  return (await loadManagedBundle()).fetchBundleComparison(id, other, options)
}

export async function fetchNpmComparison(name, version, otherVersion, options) {
  return (await loadManagedBundle()).fetchNpmComparison(name, version, otherVersion, options)
}

export async function openManagedShareDialog(team) {
  return (await loadManagedBundle()).openManagedShareDialog(team, '', state.managedSession)
}

// `render` is the caller's: API-only consumers (finding-link resolution
// among them) must not load the renderer or touch the DOM, so this module
// never imports it.
export async function openManagedIssueDialog({ render, ...props }) {
  const isCurrent = () => state.managedSession?.id === props.session.id
    && state.managedSession?.csrfToken === props.session.csrfToken && state.currentManagedTeam === props.teamId
  const managed = await loadManagedBundle()
  if (!isCurrent()) return null
  return managed.openManagedIssueDialog({ ...props, isCurrent, onCreated: url => {
    if (!isCurrent()) return
    const id = props.context.findingId, previous = state.managedIssues.get(id)
    const changed = applyManagedIssues([id], { [id]: { url, autoFix: previous?.url === url ? previous.autoFix : null } })
    invalidateManagedFixes(props.teamId)
    if (changed) render()
  } })
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

export async function stopViewing(csrfToken) {
  return (await loadManagedBundle()).stopViewing(csrfToken)
}

export async function fetchProfile(options) {
  return (await loadManagedBundle()).fetchProfile(options)
}

export async function chooseProfileAccounts(choice, csrfToken, options) {
  return (await loadManagedBundle()).chooseProfileAccounts(choice, csrfToken, options)
}

export async function unlinkGithubAccount(id, csrfToken, options) {
  return (await loadManagedBundle()).unlinkGithubAccount(id, csrfToken, options)
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

export async function dependencyReviews(...args) {
  return (await loadManagedBundle()).dependencyReviews(...args)
}
export async function myDependencyReviews(...args) {
  return (await loadManagedBundle()).myDependencyReviews(...args)
}
export async function discardDependencyReview(...args) {
  return (await loadManagedBundle()).discardDependencyReview(...args)
}
export async function latestDependencyReview(...args) {
  return (await loadManagedBundle()).latestDependencyReview(...args)
}
