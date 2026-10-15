// Lazy managed-client entry: authenticated API calls and Manage custom elements.
// The runtime import in view/client-managed.js keeps this entire surface out of
// view.js. It loads when a managed session or page is first requested.
import './managed/pages.js'
import './managed/links.js'
import './managed/deduplication.js'
import './managed/repository-risk.js'
import { ManagedPage } from './managed/page.js'
import { managedFetch } from '../client/managed/request.js'
import { managedAppState } from './managed/state.js'
export function clearFindingHistory() { managedAppState.invalidate(['finding-history']) }
export async function loadWorkspaceImportPage() {
  const path = './client-managed-import.js'
  const mod = await import(path)
  mod.registerWorkspaceImport(ManagedPage, managedFetch)
}
export { openFindingHistoryDialog, openManagedIssueDialog, openManagedShareDialog } from './view/lazy-dialogs.js'
export * from '../client/managed/session.js'
export * from '../client/managed/profile.js'
export { watchTeamFeed } from '../client/managed/team-feed.js'
export { fetchReport, fetchReports, fetchTeamReports } from './managed/report-data.js'
export { fetchManagedLinkWorkspace } from './managed/deduplication-data.js'
export { getPreviewRole, setPreviewRole } from '../client/managed/request.js'
export { resetManagedAppState, setManagedAppSession, setManagedReportCatalog } from './managed/state.js'
export { fetchBundleMetadata, fetchBundleContents, fetchBundleAdvisories, fetchManagedBundleCatalog, fetchNpmAdvisories, fetchNpmPackage, fetchNpmProvenance, fetchNpmRisk, fetchNpmSocket, fetchNpmStats, fetchNpmTags, fetchNpmVersions, fetchBrowsableRepositories, fetchRepositoryCode, fetchRepositoryContents, fetchRepositoryHistory, fetchRepositoryIssues, fetchRepositoryAgents, fetchRepositoryItem, fetchRepositoryPulse, fetchRepositoryRefs, fetchPrettyBundleChanges, fetchPrettyBundleFile, fetchPrettyNpmChanges, fetchPrettyNpmFile, fetchPrettyNpmFiles, fetchBundleRenameDiff, fetchBundleRenameDiffs, fetchNpmRenameDiff, fetchNpmRenameDiffs, fetchBundleTypeOnly, fetchNpmTypeOnly, fetchBundleComparison, fetchNpmComparison } from './managed/bundle-data.js'
export { fetchReportSources, readReportSources, clearReportSources } from './managed/report-sources.js'
export { dependencyReviews, myDependencyReviews, discardDependencyReview, latestDependencyReview } from './managed/dependency-reviews.js'
