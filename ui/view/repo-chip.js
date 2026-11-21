// `<repo-chip>` — the page header's GitHub repo: editable (a pill with the
// value, or `Set repo` when empty, and a pencil opening an input that Enter
// / blur commits and Escape rolls back), or read-only (no pencil, for a repo
// every non-module finding shares). The shown `user/repo` slug is
// click-to-copy, with a brief "Copied" overlay. The component focuses the
// input itself: autofocus only fires on the page's first load. `editing`
// reflects so the host can drive it open; commit / cancel flip it back.
//
// Events (bubbling, composed) for the host: `repo-edit-start` (pencil:
// set `editing`), `repo-input(detail.url)` (each keystroke: persist),
// `repo-commit(detail.url)` (Enter / blur: persist, clear `editing`),
// `repo-cancel(detail.url)` (Escape: restore the pre-edit `detail.url`).
import { LitElement, html, nothing, unsafeCSS } from 'lit'
import { live } from 'lit/directives/live.js'
import chipCSS from './repo-chip.css'
import { prettyRepoLabel } from './format.js'

const GITHUB_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`

const PENCIL_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.082-.286.235-.547.445-.758l8.61-8.61z"/></svg>`

class RepoChip extends LitElement {
  static properties = {
    url:      { type: String },
    editable: { type: Boolean, reflect: true },
    editing:  { type: Boolean, reflect: true },
    _copied:  { state: true },
  }

  static styles = unsafeCSS(chipCSS)

  constructor() {
    super()
    this.url = ''
    this.editable = false
    this.editing = false
    this._copied = false
    // The value the input opened with (`_onFocus`), which Escape restores.
    this._opener = ''
  }

  render() {
    const hasUrl = !!this.url
    const label = hasUrl ? prettyRepoLabel(this.url) : 'Set repo'
    if (this.editable && this.editing) {
      // An inert ghost chip holds the host's size, so the h1 row doesn't
      // reflow as the input opens absolutely positioned over it.
      return html`<span class=${hasUrl ? 'chip' : 'chip empty'} aria-hidden="true" inert>
        ${GITHUB_ICON}
        <span class="label">${label}</span>
        <button type="button" class="edit-btn">${PENCIL_ICON}</button>
      </span>
      <input
        type="text"
        .value=${live(this.url)}
        placeholder="user/repo or https://github.com/user/repo"
        @input=${this._onInput}
        @focus=${this._onFocus}
        @keydown=${this._onKeydown}
        @blur=${this._onBlur}>`
    }
    if (this.editable) {
      // Empty, the whole pill opens the input (`Set repo` IS the
      // affordance); with a URL only the pencil does, the slug copying.
      const cls = hasUrl ? (this._copied ? 'chip copied' : 'chip') : 'chip empty'
      return html`<span class=${cls} @click=${hasUrl ? null : this._onEdit}>
        ${GITHUB_ICON}
        ${hasUrl ? this._slugLabel(label) : html`<span class="label">${label}</span>`}
        <button
          type="button"
          class="edit-btn"
          aria-label="Edit repo URL"
          @click=${this._onEdit}
        >${PENCIL_ICON}</button>
      </span>`
    }
    if (!hasUrl) return nothing
    return html`<span class=${this._copied ? 'chip readonly copied' : 'chip readonly'}>
        ${GITHUB_ICON}
        ${this._slugLabel(label)}
      </span>`
  }

  // The click-to-copy slug; the "Copied" overlay rides on `.chip.copied`.
  _slugLabel(text) {
    return html`<span
      class="label"
      @click=${this._onCopyLabel}
    >${text}</span>`
  }

  // Focus on opening; `select()` primes "type to replace".
  updated(changed) {
    if (changed.has('editing') && this.editing) {
      const input = this.renderRoot.querySelector('input')
      if (input) {
        input.focus()
        input.select()
      }
    }
  }

  // Stopping the bubble keeps the pencil's click off the chip's handler.
  _onEdit = (e) => {
    if (e) e.stopPropagation()
    this._emit('repo-edit-start')
  }

  // A silent no-op without clipboard access (an insecure context).
  _onCopyLabel = (e) => {
    if (e) e.stopPropagation()
    const text = prettyRepoLabel(this.url)
    if (!text) return
    try {
      navigator.clipboard.writeText(text).then(() => {
        this._copied = true
        setTimeout(() => { this._copied = false }, 1000)
        return null
      }).catch(() => {})
    } catch {}
  }

  _onFocus = (e) => { this._opener = e.target.value }

  _onInput = (e) => {
    this.url = e.target.value
    this._emit('repo-input', { url: this.url })
  }

  _onKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      this._emit('repo-commit', { url: this.url })
    } else if (e.key === 'Escape') {
      e.preventDefault()
      this.url = this._opener
      this._emit('repo-cancel', { url: this._opener })
    }
  }

  // Not after a keydown already committed or cancelled.
  _onBlur = () => {
    if (this.editing) this._emit('repo-commit', { url: this.url })
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
  }
}

customElements.define('repo-chip', RepoChip)
