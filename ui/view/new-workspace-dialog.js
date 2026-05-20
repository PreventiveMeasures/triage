// `<new-workspace-dialog>` — name editor for the sidebar's "+"
// button. Replaces window.prompt() so the user gets a real input
// field (with the surrounding deepview chrome) AND an up-front note
// that workspace triage is synchronized over an E2E-encrypted
// channel by default — unattached reports stay local.
//
// Extends `AppDialog` (view/app-dialog.js): shadow DOM, with the
// shared dialog frame + `.nwd-*` chrome inherited via `static
// styles`, and the showModal / focus / resolve plumbing inherited
// too. Public `openNewWorkspaceDialog()` returns a Promise that
// resolves to the trimmed name, or null on cancel.
import { html } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'

class NewWorkspaceDialog extends AppDialog {
  static properties = {
    _value: { state: true },
  }

  constructor() {
    super()
    this._value = ''
  }

  _onInput = (e) => { this._value = e.target.value }

  _onCreate = () => {
    const trimmed = (this._value ?? '').trim()
    // Enter on empty / whitespace stays a no-op so the dialog
    // matches the disabled state of the Create button — without
    // this guard Enter would route through `_finish(null)` and
    // dismiss the dialog as if the user had cancelled.
    if (!trimmed) return
    this._finish(trimmed)
  }

  _onCancel = () => this._finish(null)

  // Enter submits — single-line input, no need for Ctrl/Cmd gate.
  // Esc is handled by the inherited native <dialog> close → cancel.
  _onKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      this._onCreate()
    }
  }

  render() {
    const canCreate = (this._value ?? '').trim().length > 0
    return html`<dialog @close=${this._onClose}>
      <header class="nwd-head">
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
      <p class="nwd-note">
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
          ?disabled=${!canCreate}
          @click=${this._onCreate}
        >Create</button>
      </footer>
    </dialog>`
  }
}

customElements.define('new-workspace-dialog', NewWorkspaceDialog)

// Public entry point. Resolves with the trimmed name on Create,
// or null on Cancel / Esc / empty submit.
export function openNewWorkspaceDialog() {
  return openAppDialog('new-workspace-dialog')
}
