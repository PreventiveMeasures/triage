// Fronts the sidebar's "Delete current", always, even with no triage attached.
// Asks what becomes of triage the delete would strand, and says when the delete
// reaches the workspace's remote inventory too. No delete-locally-only choice:
// a peer's Replace would download the bytes back, and the cached tag→name kept
// auto-download off for fresh opens, so the remote row stayed listed anyway.
import { html, nothing } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog, orphanedTriage, remoteNote } from './confirmation-dialog.js'

class DeleteReportDialog extends ConfirmationDialog {
  static properties = { _triage: { state: true } }

  constructor() {
    super()
    // Keep unless wipe is picked: a re-import of the report resurfaces it.
    this._triage = 'keep'
  }

  confirmationResult(confirmed) {
    return { confirmed, triage: this.orphanedTriage > 0 ? this._triage : 'keep' }
  }

  _onTriageChange = (e) => { this._triage = e.target.value }

  render() {
    return this.prompt({
      title: `Delete ${this.kindLabel}`, action: 'Delete',
      body: html`Delete <strong>"${this.reportName}"</strong>?`,
      notes: html`${this.inRemote ? remoteNote('report') : nothing}
        ${orphanedTriage({
          name: 'drd-triage', orphaned: this.orphanedTriage, shared: this.sharedTriage,
          current: this._triage, change: this._onTriageChange, subject: `this ${this.kindLabel}`, sharedSubject: 'this report',
        })}`,
    })
  }
}

customElements.define('delete-report-dialog', DeleteReportDialog)

// Resolves `{ confirmed, triage }`, `triage` 'keep' or 'wipe'. `inRemote`: the
// workspace's objstore holds a copy; `kindLabel` names what isn't a report (a
// links file, which carries no findings).
export function openDeleteReportDialog({ name, kindLabel, triageImpact, inRemote } = {}) {
  return openAppDialog('delete-report-dialog', {
    reportName: name ?? '',
    kindLabel: kindLabel || 'report',
    orphanedTriage: triageImpact?.orphanedCount ?? 0,
    sharedTriage: triageImpact?.sharedCount ?? 0,
    inRemote: Boolean(inRemote),
  })
}
