// `<delete-report-dialog>` — confirmation prompt that fronts the
// sidebar's "Delete current" button. Always shown, even when no
// persisted triage is attached, so the destructive action goes
// through an explicit Cancel/Delete prompt. Two concerns composed
// into the same dialog:
//   - triage impact (none / shared / orphan-radio)
//   - whether the report is also stored in the workspace's remote
//     objstore inventory — if so, a notice explains that the
//     delete fans out to remote too (no per-scope choice; the
//     pre-fix "delete locally only" path had no honest semantics
//     — a peer Replace would re-download the bytes detached, and
//     the cached tag→name pinned auto-download off for fresh
//     opens, so users got a quietly-deleted-but-still-listed
//     remote row either way).
//
// Sibling of `<leave-workspace-dialog>`: extends `AppDialog` for the
// shared shadow-DOM <dialog> chrome (focus-trap + Esc-to-cancel),
// with the `.lwd-*` list-dialog layer added on top. Public
// `openDeleteReportDialog({ name, triageImpact, inRemote })`
// returns a Promise that resolves to `{ confirmed, triage }`.
// The caller already knows `inRemote` (it passed it in), so it
// can decide whether to fan out a remote delete without the
// dialog re-reporting that bit.
import { html, nothing, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import listCSS from './dialog-list.css'

class DeleteReportDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS)]

  static properties = {
    reportName: { type: String },
    orphanedTriage: { type: Number },
    sharedTriage: { type: Number },
    // `true` when the report exists in the workspace's remote
    // objstore inventory. Surfaces the remote-side notice.
    inRemote: { type: Boolean },
    _triage: { state: true },
  }

  constructor() {
    super()
    this.reportName = ''
    this.orphanedTriage = 0
    this.sharedTriage = 0
    this.inRemote = false
    // Default to the non-destructive option: keep the orphaned
    // triage in localStorage so a re-import of the same report
    // resurfaces it automatically. The user has to actively pick
    // wipe to evict.
    this._triage = 'keep'
  }

  // Focus the Cancel button (not the base default's first input) so
  // an accidental Enter doesn't immediately commit the delete.
  focusInitial() {
    this.renderRoot.querySelector('button[data-role="cancel"]')?.focus()
  }

  _finish(confirmed) {
    if (this._settled) return
    const triage = this.orphanedTriage > 0 ? this._triage : 'keep'
    super._finish({ confirmed: Boolean(confirmed), triage })
  }

  _onClose = () => this._finish(false)
  _onCancel = () => this._finish(false)
  _onConfirm = () => this._finish(true)
  _onTriageChange = (e) => { this._triage = e.target.value }

  _remoteNotice() {
    if (!this.inRemote) return nothing
    return html`<p class="lwd-note">
      This report is also stored in the workspace's <strong>remote</strong> inventory and will be removed from there too. Newly synced workspace members won't see it; members who already downloaded it keep their local copy (and could re-upload).
    </p>`
  }

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
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Delete report</h3>
      </header>
      <p class="lwd-body">
        Delete <strong>"${this.reportName}"</strong>?
      </p>
      ${this._remoteNotice()}
      ${this._triageSection()}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="danger" @click=${this._onConfirm}>Delete</button>
      </footer>
    </dialog>`
  }
}

customElements.define('delete-report-dialog', DeleteReportDialog)

// Public entry point. Resolves with `{ confirmed, triage }`. Cancel
// / Esc / native close all resolve to `{ confirmed: false, triage:
// 'keep' }`. Pass `inRemote: true` when the workspace's objstore
// session holds a copy of the report — the dialog surfaces the
// remote-side notice; the caller already knows the remote scope
// so the dialog doesn't re-emit it.
export function openDeleteReportDialog({ name, triageImpact, inRemote } = {}) {
  return openAppDialog('delete-report-dialog', {
    reportName: name ?? '',
    orphanedTriage: triageImpact?.orphanedCount ?? 0,
    sharedTriage: triageImpact?.sharedCount ?? 0,
    inRemote: Boolean(inRemote),
  })
}
