import { html, nothing, unsafeCSS } from 'lit'
import { AppDialog } from './app-dialog.js'
import listCSS from './dialog-list.css'

// The prompts that ask before something is deleted, detached or let out:
// Cancel takes focus, so a stray Enter backs out, and they resolve
// `{ confirmed }` plus what `confirmationResult` adds. An aborted `signal`
// cancels, before or after opening.
export class ConfirmationDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS)]

  firstUpdated() {
    if (this.signal?.aborted) { this._onCancel(); return }
    this.signal?.addEventListener('abort', this._onCancel, { once: true })
    super.firstUpdated()
  }

  disconnectedCallback() {
    this.signal?.removeEventListener('abort', this._onCancel)
    super.disconnectedCallback()
  }

  focusInitial() {
    this.renderRoot.querySelector('button[data-role="cancel"]')?.focus()
  }

  confirmationResult(confirmed) {
    return { confirmed: confirmed && !this.signal?.aborted }
  }

  _finish(confirmed) {
    if (this._settled) return
    super._finish(this.confirmationResult(Boolean(confirmed)))
  }

  _onClose = () => this._finish(false)
  _onConfirm = () => this._finish(true)

  // The whole of a prompt: its title, the question, what else to know, and
  // Cancel before the action (none without `action`).
  prompt({ title, titleId, body, notes = nothing, action, kind = 'danger', disabled = false, cancel = 'Cancel', status = nothing }) {
    return html`<dialog aria-labelledby=${titleId ?? nothing} @close=${this._onClose}>
      <header><h3 id=${titleId ?? nothing}>${title}</h3></header>
      <p class="lwd-body">${body}</p>
      ${notes}
      <footer class="nwd-actions">
        ${status}<span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>${cancel}</button>
        ${action ? html`<button type="button" class=${kind} ?disabled=${disabled} @click=${this._onConfirm}>${action}</button>` : nothing}
      </footer>
    </dialog>`
  }
}

// What a delete or detach of something the workspace's remote inventory holds
// also does there.
export const remoteNote = (kind, detach = false) => html`<p class="lwd-note">
  This ${kind} is also stored in the workspace's <strong>remote</strong> inventory and will be removed from there too. Newly synced workspace members won't see it; members who already downloaded it keep their local copy (and could re-upload).${detach
    ? ` The ${kind} bytes stay on this device — drop it onto another workspace to attach it there.` : ''}
</p>`

// One row of a `.lwd-choice` radio fieldset: its title, then `detail`.
export const radioOption = ({ name, value, current, change, title }, detail) => html`<label class="lwd-option">
  <input type="radio" name=${name} value=${value} ?checked=${current === value} @change=${change}>
  <span class="lwd-option-text">
    <span class="lwd-option-title">${title}</span>
    ${detail}
  </span>
</label>`

export const optionHint = (text) => html`<span class="lwd-option-hint">${text}</span>`

// What becomes of the triage a deletion leaves no report to reach: nothing to
// ask when none is stranded, else keep (the default: reapplied should a
// matching report be imported) or wipe.
export function orphanedTriage({ name, orphaned, shared, current, change, subject, sharedSubject = subject }) {
  if (orphaned === 0) {
    return html`<p class="lwd-note">${shared === 0 ? `No local triage is attached to ${subject}.`
      : `Local triage on ${sharedSubject} is also attached to ${shared === 1 ? 'a report' : 'reports'} you're keeping. Nothing will be orphaned.`}</p>`
  }
  const one = orphaned === 1
  return html`<fieldset class="lwd-choice">
    <legend>
      <strong>${orphaned}</strong> ${one ? 'triage entry won\'t' : 'triage entries won\'t'} be reachable from any remaining report. What should happen ${one ? 'to it' : 'to them'}?
    </legend>
    ${radioOption({ name, value: 'keep', current, change, title: 'Keep' }, optionHint('Reapplied automatically if a matching report is imported later.'))}
    ${radioOption({ name, value: 'wipe', current, change, title: 'Wipe' }, optionHint('Drop the orphaned triage from this browser.'))}
  </fieldset>`
}
