// `<revalidate-filter>` — the dropdown narrowing the findings to one
// outcome of the revalidation pass, inside `<conf-filter>`'s block. The
// parent hands down only the options the loaded set reaches (format.js
// reachableRevalidateFilters) and clears a selection that stops being
// reachable, which is why the value binding is `live()`: without it the
// native select would keep showing the cleared option. `?selected=` on the
// options carries the FIRST paint, which `live()` can't reach: Lit commits
// the `<select>`'s bindings before its options exist, and the filter
// outlives the element (the chrome is rebuilt on cross-view entry).
//
// Dispatches `revalidate-change(detail.value)`; events.js writes the state.
// A dedup group shows in full when any of its rows carries the outcome —
// except under Not revalidated, offered last while the underlying findings
// are on screen, which keeps a group only when NONE of its rows carries one
// (filters.js matchesOutcomeRow).
//
// CONFIRMED carries a second question: it takes the partial confirmations
// along with the full ones (format.js REVALIDATE_FILTERS), and a chip
// INSIDE that option cycles `+ Partial` → `− Partial` → `only Partial`
// (format.js activeRevalidateKinds), shown only when Confirmed is up and the
// set has partial rows. It dispatches `partial-change(detail.value)`. It sits
// at the row's right end, before the chevron: anchoring it to the word
// "Confirmed" would mean measuring that word in the theme's font.
import { nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { classMap } from 'lit/directives/class-map.js'
import { html } from '@rray/frontend/state-element'
import { ToolbarControl } from './toolbar-control.js'
import { PARTIAL_MODES } from './format.js'
import { state } from '#client/index.js'

// The chip's face per mode — green / red / yellow for in, out and only
// (toolbar.css): every mode is a state, the default included. `−` is the
// MINUS SIGN, balancing the `+`.
const PARTIAL_FACES = {
  '':      { cls: 'included', label: '+ Partial',            title: 'Confirmed, partial and revalidation rows — click for full confirmations only' },
  exclude: { cls: 'excluded', label: '− Partial',       title: 'Full confirmations only — click to show the partial ones only' },
  only:    { cls: 'only',     label: 'only Partial',         title: 'Partial confirmations only — click to show all of them again' },
}

class RevalidateFilter extends ToolbarControl {
  static properties = {
    options: { attribute: false },
    hasPartial: { type: Boolean, attribute: 'has-partial' },
  }

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
      <!-- Two entries for "no outcome", sharing a value on purpose. Idle,
           the control is an arrow slot barely wider than its chevron, so
           the selected option's text would show as a clipped sliver: the
           blank one leads, so the empty value lands on it, and hidden keeps
           it out of the menu, where the named one stands for it (the range
           this dropdown replaced). Only the blank twin is marked selected:
           marking both would leave the browser's reset on the LAST one. -->
      <option value="" hidden ?selected=${state.filterRevalidate === ''}></option>
      <option value="">Confidence</option>
      ${this.options.map((o) => html`<option value=${o.value} ?selected=${state.filterRevalidate === o.value}>${o.label}</option>`)}
    </select>
    ${this.hasPartial && state.filterRevalidate === 'confirmed' ? this._partialChip() : nothing}`
  }

  // Reads `state.filterPartial` only when the chip is up, so the
  // autorun doesn't track the mode while Confirmed isn't selected.
  _partialChip() {
    const face = PARTIAL_FACES[state.filterPartial] ?? PARTIAL_FACES['']
    return html`<button
      type="button"
      class=${classMap({ 'partial-cycle': true, [face.cls]: true })}
      data-tooltip=${face.title}
      @click=${() => this.emit('partial-change', {
        value: PARTIAL_MODES[(PARTIAL_MODES.indexOf(state.filterPartial) + 1) % PARTIAL_MODES.length],
      })}
    >${face.label}</button>`
  }

  _onChange = (e) => {
    const { value } = e.target
    // Clearing lands on the NAMED twin, which would paint its name into the
    // arrow slot, and live() can't correct it (both twins carry the empty
    // value): put the selection back on the blank one.
    if (!value) e.target.selectedIndex = 0
    this.emit('revalidate-change', { value })
  }
}

customElements.define('revalidate-filter', RevalidateFilter)
