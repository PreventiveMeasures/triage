// Single-line editor for a finding's fix reference (typically a PR URL),
// fronting .mark-fix, with the finding annotated shown above it.
import { html, nothing, unsafeCSS } from 'lit'
import { isHttpUrl } from '../format.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import severityCSS from './dialog-severity.css'
import fixLinkCSS from './dialog-fix-link.css'
import { findingContext, onEnter } from './shared.js'

class FixLinkDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(severityCSS), unsafeCSS(fixLinkCSS)]

  static properties = { _value: { state: true } }

  constructor() {
    super()
    this._value = ''
  }

  beforeOpen() { this._value = this.initial }

  // Select all: the common edit of a URL is pasting a new one over it.
  focusInitial() {
    const input = this.renderRoot.querySelector('input[type="url"]')
    if (!input) return
    input.focus()
    try { input.select() } catch {}
  }

  _onInput = (e) => { this._value = e.target.value }

  get _trimmed() { return this._value.trim() }

  _onSave = () => {
    this._finish(this._trimmed === this.initial.trim() ? null : { value: this._trimmed, scope: 'finding' })
  }

  // Resolves even unchanged: the siblings are the point, and may lack it. Not
  // when empty, which would be a group-wide delete without Clear's warning;
  // removing stays per finding.
  _onApplyToGroup = () => {
    if (this._trimmed) this._finish({ value: this._trimmed, scope: 'group' })
  }

  _onKeydown = onEnter(() => this._onSave())

  render() {
    const hasInitial = this.initial.length > 0
    const trimmed = this._trimmed
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>${hasInitial ? 'Edit fix link' : 'Add fix link'}</h3>
        ${findingContext(this.finding ?? {})}
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
        ${isHttpUrl(trimmed) ? html`<a class="open" href=${trimmed} target="_blank" rel="noopener noreferrer">Open ↗</a>` : nothing}
      </div>
      <p class="hint">PR URL, issue link, commit, or any free-form reference. Enter to save, Esc to cancel.</p>
      <footer class="nwd-actions">
        ${hasInitial ? html`<button type="button" class="danger" @click=${() => this._finish({ value: '', scope: 'finding' })}>Clear</button>` : nothing}
        <span class="nwd-spacer"></span>
        ${this.canApplyToGroup
          ? html`<button type="button" class="quiet" ?disabled=${!trimmed} @click=${this._onApplyToGroup}>Apply to whole group</button>
        <span class="nwd-spacer"></span>`
          : nothing}
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="primary" @click=${this._onSave}>Save</button>
      </footer>
    </dialog>`
  }
}

customElements.define('fix-link-dialog', FixLinkDialog)

// Resolves `{ value, scope }` on a commit: the trimmed link ('' on Clear),
// scope 'finding' for Save and Clear, 'group' for Apply to whole group. Null on
// cancel or an unchanged save. The caller owns the group, so it says whether
// to offer it (`canApplyFixToGroup` in group.js).
export function openFixLinkDialog({ initial = '', finding = null, canApplyToGroup = false } = {}) {
  return openAppDialog('fix-link-dialog', { initial: initial ?? '', finding, canApplyToGroup })
}
