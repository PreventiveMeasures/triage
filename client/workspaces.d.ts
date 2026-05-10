// Type declarations for `client/workspaces.js`. Hand-written so the
// JS source stays untouched while triage-sync.ts pulls a typed
// surface. Goes away when `workspaces.js` itself is converted.

export interface Workspace {
  id: string
  name: string
  privateKey: string
  reports: string[]
  createdAt: number
}

export type WorkspaceListener = (workspaceId: string) => void

export function listWorkspaces(): Workspace[]
export function createWorkspace(name: string): Promise<Workspace | null>
export function onWorkspaceCreated(cb: WorkspaceListener): () => void
export function onWorkspaceDeleted(cb: WorkspaceListener): () => void
export function onWorkspacePrivateKeyChanged(cb: WorkspaceListener): () => void
export function onReportMembershipChanged(cb: WorkspaceListener): () => void
export function deleteWorkspace(id: string): Promise<void>
export function renameWorkspace(id: string, name: string): Promise<boolean>
export function upsertWorkspace(workspace: {
  id: string
  name: string
  privateKey: string
  reports?: string[]
  createdAt?: number
}): Promise<Workspace>
export function setReportWorkspace(
  filename: string,
  workspaceId: string | null,
): Promise<void>
export function propagateWorkspaceChangesFromStorage(): void
