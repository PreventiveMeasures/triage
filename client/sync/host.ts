// Dependency-injection seam for `client/sync/` — lets the sync layer
// declare what it needs from the rest of `client/` without statically
// reaching `../workspaces.js`, `../storage.js`, etc. The UI's boot
// (see `ui/view.js`) builds a `SyncHost` from the concrete `client/`
// implementations and calls `installSyncHost(host)` exactly once,
// before any user-facing entry point fires.
//
// Sync sub-modules access the host through `syncHost()` and defer
// module-init wiring (listener registrations, boot-time secure-storage
// reads) via `onSyncHostInstalled(cb)` so they don't reach for the
// host while it's still unset.

import type { State, TriageBucket, TriageEntry } from '../state.ts'

// Structural views of the parent-module types `client/sync/` actually
// reads. Workspaces and bundles are JS-typed at source — we copy the
// shape here rather than re-export from `../workspaces.js`, both to
// keep the dependency direction one-way and because the canonical type
// is implicit (no `.d.ts` companion).
export interface SyncHostWorkspace {
  id: string
  name: string
  privateKey: string
  reports?: string[]
  bundles?: string[]
}

export interface SyncHostBundleMeta {
  integrity: string
  name: string
}

export type SyncHostAnalyzeResult =
  | { recognized: true, count: number, source?: string }
  | { recognized: false, count: number }

export type { TriageBucket, TriageEntry }

export interface SyncHost {
  // Mutable app state — sync reads/writes the triage map live. Identity-
  // sensitive: the same object the rest of the app holds, so
  // `host.state.triage.set(...)` is observable everywhere.
  readonly state: State

  // Workspaces — read + membership mutations + change feeds.
  listWorkspaces(): SyncHostWorkspace[]
  addReportToWorkspace(filename: string, workspaceId: string): Promise<unknown>
  addBundleToWorkspace(integrity: string, workspaceId: string): Promise<unknown>
  onReportMembershipChanged(cb: (workspaceId: string) => void): () => void
  onBundleMembershipChanged(cb: (workspaceId: string) => void): () => void
  onWorkspaceDeleted(cb: (workspaceId: string) => void): () => void
  onWorkspacePrivateKeyChanged(cb: (workspaceId: string) => void): () => void

  // Counts (auto-download path validates + records counts on saved
  // peer reports).
  analyzeContent(content: string): SyncHostAnalyzeResult
  setCount(name: string, count: number, source: string | undefined): void

  // OPFS storage (auto-download saves peer bundles/reports; presence
  // reads bundles for re-upload).
  gunzipBytes(bytes: Uint8Array): Promise<Uint8Array>
  listBundles(): Promise<SyncHostBundleMeta[]>
  listFiles(): Promise<string[]>
  readBundle(integrity: string): Promise<Uint8Array | null>
  saveBundle(name: string, bytes: Uint8Array): Promise<unknown>
  saveFileBytes(name: string, bytes: Uint8Array): Promise<unknown>

  // Triage persistence — triage-sync fans state changes from incoming
  // server updates through here so they hit disk on the next save.
  saveTriage(): Promise<unknown>

  // Secure storage (sync's persisted sessions + user-enabled flag +
  // cached operator password).
  getSecureItem(key: string): string | null
  setSecureItem(key: string, value: string): Promise<void>
  removeSecureItem(key: string): Promise<void>
  onSecureStorageHydrated(cb: () => void): () => void
}

let installed: SyncHost | null = null
const installListeners: Array<(host: SyncHost) => void> = []

// Install the host. Idempotent on a same-instance re-install (no-op);
// throws if a DIFFERENT host is installed over an existing one — the
// app expects one wiring per page lifetime.
export function installSyncHost(host: SyncHost): void {
  if (installed === host) return
  if (installed !== null) {
    throw new Error('SyncHost: a different host is already installed')
  }
  installed = host
  const listeners = installListeners.splice(0)
  for (const cb of listeners) {
    try { cb(host) } catch (err) { console.warn('SyncHost install listener:', err) }
  }
}

// Lazy accessor for callers that run only after boot wiring installed
// the host (handlers via `triageSync.*`, user-initiated
// `openWorkspace(...)`, transport callbacks). Throws pre-install so a
// misconfigured app surfaces clearly instead of no-op'ing on a stub.
export function syncHost(): SyncHost {
  if (installed === null) {
    throw new Error('SyncHost: not installed — call installSyncHost(host) during app boot')
  }
  return installed
}

// Subscribe to install. Fires synchronously if the host is already
// installed at the time of subscription; otherwise queued for the
// upcoming `installSyncHost(...)` call. Used by sync sub-modules to
// defer top-level listener registrations and secure-storage reads
// out of module-init.
export function onSyncHostInstalled(cb: (host: SyncHost) => void): void {
  if (installed !== null) {
    try { cb(installed) } catch (err) { console.warn('SyncHost install listener:', err) }
    return
  }
  installListeners.push(cb)
}
