// Fronts dragging a report out of a workspace whose remote inventory holds it
// (sidebar.js onSidebarDrop). The drag drops the remote tag too, or a fresh
// open of the workspace would download it straight back; one not in remote
// has nothing to confirm and skips this.
import { html } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog, remoteNote } from './confirmation-dialog.js'

class DetachReportDialog extends ConfirmationDialog {
  render() {
    return this.prompt({
      title: 'Detach report', action: 'Detach', notes: remoteNote('report', true),
      body: html`Detach <strong>"${this.reportName}"</strong> from workspace <strong>"${this.workspaceName}"</strong>?`,
    })
  }
}

customElements.define('detach-report-dialog', DetachReportDialog)

// Resolves `{ confirmed }`.
export function openDetachReportDialog({ name, workspaceName } = {}) {
  return openAppDialog('detach-report-dialog', { reportName: name ?? '', workspaceName: workspaceName ?? '' })
}
