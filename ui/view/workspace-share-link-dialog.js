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
import { LitElement, html, nothing } from 'lit'
import { buildShareUrl, encodeShareLink } from '../../client/workspace-share-link.js'

class WorkspaceShareLinkDialog extends LitElement {
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
  }

  createRenderRoot() { return this }

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
  }

  firstUpdated() {
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.showModal()
    this._name = this.initialName
    const input = this.querySelector('input[data-role="name"]')
    if (input) input.focus()
  }

  _finish() {
    if (this._settled) return
    this._settled = true
    if (this._copiedTimer) {
      clearTimeout(this._copiedTimer)
      this._copiedTimer = null
    }
    // Drop any plaintext password state on every exit path, not
    // just after a successful generate. A user who typed a password
    // then hit Esc / Cancel / closed the dialog otherwise leaves
    // `_password` / `_confirm` live on the LitElement instance
    // until GC reaps it. `_url` is also cleared for symmetry.
    this._password = ''
    this._confirm = ''
    this._url = ''
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: null }))
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
      this._url = buildShareUrl(encoded)
      // Drop the plaintext password as soon as it's no longer needed
      // — the encoded URL is the only thing the user copies, and a
      // post-generation re-render shouldn't re-bind the password
      // input's `.value` to live secret state.
      this._password = ''
      this._confirm = ''
    } catch (err) {
      this._error = err?.message ?? String(err)
    } finally {
      this._busy = false
    }
  }

  _onCopy = async () => {
    if (!this._url) return
    // Clear the previous attempt's error so a successful retry
    // (after granting clipboard permission, switching to a
    // secure context, etc.) doesn't keep painting the failure
    // message under the now-working button.
    this._error = ''
    try {
      await navigator.clipboard.writeText(this._url)
      this._copied = true
      // Stash the timer id so `_finish` can cancel it — without
      // that, a Close within 1500ms of Copy would leave the
      // callback firing on the detached element. Lit no-ops the
      // property write on a disconnected host so there's no crash,
      // but the leak is cheap to plug.
      if (this._copiedTimer) clearTimeout(this._copiedTimer)
      this._copiedTimer = setTimeout(() => {
        this._copied = false
        this._copiedTimer = null
      }, 1500)
    } catch {
      // Clipboard API blocked (insecure context, denied permission) —
      // surface a hint so the user knows to select + copy manually.
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
        ${this._error ? html`<p class="wsl-error">${this._error}</p>` : nothing}
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
        Triage, reports, and comments are not included. The link
        decrypts with the password above; without it the link is
        useless.
      </p>
      ${this._error ? html`<p class="wsl-error">${this._error}</p>` : nothing}
      ${this._password && this._confirm && this._password !== this._confirm
        ? html`<p class="wsl-error">Passwords don't match.</p>`
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
    return html`<dialog class="new-workspace-dialog workspace-share-dialog" @close=${this._onClose}>
      <header class="nwd-head">
        <h3>${this._url ? 'Workspace share link' : 'Share workspace by link'}</h3>
      </header>
      ${this._body()}
    </dialog>`
  }
}

customElements.define('workspace-share-link-dialog', WorkspaceShareLinkDialog)

export function openWorkspaceShareLinkDialog({ id, name, privateKeyBase64 } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('workspace-share-link-dialog')
    el.workspaceId = id ?? ''
    el.initialName = name ?? ''
    el.privateKeyBase64 = privateKeyBase64 ?? ''
    el.addEventListener('resolve', () => {
      el.remove()
      resolve()
    })
    document.body.append(el)
  })
}
