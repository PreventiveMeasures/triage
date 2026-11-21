import { html, nothing } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog } from './confirmation-dialog.js'

class LocalTriageImportDialog extends ConfirmationDialog {
  constructor() {
    super()
    this.matched = 0
    this.available = 0
  }

  confirmationResult(confirmed) {
    return { confirmed: confirmed && this.matched > 0 && !this.signal?.aborted }
  }

  render() {
    const any = this.matched > 0
    return this.prompt({
      title: 'Import local triage', titleId: 'import-title',
      body: html`<strong>${this.matched}</strong> of <strong>${this.available}</strong> local triage ${this.available === 1 ? 'entry' : 'entries'} can be imported.`,
      notes: html`<p class="lwd-note">${any
        ? 'Import saved triage and comments for these findings? Conflicting values will prompt for resolution.'
        : this.available > 0 ? 'None match findings in managed reports.' : 'There is no saved local triage to import.'}</p>
      ${this.available > this.matched ? html`<p class="lwd-empty">Unmatched entries stay in this browser.</p>` : nothing}`,
      cancel: any ? 'Cancel' : 'Close',
      action: any ? 'Import triage' : null, kind: 'primary',
    })
  }
}

customElements.define('local-triage-import-dialog', LocalTriageImportDialog)

export function openLocalTriageImportDialog(props) {
  return openAppDialog('local-triage-import-dialog', props)
}
