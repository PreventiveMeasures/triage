// `<entity-sort>` — `Findings ↓ / Files ↓ / Reports ↓ / Name A→Z`
// dropdown shared by the Packages and Repositories page toolbars.
//
// The host element carries the chevron `::after` directly via
// `.packages-toolbar entity-sort` in report.css; the `<select>` is
// the host's only child. The component picks the state slice from the
// `kind="packages"|"repositories"` attribute and emits a
// `sort-change(detail: { kind, value })` CustomEvent on native
// change. events.js's single listener writes the matching
// `state.${kind}SortBy` slot and calls render().
//
// The active sort is bound twice, same split as `<findings-sort>`
// (see the comment there for the full reasoning): `?selected=` on
// the options so the FIRST paint of a freshly-built element shows
// the real sort — Lit commits the `<select>`'s own bindings before
// its options exist, so `.value=` alone leaves the browser falling
// back to the first option — and `.value=` through Lit's `live()`
// for every later render, where a stale-filter clear in the
// parent's pipeline has to move the native value because the
// attribute is ignored once the user has picked something. The
// Packages / Repositories pages rebuild their slot wholesale on
// cross-view entry (`report.innerHTML` in render.js), so returning
// to the page with a non-default sort is exactly the first-paint
// case.
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
      ${OPTIONS.map(([value, label]) =>
        html`<option value=${value} ?selected=${state[config.stateKey] === value}>${label}</option>`)}
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
