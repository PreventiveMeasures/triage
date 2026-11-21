// The password of an encrypted bundle dropped in. Each attempt calls
// `tryPassword`; a throw keeps the dialog open.
import { html, unsafeCSS } from 'lit'
import { openAppDialog, rejectStacked } from './app-dialog.js'
import { PasswordDialog } from './shared.js'
import shareCSS from './dialog-share.css'

class WorkspaceUnlockBundleDialog extends PasswordDialog {
  static styles = [...PasswordDialog.styles, unsafeCSS(shareCSS)]

  // `_tryPassword` holds the file bytes, set by the open helper.
  static secrets = { _password: '', _tryPassword: null }

  unlock(password) { return this._tryPassword(password) }
  unlocked(result) { this._finish(result) }

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Unlock encrypted workspace</h3>
      </header>
      ${this.passwordStage('This workspace bundle is password-protected. Enter the password the sender shared with you separately to decrypt and import it.', 'dv-bundle-unlock')}
    </dialog>`
  }
}

customElements.define('workspace-unlock-bundle-dialog', WorkspaceUnlockBundleDialog)

// Resolves what `tryPassword(password)` returned (the decrypted workspace), or
// null on cancel; the password never leaves. Rejects when another modal is
// open, so `addFiles` can say which file it was.
export function openWorkspaceUnlockBundleDialog({ tryPassword } = {}) {
  if (typeof tryPassword !== 'function') {
    throw new TypeError('openWorkspaceUnlockBundleDialog: tryPassword required')
  }
  return openAppDialog('workspace-unlock-bundle-dialog', { _tryPassword: tryPassword }, { exclusive: true, conflict: rejectStacked })
}
