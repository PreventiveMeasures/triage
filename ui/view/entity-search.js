// `<entity-search>` — the Packages and Repositories toolbars' search field,
// a bare input emitting `search-input` as `<toolbar-search>` does (events.js
// writes the kind's state slot). Lit reuses the input and `live()` makes the
// matching write a no-op, so the caret survives every keystroke.
import { nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { kindConfig } from './kind-config.js'
import { emit } from './emit.js'

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
    // No default: a missing kind warns (kindConfig) rather than silently
    // routing to one.
    this.kind = ''
  }

  render() {
    const config = kindConfig('entity-search', KIND, this.kind)
    if (!config) return nothing
    return html`<input
      type="search"
      class="packages-search"
      placeholder=${`${config.label}…`}
      aria-label=${config.label}
      .value=${live(state[config.stateKey])}
      @input=${this._onInput}
    >`
  }

  _onInput = (e) => { emit(this, 'search-input', { kind: this.kind, value: e.target.value }) }
}

customElements.define('entity-search', EntitySearch)
