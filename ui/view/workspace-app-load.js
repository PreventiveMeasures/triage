import { cacheWorkspaceAppMetadata, duplicatesOf, ensureLinkedFindingsIndexed, subscribeToLinkedFindings, workspaceAppCacheToken, workspaceAppReportsCurrent } from '#client/index.js'
import { workspaceAppMetadata } from './workspace-app.js'

let loaded = null
let linksRevision = 0
subscribeToLinkedFindings(() => { linksRevision++ })

// Only the completed, focused report snapshot can bypass persisted metadata's
// full-library gate. This display value uses the same links as the main view;
// it is never persisted or reused to promote an unopened workspace.
export function setLoadedWorkspaceAppReports(workspace, reports, token, { complete, isCurrent }) {
  loaded = { id: workspace.id, membership: JSON.stringify(workspace.reports.toSorted()), reports, token, complete, isCurrent }
}

export function getLoadedWorkspaceAppMetadata(workspace) {
  if (!loaded || loaded.id !== workspace.id || !loaded.isCurrent()
      || loaded.membership !== JSON.stringify(workspace.reports.toSorted())
      || !workspaceAppReportsCurrent(workspace, loaded.token)) return null
  if (loaded.linksRevision !== linksRevision) {
    loaded.metadata = loaded.complete ? workspaceAppMetadata(loaded.reports, duplicatesOf) : { appMode: false }
    loaded.linksRevision = linksRevision
  }
  return loaded.metadata
}

// Persist only after the full links scan. It verifies file bytes itself, so
// the unrelated report-count classification pass is not a prerequisite.
export async function updateWorkspaceAppMetadata(workspace, reports, reportsToken, { complete, isCurrent, onReady }) {
  if (!isCurrent()) return
  await ensureLinkedFindingsIndexed()
  if (!isCurrent()) return
  const token = await workspaceAppCacheToken(workspace, reportsToken)
  if (!token || !isCurrent()) return
  const metadata = complete ? workspaceAppMetadata(reports, duplicatesOf) : { appMode: false }
  if (await cacheWorkspaceAppMetadata(workspace, metadata, token) && isCurrent()) {
    await onReady(metadata)
  }
}
