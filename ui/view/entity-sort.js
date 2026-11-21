// `<entity-sort>` — the Packages and Repositories toolbars' sort dropdown,
// emitting `sort-change` for events.js to write `state.${kind}SortBy`
// (report.css draws the host's chevron).
//
// The sort is bound twice, as in `<findings-sort>`: `?selected=` on the
// options for a freshly built element's first paint — Lit commits the
// select's own bindings before its options exist — and `.value=` through
// `live()` for later renders, where a stale-filter clear must move a value
// the user already picked. These pages rebuild their slot on cross-view
// entry (render.js), so a return with a non-default sort is a first paint.
import { nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { kindConfig } from './kind-config.js'
import { emit } from './emit.js'

const OPTIONS = [
  ['findings-desc', 'Findings ↓'],
  ['files-desc',    'Files ↓'],
  ['reports-desc',  'Reports ↓'],
  ['name-asc',      'Name A→Z'],
]

const KIND = {
  packages:     { stateKey: 'packagesSortBy',     aria: 'Sort packages' },
  repositories: { stateKey: 'repositoriesSortBy', aria: 'Sort repositories' },
}

class EntitySort extends StateElement {
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
    const config = kindConfig('entity-sort', KIND, this.kind)
    if (!config) return nothing
    return html`<select
      class="packages-sort"
      aria-label=${config.aria}
      .value=${live(state[config.stateKey])}
      @change=${this._onChange}
    >
      ${OPTIONS.map(([value, label]) =>
        html`<option value=${value} ?selected=${state[config.stateKey] === value}>${label}</option>`)}
    </select>`
  }

  _onChange = (e) => { emit(this, 'sort-change', { kind: this.kind, value: e.target.value }) }
}

customElements.define('entity-sort', EntitySort)
