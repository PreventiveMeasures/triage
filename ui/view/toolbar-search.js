// `<toolbar-search>` — search field shared by the findings toolbar
// (`kind="findings"`, filters against state.filterInclude) and the
// Files tab toolbar (`kind="files"`, filters against state.filesSearch).
//
// Emits `search-input(detail: { kind, value })` on native `input`.
// Uses `live()` for the value binding because the findings slice is
// reset by `resetFilters()` (filters.js) and overwritten by the graph
// "jump to findings" path (events.js) — both need the DOM `value` to
// follow state even after the user has typed in the field.
//
// The wrapping `.search-row` + adjacent `.result-count` span stay in
// the parent template, alongside the search-row's wrapping breakpoints
// in toolbar.css.
//
// Extends StateElement, so render()'s read of the matched slice is
// tracked by observer-util. Lit reuses the same `<input>` across
// re-renders, so focus + cursor position survive every keystroke.
import { nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const SEARCH_ICON = html`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
  <circle cx="11" cy="11" r="7"/>
  <path d="m20 20-3.5-3.5"/>
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
    return html`${SEARCH_ICON}
      <input
        type="text"
        aria-label=${config.placeholder}
        placeholder=${config.placeholder}
        .value=${live(state[config.stateKey])}
        @input=${this._onInput}
      >`
  }

  _onInput = (e) => {
    this.dispatchEvent(new CustomEvent('search-input', {
      detail: { kind: this.kind, value: e.target.value },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('toolbar-search', ToolbarSearch)
