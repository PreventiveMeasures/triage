// `<leave-workspace-dialog>` — confirmation prompt for the
// per-workspace Leave button. When the workspace has attached
// reports, surfaces a radio choice between detaching them back
// to the unattached list (keep the OPFS bytes, just drop
// workspace membership) and deleting them outright along with
// the workspace. In delete mode a SECOND section appears to
// handle persisted triage on those reports:
//   - none attached → silent note
//   - all also reachable from kept reports → silent note
//   - some would be orphaned → radio (keep vs. wipe)
// Either way the server-side chain is left intact, so a leave on
// this device won't disturb peers still subscribed.
//
// Sibling of `<new-workspace-dialog>`: extends `AppDialog` for the
// shared shadow-DOM <dialog> chrome (focus-trap + Esc-to-cancel),
// with the `.lwd-*` list-dialog layer added on top. Public
// `openLeaveWorkspaceDialog({ name, reportCount, triageImpact })`
// returns a Promise that resolves to `{ confirmed, mode, triage }`
// where `mode` is 'detach' | 'delete' and `triage` is 'keep' |
// 'wipe' ('keep' is the default + falls back when the radio
// isn't shown).
import { html, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import listCSS from '../styles/dialog-list.css'

class LeaveWorkspaceDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS)]

  static properties = {
    workspaceName: { type: String },
    reportCount: { type: Number },
    bundleCount: { type: Number },
    orphanedTriage: { type: Number },
    sharedTriage: { type: Number },
    _mode: { state: true },
    _triage: { state: true },
    _settled: { state: true },
  }

  constructor() {
    super()
    this.workspaceName = ''
    this.reportCount = 0
    this.bundleCount = 0
    this.orphanedTriage = 0
    this.sharedTriage = 0
    // Default to the non-destructive option — detaching keeps the
    // user's analyzed reports on disk so a wrong-button click on a
    // confirmation dialog doesn't silently shred work.
    this._mode = 'detach'
    // Same reasoning for the triage radio: keep is the
    // non-destructive default; the user has to actively pick
    // wipe to evict the persisted entries.
    this._triage = 'keep'
    // Guards against double-resolve when both `close` and a button
    // click fire (e.g. Cancel → dialog.close() → _onClose). Declared
    // in `static properties` for consistency with WorkspaceExportDialog
    // and so Lit's reactive system sees it.
    this._settled = false
  }

  // Focus the Cancel button (not the base default's first input) so
  // an accidental Enter doesn't immediately commit a destructive
  // action.
  focusInitial() {
    this.renderRoot.querySelector('button[data-role="cancel"]')?.focus()
  }

  _finish(confirmed) {
    if (this._settled) return
    // Empty workspaces never had a choice surfaced — fall back to
    // 'detach' (the no-op path) regardless of what the state cached.
    const mode = this.reportCount > 0 ? this._mode : 'detach'
    // Triage only matters in delete mode AND only when orphans
    // exist; everything else collapses to 'keep' (the no-op path).
    const triage = mode === 'delete' && this.orphanedTriage > 0
      ? this._triage
      : 'keep'
    super._finish({ confirmed: Boolean(confirmed), mode, triage })
  }

  _onClose = () => this._finish(false)
  _onCancel = () => this._finish(false)
  _onConfirm = () => this._finish(true)
  _onModeChange = (e) => { this._mode = e.target.value }
  _onTriageChange = (e) => { this._triage = e.target.value }

  // The triage section: only rendered when the user has selected
  // 'delete' mode. Three shapes based on the precomputed impact:
  //   - no triage attached at all → terse note
  //   - all attached triage is also on a kept report → reassuring
  //     note that nothing will be orphaned
  //   - some attached triage would be orphaned → keep/wipe radio
  _triageSection() {
    if (this._mode !== 'delete' || this.reportCount === 0) return ''
    const orphan = this.orphanedTriage
    const shared = this.sharedTriage
    if (orphan === 0 && shared === 0) {
      return html`<p class="lwd-note">No local triage is attached to ${this.reportCount === 1 ? 'this report' : 'these reports'}.</p>`
    }
    if (orphan === 0) {
      return html`<p class="lwd-note">Local triage on ${this.reportCount === 1 ? 'this report' : 'these reports'} is also attached to ${shared === 1 ? 'a report' : 'reports'} you're keeping. Nothing will be orphaned.</p>`
    }
    return html`<fieldset class="lwd-choice">
      <legend>
        <strong>${orphan}</strong> ${orphan === 1 ? 'triage entry won\'t' : 'triage entries won\'t'} be reachable from any remaining report. What should happen ${orphan === 1 ? 'to it' : 'to them'}?
      </legend>
      <label class="lwd-option">
        <input
          type="radio"
          name="lwd-triage"
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
          name="lwd-triage"
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
    const n = this.reportCount
    const b = this.bundleCount
    const hasReports = n > 0
    const reportNoun = n === 1 ? 'report' : 'reports'
    // Pluralization for the radio labels + hints. `n === 1`
    // takes singular pronoun / verb forms so the dialog reads
    // correctly when a workspace has exactly one report — the
    // mode-choice text now agrees in number with `reportNoun`.
    const them = n === 1 ? 'it' : 'them'
    const stay = n === 1 ? 'stays' : 'stay'
    const areRemoved = n === 1 ? 'is removed' : 'are removed'
    // Bundles attached to the workspace are detached on leave regardless
    // of mode — their OPFS bytes are content-addressed and may be
    // shared across workspaces, so 'delete mode' doesn't sweep them up
    // with the reports. The dialog surfaces the count + behaviour so
    // the user isn't surprised when the workspace disappears but the
    // bundles resurface in the unfiled Bundles section.
    const bundleNote = b > 0
      ? html`<p class="lwd-note">${b === 1 ? 'One bundle is' : `${b} bundles are`} also attached. ${b === 1 ? 'It' : 'They'} will become unfiled — the bundle bytes stay on this device either way (delete bundles manually from the Bundles list if you want them gone).</p>`
      : ''
    const choice = hasReports
      ? html`<fieldset class="lwd-choice">
          <legend>
            What should happen to the <strong>${n}</strong> attached ${reportNoun}?
          </legend>
          <label class="lwd-option">
            <input
              type="radio"
              name="lwd-mode"
              value="detach"
              ?checked=${this._mode === 'detach'}
              @change=${this._onModeChange}
            >
            <span class="lwd-option-text">
              <span class="lwd-option-title">Move ${them} out of the workspace</span>
              <span class="lwd-option-hint">The ${reportNoun} ${stay} in this browser as unattached ${reportNoun}.</span>
            </span>
          </label>
          <label class="lwd-option">
            <input
              type="radio"
              name="lwd-mode"
              value="delete"
              ?checked=${this._mode === 'delete'}
              @change=${this._onModeChange}
            >
            <span class="lwd-option-text">
              <span class="lwd-option-title">Delete ${them} along with the workspace</span>
              <span class="lwd-option-hint">The ${reportNoun} ${areRemoved} from this browser.</span>
            </span>
          </label>
        </fieldset>`
      : (b > 0
        ? html`<p class="lwd-empty">No reports are attached to this workspace (only bundles, see below).</p>`
        : html`<p class="lwd-empty">No reports are attached to this workspace.</p>`)
    return html`<dialog @close=${this._onClose}>
      <header class="lwd-head">
        <h3>Leave workspace</h3>
      </header>
      <p class="lwd-body">
        Leave workspace <strong>"${this.workspaceName}"</strong> on this device?
      </p>
      ${choice}
      ${bundleNote}
      ${this._triageSection()}
      <ul class="lwd-list">
        <li>Workspace synchronization data stays on the sync server — peers (and your other devices) keep their copy.</li>
      </ul>
      <footer class="lwd-actions">
        <span class="lwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="danger" @click=${this._onConfirm}>Leave</button>
      </footer>
    </dialog>`
  }
}

customElements.define('leave-workspace-dialog', LeaveWorkspaceDialog)

// Public entry point. Resolves with `{ confirmed, mode, triage }`.
// Cancel / Esc / native close all resolve to `{ confirmed: false,
// mode: 'detach', triage: 'keep' }`. Callers should branch on
// `confirmed` first.
export function openLeaveWorkspaceDialog({ name, reportCount, bundleCount, triageImpact } = {}) {
  return openAppDialog('leave-workspace-dialog', {
    workspaceName: name ?? '',
    reportCount: reportCount ?? 0,
    bundleCount: bundleCount ?? 0,
    orphanedTriage: triageImpact?.orphanedCount ?? 0,
    sharedTriage: triageImpact?.sharedCount ?? 0,
  })
}
