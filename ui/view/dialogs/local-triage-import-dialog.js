import { html, nothing } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog } from './confirmation-dialog.js'

class LocalTriageImportDialog extends ConfirmationDialog {
  static properties = { matched: { type: Number }, available: { type: Number } }

  constructor() {
    super()
    this.matched = 0
    this.available = 0
  }

  firstUpdated() {
    if (this.signal?.aborted) { this._onCancel(); return }
    this.signal?.addEventListener('abort', this._onCancel, { once: true })
    super.firstUpdated()
  }

  disconnectedCallback() {
    this.signal?.removeEventListener('abort', this._onCancel)
    super.disconnectedCallback()
  }

  confirmationResult(confirmed) {
    return { confirmed: confirmed && this.matched > 0 && !this.signal?.aborted }
  }

  render() {
    return html`<dialog aria-labelledby="import-title" @close=${this._onClose}>
      <header><h3 id="import-title">Import local triage</h3></header>
      <p class="lwd-body"><strong>${this.matched}</strong> of <strong>${this.available}</strong> local triage ${this.available === 1 ? 'entry' : 'entries'} can be imported.</p>
      <p class="lwd-note">${this.matched > 0
        ? 'Import saved triage and comments for these findings? Conflicting values will prompt for resolution.'
        : this.available > 0 ? 'None match findings in managed reports.' : 'There is no saved local triage to import.'}</p>
      ${this.available > this.matched ? html`<p class="lwd-empty">Unmatched entries stay in this browser.</p>` : nothing}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>${this.matched > 0 ? 'Cancel' : 'Close'}</button>
        ${this.matched > 0 ? html`<button type="button" class="primary" @click=${this._onConfirm}>Import triage</button>` : nothing}
      </footer>
    </dialog>`
  }
}

customElements.define('local-triage-import-dialog', LocalTriageImportDialog)

export function openLocalTriageImportDialog(props) {
  return openAppDialog('local-triage-import-dialog', props)
}
