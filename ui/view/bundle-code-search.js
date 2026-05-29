// `<bundle-code-search>` — the search row at the top of the Bundle
// / Code rail: SVG-prefixed text input (bound to
// `state.bundleCodeSearchQuery`), an inline clear button shown only
// while the query is non-empty, and Files / Code / Issues mode tabs
// (bound to `state.bundleCodeSearchMode`, which drives both the
// filtered dataset and the input placeholder).
//
// One component, not two: the pieces share a single flex shell and
// read each other's state (placeholder flips on mode change). The
// host element IS that flex shell (element selector in report.css).
//
// Properties:
//   * `modes` — array of available modes, parent-computed. `'issues'`
//     is offered only when the bundle has issues to search, so the
//     parent passes `['files','code']` or `['files','code','issues']`.
//
// Events (bubble + composed:true):
//   * `search-input(detail: { kind: "bundle-code", value })` — on
//     native `input` and on clear click (`value: ""`). events.js
//     writes `state.bundleCodeSearchQuery` and re-renders.
//   * `bundle-search-mode-change(detail.mode)` — on mode-tab click.
//     events.js writes `state.bundleCodeSearchMode` and re-renders.
//
// Both state reads happen inside render(), so the StateElement
// autorun fires on either mutation. Lit reuses the `<input>` across
// re-renders so the caret survives every keystroke.
//
// Active-tab fallback: if the stored mode isn't in the parent-passed
// `modes` (was on `'issues'`, switched to a bundle without issues),
// render-bundle.js falls the rail body back to `'files'`, and the
// mode-tab highlight has to follow or nothing reads as active.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { live } from 'lit/directives/live.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const PLACEHOLDER = {
  files:  'Filter files…',
  code:   'Search code…',
  issues: 'Search issues…',
}

const MODE_LABEL = {
  files:  'Filter files',
  code:   'Search code',
  issues: 'Search issues',
}

const SEARCH_ICON = html`<svg class="bundle-code-search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  <circle cx="6.5" cy="6.5" r="4.5"/>
  <path d="M9.7 9.7L13 13" stroke-linecap="round"/>
</svg>`

const MODE_ICONS = {
  // files: shape family matches the sidebar's packages button.
  files: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z"/>
  </svg>`,
  code: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5.5 4.5L2 8l3.5 3.5"/>
    <path d="M10.5 4.5L14 8l-3.5 3.5"/>
  </svg>`,
  // issues: matches the warning idiom used elsewhere for findings/severity.
  issues: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <circle cx="8" cy="8" r="6"/>
    <path d="M8 4.8v3.6" stroke-linecap="round"/>
    <circle cx="8" cy="11" r=".7" fill="currentColor" stroke="none"/>
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
        title="Clear search"
        aria-label="Clear search"
        @click=${this._onClear}
      >×</button>` : nothing}
      ${this.modes.length > 0 ? html`<span class="bundle-code-search-modes" role="tablist">
        ${this.modes.map((m) => html`<button
          type="button"
          class=${classMap({ 'bundle-code-search-mode': true, active: activeMode === m })}
          role="tab"
          aria-selected=${String(activeMode === m)}
          title=${MODE_LABEL[m] ?? m}
          aria-label=${MODE_LABEL[m] ?? m}
          @click=${() => this._selectMode(m)}
        >${MODE_ICONS[m] ?? nothing}</button>`)}
      </span>` : nothing}`
  }

  _onInput = (e) => {
    this._dispatchInput(e.target.value)
  }

  _onClear = () => {
    this._dispatchInput('')
  }

  _dispatchInput(value) {
    this.dispatchEvent(new CustomEvent('search-input', {
      detail: { kind: 'bundle-code', value },
      bubbles: true,
      composed: true,
    }))
  }

  _selectMode(mode) {
    this.dispatchEvent(new CustomEvent('bundle-search-mode-change', {
      detail: { mode },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('bundle-code-search', BundleCodeSearch)
