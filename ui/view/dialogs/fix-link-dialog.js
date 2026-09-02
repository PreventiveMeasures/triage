// `<fix-link-dialog>` — single-line URL editor for a finding's
// fix reference (typically a PR URL), fronting the .mark-fix
// button. Gives a real text field with the finding context being
// annotated, an "open" affordance for an existing URL, and the
// same look as the other deepview dialogs.
//
// Sibling of `<comment-dialog>`: extends `AppDialog` for the shared
// shadow-DOM <dialog> chrome (focus-trap + Esc-to-cancel), with the
// severity-badge + fix-link layers added on top. Public
// `openFixLinkDialog(...)` returns a Promise that resolves to the
// edited value plus the scope it applies to, or null on cancel
// (= no change).
import { html, nothing, unsafeCSS } from 'lit'
import { state } from '#client/index.js'
import { displayedSeverity, isHttpUrl } from '../format.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import severityCSS from './dialog-severity.css'
import fixLinkCSS from './dialog-fix-link.css'
import { severityBadge } from './shared.js'

class FixLinkDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(severityCSS), unsafeCSS(fixLinkCSS)]

  static properties = {
    initial: { attribute: false },
    finding: { attribute: false },
    canApplyToGroup: { attribute: false },
    _value: { state: true },
  }

  constructor() {
    super()
    this.initial = ''
    this.finding = null
    // Whether to offer the whole-group action. The caller decides —
    // it's the one holding the group (see canApplyFixToGroup).
    this.canApplyToGroup = false
    this._value = ''
  }

  // Seed the editor from the incoming value before the base
  // `firstUpdated` shows the modal.
  beforeOpen() { this._value = this.initial ?? '' }

  // Focus + select-all (vs caret-at-end): the common edit on a
  // single-line URL is "paste a new URL", overwriting the current.
  focusInitial() {
    const input = this.renderRoot.querySelector('input[type="url"]')
    if (!input) return
    input.focus()
    try { input.select() } catch {}
  }

  // Base `_finish` (close + resolve) and `_onClose` (Esc / backdrop →
  // resolve null) are inherited unchanged.

  _onInput = (e) => { this._value = e.target.value }

  _onSave = () => {
    const trimmed = (this._value ?? '').trim()
    const before = (this.initial ?? '').trim()
    if (trimmed === before) { this._finish(null); return }
    this._finish({ value: trimmed, scope: 'finding' })
  }

  // Group scope resolves even when the value is unchanged: the siblings
  // are the point, and they may not carry it yet.
  _onApplyToGroup = () => {
    this._finish({ value: (this._value ?? '').trim(), scope: 'group' })
  }

  _onClear = () => this._finish({ value: '', scope: 'finding' })

  _onCancel = () => this._finish(null)

  // Enter saves. Handling it here avoids depending on a wrapping
  // <form> for single-line submit. Esc is handled by the native
  // <dialog> close event.
  _onKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      this._onSave()
    }
  }

  render() {
    const f = this.finding ?? {}
    const loc = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : ''
    const hasInitial = (this.initial ?? '').length > 0
    const trimmed = (this._value ?? '').trim()
    const openable = isHttpUrl(trimmed)
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>${hasInitial ? 'Edit fix link' : 'Add fix link'}</h3>
        <div class="finding">
          ${severityBadge(displayedSeverity(f, state.severityMode))}
          ${loc ? html`<span class="loc" title=${loc}>${loc}</span>` : nothing}
        </div>
        ${f.description
          ? html`<div class="desc" title=${f.description}>${f.description}</div>`
          : nothing}
      </header>
      <div class="input-row">
        <input
          type="url"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="https://github.com/owner/repo/pull/123"
          .value=${this._value}
          @input=${this._onInput}
          @keydown=${this._onKeydown}
        >
        ${openable
          ? html`<a class="open" href=${trimmed} target="_blank" rel="noopener noreferrer" title="Open in a new tab">Open ↗</a>`
          : nothing}
      </div>
      <p class="hint">PR URL, issue link, commit, or any free-form reference. Enter to save, Esc to cancel.</p>
      <footer class="nwd-actions">
        ${hasInitial
          ? html`<button type="button" class="danger" @click=${this._onClear}>Clear</button>`
          : nothing}
        <span class="nwd-spacer"></span>
        ${this.canApplyToGroup
          ? html`<button type="button" class="quiet" title="Set this link on every finding in the group" @click=${this._onApplyToGroup}>Apply to whole group</button>`
          : nothing}
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="primary" @click=${this._onSave}>Save</button>
      </footer>
    </dialog>`
  }
}

customElements.define('fix-link-dialog', FixLinkDialog)

// Public entry point — mirrors `openCommentDialog`. Resolves with:
//   * `{ value, scope }` when the user committed something — `value`
//     is the trimmed link (empty string = explicit Clear), `scope` is
//     'finding' for Save / Clear and 'group' for Apply to whole group
//   * null on cancel / Esc / backdrop / unchanged save
// Callers treat null as a no-op.
//
// `canApplyToGroup` shows the group action; the caller owns that test
// because it owns the group (see `canApplyFixToGroup` in group.js).
export function openFixLinkDialog({ initial = '', finding = null, canApplyToGroup = false } = {}) {
  return openAppDialog('fix-link-dialog', { initial, finding, canApplyToGroup })
}
