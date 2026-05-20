// `<delete-report-dialog>` — confirmation prompt that fronts the
// sidebar's "Delete current" button. Always shown, even when no
// persisted triage is attached, so the destructive action goes
// through an explicit Cancel/Delete prompt. Three concerns
// composed into the same dialog:
//   - triage impact (none / shared / orphan-radio)
//   - whether the report is also stored in the workspace's remote
//     objstore inventory — if so, the user picks "delete from this
//     device only" vs "delete everywhere" (default everywhere, so
//     the destructive choice doesn't slip past while reading)
//   - the final destructive confirm
//
// Sibling of `<leave-workspace-dialog>`: extends `AppDialog` for the
// shared shadow-DOM <dialog> chrome (focus-trap + Esc-to-cancel),
// with the `.lwd-*` list-dialog layer added on top. Public
// `openDeleteReportDialog({ name, triageImpact, inRemote })`
// returns a Promise that resolves to `{ confirmed, triage,
// deleteFromRemote }`.
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
    // objstore inventory. Drives the remote-side radio block + the
    // body copy. The resolve-detail's `deleteFromRemote` flag rides
    // the user's pick.
    inRemote: { type: Boolean },
    _triage: { state: true },
    _scope: { state: true },
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
    // Default to the FULL teardown when the report is in remote:
    // the dialog's primary verb is "delete", and "this device
    // only" leaves a confusing trail (auto-download will resurface
    // the report on the next workspace open, since the bytes are
    // still in the cloud). Users who want the local-only behavior
    // pick it explicitly.
    this._scope = 'everywhere'
  }

  // Focus the Cancel button (not the base default's first input) so
  // an accidental Enter doesn't immediately commit the delete.
  focusInitial() {
    this.renderRoot.querySelector('button[data-role="cancel"]')?.focus()
  }

  _finish(confirmed) {
    if (this._settled) return
    const triage = this.orphanedTriage > 0 ? this._triage : 'keep'
    // `deleteFromRemote` only ever flips on when (1) the dialog
    // was confirmed (Cancel/Esc → false), (2) the report is
    // actually in remote, and (3) the user picked the
    // "everywhere" scope. Pre-fix this was implicit (always-on
    // when inRemote); the explicit radio + this final gate match
    // what the user clicked.
    const deleteFromRemote = Boolean(confirmed) && this.inRemote && this._scope === 'everywhere'
    super._finish({ confirmed: Boolean(confirmed), triage, deleteFromRemote })
  }

  _onClose = () => this._finish(false)
  _onCancel = () => this._finish(false)
  _onConfirm = () => this._finish(true)
  _onTriageChange = (e) => { this._triage = e.target.value }
  _onScopeChange = (e) => { this._scope = e.target.value }

  _scopeSection() {
    if (!this.inRemote) return nothing
    // Two-radio choice. The descriptive hint under each option
    // spells out the consequence so the user understands what
    // "this device only" actually does (the workspace's remote
    // copy survives, peers keep the report, AND auto-download
    // will re-attach the file on the next workspace open).
    return html`<fieldset class="lwd-choice">
      <legend>This report is also stored in the workspace's <strong>remote</strong> inventory. What should happen there?</legend>
      <label class="lwd-option">
        <input
          type="radio"
          name="drd-scope"
          value="everywhere"
          ?checked=${this._scope === 'everywhere'}
          @change=${this._onScopeChange}
        >
        <span class="lwd-option-text">
          <span class="lwd-option-title">Delete everywhere</span>
          <span class="lwd-option-hint">Remove from this device AND from the workspace's remote inventory. Other workspace members lose the report.</span>
        </span>
      </label>
      <label class="lwd-option">
        <input
          type="radio"
          name="drd-scope"
          value="local"
          ?checked=${this._scope === 'local'}
          @change=${this._onScopeChange}
        >
        <span class="lwd-option-text">
          <span class="lwd-option-title">Delete from this device only</span>
          <span class="lwd-option-hint">Keep the report on remote — other members keep their copy, and this device will auto-download it again the next time you open the workspace.</span>
        </span>
      </label>
    </fieldset>`
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
      <header class="lwd-head">
        <h3>Delete report</h3>
      </header>
      <p class="lwd-body">
        Delete <strong>"${this.reportName}"</strong>?
      </p>
      ${this._scopeSection()}
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

// Public entry point. Resolves with `{ confirmed, triage,
// deleteFromRemote }`. Cancel / Esc / native close all resolve to
// `{ confirmed: false, triage: 'keep', deleteFromRemote: false }`.
// Pass `inRemote: true` when the workspace's objstore session
// holds a copy of the report — the dialog will surface the
// remote-scope radio and the resolved `deleteFromRemote` flips on
// for the user's pick.
export function openDeleteReportDialog({ name, triageImpact, inRemote } = {}) {
  return openAppDialog('delete-report-dialog', {
    reportName: name ?? '',
    orphanedTriage: triageImpact?.orphanedCount ?? 0,
    sharedTriage: triageImpact?.sharedCount ?? 0,
    inRemote: Boolean(inRemote),
  })
}
