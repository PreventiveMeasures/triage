// Boot-time prompt while the passkey vault is enabled (`deepview.passkey.v1`
// metadata present) but locked in this tab. The passkey's PRF output derives
// the session key, and triage and OPFS reads start succeeding. Dismissable:
// the app stays usable, and view.js keeps the locked banner up.
import { html, nothing, unsafeCSS } from 'lit'
import { unlockEncryption } from '#client/index.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import shareCSS from './dialog-share.css'

class PasskeyUnlockDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(shareCSS)]

  static properties = { _busy: { state: true }, _error: { state: true } }

  constructor() {
    super()
    this._busy = false
    this._error = ''
    this._abortController = null
  }

  // Resolves whether it unlocked. Aborts a ceremony in flight, or the OS prompt
  // would stay up after a cancel.
  _finish(success) {
    if (this._settled) return
    try { this._abortController?.abort() } catch {}
    super._finish(Boolean(success))
  }

  _onUnlock = async () => {
    if (this._busy) return
    this._busy = true
    this._error = ''
    this._abortController = new AbortController()
    try {
      // False only for a user cancel, which stays quiet so they can retry.
      if (await unlockEncryption({ signal: this._abortController.signal })) this._finish(true)
    } catch (err) {
      this._error = err?.message ?? String(err)
    } finally {
      this._busy = false
      this._abortController = null
    }
  }

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Unlock your data</h3>
      </header>
      <p class="nwd-note ui-hint">
        Your triage data and report files are encrypted with a passkey
        on this device. Unlock to load them.
      </p>
      ${this._error ? html`<p class="wsl-error">${this._error}</p>` : nothing}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>${this._busy ? 'Cancel' : 'Later'}</button>
        <button
          type="button"
          class="primary"
          ?disabled=${this._busy}
          @click=${this._onUnlock}
        >${this._busy ? 'Waiting…' : 'Unlock with passkey'}</button>
      </footer>
    </dialog>`
  }
}

customElements.define('passkey-unlock-dialog', PasskeyUnlockDialog)

export function openPasskeyUnlockDialog() {
  return openAppDialog('passkey-unlock-dialog')
}
