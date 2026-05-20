// `<workspace-unlock-link-dialog>` — receiver-side prompt fired
// when the boot pipeline notices a `#share=…` hash. Two stages:
//   1. Password — decrypt the payload to `{ id, name, privateKey }`.
//   2. Name    — pre-filled with the sender's name; the user can
//                edit it before attaching. Refuses to resolve when
//                the chosen name collides with an existing local
//                workspace, or when the workspace's id already
//                matches one locally (already attached).
// Resolves with `{ id, name, privateKeyBase64 }` carrying the
// sender's id, the sender's privateKey, and the user's final
// name choice. URL replacement + the actual `attachSharedWorkspace`
// call live in the boot handler (view.js).
//
// Sibling of `<workspace-share-link-dialog>`: extends `AppDialog`
// for the shared shadow-DOM <dialog> chrome (focus-trap +
// Esc-to-cancel).
import { html, nothing, unsafeCSS } from 'lit'
import { decodeShareLink, listWorkspaces, sanitizeWorkspaceName } from '#client/index.js'
import { makeStackedModalError } from './dom.js'
import { AppDialog } from './app-dialog.js'
import shareCSS from '../styles/dialog-share.css'

class WorkspaceUnlockLinkDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(shareCSS)]

  static properties = {
    encoded: { type: String },
    _stage: { state: true },
    _password: { state: true },
    _name: { state: true },
    _decoded: { state: true },
    _existingById: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _settled: { state: true },
  }

  constructor() {
    super()
    this.encoded = ''
    this._stage = 'password'
    this._password = ''
    this._name = ''
    this._decoded = null
    this._existingById = null
    this._busy = false
    this._error = ''
    this._settled = false
  }

  // Initial focus (via the base `firstUpdated`) lands on the active
  // stage's input. Modal-conflict (another modal already open) is
  // handled by the base `firstUpdated`, which dispatches
  // `modal-conflict`; the open() wrapper wipes the wrapper-set
  // `encoded` ciphertext in that listener.
  focusInitial() {
    this._focusActiveInput()
  }

  updated(changed) {
    if (changed.has('_stage')) this._focusActiveInput()
  }

  _focusActiveInput() {
    if (this._stage === 'password') {
      this.renderRoot.querySelector('input[type="password"]')?.focus()
    } else if (this._stage === 'name') {
      const input = this.renderRoot.querySelector('input[data-role="name"]')
      if (input) {
        input.focus()
        input.select()
      }
    }
  }

  _finish(result) {
    if (this._settled) return
    // Drop the decrypted privateKey from the instance before the
    // resolve hop. Lit's reactive setter briefly retains the old
    // value in its change-tracker until the next microtask, so the
    // wipe doesn't fully erase the value until `el.remove()` detaches
    // the host — but the property slot itself is empty.
    this._decoded = null
    this._password = ''
    // Drop the encrypted blob too — `encoded` came in via property
    // assignment from the public entry point and would otherwise
    // outlive the resolve hop on the still-mounted element until
    // `el.remove()` runs.
    this.encoded = ''
    super._finish(result)
  }

  _onClose = () => this._finish(null)
  _onCancel = () => this._finish(null)

  _onPasswordInput = (e) => { this._password = e.target.value; this._error = '' }
  _onNameInput = (e) => { this._name = e.target.value }

  _onUnlock = async () => {
    if (!this._password || this._busy) return
    this._busy = true
    this._error = ''
    try {
      const decoded = await decodeShareLink({
        encoded: this.encoded,
        password: this._password,
      })
      // PBKDF2 takes hundreds of ms; user may have cancelled in the
      // meantime. Skip the writes so `_finish`'s heap-snapshot wipe
      // of `_decoded` / `_password` isn't undone by an in-flight
      // resolution landing after cancel.
      if (this._settled) return
      const existing = listWorkspaces().find((w) => w.id === decoded.id) ?? null
      this._decoded = decoded
      this._existingById = existing
      this._name = decoded.name
      this._password = ''
      this._stage = 'name'
    } catch (err) {
      if (this._settled) return
      this._error = err?.message ?? String(err)
    } finally {
      this._busy = false
    }
  }

  _onAttach = () => {
    if (!this._decoded) return
    const sanitised = sanitizeWorkspaceName(this._name)
    if (!sanitised) return
    // Re-resolve against the LIVE workspaces list, not the snapshot
    // we took at unlock-time. `_onAttach` is only reachable when
    // the snapshot was null (a same-id workspace at unlock-time
    // would have routed to the already-attached stage and disabled
    // this code path). So the only transition we need to catch is
    // "a same-id workspace appeared while the user was at the
    // name stage" — a sibling tab attached the same link, an
    // import landed, etc. Flip to the already-attached branch and
    // bail so the dialog and the persisted state agree. The
    // lock-atomic `attachSharedWorkspace` is still the source of
    // truth; this is just the UI-routing guard.
    const liveExisting = listWorkspaces().find((w) => w.id === this._decoded.id) ?? null
    if (liveExisting) {
      this._existingById = liveExisting
      return
    }
    if (this._nameCollision(sanitised)) return
    this._finish({
      id: this._decoded.id,
      name: sanitised,
      privateKeyBase64: this._decoded.privateKeyBase64,
    })
  }

  // Returns the existing workspace whose `name` collides with the
  // user's typed value (compared under the SAME `sanitizeWorkspaceName`
  // pipeline `attachSharedWorkspace` will apply at write time) and
  // whose id does NOT match the share-link's derived id. A same-id
  // collision is handled separately as the "already attached" branch
  // — there's nothing to do, so the dialog short-circuits to a Close
  // button. Compared on the sanitised form (not raw trim) so a
  // control-char variant like `"Foo"` can't slip past the gate
  // and persist as a second `"Foo"` row. Audit follow-up.
  _nameCollision(sanitised) {
    if (!sanitised || !this._decoded) return null
    for (const w of listWorkspaces()) {
      if (w.id === this._decoded.id) continue
      if (sanitizeWorkspaceName(w.name) === sanitised) return w
    }
    return null
  }

  _onKeydown = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (this._stage === 'password') this._onUnlock()
    else if (this._stage === 'name') this._onAttach()
  }

  _passwordStage() {
    return html`
      <p class="nwd-note">
        Someone shared a workspace with you. Enter the password they
        sent separately to attach it to this browser.
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
          name="dv-share-link-unlock"
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
    `
  }

  _alreadyAttachedStage() {
    const w = this._existingById
    return html`
      <p class="nwd-note">
        This workspace is already attached as
        <strong>"${w?.name ?? ''}"</strong>. Open it from the sidebar.
      </p>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" class="primary" @click=${this._onCancel}>Close</button>
      </footer>
    `
  }

  _nameStage() {
    if (this._existingById) return this._alreadyAttachedStage()
    const sanitised = sanitizeWorkspaceName(this._name)
    const collision = this._nameCollision(sanitised)
    const canAttach = Boolean(sanitised) && !collision
    return html`
      <p class="nwd-note">
        Pick a name for the workspace on this device. The shared
        identity is preserved either way — only the visible label
        changes.
      </p>
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
      ${collision
        ? html`<p class="wsl-error" role="alert">A workspace named "${sanitised}" already exists on this device. Pick a different name.</p>`
        : nothing}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button
          type="button"
          class="primary"
          ?disabled=${!canAttach}
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
      <header class="nwd-head">
        <h3>${heading}</h3>
      </header>
      ${this._stage === 'password' ? this._passwordStage() : this._nameStage()}
    </dialog>`
  }
}

customElements.define('workspace-unlock-link-dialog', WorkspaceUnlockLinkDialog)

// Resolves to `{ id, name, privateKeyBase64 }` on success (id is
// the sender's workspace identity from the share payload, either
// shipped explicitly or re-derived from the privateKey by
// `decodeShareLink`; name is the recipient's choice, defaulted to
// the sender's), or null when the user cancels, closes, or hits
// the "already attached" branch.
export function openWorkspaceUnlockLinkDialog({ encoded } = {}) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('workspace-unlock-link-dialog')
    el.encoded = encoded ?? ''
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    el.addEventListener('modal-conflict', (e) => {
      // Wipe the wrapper-set `encoded` ciphertext before detaching —
      // the dialog never opened, so its own `_finish` wipe didn't run.
      el.encoded = ''
      el.remove()
      reject(makeStackedModalError(e.detail?.cause))
    })
    document.body.append(el)
  })
}
