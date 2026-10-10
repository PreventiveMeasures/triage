// Lazy managed-client entry: authenticated API calls and Manage custom elements.
// The runtime import in view/client-managed.js keeps this entire surface out of
// view.js. It loads when a managed session or page is first requested.
import './managed/pages.js'
import './managed/links.js'
import './managed/deduplication.js'
import { ManagedPage } from './managed/page.js'
import { managedFetch } from '../client/managed/request.js'
import { managedAppState } from './managed/state.js'
export function clearFindingHistory() { managedAppState.invalidate(['finding-history']) }
export async function loadWorkspaceImportPage() {
  const path = './client-managed-import.js'
  const mod = await import(path)
  mod.registerWorkspaceImport(ManagedPage, managedFetch)
}
export async function openManagedShareDialog(...args) {
  return (await import('./view/dialogs/managed-share-dialog.js')).openManagedShareDialog(...args)
}
export async function openManagedIssueDialog(props) {
  return (await import('./view/dialogs/managed-issue-dialog.js')).openManagedIssueDialog(props)
}
export async function openFindingHistoryDialog(props) {
  return (await import('./view/dialogs/finding-history-dialog.js')).openFindingHistoryDialog(props)
}
export * from '../client/managed/session.js'
export { watchTeamFeed } from '../client/managed/team-feed.js'
export { fetchReport, fetchReports, fetchTeamReports } from './managed/report-data.js'
export { fetchManagedLinkWorkspace } from './managed/deduplication-data.js'
export { getPreviewRole, setPreviewRole } from '../client/managed/request.js'
export { resetManagedAppState, setManagedAppSession, setManagedReportCatalog } from './managed/state.js'
export { fetchBundleMetadata, fetchBundleContents, fetchBundleAdvisories, fetchManagedBundleCatalog, fetchNpmAdvisories, fetchNpmPackage, fetchNpmSocket, fetchNpmStats, fetchNpmTags, fetchNpmVersions, fetchPrettyBundleFile, fetchPrettyNpmFile } from './managed/bundle-data.js'
export { fetchReportSources, readReportSources, clearReportSources } from './managed/report-sources.js'
