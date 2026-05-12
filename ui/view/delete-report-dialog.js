// `<delete-report-dialog>` — confirmation prompt that fronts the
// sidebar's "Delete current" button. Always shown, even when no
// persisted triage is attached, so the destructive action goes
// through an explicit Cancel/Delete prompt. Three shapes based on
// the precomputed triage impact:
//   - no triage attached → terse note
//   - all attached triage is also reachable from a kept report →
//     reassuring note that nothing will be orphaned
//   - some attached triage would be orphaned → radio (keep vs.
//     wipe)
//
// Sibling of `<leave-workspace-dialog>`: native <dialog> for
// focus-trap + Esc-to-cancel, light-DOM render so global
// stylesheet rules in sidebar.css apply. Public
// `openDeleteReportDialog({ name, triageImpact })` returns a
// Promise that resolves to `{ confirmed, triage }` — `triage` is
// 'keep' | 'wipe' (defaults to 'keep' / falls back when the radio
// isn't shown).
import { LitElement, html } from 'lit'

class DeleteReportDialog extends LitElement {
  static properties = {
    reportName: { type: String },
    orphanedTriage: { type: Number },
    sharedTriage: { type: Number },
    _triage: { state: true },
  }

  // Light DOM — `.delete-report-dialog` rules live in sidebar.css.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.reportName = ''
    this.orphanedTriage = 0
    this.sharedTriage = 0
    // Default to the non-destructive option: keep the orphaned
    // triage in localStorage so a re-import of the same report
    // resurfaces it automatically. The user has to actively pick
    // wipe to evict.
    this._triage = 'keep'
  }

  firstUpdated() {
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.showModal()
    const cancel = this.querySelector('button[data-role="cancel"]')
    if (cancel) cancel.focus()
  }

  _finish(confirmed) {
    if (this._settled) return
    this._settled = true
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.close()
    // Triage only matters when orphans exist; otherwise collapse
    // to 'keep' (the no-op path).
    const triage = this.orphanedTriage > 0 ? this._triage : 'keep'
    this.dispatchEvent(new CustomEvent('resolve', {
      detail: { confirmed: Boolean(confirmed), triage },
    }))
  }

  _onClose = () => this._finish(false)
  _onCancel = () => this._finish(false)
  _onConfirm = () => this._finish(true)
  _onTriageChange = (e) => { this._triage = e.target.value }

  _triageSection() {
    const orphan = this.orphanedTriage
    const shared = this.sharedTriage
    if (orphan === 0 && shared === 0) {
      return html`<p class="lwd-note">No local triage is attached to this report.</p>`
    }
    if (orphan === 0) {
      return html`<p class="lwd-note">Local triage on this report is also attached to ${shared === 1 ? 'a report' : 'reports'} you're keeping. Nothing will be orphaned.</p>`
    }
    return html`<fieldset class="lwd-choice">
      <legend>
        <strong>${orphan}</strong> ${orphan === 1 ? 'triage entry won\'t' : 'triage entries won\'t'} be reachable from any remaining report. What should happen ${orphan === 1 ? 'to it' : 'to them'}?
      </legend>
      <label class="lwd-option">
        <input
          type="radio"
          name="drd-triage"
          value="keep"
          ?checked=${this._triage === 'keep'}
          @change=${this._onTriageChange}
        >
        <span class="lwd-option-text">
          <span class="lwd-option-title">Keep</span>
          <span class="lwd-option-hint">Reapplied automatically if a matching report is imported later.</span>
        </span>
      </label>
      <label class="lwd-option">
        <input
          type="radio"
          name="drd-triage"
          value="wipe"
          ?checked=${this._triage === 'wipe'}
          @change=${this._onTriageChange}
        >
        <span class="lwd-option-text">
          <span class="lwd-option-title">Wipe</span>
          <span class="lwd-option-hint">Drop the orphaned triage from this browser.</span>
        </span>
      </label>
    </fieldset>`
  }

  render() {
    return html`<dialog class="delete-report-dialog leave-workspace-dialog" @close=${this._onClose}>
      <header class="lwd-head">
        <h3>Delete report</h3>
      </header>
      <p class="lwd-body">
        Delete <strong>"${this.reportName}"</strong> from this device?
      </p>
      ${this._triageSection()}
      <footer class="lwd-actions">
        <span class="lwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="danger" @click=${this._onConfirm}>Delete</button>
      </footer>
    </dialog>`
  }
}

customElements.define('delete-report-dialog', DeleteReportDialog)

// Public entry point. Resolves with `{ confirmed, triage }`.
// Cancel / Esc / native close all resolve to `{ confirmed: false,
// triage: 'keep' }`.
export function openDeleteReportDialog({ name, triageImpact } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('delete-report-dialog')
    el.reportName = name ?? ''
    el.orphanedTriage = triageImpact?.orphanedCount ?? 0
    el.sharedTriage = triageImpact?.sharedCount ?? 0
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    document.body.appendChild(el)
  })
}
