// `<sync-auth-dialog>` — operator-side password prompt for the
// triage-sync server's first-action gate. Fires when the relay
// emits `unauthorized` for a workspace tag it hasn't seen before
// (see server-e2e/index.ts `requiresAuth` + `workspaceExists` and the
// matching client wiring in client/sync/triage-sync.ts's `runAuthFlow`).
//
// Extends `AppDialog`: shadow DOM with the shared dialog frame +
// `.nwd-*` chrome inherited via `static styles`. `retry=true` swaps
// the body copy to "wrong password" — `runAuthFlow` passes it when
// the prior `authenticate { password }` came back as the no-context
// `unauthorized` (the server's wrong-password signal).
import { html } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'

class SyncAuthDialog extends AppDialog {
  static properties = {
    retry: { type: Boolean },
    _value: { state: true },
  }

  constructor() {
    super()
    this.retry = false
    this._value = ''
  }

  // Wipe the password before the resolve hop — mirrors
  // `workspace-unlock-link-dialog`'s post-unlock wipe. Lit's reactive
  // tracker retains the old value until the next microtask, but the
  // slot is emptied so the still-mounted host doesn't keep the bytes.
  _finish(result) {
    this._value = ''
    super._finish(result)
  }

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
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Sync server password</h3>
      </header>
      <p class="nwd-intro">${intro}</p>
      <input
        type="password"
        class="nwd-input"
        placeholder="Password"
        autocomplete="off"
        data-1p-ignore="true"
        data-lpignore="true"
        data-bwignore="true"
        data-form-type="other"
        name="dv-sync-auth"
        maxlength="4096"
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
// body copy to the "wrong password" variant.
export function openSyncAuthDialog({ retry = false } = {}) {
  return openAppDialog('sync-auth-dialog', { retry: Boolean(retry) })
}
