// `<bundle-code-search>`: the Code rail's search row, its query
// (`state.bundleCodeSearchQuery`) with a clear button while there is one,
// and the `modes` its parent offers (`issues` only where the bundle has
// issues) as tabs (`state.bundleCodeSearchMode`, which picks the placeholder
// too). A stored mode not offered reads as Files, as the rail falls back to.
// It emits `search-input` (`{ kind: 'bundle-code', value }`) and
// `bundle-search-mode-change` (`{ mode }`), which events.js writes to state.
// Lit keeps the `<input>` across renders, so the caret survives typing.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { live } from 'lit/directives/live.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { CODE_MODE_ICON, FILES_MODE_ICON } from './lit-icons.js'

const PLACEHOLDER = {
  files:   'Filter files…',
  code:    'Search code…',
  issues:  'Search issues…',
  largest: 'Filter largest files…',
}

const MODE_LABEL = {
  files:   'Filter files',
  code:    'Search code',
  issues:  'Search issues',
  largest: 'Largest files',
}

const SEARCH_ICON = html`<svg class="bundle-code-search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  <circle cx="6.5" cy="6.5" r="4.5"/>
  <path d="M9.7 9.7L13 13" stroke-linecap="round"/>
</svg>`

const MODE_ICONS = {
  files: FILES_MODE_ICON,
  code: CODE_MODE_ICON,
  // issues: matches the warning idiom used elsewhere for findings/severity.
  issues: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <circle cx="8" cy="8" r="6"/>
    <path d="M8 4.8v3.6" stroke-linecap="round"/>
    <circle cx="8" cy="11" r=".7" fill="currentColor" stroke="none"/>
  </svg>`,
  // largest: bars shortening down the list, largest first.
  largest: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
    <path d="M2.5 4h11M2.5 8h7.5M2.5 12h4"/>
  </svg>`,
}

class BundleCodeSearch extends StateElement {
  static properties = {
    modes: { attribute: false },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.modes = []
  }

  render() {
    const query = state.bundleCodeSearchQuery
    const stored = state.bundleCodeSearchMode
    const activeMode = this.modes.includes(stored) ? stored : 'files'
    const placeholder = PLACEHOLDER[activeMode] ?? PLACEHOLDER.files
    return html`${SEARCH_ICON}
      <input
        type="text"
        class="bundle-code-search-input"
        placeholder=${placeholder}
        aria-label=${placeholder}
        .value=${live(query)}
        @input=${this._onInput}
      >
      ${query ? html`<button
        type="button"
        class="bundle-code-search-clear"
        aria-label="Clear search"
        @click=${this._onClear}
      >×</button>` : nothing}
      ${this.modes.length > 0 ? html`<span class="bundle-code-search-modes" role="tablist">
        ${this.modes.map((m) => html`<button
          type="button"
          class=${classMap({ 'bundle-code-search-mode': true, active: activeMode === m })}
          role="tab"
          aria-selected=${String(activeMode === m)}
          data-tooltip=${MODE_LABEL[m] ?? m}
          aria-label=${MODE_LABEL[m] ?? m}
          @click=${() => this._selectMode(m)}
        >${MODE_ICONS[m] ?? nothing}</button>`)}
      </span>` : nothing}`
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }))
  }

  _onInput = (e) => { this._emit('search-input', { kind: 'bundle-code', value: e.target.value }) }

  _onClear = () => { this._emit('search-input', { kind: 'bundle-code', value: '' }) }

  _selectMode(mode) {
    this._emit('bundle-search-mode-change', { mode })
  }
}

customElements.define('bundle-code-search', BundleCodeSearch)
