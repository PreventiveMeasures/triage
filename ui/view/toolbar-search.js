// `<toolbar-search>` — the SVG-icon-prefixed search field used by
// the findings toolbar and the Files tab toolbar.
//
// The component picks its state slice from `kind="findings"|"files"`,
// emits a `search-input(detail: { kind, value })` CustomEvent on
// native `input`. The findings variant also shows a trailing negate
// toggle while the query is non-empty, emitting `search-negate-toggle`
// to flip `state.filterIncludeNegate`. It uses `live()` for the value
// binding — the findings slice is reset by `resetFilters()` in
// filters.js and overwritten by the graph "jump to findings" path in
// events.js, both of which need the DOM `value` to follow state even
// after user interaction has touched the field.
//
// The wrapping `.search-row` + adjacent `.result-count` span stay
// in the parent template (those compose the search field with the
// count and live alongside the search-row's wrapping breakpoints in
// toolbar.css).
//
// Reactivity: extends StateElement, so reads of the matched state
// slice during render() are tracked by observer-util. Lit reuses the
// same `<input>` element across re-renders, so focus + cursor
// position survive every keystroke.
//
// Attributes:
//   * `kind` — `"findings"` (filters the findings list against
//                state.filterInclude) or `"files"` (filters the
//                Files tab tree against state.filesSearch).
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { live } from 'lit/directives/live.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const SEARCH_ICON = html`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
  <circle cx="11" cy="11" r="7"/>
  <path d="m20 20-3.5-3.5"/>
</svg>`

// Trailing negate toggle (findings only): inverts the query so the
// list keeps findings that DON'T match. Hidden while the field empty.
const NEGATE_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  <circle cx="8" cy="8" r="5.5"/>
  <path d="M4.1 4.1l7.8 7.8" stroke-linecap="round"/>
</svg>`

const KIND = {
  findings: { stateKey: 'filterInclude', placeholder: 'Search findings…' },
  files:    { stateKey: 'filesSearch',   placeholder: 'Search files…' },
}

class ToolbarSearch extends StateElement {
  static properties = {
    kind: { type: String },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    // No sensible default — `kind` discriminates which state slice
    // the autorun reads. Leaving it empty surfaces a missing-attr
    // host as a dev warn (via the guard in render()) rather than a
    // silent route to one of the kinds.
    this.kind = ''
  }

  render() {
    const config = KIND[this.kind]
    if (!config) {
      console.warn(`<toolbar-search>: unknown kind ${JSON.stringify(this.kind)}; ` +
        `expected one of ${Object.keys(KIND).map((k) => JSON.stringify(k)).join(', ')}.`)
      return nothing
    }
    const value = state[config.stateKey]
    return html`${SEARCH_ICON}
      <input
        type="text"
        aria-label=${config.placeholder}
        placeholder=${config.placeholder}
        .value=${live(value)}
        @input=${this._onInput}
      >
      ${this.kind === 'findings' && value ? this._negateToggle() : nothing}`
  }

  // Reads `state.filterIncludeNegate` only when rendered (findings kind,
  // non-empty query), so the files variant's autorun never tracks it.
  _negateToggle() {
    const negate = state.filterIncludeNegate
    return html`<button
      type="button"
      class=${classMap({ 'search-negate-btn': true, active: negate })}
      title=${negate ? 'Negation on — click to undo' : 'Negate: show non-matching findings'}
      aria-label="Negate search"
      aria-pressed=${String(negate)}
      @click=${this._onToggleNegate}
    >${NEGATE_ICON}</button>`
  }

  _onInput = (e) => {
    this.dispatchEvent(new CustomEvent('search-input', {
      detail: { kind: this.kind, value: e.target.value },
      bubbles: true,
      composed: true,
    }))
  }

  _onToggleNegate = () => {
    this.dispatchEvent(new CustomEvent('search-negate-toggle', {
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('toolbar-search', ToolbarSearch)
