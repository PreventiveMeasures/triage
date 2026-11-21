// Pieces several dialogs share. Dependency-light: some of its importers are
// held up front (view/lazy-dialogs.js).
import { html, nothing } from 'lit'
import { state } from '#client/index.js'
import { displayedSeverity } from '../format.js'
import { AppDialog } from './app-dialog.js'

// Severity chip (`.conflict-sev`, dialog-severity.css), of an already resolved
// severity: a finding's as its card shows it, or sync metadata's as is.
export function severityBadge(sev) {
  if (!sev) return nothing
  return html`<span class=${`conflict-sev sev-${sev}`}>${sev.replaceAll('_', ' ')}</span>`
}

export const findingLocation = (f) => f?.file ? (f.line ? `${f.file}:${f.line}` : f.file) : ''

// The finding an editor annotates, under its title: severity, location and
// description, each truncated with the whole on hover.
export function findingContext(f) {
  const loc = findingLocation(f)
  return html`<div class="finding">
      ${severityBadge(displayedSeverity(f, state.severityMode))}
      ${loc ? html`<span class="loc" data-tooltip-truncated data-tooltip=${loc}>${loc}</span>` : nothing}
    </div>
    ${f.description ? html`<div class="desc" data-tooltip-truncated data-tooltip=${f.description}>${f.description}</div>` : nothing}`
}

// Enter runs `action`: single-line fields, no wrapping <form>.
export const onEnter = (action) => (e) => {
  if (e.key !== 'Enter') return
  e.preventDefault()
  action()
}

// A labelled `.wsl-field` (dialog-share.css).
export const field = (label, control) => html`<label class="wsl-field">
  <span>${label}</span>
  ${control}
</label>`

// A one-off secret (a sync-server or share-link password), which password
// managers are told not to save or fill.
export const secretInput = ({ name, value, input, keydown, maxlength = 1024, placeholder = nothing, disabled = false }) => html`<input
  type="password"
  class="nwd-input"
  placeholder=${placeholder}
  autocomplete="off"
  data-1p-ignore="true"
  data-lpignore="true"
  data-bwignore="true"
  data-form-type="other"
  name=${name}
  maxlength=${maxlength}
  ?disabled=${disabled}
  .value=${value}
  @input=${input}
  @keydown=${keydown}
>`

// A dialog whose password feeds slow work (PBKDF2). Unlocking ones give
// `unlock(password)` and `unlocked(result)` and render `passwordStage`;
// those setting a new password render `newPasswordFields`.
export class PasswordDialog extends AppDialog {
  static properties = { _password: { state: true }, _confirm: { state: true }, _busy: { state: true }, _error: { state: true } }

  constructor() {
    super()
    this._password = ''
    this._confirm = ''
    this._busy = false
    this._error = ''
  }

  _onPasswordInput = (e) => { this._password = e.target.value; this._error = '' }
  _onConfirmInput = (e) => { this._confirm = e.target.value; this._error = '' }

  // A throw shows its message and keeps the dialog open; once the dialog is
  // closed the outcome is dropped, so nothing outlives it.
  async _attempt(work, done) {
    this._busy = true
    this._error = ''
    try {
      const result = await work()
      if (!this._settled) done(result)
    } catch (err) {
      if (!this._settled) this._error = err?.message ?? String(err)
    } finally {
      this._busy = false
    }
  }

  _onUnlock = () => {
    if (this._password && !this._busy) void this._attempt(() => this.unlock(this._password), (result) => this.unlocked(result))
  }

  _onKeydown = onEnter(() => this._onUnlock())

  newPasswordFields(name, disabled = false) {
    return html`
      ${field('Password', secretInput({ name, value: this._password, input: this._onPasswordInput, keydown: this._onKeydown, disabled }))}
      ${field('Confirm password', secretInput({ name: `${name}-confirm`, value: this._confirm, input: this._onConfirmInput, keydown: this._onKeydown, disabled }))}
    `
  }

  passwordStage(note, name) {
    return html`
      <p class="nwd-note ui-hint">${note}</p>
      ${field('Password', secretInput({ name, value: this._password, input: this._onPasswordInput, keydown: this._onKeydown }))}
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
}
