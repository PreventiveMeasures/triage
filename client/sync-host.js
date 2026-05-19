// Default `SyncHost` wiring — composes the host that `client/sync/*`
// modules read through (workspace listings + change feeds, OPFS
// storage, counts, triage save, secure storage, app state) from
// the rest of `client/`, and the post-load notifier handshake that
// lets `saveTriage` fan out to peers.
//
// Lives OUTSIDE `client/sync.js` deliberately. The sync chunk's
// entry must not import non-sync `client/*` files, otherwise the
// chunk re-bundles e.g. `client/triage.js` and the
// `triageChangeNotifier` slot saveTriage flips ends up forked
// across the main `view.js` bundle and the lazy chunk —
// `saveTriage` (running in the main bundle) writes to the main
// bundle's slot, the chunk's `installDefaultSyncHost` wires the
// chunk's slot, and notifications silently no-op.
//
// `applyDefaultSyncHost(syncMod)` is the install entry: pass it
// the loaded sync module namespace (whether via `await
// import('./sync.js')` in the UI loader or a direct static import
// in tests). It installs the host and wires the
// `setTriageChangeNotifier` slot to call into the loaded module's
// `triageSync.notify`.

import { state } from './state.ts'
import { analyzeContent, setCount } from './counts.js'
import { addBundleToWorkspace, addReportToWorkspace, listWorkspaces, onBundleMembershipChanged, onReportMembershipChanged, onWorkspaceDeleted, onWorkspacePrivateKeyChanged } from './workspaces.js'
import { gunzipBytes, listBundles, listFiles, readBundle, saveBundle, saveFileBytes } from './storage.js'
import { saveTriage, setTriageChangeNotifier } from './triage.js'
import { getItem as getSecureItem, onAfterHydrate as onSecureStorageHydrated, removeItem as removeSecureItem, setItem as setSecureItem } from './secure-storage.js'

export const defaultSyncHost = {
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

export function applyDefaultSyncHost(syncMod) {
  syncMod.installSyncHost(defaultSyncHost)
  // Wire triage's tail-of-save notifier so `saveTriage` fans the
  // change out to peers via `triageSync.notify`. The slot lives on
  // THIS bundle's `client/triage.js` instance, which is the one
  // `saveTriage` (called from UI code in the main bundle) writes
  // through. The lookup `() => syncMod.triageSync.notify()` is
  // intentionally late-bound so tests that stub
  // `triageSync.notify = ...` still see their stub invoked.
  setTriageChangeNotifier(() => syncMod.triageSync.notify())
}
