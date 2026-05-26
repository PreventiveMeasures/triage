// `<entity-sort>` — `Findings ↓ / Files ↓ / Reports ↓ / Name A→Z`
// dropdown shared by the Packages and Repositories page toolbars.
// Replaces two near-duplicate `<select>` blocks (one per page) and
// two id-keyed branches in events.js's generic toolbar `change`
// listener that wrote to `state.packagesSortBy` /
// `state.repositoriesSortBy`.
//
// The two pages already shared their option list, the inner select
// styling (`.packages-sort`), and toggle shape — only the state
// slice (and the aria-label) differed. The host element now carries
// the chevron `::after` directly via `.packages-toolbar entity-sort`
// in report.css; the `<select>` is the host's only child. The
// component picks the state slice from the
// `kind="packages"|"repositories"` attribute and
// emits a `sort-change(detail: { kind, value })` CustomEvent on
// native change. events.js's single listener writes the matching
// `state.${kind}SortBy` slot and calls render().
//
// The native `<select>` value is bound through Lit's `live()`
// directive so a stale-filter clear in the parent's pipeline
// actually updates the visible selection — same reasoning as
// `<analyzer-select>`'s `live()` binding.
//
// Properties:
//   * `kind` — `"packages"` or `"repositories"`. Required (no
//              sensible default; missing/unknown surfaces as a dev
//              warn from the render-time guard).
import { nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

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
    // No sensible default — `kind` discriminates which state slice
    // the autorun reads. Leaving it empty surfaces a missing-attr
    // host as a dev warn (via the guard in render()) rather than a
    // silent route to one of the kinds.
    this.kind = ''
  }

  render() {
    const config = KIND[this.kind]
    if (!config) {
      console.warn(`<entity-sort>: unknown kind ${JSON.stringify(this.kind)}; ` +
        `expected one of ${Object.keys(KIND).map((k) => JSON.stringify(k)).join(', ')}.`)
      return nothing
    }
    return html`<select
      class="packages-sort"
      aria-label=${config.aria}
      .value=${live(state[config.stateKey])}
      @change=${this._onChange}
    >
      ${OPTIONS.map(([value, label]) => html`<option value=${value}>${label}</option>`)}
    </select>`
  }

  _onChange = (e) => {
    this.dispatchEvent(new CustomEvent('sort-change', {
      detail: { kind: this.kind, value: e.target.value },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('entity-sort', EntitySort)
