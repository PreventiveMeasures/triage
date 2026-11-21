// The sync badge's "N cloud" prompt: downloads peer-uploaded reports and
// bundles from the workspace's remote inventory, each by its own session method.
//
//   openSyncDownloadDialog({ workspaceId, items })
//     items: Array<{ kind: 'report', identifier: filename }
//                 | { kind: 'bundle', identifier: integrity }>
//   → Promise<{ downloaded, failed }>
import { html } from 'lit'
import { addBundleToWorkspace, state } from '#client/index.js'
import { downloadFileFromRemote, fetchBundleFromRemote } from '../client-sync.js'
import { switchToWorkspace } from '../ingest.js'
import { TransferDialog, openTransferDialog } from './sync-transfer.js'

class SyncDownloadDialog extends TransferDialog {
  static copy = {
    verb: 'Download',
    heading: 'Download from remote',
    key: 'downloaded',
    one: (label) => html`Download <strong>"${label}"</strong> from the workspace's remote inventory?`,
    many: (count, kinds) => html`Download <strong>${count}</strong> remote ${kinds} into this workspace?`,
  }

  async transfer({ kind, identifier }) {
    if (kind === 'bundle') {
      // Saves it and tells the bundle listener (the UI refreshes); this
      // attaches it to the workspace.
      const r = await fetchBundleFromRemote(this.workspaceId, identifier)
      if (!r.ok) return r.reason ?? 'unknown'
      await addBundleToWorkspace(identifier, this.workspaceId)
      return undefined
    }
    // Through presence rather than a bare fetch + save, so the copy gets a sync
    // baseline: without one, a Replace landing while offline is never picked up.
    const r = await downloadFileFromRemote(this.workspaceId, identifier)
    return r?.ok ? undefined : r?.reason ?? 'sync is not available'
  }

  // Reload the workspace still on screen, so new reports join its findings.
  async transferred(moved) {
    if (!moved.some((d) => d.kind === 'report')) return
    try {
      if (state.currentWorkspace === this.workspaceId) await switchToWorkspace(this.workspaceId)
    } catch {}
  }
}

customElements.define('sync-download-dialog', SyncDownloadDialog)

export function openSyncDownloadDialog(options) {
  return openTransferDialog('sync-download-dialog', options)
}
