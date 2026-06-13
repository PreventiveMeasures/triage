// `<download-bundle-dialog>` — confirmation prompt that fronts the
// bundle Overview's "Download bundle" button. Saving a bundle writes
// its bytes to disk as a plaintext file that carries every source the
// bundle bundled (the full original artifact, sources and all), and —
// when the vault is enabled — drops the encryption the on-disk OPFS
// copy has. These are properties a user might not expect from a
// one-click download, so the action goes through an explicit
// Cancel/Download prompt; the warning copy adapts to whether the
// vault is encrypted (see `_securityNote`).
//
// Sibling of `<delete-bundle-dialog>` / `<detach-bundle-dialog>`:
// extends `AppDialog` for the shared shadow-DOM <dialog> chrome
// (focus-trap + Esc-to-cancel), with the `.lwd-*` list-dialog layer
// added on top. Public `openDownloadBundleDialog({ name, encrypted })`
// returns a Promise that resolves to `{ confirmed }`.
import { html, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import listCSS from './dialog-list.css'

class DownloadBundleDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS)]

  static properties = {
    bundleName: { type: String },
    // `true` when the passkey/password vault is enabled, so the
    // bundle's on-disk OPFS copy is stored encrypted — the note then
    // contrasts that with the plaintext file the download writes.
    encrypted: { type: Boolean },
  }

  constructor() {
    super()
    this.bundleName = ''
    this.encrypted = false
  }

  // Focus Cancel (not the base default's primary button) so an
  // accidental Enter doesn't write a decrypted copy to disk before
  // the warning is read — matches the sibling bundle dialogs.
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

  // The warning paragraph. When the vault is encrypted the download
  // strips a protection the stored copy has (it writes plaintext to
  // disk), so the note draws that contrast; otherwise the on-disk copy
  // is already plaintext and the note just flags the plaintext file
  // and its full source contents.
  _securityNote() {
    if (this.encrypted) {
      return html`<p class="lwd-note">
        The bundle is saved <strong>unencrypted</strong> — even though your vault keeps its stored copy encrypted — and the file contains <strong>all of the bundle's related sources</strong>. Anyone with access to the downloaded file can read every bundled source, so store or share it with care.
      </p>`
    }
    return html`<p class="lwd-note">
      The downloaded file is <strong>unencrypted</strong> and contains <strong>all of the bundle's related sources</strong>. Anyone with access to it can read every bundled source, so store or share it with care.
    </p>`
  }

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Download bundle</h3>
      </header>
      <p class="lwd-body">
        Download <strong>"${this.bundleName}"</strong> to disk?
      </p>
      ${this._securityNote()}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="primary" @click=${this._onConfirm}>Download</button>
      </footer>
    </dialog>`
  }
}

customElements.define('download-bundle-dialog', DownloadBundleDialog)

// Public entry point. Resolves with `{ confirmed }`. Cancel / Esc /
// native close all resolve to `{ confirmed: false }`.
export function openDownloadBundleDialog({ name, encrypted } = {}) {
  return openAppDialog('download-bundle-dialog', {
    bundleName: name ?? '',
    encrypted: Boolean(encrypted),
  })
}
