// Fronts the sidebar's "Delete current" for a bundle. There is no
// delete-locally-only choice: see delete-report-dialog.js.
import { html, nothing } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog, remoteNote } from './confirmation-dialog.js'

class DeleteBundleDialog extends ConfirmationDialog {
  render() {
    return this.prompt({
      title: 'Delete bundle', action: 'Delete',
      body: html`Delete <strong>"${this.bundleName}"</strong>?`,
      notes: this.inRemote ? remoteNote('bundle') : nothing,
    })
  }
}

customElements.define('delete-bundle-dialog', DeleteBundleDialog)

// Resolves `{ confirmed }`. `inRemote`: an owning workspace's objstore holds
// a copy, so the delete reaches it too.
export function openDeleteBundleDialog({ name, inRemote } = {}) {
  return openAppDialog('delete-bundle-dialog', { bundleName: name ?? '', inRemote: Boolean(inRemote) })
}
