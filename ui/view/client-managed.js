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

// The managed module's `name`, called with `args` once it has loaded. The
// proxies below are hoisted declarations: managed-pull-requests.js, which
// this module imports, takes fetchFixes as it is evaluated.
async function call(name, args) { return (await loadManagedBundle())[name](...args) }
// And one whose answer names GitHub users, known as it arrives (github-users.js).
function callKnowing(name, args) { return knowingGithubUsers(() => call(name, args)) }

export function probeSession(...args) { return call('probeSession', args) }
export function probeTeams(...args) { return call('probeTeams', args) }
export function fetchManagedBundleCatalog(...args) { return call('fetchManagedBundleCatalog', args) }
export function fetchNpmPackage(...args) { return call('fetchNpmPackage', args) }
export function fetchRepositoryCode(...args) { return call('fetchRepositoryCode', args) }
export function fetchBrowsableRepositories(...args) { return call('fetchBrowsableRepositories', args) }
export function fetchRepositoryRefs(...args) { return call('fetchRepositoryRefs', args) }
export function fetchRepositoryContents(...args) { return call('fetchRepositoryContents', args) }
export function fetchRepositoryHistory(...args) { return callKnowing('fetchRepositoryHistory', args) }
export function fetchRepositoryChanges(...args) { return call('fetchRepositoryChanges', args) }
export function fetchRepositoryTree(...args) { return call('fetchRepositoryTree', args) }

// The first read an Activity view opening on `tab` makes, read ahead of it
// (bundle-data.js prefetchActivity).
export async function prefetchActivity(repoId, tab, options) {
  (await loadManagedBundle()).prefetchActivity(repoId, tab, options)
}

export function fetchRepositoryAgents(...args) { return callKnowing('fetchRepositoryAgents', args) }
export function fetchRepositoryIssues(...args) { return callKnowing('fetchRepositoryIssues', args) }
export function fetchRepositoryItem(...args) { return callKnowing('fetchRepositoryItem', args) }
export function fetchPullDependencies(...args) { return call('fetchPullDependencies', args) }
export function fetchPullDependenciesOf(...args) { return call('fetchPullDependenciesOf', args) }
export function fetchBundleDependencyReview(...args) { return call('fetchBundleDependencyReview', args) }
export function fetchBundleValidation(...args) { return call('fetchBundleValidation', args) }
export function runBundleValidation(...args) { return call('runBundleValidation', args) }
export function fetchTeamDependencies(...args) { return call('fetchTeamDependencies', args) }
export function fetchNpmDeltas(...args) { return call('fetchNpmDeltas', args) }
export function fetchRepositoryPulse(...args) { return callKnowing('fetchRepositoryPulse', args) }
export function fetchRepositoryPulseItems(...args) { return callKnowing('fetchRepositoryPulseItems', args) }
export function fetchNpmVersions(...args) { return call('fetchNpmVersions', args) }
export function fetchNpmStats(...args) { return call('fetchNpmStats', args) }
export function fetchNpmAdvisories(...args) { return call('fetchNpmAdvisories', args) }
export function fetchNpmTags(...args) { return call('fetchNpmTags', args) }
export function fetchNpmRisk(...args) { return call('fetchNpmRisk', args) }
export function fetchNpmSocket(...args) { return call('fetchNpmSocket', args) }
export function fetchNpmProvenance(...args) { return call('fetchNpmProvenance', args) }
export function fetchPrettyBundleFile(...args) { return call('fetchPrettyBundleFile', args) }
export function fetchPrettyNpmFiles(...args) { return call('fetchPrettyNpmFiles', args) }
export function fetchPrettyNpmFile(...args) { return call('fetchPrettyNpmFile', args) }
export function fetchPrettyBundleChanges(...args) { return call('fetchPrettyBundleChanges', args) }
export function fetchPrettyNpmChanges(...args) { return call('fetchPrettyNpmChanges', args) }
export function fetchBundleRenameDiff(...args) { return call('fetchBundleRenameDiff', args) }
export function fetchNpmRenameDiff(...args) { return call('fetchNpmRenameDiff', args) }
export function fetchBundleRenameDiffs(...args) { return call('fetchBundleRenameDiffs', args) }
export function fetchNpmRenameDiffs(...args) { return call('fetchNpmRenameDiffs', args) }
export function fetchBundleTypeOnly(...args) { return call('fetchBundleTypeOnly', args) }
export function fetchNpmTypeOnly(...args) { return call('fetchNpmTypeOnly', args) }
export function fetchBundleComparison(...args) { return call('fetchBundleComparison', args) }
export function fetchNpmComparison(...args) { return call('fetchNpmComparison', args) }

// The session as it is once the module has loaded.
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
    const changed = applyManagedIssues([id], { [id]: previous?.url === url ? previous : { url } })
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

export function fetchReport(...args) { return call('fetchReport', args) }
export function fetchReports(...args) { return call('fetchReports', args) }
export function fetchTeamAnnotations(...args) { return call('fetchTeamAnnotations', args) }

// Those of a team default to the one shown.
export function fetchReportTriage(id, teamId = state.currentManagedTeam, options) { return call('fetchReportTriage', [id, teamId, options]) }
export function fetchFixes(...args) { return call('fetchFixes', args) }
export function fetchReportComments(id, teamId = state.currentManagedTeam, options) { return call('fetchReportComments', [id, teamId, options]) }
export function saveReportComment(reportId, entry, csrfToken, teamId = state.currentManagedTeam) {
  return call('saveReportComment', [reportId, entry, csrfToken, teamId])
}
export function deleteReportComment(reportId, commentId, version, csrfToken, teamId = state.currentManagedTeam) {
  return call('deleteReportComment', [reportId, commentId, version, csrfToken, teamId])
}
export function pushReportTriage(id, entries, csrfToken, teamId = state.currentManagedTeam) { return call('pushReportTriage', [id, entries, csrfToken, teamId]) }

export async function login(loginPath) {
  if (loginPath) managedHistory?.rememberFinding()
  return (await loadManagedBundle()).login(loginPath)
}

export function logout(...args) { return call('logout', args) }
export function stopViewing(...args) { return call('stopViewing', args) }
export function fetchProfile(...args) { return call('fetchProfile', args) }
export function chooseProfileAccounts(...args) { return call('chooseProfileAccounts', args) }
export function unlinkGithubAccount(...args) { return call('unlinkGithubAccount', args) }
export function fetchBundleMetadata(...args) { return call('fetchBundleMetadata', args) }
export function fetchBundleContents(...args) { return call('fetchBundleContents', args) }
export function fetchTeamReports(...args) { return call('fetchTeamReports', args) }
export function fetchTeamTrees(...args) { return call('fetchTeamTrees', args) }
export function watchTeamFeed(...args) { return call('watchTeamFeed', args) }

export function fetchBundleAdvisories(id, teamId = state.currentManagedTeam, reason = '', repoAdvisories = false, details = false) {
  return call('fetchBundleAdvisories', [id, teamId, reason, repoAdvisories, details])
}

export function dependencyReviews(...args) { return call('dependencyReviews', args) }
export function myDependencyReviews(...args) { return call('myDependencyReviews', args) }
export function teamDependencyReviews(...args) { return call('teamDependencyReviews', args) }
export function discardDependencyReview(...args) { return call('discardDependencyReview', args) }
export function latestDependencyReview(...args) { return call('latestDependencyReview', args) }
