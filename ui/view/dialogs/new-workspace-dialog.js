// Name editor for the sidebar's "+", with the note that workspace triage syncs
// end-to-end encrypted while unattached reports stay local.
import { html } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { onEnter } from './shared.js'

class NewWorkspaceDialog extends AppDialog {
  static properties = { _value: { state: true } }

  constructor() {
    super()
    this._value = ''
  }

  _onInput = (e) => { this._value = e.target.value }

  // A blank name does nothing, as the disabled Create does, rather than
  // dismissing the dialog.
  _onCreate = () => {
    const trimmed = this._value.trim()
    if (trimmed) this._finish(trimmed)
  }

  _onKeydown = onEnter(() => this._onCreate())

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>New workspace</h3>
      </header>
      <input
        type="text"
        class="nwd-input"
        placeholder="Workspace name"
        maxlength="200"
        .value=${this._value}
        @input=${this._onInput}
        @keydown=${this._onKeydown}
      >
      <p class="nwd-note ui-hint">
        Workspace triage is synchronized by default over an
        end-to-end encrypted channel. Triage on unattached
        reports stays local to this browser.
      </p>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button
          type="button"
          class="primary"
          ?disabled=${!this._value.trim()}
          @click=${this._onCreate}
        >Create</button>
      </footer>
    </dialog>`
  }
}

customElements.define('new-workspace-dialog', NewWorkspaceDialog)

// Resolves the trimmed name, or null on cancel.
export function openNewWorkspaceDialog() {
  return openAppDialog('new-workspace-dialog')
}
