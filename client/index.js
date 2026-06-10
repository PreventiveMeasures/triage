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
  indexedHashFindingCount,
  reportsForFinding,
  reportsForFindingByPackage,
  reportsForFindingByRepo,
  subscribeToBundleFindingIndex,
} from './bundle-finding-index.js'

export { compareVersionsDesc, isPlaceholderNpmPackage } from './bundle-finding-versions.js'

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
  getItem as getSecureItem,
  hydrate as hydrateSecureStorage,
  migrateToEncrypted as migrateSecureStorageToEncrypted,
  migrateToPlaintext as migrateSecureStorageToPlaintext,
  removeItem as removeSecureItem,
  setItem as setSecureItem,
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
  loadPromise as triageLoadPromise,
  migrateTriageToEncrypted,
  migrateTriageToPlaintext,
  saveTriage,
  setTriageReloadNotifier,
} from './triage.js'

export {
  bucketOf,
  isReportIgnored,
  patchEntry,
  setReportIgnored,
} from './triage-entry.ts'

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
  removeBundleFromWorkspace,
  removeReportFromWorkspace,
  renameWorkspace,
  sanitizeWorkspaceName,
  setBundleWorkspace,
  setReportWorkspace,
  syncObservedAfterHydrate,
} from './workspaces.js'
