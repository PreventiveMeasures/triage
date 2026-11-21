// Sender side of "Share by link": the outgoing name and a password derive an
// AES-GCM key (PBKDF2) sealing a copyable `#share=…` link. The receiver's side
// is workspace-unlock-link-dialog.js.
import { html, nothing, unsafeCSS } from 'lit'
import { buildShareUrl, encodeShareLink } from '#client/index.js'
import { openAppDialog, rejectStacked } from './app-dialog.js'
import { PasswordDialog, field, onEnter } from './shared.js'
import shareCSS from './dialog-share.css'

class WorkspaceShareLinkDialog extends PasswordDialog {
  static styles = [...PasswordDialog.styles, unsafeCSS(shareCSS)]

  static properties = { _name: { state: true }, _url: { state: true }, _copied: { state: true } }

  // The typed password, the link (which embeds the private key), and the raw
  // key the open helper set.
  static secrets = { _password: '', _confirm: '', _url: '', privateKeyBase64: '' }

  constructor() {
    super()
    this._name = ''
    this._url = ''
    this._copied = false
  }

  beforeOpen() { this._name = this.initialName }

  disconnectedCallback() {
    clearTimeout(this._copiedTimer)
    super.disconnectedCallback()
  }

  _onNameInput = (e) => { this._name = e.target.value }

  _canGenerate() {
    return this._name.trim().length > 0 && this._password.length > 0 && this._password === this._confirm && !this._busy
  }

  _onGenerate = () => {
    if (!this._canGenerate()) return
    const link = { id: this.workspaceId, name: this._name.trim(), privateKeyBase64: this.privateKeyBase64, password: this._password }
    void this._attempt(() => encodeShareLink(link), (encoded) => {
      this._url = buildShareUrl(encoded)
      // The link is all that's copied; don't keep the password bound.
      this._password = ''
      this._confirm = ''
    })
  }

  _onCopy = async () => {
    if (!this._url) return
    this._error = ''
    try {
      await navigator.clipboard.writeText(this._url)
      if (this._settled) return
      this._copied = true
      clearTimeout(this._copiedTimer)
      this._copiedTimer = setTimeout(() => { this._copied = false }, 1500)
    } catch {
      // Blocked clipboard (insecure context, denied permission).
      if (!this._settled) this._error = 'Copy failed — select the link and copy it manually.'
    }
  }

  _onKeydown = onEnter(() => {
    if (!this._url) this._onGenerate()
  })

  _errorLine() {
    return this._error ? html`<p class="wsl-error" role="alert">${this._error}</p>` : nothing
  }

  _body() {
    if (this._url) {
      return html`
        <p class="nwd-note ui-hint">
          Anyone with the link <strong>and</strong> the password can attach
          this workspace. Share them through separate channels.
        </p>
        ${field('Share link', html`<textarea
          class="wsl-link"
          readonly
          rows="3"
          @focus=${(e) => e.target.select()}
        >${this._url}</textarea>`)}
        ${this._errorLine()}
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
      ${field('Workspace name', html`<input
        type="text"
        class="nwd-input"
        data-role="name"
        placeholder="Workspace name"
        maxlength="200"
        .value=${this._name}
        @input=${this._onNameInput}
        @keydown=${this._onKeydown}
      >`)}
      ${this.newPasswordFields('dv-share-link-pw')}
      <p class="nwd-note ui-hint">
        The link carries the workspace's identity (id, name, and
        private key) so the recipient joins the same sync chain.
        Triage, reports, and comments aren't in the link itself —
        they sync over once the recipient joins. The link decrypts
        with the password above; without it the link is useless.
      </p>
      ${this._errorLine()}
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

// Resolves on close; rejects when the dialog can't open.
export function openWorkspaceShareLinkDialog({ id, name, privateKeyBase64 } = {}) {
  return openAppDialog('workspace-share-link-dialog', {
    workspaceId: id ?? '',
    initialName: name ?? '',
    privateKeyBase64: privateKeyBase64 ?? '',
  }, { conflict: rejectStacked })
}
