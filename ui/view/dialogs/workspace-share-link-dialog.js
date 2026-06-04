// `<workspace-share-link-dialog>` — sender-side prompt for the
// per-workspace "Share by link" affordance. Prompts for the
// outgoing name (defaulting to the workspace's current one) and a
// password, derives an AES-GCM key (PBKDF2), and shows the user a
// copyable `#share=…` link. The receiver-side unlock dialog lives
// in `workspace-unlock-link-dialog.js`.
//
// Sibling of `<new-workspace-dialog>` / `<leave-workspace-dialog>`:
// native <dialog> for focus-trap + Esc-to-cancel, light-DOM render
// so global stylesheet rules in sidebar.css apply.
import { html, nothing, unsafeCSS } from 'lit'
import { buildShareUrl, encodeShareLink } from '#client/index.js'
import { makeStackedModalError } from '../dom.js'
import { AppDialog } from './app-dialog.js'
import shareCSS from './dialog-share.css'

class WorkspaceShareLinkDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(shareCSS)]

  static properties = {
    workspaceId: { type: String },
    initialName: { type: String },
    privateKeyBase64: { type: String },
    _name: { state: true },
    _password: { state: true },
    _confirm: { state: true },
    _url: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _copied: { state: true },
    _settled: { state: true },
  }

  constructor() {
    super()
    this.workspaceId = ''
    this.initialName = ''
    this.privateKeyBase64 = ''
    this._name = ''
    this._password = ''
    this._confirm = ''
    this._url = ''
    this._busy = false
    this._error = ''
    this._copied = false
    this._settled = false
  }

  beforeOpen() { this._name = this.initialName }

  focusInitial() {
    this.renderRoot.querySelector('input[data-role="name"]')?.focus()
  }

  _finish() {
    if (this._settled) return
    if (this._copiedTimer) {
      clearTimeout(this._copiedTimer)
      this._copiedTimer = null
    }
    // Drop sensitive state on every exit path, not just after a
    // successful generate. `_password` / `_confirm` carry the typed
    // secret; `_url` embeds the workspace private key (base64url +
    // AES-GCM ciphertext the password unlocks); `privateKeyBase64` is
    // the raw 32-byte key passed in via property assignment. The
    // property slots empty immediately, but Lit's reactive setter
    // retains the old value in its change-tracker until the next
    // microtask, so full erasure waits for `el.remove()` (sync in the
    // wrapper's resolve listener).
    this._password = ''
    this._confirm = ''
    this._url = ''
    this.privateKeyBase64 = ''
    super._finish(null)
  }

  _onClose = () => this._finish()
  _onCancel = () => this._finish()

  _onNameInput = (e) => { this._name = e.target.value }
  _onPasswordInput = (e) => { this._password = e.target.value; this._error = '' }
  _onConfirmInput = (e) => { this._confirm = e.target.value; this._error = '' }

  _canGenerate() {
    return (this._name ?? '').trim().length > 0
      && (this._password ?? '').length > 0
      && this._password === this._confirm
      && !this._busy
  }

  _onGenerate = async () => {
    if (!this._canGenerate()) return
    this._busy = true
    this._error = ''
    try {
      const encoded = await encodeShareLink({
        id: this.workspaceId,
        name: this._name.trim(),
        privateKeyBase64: this.privateKeyBase64,
        password: this._password,
      })
      // PBKDF2 takes hundreds of ms; user may have cancelled meanwhile.
      // Skip the URL write so the freshly-derived encoded value (which
      // embeds the workspace private key) doesn't outlive the cancelled
      // dialog. `_finish` already cleared `_password` / `_url`.
      if (this._settled) return
      this._url = buildShareUrl(encoded)
      // Drop the plaintext password once no longer needed — the encoded
      // URL is all the user copies, and a post-generation re-render
      // shouldn't re-bind the password input's `.value` to live secret.
      this._password = ''
      this._confirm = ''
    } catch (err) {
      if (this._settled) return
      this._error = err?.message ?? String(err)
    } finally {
      this._busy = false
    }
  }

  _onCopy = async () => {
    if (!this._url) return
    // Clear the previous attempt's error so a successful retry (after
    // granting clipboard permission, switching to a secure context,
    // etc.) doesn't keep painting the failure under the working button.
    this._error = ''
    try {
      await navigator.clipboard.writeText(this._url)
      // Close may have fired while the write was pending. Skip the
      // timer so it doesn't land on a detached element — Lit no-ops the
      // write, but the 1500ms closure pins `this` against GC meanwhile.
      if (this._settled) return
      this._copied = true
      // Stash the timer id so `_finish` can cancel it — otherwise a
      // Close within 1500ms of Copy leaves the callback firing on the
      // detached element (cheap leak, no crash).
      if (this._copiedTimer) clearTimeout(this._copiedTimer)
      this._copiedTimer = setTimeout(() => {
        this._copied = false
        this._copiedTimer = null
      }, 1500)
    } catch {
      // Clipboard API blocked (insecure context, denied permission) —
      // surface a hint so the user knows to select + copy manually.
      if (this._settled) return
      this._error = 'Copy failed — select the link and copy it manually.'
    }
  }

  _onKeydown = (e) => {
    if (e.key === 'Enter' && !this._url) {
      e.preventDefault()
      this._onGenerate()
    }
  }

  _body() {
    if (this._url) {
      return html`
        <p class="nwd-note">
          Anyone with the link <strong>and</strong> the password can attach
          this workspace. Share them through separate channels.
        </p>
        <label class="wsl-field">
          <span>Share link</span>
          <textarea
            class="wsl-link"
            readonly
            rows="3"
            @focus=${(e) => e.target.select()}
          >${this._url}</textarea>
        </label>
        ${this._error ? html`<p class="wsl-error" role="alert">${this._error}</p>` : nothing}
        <footer class="nwd-actions">
          <span class="nwd-spacer"></span>
          <button type="button" @click=${this._onCancel}>Close</button>
          <button
            type="button"
            class="primary"
            @click=${this._onCopy}
          >${this._copied ? 'Copied' : 'Copy link'}</button>
        </footer>
      `
    }
    return html`
      <label class="wsl-field">
        <span>Workspace name</span>
        <input
          type="text"
          class="nwd-input"
          data-role="name"
          placeholder="Workspace name"
          maxlength="200"
          .value=${this._name}
          @input=${this._onNameInput}
          @keydown=${this._onKeydown}
        >
      </label>
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
          name="dv-share-link-pw"
          maxlength="1024"
          .value=${this._password}
          @input=${this._onPasswordInput}
          @keydown=${this._onKeydown}
        >
      </label>
      <label class="wsl-field">
        <span>Confirm password</span>
        <input
          type="password"
          class="nwd-input"
          autocomplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          name="dv-share-link-pw-confirm"
          maxlength="1024"
          .value=${this._confirm}
          @input=${this._onConfirmInput}
          @keydown=${this._onKeydown}
        >
      </label>
      <p class="nwd-note">
        The link carries the workspace's identity (id, name, and
        private key) so the recipient joins the same sync chain.
        Triage, reports, and comments aren't in the link itself —
        they sync over once the recipient joins. The link decrypts
        with the password above; without it the link is useless.
      </p>
      ${this._error ? html`<p class="wsl-error" role="alert">${this._error}</p>` : nothing}
      ${this._password && this._confirm && this._password !== this._confirm
        ? html`<p class="wsl-error" role="alert">Passwords don't match.</p>`
        : nothing}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button
          type="button"
          class="primary"
          ?disabled=${!this._canGenerate()}
          @click=${this._onGenerate}
        >${this._busy ? 'Generating…' : 'Generate link'}</button>
      </footer>
    `
  }

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>${this._url ? 'Workspace share link' : 'Share workspace by link'}</h3>
      </header>
      ${this._body()}
    </dialog>`
  }
}

customElements.define('workspace-share-link-dialog', WorkspaceShareLinkDialog)

export function openWorkspaceShareLinkDialog({ id, name, privateKeyBase64 } = {}) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('workspace-share-link-dialog')
    el.workspaceId = id ?? ''
    el.initialName = name ?? ''
    el.privateKeyBase64 = privateKeyBase64 ?? ''
    el.addEventListener('resolve', () => {
      el.remove()
      resolve()
    })
    el.addEventListener('modal-conflict', (e) => {
      // Wipe the raw 32-byte key before detaching — the dialog never
      // opened, so its own `_finish` wipe didn't run.
      el.privateKeyBase64 = ''
      el.remove()
      reject(makeStackedModalError(e.detail?.cause))
    })
    document.body.append(el)
  })
}
