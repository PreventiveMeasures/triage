// Fronts a workspace's Leave button. Attached reports can be detached back to
// the unattached list or deleted with it, and deleting asks what becomes of
// triage no remaining report reaches. Either way the server-side chain stays,
// so leaving on this device doesn't disturb peers.
import { html, nothing } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog, optionHint, orphanedTriage, radioOption } from './confirmation-dialog.js'

class LeaveWorkspaceDialog extends ConfirmationDialog {
  static properties = { _mode: { state: true }, _triage: { state: true } }

  constructor() {
    super()
    // The non-destructive defaults, so a wrong click shreds nothing.
    this._mode = 'detach'
    this._triage = 'keep'
  }

  // A choice never shown falls back to its no-op: 'detach' without reports,
  // 'keep' unless deleting strands triage.
  confirmationResult(confirmed) {
    const mode = this.reportCount > 0 ? this._mode : 'detach'
    const triage = mode === 'delete' && this.orphanedTriage > 0 ? this._triage : 'keep'
    return { confirmed, mode, triage }
  }

  _onModeChange = (e) => { this._mode = e.target.value }
  _onTriageChange = (e) => { this._triage = e.target.value }

  _modeChoice() {
    const n = this.reportCount
    const one = n === 1
    const reports = one ? 'report' : 'reports'
    const option = (value, title, hint) => radioOption({ name: 'lwd-mode', value, current: this._mode, change: this._onModeChange, title }, optionHint(hint))
    return html`<fieldset class="lwd-choice">
      <legend>
        What should happen to the <strong>${n}</strong> attached ${reports}?
      </legend>
      ${option('detach', `Move ${one ? 'it' : 'them'} out of the workspace`, `The ${reports} ${one ? 'stays' : 'stay'} in this browser as unattached ${reports}.`)}
      ${option('delete', `Delete ${one ? 'it' : 'them'} along with the workspace`, `The ${reports} ${one ? 'is removed' : 'are removed'} from this browser.`)}
    </fieldset>`
  }

  render() {
    const n = this.reportCount
    const b = this.bundleCount
    // Bundles are content-addressed and may be shared, so leaving only ever
    // detaches them, whichever the mode.
    const bundles = b > 0
      ? html`<p class="lwd-note">${b === 1 ? 'One bundle is' : `${b} bundles are`} also attached. ${b === 1 ? 'It' : 'They'} will become unfiled — the bundle bytes stay on this device either way (delete bundles manually from the Bundles list if you want them gone).</p>`
      : nothing
    return this.prompt({
      title: 'Leave workspace', action: 'Leave',
      body: html`Leave workspace <strong>"${this.workspaceName}"</strong> on this device?`,
      notes: html`${n > 0 ? this._modeChoice()
        : html`<p class="lwd-empty">No reports are attached to this workspace${b > 0 ? ' (only bundles, see below)' : ''}.</p>`}
        ${bundles}
        ${this._mode === 'delete' && n > 0 ? orphanedTriage({
          name: 'lwd-triage', orphaned: this.orphanedTriage, shared: this.sharedTriage,
          current: this._triage, change: this._onTriageChange, subject: n === 1 ? 'this report' : 'these reports',
        }) : nothing}
        <ul class="lwd-list">
          <li>Workspace synchronization data stays on the sync server — peers (and your other devices) keep their copy.</li>
        </ul>`,
    })
  }
}

customElements.define('leave-workspace-dialog', LeaveWorkspaceDialog)

// Resolves `{ confirmed, mode, triage }`: `mode` 'detach' or 'delete',
// `triage` 'keep' or 'wipe'.
export function openLeaveWorkspaceDialog({ name, reportCount, bundleCount, triageImpact } = {}) {
  return openAppDialog('leave-workspace-dialog', {
    workspaceName: name ?? '',
    reportCount: reportCount ?? 0,
    bundleCount: bundleCount ?? 0,
    orphanedTriage: triageImpact?.orphanedCount ?? 0,
    sharedTriage: triageImpact?.sharedCount ?? 0,
  })
}
