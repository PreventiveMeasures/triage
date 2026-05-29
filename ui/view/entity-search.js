// `<entity-search>` — bare `<input type="search">` shared by the
// Packages and Repositories page toolbars. Sibling of
// `<toolbar-search>` (findings + Files-tab variant — different
// chrome, has an SVG icon prefix and lives inside `.search-row`)
// and `<entity-sort>` (Packages/Repositories sort dropdown).
//
// Dispatches `search-input(detail: { kind, value })` on native
// `input`, matching the contract `<toolbar-search>` already uses;
// the two new kinds route through events.js's `search-input`
// listener. No focus-keeping dance needed: Lit reuses the `<input>`
// across re-renders and `live()` is a no-op DOM write when the typed
// value matches state, so the user's caret survives every keystroke.
//
// Attributes:
//   * `kind` — `"packages"` (writes state.packagesSearchQuery) or
//              `"repositories"` (writes state.repositoriesSearchQuery).
import { nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const KIND = {
  packages:     { stateKey: 'packagesSearchQuery',     label: 'Filter packages' },
  repositories: { stateKey: 'repositoriesSearchQuery', label: 'Filter repositories' },
}

class EntitySearch extends StateElement {
  static properties = {
    kind: { type: String },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    // No sensible default — `kind` discriminates which state slice
    // the autorun reads. Missing surfaces as a dev warn (see
    // render()) rather than silently routing to one kind.
    this.kind = ''
  }

  render() {
    const config = KIND[this.kind]
    if (!config) {
      console.warn(`<entity-search>: unknown kind ${JSON.stringify(this.kind)}; ` +
        `expected one of ${Object.keys(KIND).map((k) => JSON.stringify(k)).join(', ')}.`)
      return nothing
    }
    return html`<input
      type="search"
      class="packages-search"
      placeholder=${`${config.label}…`}
      aria-label=${config.label}
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

customElements.define('entity-search', EntitySearch)
