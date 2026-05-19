// Aggregated entry point for `/ui` consumers — the UI layer imports
// every client API through here so the module boundary is one line in
// `index.js` instead of dozens of deep reaches into individual files.
// Only the exports actually used by `/ui` are re-exported; tests and
// sibling client modules keep importing the source modules directly.

export {
  ensureBundleFindingsIndexed,
  findingsForFileHash,
  getPackagesIndex,
  getRepositoriesIndex,
  reportsForFinding,
  reportsForFindingByPackage,
  reportsForFindingByRepo,
  subscribeToBundleFindingIndex,
} from './bundle-finding-index.js'

export {
  bundlesForFileHash,
  dropBundleFromHashIndex,
  hasBundleFileHashes,
  recordBundleFileHashes,
} from './bundle-hash-index.js'

export {
  analyzeContent,
  ensureCounts,
  getCount,
  getKind,
  removeCount,
  setCount,
} from './counts.js'

export { buildFindingLookupForLoadedReports } from './finding-lookup.js'

export { migrateLegacyFilenames } from './migrate-legacy.js'

export {
  computeBundleResourceTag,
  computeResourceTag,
} from './objstore-content-crypto.ts'

export {
  createObjstoreClient,
  deriveObjstoreKeys,
} from './objstore.ts'

export {
  disableEncryption,
  enableEncryption,
  hasOrphanedUserId,
  isDisablingInThisTab,
  isEncryptionEnabled,
  isPasskeyEnvironmentSupported,
  isUnlocked,
  onVaultStateChange,
  unlockEncryption,
  wipeAllVaultData,
} from './passkey-vault.js'

export {
  getItem,
  hydrate,
  migrateToEncrypted,
  migrateToPlaintext,
  removeItem,
  setItem,
} from './secure-storage.js'

export {
  VIEW_MODE_KEY,
  loadRepoUrlFor,
  saveRepoUrlFor,
  state,
} from './state.ts'

export {
  deleteBundle,
  deleteFile,
  gunzipBytes,
  hasAnyBundles,
  listBundles,
  listFiles,
  migrateOpfsBundlesDecrypt,
  migrateOpfsBundlesEncrypt,
  migrateOpfsFilesDecrypt,
  migrateOpfsFilesEncrypt,
  readBundle,
  readFile,
  readFileBytes,
  saveBundle,
  saveFile,
  saveFileBytes,
} from './storage.js'

export { getSharedTransport } from './sync-transport.ts'

export {
  applyTriageImport,
  buildTriageExportGzip,
  parseTriageExportGzip,
} from './triage-export.js'

export {
  analyzeTriageImpact,
  pruneOrphanTriage,
} from './triage-gc.js'

export {
  setAuthenticationResolver,
  setHydrationConflictResolver,
  setRedraw,
  triageSync,
} from './triage-sync.ts'

export {
  loadPromise,
  migrateTriageToEncrypted,
  migrateTriageToPlaintext,
  saveTriage,
} from './triage.js'

export { isEncryptedBundle } from './workspace-bundle-crypto.js'

export { buildWorkspaceExportBundle } from './workspace-export.js'

export {
  applyWorkspaceImport,
  parseWorkspaceBundleBytes,
  readBundleBytes,
} from './workspace-import.js'

export {
  buildShareUrl,
  decodeShareLink,
  encodeShareLink,
  extractShareEncoded,
} from './workspace-share-link.js'

export {
  addBundleToWorkspace,
  addReportToWorkspace,
  attachSharedWorkspace,
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  onBundleMembershipChanged,
  onReportMembershipChanged,
  onWorkspaceDeleted,
  onWorkspacePrivateKeyChanged,
  removeBundleFromWorkspace,
  removeReportFromWorkspace,
  renameWorkspace,
  sanitizeWorkspaceName,
  setBundleWorkspace,
  setReportWorkspace,
  syncObservedAfterHydrate,
} from './workspaces.js'
