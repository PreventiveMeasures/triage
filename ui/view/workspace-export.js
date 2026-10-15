import { openWorkspaceExportDialog } from './lazy-dialogs.js'

// Thin DOM wrapper — the dialog collects the password (or explicit
// opt-out) and triggers the download itself.

export async function exportWorkspace(workspace) {
  await openWorkspaceExportDialog({ workspace })
}
