// `<passkey-unlock-dialog>` — boot-time prompt shown when the
// passkey vault is enabled (i.e. `deepview.passkey.v1` metadata is
// present in localStorage) but this tab hasn't unlocked it yet. The
// user clicks "Unlock with passkey", the browser prompts for the
// stored credential, the assertion's PRF output is derived to a
// session key, and triage / OPFS reads start succeeding.
//
// Layout mirrors the setup + share-link dialogs (native <dialog>,
// light-DOM render, focus-trap). The user can dismiss; the app is
// still usable but encrypted-at-rest data won't load (banner stays
// up via the vault-state listener wired in view.js).

import { LitElement, html, nothing } from 'lit'
import { unlockEncryption } from '../../client/index.js'

class PasskeyUnlockDialog extends LitElement {
  static properties = {
    _busy: { state: true },
    _error: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this._busy = false
    this._error = ''
    this._abortController = null
  }

  firstUpdated() {
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.showModal()
    // Auto-focus the primary action so Enter unlocks. The
    // authenticator's own UI takes over once the WebAuthn call
    // fires, so we don't need any input field here.
    const button = this.querySelector('button.primary')
    if (button) button.focus()
  }

  _finish(success) {
    if (this._settled) return
    this._settled = true
    // Abort any in-flight WebAuthn ceremony so the system prompt
    // disappears when the user cancels via our dialog (Browser /
    // OS prompts otherwise stay up and confuse the user).
    if (this._abortController) {
      try { this._abortController.abort() } catch {}
    }
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: !!success }))
  }

  _onClose = () => this._finish(false)
  _onCancel = () => this._finish(false)

  _onUnlock = async () => {
    if (this._busy) return
    this._busy = true
    this._error = ''
    this._abortController = new AbortController()
    try {
      const ok = await unlockEncryption({ signal: this._abortController.signal })
      if (ok) {
        this._finish(true)
        return
      }
      // unlockEncryption returns false ONLY for a user-cancel
      // (NotAllowedError / AbortError). Don't surface anything in
      // that case — the dialog stays up so the user can retry.
      this._error = ''
    } catch (err) {
      this._error = err?.message ?? String(err)
    } finally {
      this._busy = false
      this._abortController = null
    }
  }

  render() {
    return html`<dialog class="new-workspace-dialog workspace-share-dialog" @close=${this._onClose}>
      <header class="nwd-head">
        <h3>Unlock your data</h3>
      </header>
      <p class="nwd-note">
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
  return new Promise((resolve) => {
    const el = document.createElement('passkey-unlock-dialog')
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    document.body.append(el)
  })
}
