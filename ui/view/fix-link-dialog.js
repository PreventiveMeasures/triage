// `<fix-link-dialog>` — single-line URL editor for a finding's
// fix reference (typically a PR URL). Replaces window.prompt()
// for the .mark-fix button so the user gets a real text field
// with the finding context they are annotating, an "open"
// affordance for an existing URL, and the same look as the
// other deepview dialogs.
//
// Sibling of `<comment-dialog>`: native <dialog> for focus-trap
// + Esc-to-cancel, light-DOM render so global stylesheet rules
// in sidebar.css apply. Public `openFixLinkDialog(...)` returns
// a Promise that resolves to the trimmed new value, or null on
// cancel (= no change).
import { LitElement, html, nothing } from 'lit'

function severityBadgeTemplate(sev) {
  if (!sev) return nothing
  const label = sev.replace(/_/gu, ' ')
  return html`<span class=${`conflict-sev sev-${sev}`}>${label}</span>`
}

// Only http(s) URLs get an Open affordance — file:// / javascript:
// would either no-op or be a security footgun. The dialog accepts
// any text the user types (some flows store a plain string like
// "internal ticket #42"); the chip is just a hint when the value
// looks like a real web URL.
function isOpenableUrl(s) {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch { return false }
}

class FixLinkDialog extends LitElement {
  static properties = {
    initial: { attribute: false },
    finding: { attribute: false },
    _value: { state: true },
  }

  // Light DOM — `.fix-link-dialog` rules live in sidebar.css.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.initial = ''
    this.finding = null
    this._value = ''
  }

  // Show the modal once the <dialog> is in the document, then
  // focus + select-all the input. Select-all (vs caret-at-end)
  // matches single-line URL editors — the common edit is "paste
  // a new URL", which overwrites the current one.
  firstUpdated() {
    this._value = this.initial ?? ''
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.showModal()
    const input = this.querySelector('input[type="url"]')
    if (input) {
      input.focus()
      try { input.select() } catch {}
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
    if (trimmed === before) { this._finish(null); return }
    this._finish(trimmed)
  }

  _onClear = () => this._finish('')

  _onCancel = () => this._finish(null)

  // Enter saves; the input is single-line so a bare Enter would
  // submit a wrapping <form> anyway — handling it here avoids
  // depending on a form parent. Esc is handled by the native
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
    const openable = isOpenableUrl(trimmed)
    return html`<dialog class="fix-link-dialog" @close=${this._onClose}>
      <header class="fl-head">
        <h3>${hasInitial ? 'Edit fix link' : 'Add fix link'}</h3>
        <div class="fl-finding">
          ${severityBadgeTemplate(f.severity)}
          ${loc ? html`<span class="fl-loc" title=${loc}>${loc}</span>` : nothing}
        </div>
        ${f.description
          ? html`<div class="fl-desc" title=${f.description}>${f.description}</div>`
          : nothing}
      </header>
      <div class="fl-input-row">
        <input
          class="fl-input"
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
          ? html`<a class="fl-open" href=${trimmed} target="_blank" rel="noopener" title="Open in a new tab">Open ↗</a>`
          : nothing}
      </div>
      <p class="fl-hint">PR URL, issue link, commit, or any free-form reference. Enter to save, Esc to cancel.</p>
      <footer class="fl-actions">
        ${hasInitial
          ? html`<button type="button" class="danger" @click=${this._onClear}>Clear</button>`
          : nothing}
        <span class="fl-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="primary" @click=${this._onSave}>Save</button>
      </footer>
    </dialog>`
  }
}

customElements.define('fix-link-dialog', FixLinkDialog)

// Public entry point — mirrors `openCommentDialog`. Resolves with:
//   * a trimmed string when the user saved a different value
//     (empty string = explicit Clear)
//   * null on cancel / Esc / backdrop / unchanged save
// Callers treat null as a no-op.
export function openFixLinkDialog({ initial = '', finding = null } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('fix-link-dialog')
    el.initial = initial
    el.finding = finding
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    document.body.appendChild(el)
  })
}
