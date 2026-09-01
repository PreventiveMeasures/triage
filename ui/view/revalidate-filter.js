// `<revalidate-filter>` — toolbar dropdown that narrows the findings to
// one outcome of the revalidation pass, sitting right of the Confidence
// range. Native single-select in the `<repo-filter>` mould (that
// component is the reference for this pattern), with an implicit "no
// filter" entry.
//
// The option list is DATA-DRIVEN and reachable-only: the parent scans
// the loaded set for the `revalidate` values present and hands down the
// options those reach (format.js REVALIDATE_FILTERS /
// reachableRevalidateFilters), so the dropdown never offers an outcome
// that would filter to nothing — and the whole component is dropped by
// the toolbar when that list comes back empty. The parent also clears a
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

class RevalidateFilter extends StateElement {
  static properties = {
    options: { attribute: false },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.options = []
  }

  render() {
    return html`<select
      class="sort-select"
      aria-label="Filter by revalidation outcome"
      .value=${live(state.filterRevalidate)}
      @change=${this._onChange}
    >
      <!-- The clear entry is named for what clearing gets you back:
           the confidence range this dropdown replaced. It carries that
           name only while there IS something to clear, because idle it
           is the SELECTED option and a native select paints its
           selected option's text — labelling it there would print
           "Confidence" a second time, beside the block's own label, in
           a control that is otherwise just its arrow. -->
      <option value="" title="Filter by confidence range instead">${state.filterRevalidate ? 'Confidence' : ''}</option>
      ${this.options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
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
