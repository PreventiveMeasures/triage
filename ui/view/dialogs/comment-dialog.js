// Multi-line comment editor for a finding, fronting .mark-comment, with the
// finding annotated shown above it.
import { html, nothing, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import severityCSS from './dialog-severity.css'
import commentCSS from './dialog-comment.css'
import { findingContext } from './shared.js'

class CommentDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(severityCSS), unsafeCSS(commentCSS)]

  static properties = { _value: { state: true } }

  constructor() {
    super()
    this._value = ''
  }

  beforeOpen() { this._value = this.initial }

  // Caret at the end, so a returning writer keeps typing.
  focusInitial() {
    const ta = this.renderRoot.querySelector('textarea')
    if (!ta) return
    ta.focus()
    try { ta.setSelectionRange(ta.value.length, ta.value.length) } catch {}
  }

  _onInput = (e) => { this._value = e.target.value }

  // An unchanged value resolves null, as a cancel does.
  _onSave = () => {
    const trimmed = this._value.trim()
    this._finish(trimmed === this.initial.trim() ? null : trimmed)
  }

  // Ctrl/Cmd+Enter saves, as most multi-line comment fields do.
  _onKeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      this._onSave()
    }
  }

  render() {
    const hasInitial = this.initial.length > 0
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>${hasInitial ? 'Edit comment' : 'Add comment'}</h3>
        ${findingContext(this.finding ?? {})}
      </header>
      <textarea
        rows="6"
        placeholder="Write your notes here. Markdown is not rendered. Ctrl/⌘+Enter to save, Esc to cancel."
        .value=${this._value}
        @input=${this._onInput}
        @keydown=${this._onKeydown}
      ></textarea>
      <footer class="nwd-actions">
        ${hasInitial ? html`<button type="button" class="danger" @click=${() => this._finish('')}>Clear</button>` : nothing}
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="primary" @click=${this._onSave}>Save</button>
      </footer>
    </dialog>`
  }
}

customElements.define('comment-dialog', CommentDialog)

// `finding` gives the context (severity, file, line, description, all
// optional), `initial` the current comment. Resolves the trimmed new text ('' on
// Clear), or null on cancel or an unchanged save: a no-op for callers.
export function openCommentDialog({ initial = '', finding = null } = {}) {
  return openAppDialog('comment-dialog', { initial: initial ?? '', finding })
}
