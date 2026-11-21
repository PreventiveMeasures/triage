// The sync server's password, asked when the relay answers `unauthorized` for
// a workspace tag it hasn't seen (server-e2e/sync-handlers.ts `requiresAuth`;
// client/sync/triage-sync.ts `runAuthFlow`). `retry`: the last password was
// wrong, as the server's context-free `unauthorized` says.
import { html } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { onEnter, secretInput } from './shared.js'

class SyncAuthDialog extends AppDialog {
  static properties = { _value: { state: true } }

  static secrets = { _value: '' }

  constructor() {
    super()
    this._value = ''
  }

  _onInput = (e) => { this._value = e.target.value }
  _onSubmit = () => {
    if (this._value) this._finish(this._value)
  }
  _onKeydown = onEnter(this._onSubmit)

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Sync server password</h3>
      </header>
      <p class="nwd-intro">${this.retry
        ? 'That password didn\'t match. Try again, or cancel to leave the workspace unsynced for now.'
        : 'This sync server requires a password before it accepts a new workspace. Enter it to create the workspace on the server.'}</p>
      ${secretInput({
        name: 'dv-sync-auth', maxlength: 4096, placeholder: 'Password', value: this._value, input: this._onInput, keydown: this._onKeydown,
      })}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button
          type="button"
          class="primary"
          ?disabled=${!this._value}
          @click=${this._onSubmit}
        >${this.retry ? 'Retry' : 'Authenticate'}</button>
      </footer>
    </dialog>`
  }
}

customElements.define('sync-auth-dialog', SyncAuthDialog)

// Resolves the password entered, or null on cancel.
export function openSyncAuthDialog({ retry = false } = {}) {
  return openAppDialog('sync-auth-dialog', { retry: Boolean(retry) })
}
