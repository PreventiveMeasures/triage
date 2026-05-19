// Aggregated entry point for `/ui` consumers that need the sync
// surface (objstore presence + triage-sync). Split from
// `#client/index.js` so importing storage / vault / counts doesn't
// drag the sync transport into the bundle's import graph.
//
// Also wires the dependency-injection seam: `client/sync/*` modules
// declare what they need from the rest of `client/` via a
// `SyncHost` interface (see `./sync/host.ts`) and reach the live
// implementation through `syncHost()`. `installDefaultSyncHost`
// composes the host from concrete `client/` exports — UI boot calls
// it once.

import { state } from './state.ts'
import { analyzeContent, setCount } from './counts.js'
import { addBundleToWorkspace, addReportToWorkspace, listWorkspaces, onBundleMembershipChanged, onReportMembershipChanged, onWorkspaceDeleted, onWorkspacePrivateKeyChanged } from './workspaces.js'
import { gunzipBytes, listBundles, listFiles, readBundle, saveBundle, saveFileBytes } from './storage.js'
import { saveTriage, setTriageChangeNotifier } from './triage.js'
import { getItem as getSecureItem, onAfterHydrate as onSecureStorageHydrated, removeItem as removeSecureItem, setItem as setSecureItem } from './secure-storage.js'
import { installSyncHost } from './sync/host.ts'
import { triageSync } from './sync/triage-sync.ts'

export {
  closeWorkspace,
  deleteFromRemote,
  discoverRemoteBundleIntegrities,
  discoverRemoteFileNames,
  fetchBundleFromRemote,
  fetchFile,
  isBundleInRemote,
  isInRemote,
  onAutoDownloaded,
  onBundleAutoDownloaded,
  onChange,
  openWorkspace,
  putBundleToRemote,
  putFile,
  remoteBundleName,
  remoteCount,
} from './sync/objstore-presence.js'

export {
  setAuthenticationResolver,
  setHydrationConflictResolver,
  setRedraw,
  triageSync,
} from './sync/triage-sync.ts'

export { installSyncHost } from './sync/host.ts'

// Compose + install the default host. Called once from `ui/view.js`
// boot. Re-call is a no-op via `installSyncHost`'s same-instance
// guard (the host object is module-scoped so subsequent calls pass
// the identical reference).
const defaultHost = {
  get state() { return state },
  listWorkspaces,
  addReportToWorkspace,
  addBundleToWorkspace,
  onReportMembershipChanged,
  onBundleMembershipChanged,
  onWorkspaceDeleted,
  onWorkspacePrivateKeyChanged,
  analyzeContent,
  setCount,
  gunzipBytes,
  listBundles,
  listFiles,
  readBundle,
  saveBundle,
  saveFileBytes,
  saveTriage,
  getSecureItem,
  setSecureItem,
  removeSecureItem,
  onSecureStorageHydrated,
}

export function installDefaultSyncHost() {
  installSyncHost(defaultHost)
  // Wire triage's tail-of-save notifier so `saveTriage` fans the
  // change out to peers via `triageSync.notify`. The wrapper looks
  // up `triageSync.notify` at call time (not at install time) so
  // tests that stub `triageSync.notify = ...` to intercept the
  // fan-out still see their stub invoked — a captured `.bind` would
  // hold the pre-stub method.
  setTriageChangeNotifier(() => triageSync.notify())
}
