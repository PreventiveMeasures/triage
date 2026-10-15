// The dialogs, a bundle of their own (ui/dialogs.js) loaded the first time one
// opens: every dialog in dialogs/, with its styles and what only dialogs use.
// Each opener here stands for the dialog's own, under its name: it takes the
// same arguments and returns the same promise, of the dialog's result, once
// the bundle is in. Outside dialogs/, dialogs open through here, but for two
// that their callers import directly, held up front because a dialog that
// can't load there costs more than its bytes: the proxy-auth notice, which
// opens when this origin's requests are redirected to a login proxy (the
// bundle's would be too), and the triage conflict dialog, whose callers keep
// local values when it can't open, the user's choice lost.
import { lazyEntry } from './lazy-entry.js'

const dialogs = lazyEntry('./dialogs.js')
const opener = name => async (...args) => (await dialogs.load())[name](...args)

export const openAdvisoryDetailsDialog = opener('openAdvisoryDetailsDialog')
export const openCommentDialog = opener('openCommentDialog')
export const openDeleteBundleDialog = opener('openDeleteBundleDialog')
export const openDeleteReportDialog = opener('openDeleteReportDialog')
export const openDetachBundleDialog = opener('openDetachBundleDialog')
export const openDetachReportDialog = opener('openDetachReportDialog')
export const openDiscardReviewDialog = opener('openDiscardReviewDialog')
export const openDownloadBundleDialog = opener('openDownloadBundleDialog')
export const openExportConfirmDialog = opener('openExportConfirmDialog')
export const openExportViewDialog = opener('openExportViewDialog')
export const openFindingHistoryDialog = opener('openFindingHistoryDialog')
export const openFindingSourceDialog = opener('openFindingSourceDialog')
export const openFixLinkDialog = opener('openFixLinkDialog')
export const openImportConflictDialog = opener('openImportConflictDialog')
export const openLeaveWorkspaceDialog = opener('openLeaveWorkspaceDialog')
export const openLocalContentImportDialog = opener('openLocalContentImportDialog')
export const openLocalTriageImportDialog = opener('openLocalTriageImportDialog')
export const openManagedCommentsDialog = opener('openManagedCommentsDialog')
export const openManagedIssueDialog = opener('openManagedIssueDialog')
export const openManagedShareDialog = opener('openManagedShareDialog')
export const openNewWorkspaceDialog = opener('openNewWorkspaceDialog')
export const openNpmCompareAdvisoriesDialog = opener('openNpmCompareAdvisoriesDialog')
export const openObjstoreRecoveryDialog = opener('openObjstoreRecoveryDialog')
export const openPasskeySetupDialog = opener('openPasskeySetupDialog')
export const openPasskeyUnlockDialog = opener('openPasskeyUnlockDialog')
export const openPersistenceDegradedDialog = opener('openPersistenceDegradedDialog')
export const openReportCompareDialog = opener('openReportCompareDialog')
export const openRevalidationConflictsDialog = opener('openRevalidationConflictsDialog')
export const openStoragePersistDialog = opener('openStoragePersistDialog')
export const openSyncAuthDialog = opener('openSyncAuthDialog')
export const openSyncDownloadDialog = opener('openSyncDownloadDialog')
export const openSyncSuggestDialog = opener('openSyncSuggestDialog')
export const openSyncUploadDialog = opener('openSyncUploadDialog')
export const openTriageComparisonDialog = opener('openTriageComparisonDialog')
export const openTriageExportDialog = opener('openTriageExportDialog')
export const openWhyDialog = opener('openWhyDialog')
export const openWorkspaceExportDialog = opener('openWorkspaceExportDialog')
export const openWorkspaceShareLinkDialog = opener('openWorkspaceShareLinkDialog')
export const openWorkspaceUnlockBundleDialog = opener('openWorkspaceUnlockBundleDialog')
export const openWorkspaceUnlockLinkDialog = opener('openWorkspaceUnlockLinkDialog')
