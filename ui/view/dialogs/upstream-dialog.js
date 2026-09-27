// `<upstream-dialog>` — editor for a dependency finding's CAUSE record:
// what the code's own maintainers did about it, as distinct from what
// this app did about shipping it. Fronts the .mark-upstream button.
//
// Sibling of `<fix-link-dialog>`, and deliberately its shape: extends
// `AppDialog` for the shared shadow-DOM <dialog> chrome (focus-trap +
// Esc-to-cancel) and reuses its severity + input styling rather than
// carrying a stylesheet of its own. `openUpstreamDialog(...)` resolves
// with the edited record, or null on cancel (= no change).
import { html, nothing, unsafeCSS } from 'lit'
import { state } from '#client/index.js'
import { UPSTREAM_LABELS } from '../../../report/index.js'
import { displayedSeverity, isHttpUrl } from '../format.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import severityCSS from './dialog-severity.css'
import fixLinkCSS from './dialog-fix-link.css'
import { severityBadge } from './shared.js'

const STATES = ['reported', 'fixed', 'wontfix']

class UpstreamDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(severityCSS), unsafeCSS(fixLinkCSS)]

  static properties = {
    initial: { attribute: false },
    finding: { attribute: false },
    _state: { state: true },
    _link: { state: true },
    _since: { state: true },
  }

  constructor() {
    super()
    this.initial = null
    this.finding = null
    this._state = ''
    this._link = ''
    this._since = ''
  }

  beforeOpen() {
    this._state = this.initial?.state ?? ''
    this._link = this.initial?.link ?? ''
    this._since = this.initial?.since ?? ''
  }

  focusInitial() {
    this.renderRoot.querySelector('.upstream-state button')?.focus()
  }

  // `since` only means anything under 'fixed' — it names the version
  // the fix shipped in. Picking another state drops it rather than
  // leaving a value the record no longer has a place for.
  _pick = (value) => {
    this._state = this._state === value ? '' : value
    if (this._state !== 'fixed') this._since = ''
  }

  get _value() {
    return {
      state: this._state || undefined,
      link: this._link.trim() || undefined,
      since: this._state === 'fixed' ? (this._since.trim() || undefined) : undefined,
    }
  }

  _onSave = () => {
    const v = this._value
    const before = this.initial ?? {}
    const same = (v.state ?? '') === (before.state ?? '')
      && (v.link ?? '') === (before.link ?? '')
      && (v.since ?? '') === (before.since ?? '')
    this._finish(same ? null : { value: v })
  }

  _onClear = () => this._finish({ value: {} })

  _onCancel = () => this._finish(null)

  _onKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      this._onSave()
    }
  }

  render() {
    const f = this.finding ?? {}
    const loc = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : ''
    const hasInitial = Boolean(this.initial?.state || this.initial?.link || this.initial?.since)
    const link = this._link.trim()
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Upstream status</h3>
        <div class="finding">
          ${severityBadge(displayedSeverity(f, state.severityMode))}
          ${loc ? html`<span class="loc" title=${loc}>${loc}</span>` : nothing}
        </div>
      </header>
      <div class="upstream-state nwd-actions">
        ${STATES.map((value) => html`<button
          type="button"
          class=${this._state === value ? 'primary' : 'quiet'}
          aria-pressed=${String(this._state === value)}
          @click=${() => this._pick(value)}
        >${UPSTREAM_LABELS[value]}</button>`)}
      </div>
      <div class="input-row">
        <input
          type="url"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="https://github.com/owner/repo/issues/42"
          .value=${this._link}
          @input=${(e) => { this._link = e.target.value }}
          @keydown=${this._onKeydown}
        >
        ${isHttpUrl(link)
          ? html`<a class="open" href=${link} target="_blank" rel="noopener noreferrer">Open ↗</a>`
          : nothing}
      </div>
      ${this._state === 'fixed'
        ? html`<div class="input-row">
            <input
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="First fixed version, e.g. 4.17.21"
              .value=${this._since}
              @input=${(e) => { this._since = e.target.value }}
              @keydown=${this._onKeydown}
            >
          </div>`
        : nothing}
      <p class="hint">What the dependency's own maintainers did. Recorded once and read by every app shipping this code. Enter to save, Esc to cancel.</p>
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

customElements.define('upstream-dialog', UpstreamDialog)

// Resolves with `{ value }` — the edited record, `{}` for an explicit
// Clear — or null on cancel / Esc / backdrop / unchanged save, which
// callers treat as a no-op.
export function openUpstreamDialog({ initial = null, finding = null } = {}) {
  return openAppDialog('upstream-dialog', { initial, finding })
}
