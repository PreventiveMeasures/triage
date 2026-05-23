// Aggregated entry point for the sync surface (objstore presence +
// triage-sync). Imported by `ui/client-sync.js` as the lazy chunk;
// kept strictly to sync re-exports + the host install seam — no
// non-sync `client/*` imports — so this bundle's runtime graph
// stays disjoint from the main `view.js` bundle's. The default
// host (which DOES touch the rest of `client/`) is composed
// elsewhere — see `client/sync-host.js`.

export {
  closeWorkspace,
  deleteBundleFromRemote,
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
  openWorkspaceIds,
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
