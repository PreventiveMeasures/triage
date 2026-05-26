// `<bundle-code-search>` — the search row at the top of the Bundle
// / Code rail. Owns three responsibilities that visually compose as
// one flex row inside the rail:
//   * The SVG-prefixed text input bound to `state.bundleCodeSearchQuery`.
//   * The inline clear button (`×`) that appears only while the
//     query is non-empty.
//   * The Files / Code / Issues mode tabs bound to
//     `state.bundleCodeSearchMode` (which drives which dataset the
//     query filters against AND the input's placeholder text).
//
// One component rather than two because the three pieces share a
// single flex shell — they read each other's state (the placeholder
// flips on mode change) and a wrapping `<div class="bundle-code-search">`
// holding two sibling components was the only thing forcing them
// to be separate hosts. The host element now IS the flex shell
// (element selector in report.css; no wrapping div needed).
//
// Replaces inline markup in render-bundle.js's `renderBundleCodeView`
// plus two events.js delegate branches (`[data-bundle-search-clear]`
// for the clear button, `[data-bundle-search-mode]` for the mode
// tabs) and one `input` listener branch (`bundle-code-search-input`).
// The id-keyed / data-attribute scheme drops entirely.
//
// Properties:
//   * `modes` (`attribute: false`) — array of available modes,
//                parent-computed. `'issues'` is only offered when the
//                bundle has any issues to search through, so the
//                parent passes `['files', 'code']` or `['files',
//                'code', 'issues']`.
//
// Events (bubble + composed:true):
//   * `search-input(detail: { kind: "bundle-code", value })` — fired
//     on native `input` and on clear-button click (with `value: ""`).
//     events.js's `search-input` listener writes
//     `state.bundleCodeSearchQuery` and re-renders.
//   * `bundle-search-mode-change(detail.mode)` — fired on mode-tab
//     click. events.js's listener writes
//     `state.bundleCodeSearchMode` and re-renders.
//
// Reactivity: extends StateElement. Both state reads happen inside
// render(), so the autorun fires on either mutation. Lit reuses the
// `<input>` element across re-renders so the user's caret survives
// every keystroke (same argument as the prior `<toolbar-search>` /
// `<entity-search>` ports).
//
// Active-tab fallback: if the stored mode isn't in the parent-passed
// `modes` (e.g. user was on `'issues'` on a bundle that had issues,
// then switches to one without), the rail body falls back to
// `'files'` in render-bundle.js, and the mode-tab highlight has to
// follow or nothing reads as active.
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
  // files  — folder/tree glyph (same shape family as the sidebar's
  // packages button) for the file-tree filter mode.
  files: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z"/>
  </svg>`,
  // code   — angle brackets, the universal "code" marker, used to
  // signal the full-text source-content search mode.
  code: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5.5 4.5L2 8l3.5 3.5"/>
    <path d="M10.5 4.5L14 8l-3.5 3.5"/>
  </svg>`,
  // issues — circle with an exclamation, matching the warning idiom
  // used elsewhere for findings/severity.
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
