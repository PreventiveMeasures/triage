// `<upstream-dialog>` — editor for a finding's CAUSE track: what the
// dependency's own maintainers have done about the bug. Fronts the
// `.mark-upstream` button, which only a dependency finding carries
// (in the app's own code there is no upstream separate from the app,
// so there is nothing here to say).
//
// The one place in the app that deliberately writes a fact EVERY app
// reads. A finding id is derived from the source bytes, so the entry
// this saves into is the same entry every other app shipping that
// dependency looks at — which is the point: an upstream issue is
// worth filing once, and "fixed in 4.17.21" is worth knowing wherever
// those bytes are still shipped. The board's per-app work track
// (`.mark-fix`, the kanban columns) is the half that stays local; see
// the two-track note on `TriageEntry` in client/state.ts.
//
// Sibling of `<fix-link-dialog>`: extends `AppDialog` for the shared
// shadow-DOM <dialog> chrome (focus-trap + Esc-to-cancel) and repeats
// its header / input / hint shapes, since the two annotate the same
// card from adjacent buttons. Public `openUpstreamDialog(...)`
// resolves to the edited record, or null on cancel / no change.
import { html, nothing, unsafeCSS } from 'lit'
import { state } from '#client/index.js'
import { UPSTREAM_LABELS } from '../../../report/index.js'
import { displayedSeverity, isHttpUrl } from '../format.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import severityCSS from './dialog-severity.css'
import upstreamCSS from './dialog-upstream.css'
import { severityBadge } from './shared.js'

// The states, in the order a report travels through them. '' is the
// resting state ("nobody has said anything"), which is also what
// clearing the record leaves behind — so it is a choice in the picker
// rather than a separate destructive button.
const STATES = [
  { key: '', label: 'Not reported' },
  // The words come from report/labels.js, so the picker, the card's
  // line and the exported document all name a state the same way.
  ...Object.entries(UPSTREAM_LABELS).map(([key, label]) => ({ key, label })),
]

const LINK_PLACEHOLDER = {
  '': 'https://github.com/owner/repo/issues/123',
  reported: 'https://github.com/owner/repo/issues/123',
  fixed: 'https://github.com/owner/repo/pull/456',
  wontfix: 'https://github.com/owner/repo/issues/123#issuecomment-…',
}

class UpstreamDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(severityCSS), unsafeCSS(upstreamCSS)]

  static properties = {
    initial: { attribute: false },
    finding: { attribute: false },
    packageName: { attribute: false },
    _state: { state: true },
    _link: { state: true },
    _since: { state: true },
  }

  constructor() {
    super()
    this.initial = null
    this.finding = null
    this.packageName = ''
    this._state = ''
    this._link = ''
    this._since = ''
  }

  beforeOpen() {
    const init = this.initial ?? {}
    this._state = init.state ?? ''
    this._link = init.link ?? ''
    this._since = init.since ?? ''
  }

  focusInitial() {
    const input = this.renderRoot.querySelector('input[type="url"]')
    if (!input) return
    input.focus()
    try { input.select() } catch {}
  }

  _pick = (key) => {
    this._state = key
    // Leaving the fixed state drops the version with it: "fixed in
    // 4.17.21" is not a fact that survives being told the bug was
    // never fixed, and leaving it behind would save a record whose
    // two halves disagree.
    if (key !== 'fixed') this._since = ''
  }

  _onLink = (e) => { this._link = e.target.value }
  _onSince = (e) => { this._since = e.target.value }

  _onKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      this._onSave()
    }
  }

  // The record as the entry would store it — trimmed, and empty
  // fields dropped so an all-blank form reads as "retract this".
  get _value() {
    const out = {}
    if (this._state) out.state = this._state
    const link = (this._link ?? '').trim()
    if (link) out.link = link
    const since = this._state === 'fixed' ? (this._since ?? '').trim() : ''
    if (since) out.since = since
    return out
  }

  _same(value) {
    const init = this.initial ?? {}
    return (init.state ?? '') === (value.state ?? '')
      && (init.link ?? '') === (value.link ?? '')
      && (init.since ?? '') === (value.since ?? '')
  }

  _onSave = () => {
    const value = this._value
    if (this._same(value)) { this._finish(null); return }
    this._finish({ value })
  }

  _onClear = () => this._finish({ value: {} })

  _onCancel = () => this._finish(null)

  render() {
    const f = this.finding ?? {}
    const loc = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : ''
    const hasInitial = Boolean(this.initial && (this.initial.state || this.initial.link || this.initial.since))
    const link = (this._link ?? '').trim()
    const openable = isHttpUrl(link)
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>${hasInitial ? 'Edit upstream status' : 'Record upstream status'}</h3>
        <div class="finding">
          ${severityBadge(displayedSeverity(f, state.severityMode))}
          ${this.packageName ? html`<span class="pkg">${this.packageName}</span>` : nothing}
          ${loc ? html`<span class="loc" title=${loc}>${loc}</span>` : nothing}
        </div>
        ${f.description
          ? html`<div class="desc" title=${f.description}>${f.description}</div>`
          : nothing}
      </header>
      <div class="field">
        <span class="field-label" id="upstream-state-label">Upstream</span>
        <div class="states" role="group" aria-labelledby="upstream-state-label">
          ${STATES.map((s) => html`<button
            type="button"
            class="state-btn"
            aria-pressed=${String(this._state === s.key)}
            @click=${() => this._pick(s.key)}
          >${s.label}</button>`)}
        </div>
      </div>
      <div class="field">
        <span class="field-label">Link</span>
        <div class="input-row">
          <input
            type="url"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            placeholder=${LINK_PLACEHOLDER[this._state] ?? LINK_PLACEHOLDER['']}
            aria-label="Upstream issue or pull request URL"
            .value=${this._link}
            @input=${this._onLink}
            @keydown=${this._onKeydown}
          >
          ${openable
            ? html`<a class="open" href=${link} target="_blank" rel="noopener noreferrer">Open ↗</a>`
            : nothing}
        </div>
      </div>
      ${this._state === 'fixed'
        ? html`<div class="field">
            <span class="field-label">Fixed in version</span>
            <div class="input-row">
              <input
                type="text"
                autocomplete="off"
                spellcheck="false"
                placeholder="4.17.21"
                aria-label="First version carrying the fix"
                .value=${this._since}
                @input=${this._onSince}
                @keydown=${this._onKeydown}
              >
            </div>
            <p class="hint">The first release carrying the fix, so the apps still on an older one read “upgrade to this” rather than “no known remedy”.</p>
          </div>`
        : nothing}
      <p class="scope-note">Saved against the finding itself, so every app that ships this code sees it. What your app did about it stays on the board, per app.</p>
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

// Public entry point — mirrors `openFixLinkDialog`. Resolves with:
//   * `{ value }` where `value` is the `{ state?, link?, since? }`
//     record to store — `{}` means "retract it" (Clear, or every
//     field emptied)
//   * null on cancel / Esc / backdrop / unchanged save
export function openUpstreamDialog({ initial = null, finding = null, packageName = '' } = {}) {
  return openAppDialog('upstream-dialog', { initial, finding, packageName })
}
