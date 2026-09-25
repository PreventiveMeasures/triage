import { cacheWorkspaceAppMetadata, duplicatesOf, ensureCounts, ensureLinkedFindingsIndexed, listFiles, workspaceAppCacheToken } from '#client/index.js'
import { workspaceAppMetadata } from './workspace-app.js'

// Run after the selected reports have painted. Classifying the rest of the
// library is only needed to discover links and derive complete App metadata.
export async function updateWorkspaceAppMetadata(workspace, reports, reportsToken, { complete, isCurrent, onReady }) {
  await ensureCounts(await listFiles())
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
