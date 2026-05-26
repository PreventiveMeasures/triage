// `<toolbar-search>` — the SVG-icon-prefixed search field used by
// the findings toolbar and the Files tab toolbar. Consolidates two
// near-duplicate inline `<div class="toolbar-search"><svg>…</svg>
// <input id="..." .value=${state.X}>` blocks (one in render.js's
// `toolbarTemplate`, one in render-files.js's `renderTreeView`
// toolbar) into one StateElement.
//
// The two pages had identical wrapper + SVG markup, identical
// `<input type="text">` shape, and identical event flow (write the
// matching state slice on `input`, re-render). Only the state slice
// (`state.filterInclude` vs `state.filesSearch`), placeholder, and
// id differed. The component picks the slice from `kind="findings"|
// "files"`, emits a `search-input(detail: { kind, value })`
// CustomEvent on native `input`, and uses `live()` for the value
// binding — the findings slice is reset by `resetFilters()` in
// filters.js and overwritten by the graph "jump to findings" path
// in events.js, both of which need the DOM `value` to follow state
// even after user interaction has touched the field.
//
// The wrapping `.search-row` + adjacent `.result-count` span stay
// in the parent template (those compose the search field with the
// count and live alongside the search-row's wrapping breakpoints in
// toolbar.css).
//
// Reactivity: extends StateElement, so reads of the matched state
// slice during render() are tracked by observer-util. Lit reuses
// the same `<input>` element across re-renders (parent and own
// autorun both diff against the same template), so focus + cursor
// position survive every keystroke without the `renderKeepFocus`
// dance the id-keyed listener in events.js used to do.
//
// Attributes:
//   * `kind` — `"findings"` (filters the findings list against
//                state.filterInclude) or `"files"` (filters the
//                Files tab tree against state.filesSearch).
import { html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { StateElement } from '@rray/frontend/state-element'
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
