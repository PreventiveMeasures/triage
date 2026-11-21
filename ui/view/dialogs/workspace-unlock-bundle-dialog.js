// The password of an encrypted bundle dropped in. Each attempt calls
// `tryPassword`; a throw keeps the dialog open.
import { html, nothing, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog, rejectStacked } from './app-dialog.js'
import { field, onEnter, secretInput } from './shared.js'
import shareCSS from './dialog-share.css'

class WorkspaceUnlockBundleDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(shareCSS)]

  static properties = { _password: { state: true }, _busy: { state: true }, _error: { state: true } }

  // `_tryPassword` holds the file bytes, set by the open helper.
  static secrets = { _password: '', _tryPassword: null }

  constructor() {
    super()
    this._password = ''
    this._busy = false
    this._error = ''
  }

  _onPasswordInput = (e) => { this._password = e.target.value; this._error = '' }

  _onUnlock = async () => {
    if (!this._password || this._busy) return
    this._busy = true
    this._error = ''
    try {
      const result = await this._tryPassword(this._password)
      // PBKDF2 takes a while: once cancelled, the decrypted workspace (its
      // private key, reports, triage) goes nowhere.
      if (!this._settled) this._finish(result)
    } catch (err) {
      if (!this._settled) this._error = err?.message ?? String(err)
    } finally {
      this._busy = false
    }
  }

  _onKeydown = onEnter(this._onUnlock)

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Unlock encrypted workspace</h3>
      </header>
      <p class="nwd-note ui-hint">
        This workspace bundle is password-protected. Enter the password
        the sender shared with you separately to decrypt and import it.
      </p>
      ${field('Password', secretInput({ name: 'dv-bundle-unlock', value: this._password, input: this._onPasswordInput, keydown: this._onKeydown }))}
      ${this._error ? html`<p class="wsl-error" role="alert">${this._error}</p>` : nothing}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button
          type="button"
          class="primary"
          ?disabled=${!this._password || this._busy}
          @click=${this._onUnlock}
        >${this._busy ? 'Unlocking…' : 'Unlock'}</button>
      </footer>
    </dialog>`
  }
}

customElements.define('workspace-unlock-bundle-dialog', WorkspaceUnlockBundleDialog)

// Resolves what `tryPassword(password)` returned, or null on cancel; the
// password never leaves. Rejects when another modal is open, so `addFiles` can
// say which file it was.
export function openWorkspaceUnlockBundleDialog({ tryPassword } = {}) {
  if (typeof tryPassword !== 'function') {
    throw new TypeError('openWorkspaceUnlockBundleDialog: tryPassword required')
  }
  return openAppDialog('workspace-unlock-bundle-dialog', { _tryPassword: tryPassword }, { exclusive: true, conflict: rejectStacked })
}
