// Aggregated entry point for `/ui` consumers that need the sync
// surface (objstore presence + triage-sync). Split from
// `#client/index.js` so importing storage / vault / counts doesn't
// drag the sync transport into the bundle's import graph.

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
