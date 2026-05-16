// `<new-workspace-dialog>` — name editor for the sidebar's
// "+" button. Replaces window.prompt() so the user gets a real
// input field (with the surrounding deepview chrome) AND an
// up-front note that workspace triage is synchronized over an
// E2E-encrypted channel by default — unattached reports stay
// local.
//
// Sibling of `<comment-dialog>` / `<fix-link-dialog>`: native
// <dialog> for focus-trap + Esc-to-cancel, light-DOM render so
// global stylesheet rules in sidebar.css apply. Public
// `openNewWorkspaceDialog()` returns a Promise that resolves to
// the trimmed name, or null on cancel.
import { LitElement, html } from 'lit'

class NewWorkspaceDialog extends LitElement {
  static properties = {
    _value: { state: true },
  }

  // Light DOM — `.new-workspace-dialog` rules live in sidebar.css.
  createRenderRoot() { return this }

  constructor() {
    super()
    this._value = ''
  }

  // Show the modal once the <dialog> lands in the document, then
  // focus the name input. No initial value to select — the dialog
  // always opens for a fresh workspace.
  firstUpdated() {
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.showModal()
    const input = this.querySelector('input[type="text"]')
    if (input) input.focus()
  }

  _finish(result) {
    if (this._settled) return
    this._settled = true
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: result }))
  }

  // Esc → cancel. The native <dialog> fires `close` on Esc;
  // backdrop clicks are intentionally NOT a dismiss path (the
  // user types a name in the input, then commits via Create or
  // explicitly cancels via the Cancel button / Esc).
  _onClose = () => this._finish(null)

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

  // Enter submits — single-line input, no need for Ctrl/Cmd
  // gate. Esc is handled by the native <dialog> close event.
  _onKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      this._onCreate()
    }
  }

  render() {
    const canCreate = (this._value ?? '').trim().length > 0
    return html`<dialog class="new-workspace-dialog" @close=${this._onClose}>
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
  return new Promise((resolve) => {
    const el = document.createElement('new-workspace-dialog')
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    document.body.append(el)
  })
}
