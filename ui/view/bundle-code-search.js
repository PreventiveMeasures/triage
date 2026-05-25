// `<bundle-code-search>` — the search field at the top of the
// Bundle / Code rail. Distinct enough from `<toolbar-search>` and
// `<entity-search>` to warrant its own component:
//   * Reads TWO state slices: `state.bundleCodeSearchQuery` (the
//     typed string) AND `state.bundleCodeSearchMode` (drives the
//     placeholder — "Filter files…" / "Search code…" / "Search
//     issues…").
//   * Carries an inline clear button (`×`) that appears only while
//     the query is non-empty.
//   * Different SVG icon (smaller, different stroke weight) than
//     `<toolbar-search>`'s.
//
// Replaces the inline SVG + `<input id="bundle-code-search-input">`
// + clear-button trio inside the `.bundle-code-search` wrapper in
// render-bundle.js's `renderBundleCodeView`, plus two handlers in
// events.js: the `bundle-code-search-input` id-keyed branch in the
// generic `input` listener, and the `[data-bundle-search-clear]`
// branch in the click delegate. The parent keeps the
// `.bundle-code-search` wrapper because the search-mode tab strip
// (Files / Code / Issues) lives as a sibling of this component
// inside the same wrapper.
//
// On both native `input` and clear-button click, dispatches
// `search-input(detail: { kind: "bundle-code", value })` — the
// existing `search-input` listener in events.js gains a new branch
// and the clear path collapses into the same flow (`value: ""`).
//
// Reactivity: extends StateElement. Both state reads happen inside
// render(), so the autorun fires on either slice's mutation. Lit
// reuses the `<input>` element across re-renders so the user's
// caret survives every keystroke — same argument as the prior
// `<toolbar-search>` / `<entity-search>` ports.
import { html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { StateElement } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const PLACEHOLDER = {
  files:  'Filter files…',
  code:   'Search code…',
  issues: 'Search issues…',
}

const SEARCH_ICON = html`<svg class="bundle-code-search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  <circle cx="6.5" cy="6.5" r="4.5"/>
  <path d="M9.7 9.7L13 13" stroke-linecap="round"/>
</svg>`

class BundleCodeSearch extends StateElement {
  createRenderRoot() { return this }

  render() {
    const query = state.bundleCodeSearchQuery
    const mode = state.bundleCodeSearchMode
    const placeholder = PLACEHOLDER[mode] ?? PLACEHOLDER.files
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
      >×</button>` : nothing}`
  }

  _onInput = (e) => {
    this._dispatch(e.target.value)
  }

  _onClear = () => {
    this._dispatch('')
  }

  _dispatch(value) {
    this.dispatchEvent(new CustomEvent('search-input', {
      detail: { kind: 'bundle-code', value },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('bundle-code-search', BundleCodeSearch)
