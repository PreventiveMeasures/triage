// `<workspace-unlock-bundle-dialog>` — receiver-side password prompt
// for an encrypted bundle drop. Sibling of `<workspace-unlock-link-dialog>`.
// Owns the wrong-password retry loop: each typed password calls
// `tryPassword`, and a throw keeps the dialog open.
import { LitElement, html, nothing } from 'lit'
import { makeStackedModalError } from './dom.js'

class WorkspaceUnlockBundleDialog extends LitElement {
  static properties = {
    _password: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _settled: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this._password = ''
    this._busy = false
    this._error = ''
    this._settled = false
    // Always set by `openWorkspaceUnlockBundleDialog` before mount.
    this._tryPassword = null
  }

  firstUpdated() {
    const dialog = this.querySelector('dialog')
    if (!dialog) return
    try {
      dialog.showModal()
    } catch (err) {
      // Another modal is already open. Let the wrapper reject so the
      // caller can surface a message with file context (addFiles
      // alerts per-file with the filename in scope).
      this._signalModalConflict(err)
      return
    }
    const input = this.querySelector('input[type="password"]')
    if (input) input.focus()
  }

  _signalModalConflict(err) {
    if (this._settled) return
    this._settled = true
    // `_finish` wipes `_password` too, but at modal-conflict time the
    // user hasn't typed yet — only the wrapper-set `_tryPassword`
    // closure (capturing file bytes + decryption call) needs wiping
    // so the bytes become GC-eligible immediately even if the
    // wrapper's `el.remove()` is delayed by a slow listener.
    this._tryPassword = null
    this.dispatchEvent(new CustomEvent('modal-conflict', { detail: { cause: err } }))
  }

  _finish(result) {
    if (this._settled) return
    this._settled = true
    // Drop sensitive state on every exit path. `_password` carries
    // the typed secret; `_tryPassword` is the wrapper-set closure
    // that captures the file bytes + would invoke decryptBundle if
    // called. Lit's reactive setter retains the old value in its
    // change-tracker until the next microtask, but `el.remove()`
    // runs sync in the wrapper's resolve listener, so the post-
    // remove element is GC-eligible.
    this._password = ''
    this._tryPassword = null
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: result }))
  }

  _onClose = () => this._finish(null)
  _onCancel = () => this._finish(null)

  _onPasswordInput = (e) => { this._password = e.target.value; this._error = '' }

  _onUnlock = async () => {
    if (!this._password || this._busy) return
    this._busy = true
    this._error = ''
    try {
      const result = await this._tryPassword(this._password)
      // PBKDF2 takes hundreds of ms; user may have cancelled in the
      // meantime. Skip the resolve so the decrypted `result` (with
      // workspace.privateKey + reports + triage) isn't passed through
      // to a settled-and-detached dialog.
      if (this._settled) return
      this._finish(result)
    } catch (err) {
      if (this._settled) return
      this._error = err?.message ?? String(err)
    } finally {
      this._busy = false
    }
  }

  _onKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      this._onUnlock()
    }
  }

  render() {
    return html`<dialog class="new-workspace-dialog workspace-unlock-dialog" @close=${this._onClose}>
      <header class="nwd-head">
        <h3>Unlock encrypted workspace</h3>
      </header>
      <p class="nwd-note">
        This workspace bundle is password-protected. Enter the password
        the sender shared with you separately to decrypt and import it.
      </p>
      <label class="wsl-field">
        <span>Password</span>
        <input
          type="password"
          class="nwd-input"
          autocomplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          name="dv-bundle-unlock"
          maxlength="1024"
          .value=${this._password}
          @input=${this._onPasswordInput}
          @keydown=${this._onKeydown}
        >
      </label>
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

// `tryPassword(password)` is invoked per attempt; throw to keep the
// dialog open. Resolves with the `tryPassword` return value on success
// or `null` on cancel. Rejects when another modal is already open so
// the caller (typically `addFiles`) can surface a per-file error
// message with filename context. The plaintext password never crosses
// this boundary.
export function openWorkspaceUnlockBundleDialog({ tryPassword } = {}) {
  if (typeof tryPassword !== 'function') {
    throw new TypeError('openWorkspaceUnlockBundleDialog: tryPassword required')
  }
  return new Promise((resolve, reject) => {
    const el = document.createElement('workspace-unlock-bundle-dialog')
    el._tryPassword = tryPassword
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    el.addEventListener('modal-conflict', (e) => {
      el.remove()
      reject(makeStackedModalError(e.detail?.cause))
    })
    document.body.append(el)
  })
}
