// `<delete-bundle-dialog>` — confirmation prompt that fronts the
// sidebar's "Delete current" button when a bundle is the active
// selection. Always shown so the destructive action goes through an
// explicit Cancel/Delete prompt. When the bundle exists in any
// owning workspace's remote objstore inventory, a notice surfaces
// explaining that the delete fans out to remote too (no per-scope
// choice; the "delete locally only" path had no honest semantics —
// see the matching note in `delete-report-dialog.js`).
//
// Sibling of `<delete-report-dialog>`: extends `AppDialog` for the
// shared shadow-DOM <dialog> chrome (focus-trap + Esc-to-cancel),
// with the `.lwd-*` list-dialog layer added on top. Public
// `openDeleteBundleDialog({ name, inRemote })` returns a Promise
// that resolves to `{ confirmed }`. The caller already knows
// `inRemote` (it passed it in), so it can decide whether to fan
// out a remote delete without the dialog re-reporting that bit.
import { html, nothing, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import listCSS from './dialog-list.css'

class DeleteBundleDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS)]

  static properties = {
    bundleName: { type: String },
    // true = bundle is in an owning workspace's remote objstore inventory; surfaces the remote-side notice.
    inRemote: { type: Boolean },
  }

  constructor() {
    super()
    this.bundleName = ''
    this.inRemote = false
  }

  // Focus the Cancel button (not the base default's first input) so
  // an accidental Enter doesn't immediately commit the delete.
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

  _remoteNotice() {
    if (!this.inRemote) return nothing
    return html`<p class="lwd-note">
      This bundle is also stored in the workspace's <strong>remote</strong> inventory and will be removed from there too. Newly synced workspace members won't see it; members who already downloaded it keep their local copy (and could re-upload).
    </p>`
  }

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Delete bundle</h3>
      </header>
      <p class="lwd-body">
        Delete <strong>"${this.bundleName}"</strong>?
      </p>
      ${this._remoteNotice()}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="danger" @click=${this._onConfirm}>Delete</button>
      </footer>
    </dialog>`
  }
}

customElements.define('delete-bundle-dialog', DeleteBundleDialog)

// Public entry point. Resolves with `{ confirmed }`. Cancel / Esc /
// native close all resolve to `{ confirmed: false }`. Pass
// `inRemote: true` when any owning workspace's objstore session
// holds a copy of the bundle, to surface the remote-side notice.
export function openDeleteBundleDialog({ name, inRemote } = {}) {
  return openAppDialog('delete-bundle-dialog', {
    bundleName: name ?? '',
    inRemote: Boolean(inRemote),
  })
}
