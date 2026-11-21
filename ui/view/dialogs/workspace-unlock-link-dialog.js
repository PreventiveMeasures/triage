// Receiver side of a `#share=…` link, in two stages: the password decrypts the
// payload to `{ id, name, privateKey }`, then the name (the sender's, editable)
// attaches it. It won't resolve a name colliding with a local workspace's, and
// says so when the workspace is attached already. URL replacement and
// `attachSharedWorkspace` are the boot handler's (view.js).
import { html, nothing, unsafeCSS } from 'lit'
import { decodeShareLink, listWorkspaces, sanitizeWorkspaceName } from '#client/index.js'
import { openAppDialog, rejectStacked } from './app-dialog.js'
import { PasswordDialog, field, onEnter } from './shared.js'
import shareCSS from './dialog-share.css'

const workspaceWithId = (id) => listWorkspaces().find((w) => w.id === id) ?? null

class WorkspaceUnlockLinkDialog extends PasswordDialog {
  static styles = [...PasswordDialog.styles, unsafeCSS(shareCSS)]

  static properties = {
    encoded: { type: String },
    _stage: { state: true },
    _name: { state: true },
    _decoded: { state: true },
    _existingById: { state: true },
  }

  // The decrypted private key, and the ciphertext the open helper set.
  static secrets = { _decoded: null, _password: '', encoded: '' }

  constructor() {
    super()
    this.encoded = ''
    this._stage = 'password'
    this._name = ''
    this._decoded = null
    this._existingById = null
  }

  updated(changed) {
    if (!changed.has('_stage')) return
    if (this._stage === 'password') {
      this.renderRoot.querySelector('input[type="password"]')?.focus()
      return
    }
    const input = this.renderRoot.querySelector('input[data-role="name"]')
    input?.focus()
    input?.select()
  }

  _onNameInput = (e) => { this._name = e.target.value }

  unlock(password) { return decodeShareLink({ encoded: this.encoded, password }) }

  unlocked(decoded) {
    this._existingById = workspaceWithId(decoded.id)
    this._decoded = decoded
    this._name = decoded.name
    this._password = ''
    this._stage = 'name'
  }

  _onAttach = () => {
    if (!this._decoded) return
    const sanitised = sanitizeWorkspaceName(this._name)
    if (!sanitised) return
    // Against the live list, not the unlock-time snapshot: a sibling tab or an
    // import may have attached the same workspace meanwhile, which flips to
    // the already-attached stage. `attachSharedWorkspace` stays the authority.
    const existing = workspaceWithId(this._decoded.id)
    if (existing) {
      this._existingById = existing
      return
    }
    if (this._nameCollision(sanitised)) return
    this._finish({ id: this._decoded.id, name: sanitised, privateKeyBase64: this._decoded.privateKeyBase64 })
  }

  // Another workspace (same id is the already-attached case) whose name
  // matches, compared as `attachSharedWorkspace` will store it, so a
  // control-char variant can't slip past as a second "Foo".
  _nameCollision(sanitised) {
    if (!sanitised || !this._decoded) return null
    return listWorkspaces().find((w) => w.id !== this._decoded.id && sanitizeWorkspaceName(w.name) === sanitised) ?? null
  }

  _onKeydown = onEnter(() => (this._stage === 'password' ? this._onUnlock() : this._onAttach()))

  _nameStage() {
    if (this._existingById) {
      return html`
        <p class="nwd-note">
          This workspace is already attached as
          <strong>"${this._existingById.name ?? ''}"</strong>. Open it from the sidebar.
        </p>
        <footer class="nwd-actions">
          <span class="nwd-spacer"></span>
          <button type="button" class="primary" @click=${this._onCancel}>Close</button>
        </footer>
      `
    }
    const sanitised = sanitizeWorkspaceName(this._name)
    const collision = this._nameCollision(sanitised)
    return html`
      <p class="nwd-note ui-hint">
        Pick a name for the workspace on this device. The shared
        identity is preserved either way — only the visible label
        changes.
      </p>
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
      ${collision
        ? html`<p class="wsl-error" role="alert">A workspace named "${sanitised}" already exists on this device. Pick a different name.</p>`
        : nothing}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button
          type="button"
          class="primary"
          ?disabled=${!sanitised || Boolean(collision)}
          @click=${this._onAttach}
        >Attach</button>
      </footer>
    `
  }

  render() {
    const heading = this._stage === 'password'
      ? 'Attach shared workspace'
      : (this._existingById ? 'Workspace already attached' : 'Name the workspace')
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>${heading}</h3>
      </header>
      ${this._stage === 'password'
        ? this.passwordStage('Someone shared a workspace with you. Enter the password they sent separately to attach it to this browser.', 'dv-share-link-unlock')
        : this._nameStage()}
    </dialog>`
  }
}

customElements.define('workspace-unlock-link-dialog', WorkspaceUnlockLinkDialog)

// Resolves `{ id, name, privateKeyBase64 }`: the sender's workspace identity
// (shipped, or re-derived from the key by `decodeShareLink`) under the name
// chosen here; null on cancel or when it is attached already. Rejects when
// another modal is open.
export function openWorkspaceUnlockLinkDialog({ encoded } = {}) {
  return openAppDialog('workspace-unlock-link-dialog', { encoded: encoded ?? '' }, { exclusive: true, conflict: rejectStacked })
}
