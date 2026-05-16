// Type declarations for `client/workspaces.js`. Hand-written so the
// JS source stays untouched while triage-sync.ts pulls a typed
// surface. Goes away when `workspaces.js` itself is converted.

export interface Workspace {
  id: string
  name: string
  privateKey: string
  reports: string[]
  bundles: string[]
  createdAt: number
}

export type WorkspaceListener = (workspaceId: string) => void

export function listWorkspaces(): Workspace[]
export function createWorkspace(name: string): Promise<Workspace | null>
export function onWorkspaceCreated(cb: WorkspaceListener): () => void
export function onWorkspaceDeleted(cb: WorkspaceListener): () => void
export function onWorkspacePrivateKeyChanged(cb: WorkspaceListener): () => void
export function onReportMembershipChanged(cb: WorkspaceListener): () => void
export function onBundleMembershipChanged(cb: WorkspaceListener): () => void
export function deleteWorkspace(id: string): Promise<void>
export function renameWorkspace(id: string, name: string): Promise<boolean>
export function upsertWorkspace(workspace: {
  id: string
  name: string
  privateKey: string
  reports?: string[]
  bundles?: string[]
  /**
   * When true, `bundles` is ignored and the previously-persisted
   * `bundles` array for this id is reused (read inside the lock).
   * On first-insert with this flag, defaults to []. Used by the import
   * path to avoid wiping locally-attached bundles when an older export
   * predates the field.
   */
  preserveBundles?: boolean
  createdAt?: number
}): Promise<Workspace>
export function setReportWorkspace(
  filename: string,
  workspaceId: string | null,
): Promise<void>
export function setBundleWorkspace(
  integrity: string,
  workspaceId: string | null,
): Promise<void>

export type AttachSharedResult =
  | { status: 'attached'; workspace: Workspace }
  | { status: 'already-attached'; workspace: Workspace }
  | { status: 'name-collision'; existing: Workspace | null }

export function attachSharedWorkspace(workspace: {
  id: string
  name: string
  privateKey: string
  createdAt?: number
}): Promise<AttachSharedResult>

export function sanitizeWorkspaceName(raw: string | null | undefined): string | null

export function propagateWorkspaceChangesFromStorage(): void
