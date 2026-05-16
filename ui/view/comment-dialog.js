// `<comment-dialog>` — multi-line comment editor for a finding.
// Replaces window.prompt() for the .mark-comment button so the
// user can write more than one line, see the finding context they
// are annotating, and use a real textarea (paste with newlines,
// arrow keys, undo, etc.).
//
// Same shape as the other deepview dialogs (triage-export-dialog,
// triage-conflict-dialog): native <dialog> for focus-trap +
// Esc-to-cancel, light-DOM render so the global stylesheet rules
// in sidebar.css apply. Public `openCommentDialog(...)` returns a
// Promise that resolves to the trimmed new value, or null on
// cancel (= no change).
import { LitElement, html, nothing } from 'lit'

function severityBadgeTemplate(sev) {
  if (!sev) return nothing
  const label = sev.replaceAll('_', ' ')
  return html`<span class=${`conflict-sev sev-${sev}`}>${label}</span>`
}

class CommentDialog extends LitElement {
  static properties = {
    initial: { attribute: false },
    finding: { attribute: false },
    _value: { state: true },
  }

  // Light DOM — `.comment-dialog` rules live in sidebar.css next
  // to the other dialogs. A shadow root would hide them.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.initial = ''
    this.finding = null
    this._value = ''
  }

  // Show the modal once the <dialog> is in the document, then
  // focus the textarea and place the caret at the end so a
  // returning user can immediately keep typing without
  // re-selecting. selectionStart/End assignment is a no-op when
  // initial is empty.
  firstUpdated() {
    this._value = this.initial ?? ''
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.showModal()
    const ta = this.querySelector('textarea')
    if (ta) {
      ta.focus()
      const end = ta.value.length
      try { ta.setSelectionRange(end, end) } catch {}
    }
  }

  _finish(result) {
    if (this._settled) return
    this._settled = true
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: result }))
  }

  // Esc / backdrop close → cancel (= no change). The native
  // <dialog> fires `close` for both paths.
  _onClose = () => this._finish(null)

  _onInput = (e) => { this._value = e.target.value }

  _onSave = () => {
    const trimmed = (this._value ?? '').trim()
    const before = (this.initial ?? '').trim()
    // No-op when nothing changed — same semantic the old prompt
    // path used (early-return on trimmed === current).
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
    return html`<dialog class="comment-dialog" @close=${this._onClose}>
      <header class="cd-head">
        <h3>${hasInitial ? 'Edit comment' : 'Add comment'}</h3>
        <div class="cd-finding">
          ${severityBadgeTemplate(f.severity)}
          ${loc ? html`<span class="cd-loc" title=${loc}>${loc}</span>` : nothing}
        </div>
        ${f.description
          ? html`<div class="cd-desc" title=${f.description}>${f.description}</div>`
          : nothing}
      </header>
      <textarea
        class="cd-textarea"
        rows="6"
        placeholder="Write your notes here. Markdown is not rendered. Ctrl/⌘+Enter to save, Esc to cancel."
        .value=${this._value}
        @input=${this._onInput}
        @keydown=${this._onKeydown}
      ></textarea>
      <footer class="cd-actions">
        ${hasInitial
          ? html`<button type="button" class="danger" @click=${this._onClear}>Clear</button>`
          : nothing}
        <span class="cd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="primary" @click=${this._onSave}>Save</button>
      </footer>
    </dialog>`
  }
}

customElements.define('comment-dialog', CommentDialog)

// Public entry point. `finding` is the active tab object the
// caller already resolved (severity / file / line / description
// used for the context header — all optional). `initial` is the
// current comment text (defaults to ''). Resolves with:
//   * a trimmed string when the user saved a different value
//     (empty string = explicit Clear)
//   * null when the user cancelled, dismissed the dialog with
//     Esc / backdrop, or saved an unchanged value
// Callers treat null as a no-op (skip persistence + re-render).
export function openCommentDialog({ initial = '', finding = null } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('comment-dialog')
    el.initial = initial
    el.finding = finding
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    document.body.append(el)
  })
}
