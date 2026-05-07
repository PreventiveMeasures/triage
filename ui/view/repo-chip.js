// `<repo-chip>` — the page-header's GitHub repo display, with three
// visual modes:
//
//   * Editable, collapsed:
//       [github] user/repo  [pencil]
//     A pill showing the typed value (or `Set repo` when empty)
//     plus a pencil button that swaps the chip for an input.
//
//   * Editable, expanded:
//       [input……………………]
//     Bare focused input. Enter / blur commits, Escape rolls back
//     to the value the input was opened with.
//
//   * Read-only:
//       [github] user/repo
//     No pencil. Used when every non-module finding shares the
//     same `repo.github` and no user input is needed.
//
// Replaces `repoChipHtml` (in render.js) plus the in-events.js
// `data-edit-repo` click branch + `#repo-url` input / keydown /
// focusout branches. The component owns the focus management
// (calling `.focus()` after switching to editing mode is
// otherwise unreliable on innerHTML-injected nodes — autofocus
// only fires on the page's first load).
//
// Properties:
//   * `url` — current value (full URL or bare slug; the host
//     normalizes via prettyRepoLabel for display).
//   * `editable` — whether the chip should let the user type.
//     `false` shows the read-only variant with no pencil.
//   * `editing` — whether the input form is open. Mirrored to an
//     attribute so the host's render-state can drive it; the
//     component flips it back to `false` on its own commit /
//     cancel events for free.
//
// Events (all bubble + composed:true):
//   * `repo-edit-start` — pencil clicked. Host should set
//     `editing=true` and re-render.
//   * `repo-input(detail.url)` — fires on every keystroke for
//     live persistence.
//   * `repo-commit(detail.url)` — Enter / blur. Host should set
//     `editing=false` and persist the final value.
//   * `repo-cancel(detail.url)` — Escape. `detail.url` is the
//     pre-edit value (the one the input was opened with) — host
//     should restore that and set `editing=false`.
import { LitElement, html, unsafeCSS, nothing } from 'lit'
import chipCSS from './repo-chip.css'

// Strip protocol + host so the chip reads as the bare `user/repo`
// slug — that's the canonical form per-finding `repo.github` carries
// (e.g. `lodash/lodash`), so the same value renders consistently
// whether it came from a finding or the user's typed URL. Falls back
// to the raw input when the URL isn't a github.com one.
function prettyRepoLabel(s) {
  if (!s) return ''
  const m = s.match(/github\.com\/([^/?#]+\/[^/?#]+?)(?:\.git)?(?:[/?#]|$)/iu)
  return m ? m[1] : s
}

const GITHUB_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`

const PENCIL_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.082-.286.235-.547.445-.758l8.61-8.61z"/></svg>`

class RepoChip extends LitElement {
  static properties = {
    url:      { type: String },
    editable: { type: Boolean, reflect: true },
    editing:  { type: Boolean, reflect: true },
  }

  static styles = unsafeCSS(chipCSS)

  constructor() {
    super()
    this.url = ''
    this.editable = false
    this.editing = false
    // Snapshot of the URL at the moment the input opened — Escape
    // rolls back to this. Captured by `_onFocus` so a programmatic
    // re-open after a previous commit always starts with the most
    // recently-saved value.
    this._opener = ''
  }

  render() {
    if (this.editable && this.editing) {
      return html`<input
        type="text"
        .value=${this.url}
        placeholder="user/repo or https://github.com/user/repo"
        @input=${this._onInput}
        @focus=${this._onFocus}
        @keydown=${this._onKeydown}
        @blur=${this._onBlur}>`
    }
    if (this.editable) {
      const hasUrl = !!this.url
      const label = hasUrl ? prettyRepoLabel(this.url) : 'Set repo'
      const cls = hasUrl ? 'chip' : 'chip empty'
      return html`<span class=${cls}>
        ${GITHUB_ICON}
        <span class="label">${label}</span>
        <button
          type="button"
          class="edit-btn"
          title="Edit repo URL"
          aria-label="Edit repo URL"
          @click=${this._onEdit}
        >${PENCIL_ICON}</button>
      </span>`
    }
    if (this.url) {
      return html`<span class="chip readonly" title="Repo from findings (read-only)">
        ${GITHUB_ICON}
        <span class="label">${prettyRepoLabel(this.url)}</span>
      </span>`
    }
    return nothing
  }

  // Auto-focus the input the moment editing flips on. `autofocus` on
  // an innerHTML-injected node is unreliable in Chrome (only the
  // page's initial parse honours it), so we drive focus imperatively
  // here. Selecting the existing value puts the cursor at the end
  // and primes "type to replace" behaviour.
  updated(changed) {
    if (changed.has('editing') && this.editing) {
      const input = this.renderRoot.querySelector('input')
      if (input) {
        input.focus()
        input.select()
      }
    }
  }

  _onEdit = () => { this._emit('repo-edit-start') }

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
      // Restore the input's value AND emit cancel — the host
      // updates state.repoUrl from the cancel detail and re-renders.
      this.url = this._opener
      this._emit('repo-cancel', { url: this._opener })
    }
  }

  _onBlur = () => {
    // Only commit when still in editing mode — a blur fired by a
    // keydown handler that already dispatched commit/cancel would
    // double up otherwise.
    if (this.editing) this._emit('repo-commit', { url: this.url })
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, {
      detail,
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('repo-chip', RepoChip)
