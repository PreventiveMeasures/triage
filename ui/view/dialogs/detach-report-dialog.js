// `<detach-report-dialog>` — confirmation prompt that fronts the
// report drag-out path in `sidebar.js`'s `onSidebarDrop` when the
// source workspace's remote inventory holds a copy. Drag-out drops
// the source's remote tag (a fresh `openWorkspace(source)` would
// otherwise auto-download the report straight back, defeating the
// drag); the dialog surfaces that side-effect so the user can back
// out instead of silently losing the workspace's remote copy.
//
// Drag-out for a report that ISN'T in the source workspace's remote
// skips the dialog entirely — there's nothing destructive to confirm,
// it's a pure local membership detach.
//
// Sibling of `<detach-bundle-dialog>` / `<delete-report-dialog>`:
// extends `AppDialog` for the shared shadow-DOM <dialog> chrome
// (focus-trap + Esc-to-cancel), with the `.lwd-*` list-dialog layer
// added on top. Public `openDetachReportDialog({ name, workspaceName })`
// returns a Promise that resolves to `{ confirmed }`.
import { html, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import listCSS from './dialog-list.css'

class DetachReportDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS)]

  static properties = {
    reportName: { type: String },
    workspaceName: { type: String },
  }

  constructor() {
    super()
    this.reportName = ''
    this.workspaceName = ''
  }

  // Focus the Cancel button (not the base default's first input) so
  // an accidental Enter doesn't immediately commit the detach.
  focusInitial() {
    this.renderRoot.querySelector('button[data-role="cancel"]')?.focus()
  }

  _finish(confirmed) {
    if (this._settled) return
    super._finish({ confirmed: Boolean(confirmed) })
  }

  _onClose = () => this._finish(false)
  _onCancel = () => this._finish(false)
  _onConfirm = () => this._finish(true)

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Detach report</h3>
      </header>
      <p class="lwd-body">
        Detach <strong>"${this.reportName}"</strong> from workspace <strong>"${this.workspaceName}"</strong>?
      </p>
      <p class="lwd-note">
        This report is also stored in the workspace's <strong>remote</strong> inventory and will be removed from there too. Newly synced workspace members won't see it; members who already downloaded it keep their local copy (and could re-upload). The report bytes stay on this device — drop it onto another workspace to attach it there.
      </p>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="danger" @click=${this._onConfirm}>Detach</button>
      </footer>
    </dialog>`
  }
}

customElements.define('detach-report-dialog', DetachReportDialog)

// Public entry point. Resolves with `{ confirmed }`. Cancel / Esc /
// native close all resolve to `{ confirmed: false }`. Only call this
// when the source workspace's objstore session holds a copy of the
// report — drag-out for a report that isn't in remote has nothing to
// confirm and should skip straight to the detach.
export function openDetachReportDialog({ name, workspaceName } = {}) {
  return openAppDialog('detach-report-dialog', {
    reportName: name ?? '',
    workspaceName: workspaceName ?? '',
  })
}
