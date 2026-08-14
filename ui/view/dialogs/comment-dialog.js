// `<comment-dialog>` — multi-line comment editor for a finding,
// fronting the .mark-comment button. Lets the user write more than
// one line, see the finding context they're annotating, and use a
// real textarea (paste with newlines, arrow keys, undo, etc.).
//
// Same shape as the other deepview dialogs (triage-export-dialog,
// triage-conflict-dialog): extends `AppDialog` for the shared
// shadow-DOM <dialog> chrome (focus-trap + Esc-to-cancel), with the
// severity-badge + comment layers added on top. Public
// `openCommentDialog(...)` returns a Promise that resolves to the
// trimmed new value, or null on cancel (= no change).
import { html, nothing, unsafeCSS } from 'lit'
import { state } from '#client/index.js'
import { displayedSeverity } from '../format.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import severityCSS from './dialog-severity.css'
import commentCSS from './dialog-comment.css'
import { severityBadge } from './shared.js'

class CommentDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(severityCSS), unsafeCSS(commentCSS)]

  static properties = {
    initial: { attribute: false },
    finding: { attribute: false },
    _value: { state: true },
  }

  constructor() {
    super()
    this.initial = ''
    this.finding = null
    this._value = ''
  }

  // Seed the editor from the incoming value before the base
  // `firstUpdated` shows the modal.
  beforeOpen() { this._value = this.initial ?? '' }

  // Focus the textarea and place the caret at the end so a returning
  // user can immediately keep typing without re-selecting.
  // selectionStart/End assignment is a no-op when initial is empty.
  focusInitial() {
    const ta = this.renderRoot.querySelector('textarea')
    if (!ta) return
    ta.focus()
    const end = ta.value.length
    try { ta.setSelectionRange(end, end) } catch {}
  }

  // Base `_finish` (close + resolve) and `_onClose` (Esc / backdrop →
  // resolve null) are inherited unchanged.

  _onInput = (e) => { this._value = e.target.value }

  _onSave = () => {
    const trimmed = (this._value ?? '').trim()
    const before = (this.initial ?? '').trim()
    // Unchanged value resolves null (no-op), like a non-edit.
    if (trimmed === before) { this._finish(null); return }
    this._finish(trimmed)
  }

  _onClear = () => this._finish('')

  _onCancel = () => this._finish(null)

  // Ctrl/Cmd+Enter saves — matches the keyboard idiom most
  // multi-line comment fields use (GitHub, Linear, etc.).
  // Esc is handled by the native <dialog> close event.
  _onKeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      this._onSave()
    }
  }

  render() {
    const f = this.finding ?? {}
    const loc = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : ''
    const hasInitial = (this.initial ?? '').length > 0
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>${hasInitial ? 'Edit comment' : 'Add comment'}</h3>
        <div class="finding">
          ${severityBadge(displayedSeverity(f, state.severityMode))}
          ${loc ? html`<span class="loc" title=${loc}>${loc}</span>` : nothing}
        </div>
        ${f.description
          ? html`<div class="desc" title=${f.description}>${f.description}</div>`
          : nothing}
      </header>
      <textarea
        rows="6"
        placeholder="Write your notes here. Markdown is not rendered. Ctrl/⌘+Enter to save, Esc to cancel."
        .value=${this._value}
        @input=${this._onInput}
        @keydown=${this._onKeydown}
      ></textarea>
      <footer class="nwd-actions">
        ${hasInitial
          ? html`<button type="button" class="danger" @click=${this._onClear}>Clear</button>`
          : nothing}
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="primary" @click=${this._onSave}>Save</button>
      </footer>
    </dialog>`
  }
}

customElements.define('comment-dialog', CommentDialog)

// Public entry point. `finding` supplies the context header
// (severity / file / line / description, all optional); `initial`
// is the current comment text (defaults to ''). Resolves with:
//   * a trimmed string when the user saved a different value
//     (empty string = explicit Clear)
//   * null on cancel / Esc / backdrop / unchanged save
// Callers treat null as a no-op (skip persistence + re-render).
export function openCommentDialog({ initial = '', finding = null } = {}) {
  return openAppDialog('comment-dialog', { initial, finding })
}
