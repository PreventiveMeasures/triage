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
//
// CONFIRMED carries a second question inside it. That option takes the
// partial confirmations along with the full ones (format.js
// REVALIDATE_FILTERS), and a reader looking at what survived often
// wants to draw that line: everything, the narrowed ones only, or the
// clean confirmations only. It is not a second filter — it has no
// meaning under any other outcome — so it isn't a second control
// either. It's a chip INSIDE the Confirmed row, cycling `+ Partial` →
// `− Partial` → `only Partial` on click, riding the block the select
// already spans. Shown only when Confirmed is up AND the loaded set
// has partial rows to sort; `partialCycle` dispatches
// `partial-change(detail.value)` and events.js does the write.
//
// It sits at the RIGHT of the row, before the chevron, rather than
// tucked against the word "Confirmed": the select spans the whole
// block so its value can start at the left edge, and anchoring the
// chip to that edge would mean measuring the rendered width of a word
// in whatever font the theme is using. The block has the room, and the
// two ends read as label and modifier.
import { nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { PARTIAL_MODES } from './format.js'
import { state } from '#client/index.js'

// The chip's face for each mode. The sign carries the meaning, so the
// three read as one control in three positions rather than three
// labels; `−` is the MINUS SIGN, not a hyphen, so it balances the `+`.
const PARTIAL_LABELS = { '': '+ Partial', exclude: '\u2212 Partial', only: 'only Partial' }
const PARTIAL_TITLES = {
  '': 'Partial confirmations included — click to exclude them',
  exclude: 'Partial confirmations excluded — click to show only those',
  only: 'Showing only partial confirmations — click to include all',
}

class RevalidateFilter extends StateElement {
  static properties = {
    options: { attribute: false },
    hasPartial: { type: Boolean, attribute: 'has-partial' },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.options = []
    this.hasPartial = false
  }

  render() {
    return html`<select
      class="sort-select"
      aria-label="Filter by revalidation outcome"
      .value=${live(state.filterRevalidate)}
      @change=${this._onChange}
    >
      <!-- Two entries for "no outcome", sharing a value on purpose
           (and written without backticks — this is inside a template
           literal). A native select paints its SELECTED option's text,
           and idle this is the selection — but idle the control is an
           arrow slot barely wider than its chevron, so any text there
           comes out as a clipped sliver of a glyph. The blank one
           leads, so setting the value to the empty string lands on it
           and the closed control is truly empty; hidden keeps it out
           of the menu, where the named one stands for it. That name is
           what clearing gets you back: the confidence range this
           dropdown replaced. -->
      <option value="" hidden></option>
      <option value="">Confidence</option>
      ${this.options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
    </select>
    ${this.hasPartial && state.filterRevalidate === 'confirmed'
      ? html`<button
          type="button"
          class=${classMap({ 'partial-cycle': true, on: Boolean(state.filterPartial) })}
          title=${PARTIAL_TITLES[state.filterPartial] ?? PARTIAL_TITLES['']}
          @click=${this._onPartial}
        >${PARTIAL_LABELS[state.filterPartial] ?? PARTIAL_LABELS['']}</button>`
      : nothing}`
  }

  _onPartial = () => {
    const at = PARTIAL_MODES.indexOf(state.filterPartial)
    const next = PARTIAL_MODES[(at + 1) % PARTIAL_MODES.length]
    this.dispatchEvent(new CustomEvent('partial-change', {
      detail: { value: next },
      bubbles: true,
      composed: true,
    }))
  }

  _onChange = (e) => {
    const { value } = e.target
    // Clearing lands on the NAMED half of the pair above, which would
    // then paint its name into the arrow slot. The re-render can't
    // correct it — live() compares VALUES, and both halves carry the
    // empty one — so put the selection back on the blank twin here.
    if (!value) e.target.selectedIndex = 0
    this.dispatchEvent(new CustomEvent('revalidate-change', {
      detail: { value },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('revalidate-filter', RevalidateFilter)
