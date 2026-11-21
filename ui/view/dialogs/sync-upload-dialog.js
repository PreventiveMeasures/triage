// The sync badge's "M local" prompt: uploads reports and bundles to the
// workspace's remote inventory, each by its own session method.
//
//   openSyncUploadDialog({ workspaceId, items })
//     items: Array<{ kind: 'report', identifier: filename }
//                 | { kind: 'bundle', identifier: integrity, label?: string }>
//   → Promise<{ uploaded, failed }>, each entry `{ kind, identifier }`
import { html } from 'lit'
import { readFileBytes } from '#client/index.js'
import { putBundleToRemote, putFile } from '../client-sync.js'
import { TransferDialog, openTransferDialog } from './sync-transfer.js'

class SyncUploadDialog extends TransferDialog {
  static copy = {
    verb: 'Upload',
    heading: 'Upload to remote',
    key: 'uploaded',
    one: (label) => html`Upload <strong>"${label}"</strong> to the workspace's remote inventory?`,
    many: (count, kinds) => html`Upload <strong>${count}</strong> local ${kinds} to the workspace's remote inventory?`,
    note: html`<p class="nwd-note ui-hint">
      End-to-end encrypted with the workspace key — only workspace
      members can decrypt the uploaded content.
    </p>`,
  }

  async transfer({ kind, identifier }) {
    const result = kind === 'bundle'
      ? await putBundleToRemote(this.workspaceId, identifier)
      : await putFile(this.workspaceId, identifier, await readFileBytes(identifier))
    return result.ok ? undefined : result.reason ?? 'unknown'
  }
}

customElements.define('sync-upload-dialog', SyncUploadDialog)

export function openSyncUploadDialog(options) {
  return openTransferDialog('sync-upload-dialog', options)
}
