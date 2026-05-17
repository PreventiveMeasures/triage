// `<sync-auth-dialog>` — operator-side password prompt for the
// triage-sync server's first-action gate. Fires when the relay
// emits `unauthorized` for a workspace tag it hasn't seen before
// (see server/index.ts `requiresAuth` + `workspaceExists` and the
// matching client wiring in client/triage-sync.ts's `runAuthFlow`).
//
// Sibling of `<new-workspace-dialog>` / the `<workspace-unlock-*>`
// family: native <dialog> for focus-trap + Esc-to-cancel, light-DOM
// render so the `.new-workspace-dialog` stylesheet rules in
// sidebar.css apply unchanged.
//
// `retry=true` swaps the body copy to "wrong password" — `runAuthFlow`
// passes it when the prior `authenticate { password }` came back as
// the no-context `unauthorized` (the server's wrong-password signal).
import { LitElement, html } from 'lit'

class SyncAuthDialog extends LitElement {
  static properties = {
    retry: { type: Boolean },
    _value: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.retry = false
    this._value = ''
  }

  firstUpdated() {
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.showModal()
    const input = this.querySelector('input[type="password"]')
    if (input) input.focus()
  }

  _finish(result) {
    if (this._settled) return
    this._settled = true
    // Wipe the password from the LitElement instance before the
    // resolve hop — mirrors `workspace-unlock-link-dialog`'s
    // post-unlock wipe. Lit's reactive tracker retains the old
    // value until the next microtask, but the slot itself is
    // emptied so the still-mounted host doesn't keep the bytes.
    this._value = ''
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: result }))
  }

  _onClose = () => this._finish(null)
  _onCancel = () => this._finish(null)
  _onInput = (e) => { this._value = e.target.value }

  _onSubmit = () => {
    const value = this._value ?? ''
    if (!value) return
    this._finish(value)
  }

  _onKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      this._onSubmit()
    }
  }

  render() {
    const canSubmit = (this._value ?? '').length > 0
    const intro = this.retry
      ? 'That password didn\'t match. Try again, or cancel to leave the workspace unsynced for now.'
      : 'This sync server requires a password before it accepts a new workspace. Enter it to create the workspace on the server.'
    return html`<dialog class="new-workspace-dialog" @close=${this._onClose}>
      <header class="nwd-head">
        <h3>Sync server password</h3>
      </header>
      <p class="nwd-note">${intro}</p>
      <input
        type="password"
        class="nwd-input"
        placeholder="Password"
        autocomplete="current-password"
        .value=${this._value}
        @input=${this._onInput}
        @keydown=${this._onKeydown}
      >
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button
          type="button"
          class="primary"
          ?disabled=${!canSubmit}
          @click=${this._onSubmit}
        >${this.retry ? 'Retry' : 'Authenticate'}</button>
      </footer>
    </dialog>`
  }
}

customElements.define('sync-auth-dialog', SyncAuthDialog)

// Public entry point. Resolves with the entered password on submit,
// or null on Cancel / Esc / empty submit. `retry: true` flips the
// body copy to the "wrong password" variant — the caller
// (client/triage-sync.ts's `runAuthFlow`) passes this when the
// previous attempt on the same socket was rejected.
export function openSyncAuthDialog({ retry = false } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('sync-auth-dialog')
    el.retry = Boolean(retry)
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    document.body.append(el)
  })
}
