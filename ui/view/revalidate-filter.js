// `<revalidate-filter>` — toolbar dropdown that narrows the findings to
// one outcome of the revalidation pass, sitting right of the Confidence
// range. Native single-select in the `<repo-filter>` mould (that
// component is the reference for this pattern), with an implicit "no
// filter" entry.
//
// The option list is DATA-DRIVEN and reachable-only: the parent scans
// the loaded set for the `revalidate` values actually present and hands
// them down, so the dropdown never offers an outcome that would filter
// to nothing — and the whole component is dropped by the toolbar when
// no finding carries the field at all. The parent also clears a
// selection that stops being reachable (a report unloaded out from
// under it), which is why the value binding is `live()`: without it the
// native select would keep showing the cleared option.
//
// Reactivity: extends StateElement, so the read of
// `state.filterRevalidate` during render() is tracked.
//
// Dispatches `revalidate-change(detail.value)` on native change;
// events.js writes the state and re-renders. Matching is per finding
// and group-wide (filters.js applyFilters runs every predicate through
// `g.some(...)`), so a dedup group shows in full when any of its rows
// carries the selected outcome — the same rule severity, color and
// analyzer follow.
import { live } from 'lit/directives/live.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { REVALIDATE_KINDS } from './format.js'

function label(kind) {
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

class RevalidateFilter extends StateElement {
  static properties = {
    kinds: { attribute: false },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.kinds = []
  }

  render() {
    // REVALIDATE_KINDS drives the order so the list reads the same
    // whichever outcomes a report happens to carry.
    const reachable = REVALIDATE_KINDS.filter((k) => this.kinds.includes(k))
    return html`<select
      class="sort-select"
      aria-label="Filter by revalidation outcome"
      .value=${live(state.filterRevalidate)}
      @change=${this._onChange}
    >
      <option value="" title="No revalidation filter">-</option>
      ${reachable.map((k) => html`<option value=${k}>${label(k)}</option>`)}
    </select>`
  }

  _onChange = (e) => {
    this.dispatchEvent(new CustomEvent('revalidate-change', {
      detail: { value: e.target.value },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('revalidate-filter', RevalidateFilter)
