// Fronts the bundle Overview's "Download bundle": the file is plaintext and
// carries every source the bundle holds, and with the vault on it drops the
// encryption the stored copy has. Not what a one-click download suggests, so
// it asks first.
import { html } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog } from './confirmation-dialog.js'

class DownloadBundleDialog extends ConfirmationDialog {
  render() {
    return this.prompt({
      title: 'Download bundle', action: 'Download', kind: 'primary',
      body: html`Download <strong>"${this.bundleName}"</strong> to disk?`,
      notes: this.encrypted
        ? html`<p class="lwd-note">
          The bundle is saved <strong>unencrypted</strong> — even though your vault keeps its stored copy encrypted — and the file contains <strong>all of the bundle's related sources</strong>. Anyone with access to the downloaded file can read every bundled source, so store or share it with care.
        </p>`
        : html`<p class="lwd-note">
          The downloaded file is <strong>unencrypted</strong> and contains <strong>all of the bundle's related sources</strong>. Anyone with access to it can read every bundled source, so store or share it with care.
        </p>`,
    })
  }
}

customElements.define('download-bundle-dialog', DownloadBundleDialog)

// Resolves `{ confirmed }`. `encrypted`: the vault is on.
export function openDownloadBundleDialog({ name, encrypted } = {}) {
  return openAppDialog('download-bundle-dialog', { bundleName: name ?? '', encrypted: Boolean(encrypted) })
}
