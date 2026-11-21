// Fronts dragging a bundle out of a workspace whose remote inventory holds it
// (sidebar.js onSidebarDrop). The drag drops the remote tag too, or a fresh
// open of the workspace would download it straight back; one not in remote
// has nothing to confirm and skips this.
import { html } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog, remoteNote } from './confirmation-dialog.js'

class DetachBundleDialog extends ConfirmationDialog {
  render() {
    return this.prompt({
      title: 'Detach bundle', action: 'Detach', notes: remoteNote('bundle', true),
      body: html`Detach <strong>"${this.bundleName}"</strong> from workspace <strong>"${this.workspaceName}"</strong>?`,
    })
  }
}

customElements.define('detach-bundle-dialog', DetachBundleDialog)

// Resolves `{ confirmed }`.
export function openDetachBundleDialog({ name, workspaceName } = {}) {
  return openAppDialog('detach-bundle-dialog', { bundleName: name ?? '', workspaceName: workspaceName ?? '' })
}
