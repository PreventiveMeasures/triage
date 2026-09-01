// `<conf-filter>` — `Confidence [0—10]` dual-thumb range filter
// in the findings toolbar. Wraps the `<range-slider>` +
// `<conf-range-mirror>` pair, both kept as generic property-driven
// components — `<range-slider>` is a reusable UI primitive and
// `<conf-range-mirror>` carries its own event-based drag suppression
// that shouldn't depend on state reactivity. Host carries the layout
// styling directly (element selector in toolbar.css).
//
// Slider edge semantics (see filters.js / matchesFilters): lower
// bound at 0 means "include findings without a confidence rating"
// and upper bound at 10 means "no upper cap (allow >10 outliers)"
// — both edges are how the user opts out of that half of the
// filter, NOT a literal 0-or-10 match.
//
// Reactivity: extends StateElement, so the autorun tracks the two
// state reads and re-renders the inner property bindings when state
// changes — typically on `range-change` release. `range-input`
// during a drag doesn't touch state (the mirror handles the live
// label update event-side); committed values come back via the same
// autorun after release.
//
// Event contract: the slider dispatches `range-input` (drag) and
// `range-change` (release) CustomEvents, bubbling composed; events.js
// listens on `report` and writes `state.filterConfMin`/`Max` on
// `range-change`. This component intercepts neither — it just owns
// the layout + state-to-prop hand-off.
//
// The block also carries the revalidation-outcome dropdown, when the
// loaded set reaches one (`<revalidate-filter>`, options resolved by
// the parent). The two are one control in two modes, not two filters:
// picking an outcome REPLACES the range — label and slider give up
// the block and the outcome takes their place, reading from the left
// edge where the label was — and the range reads as 0—10 (filters.js
// skips the confidence branch entirely while an outcome is selected).
// The range keeps its numbers rather than being reset, so clearing the
// outcome hands the user back the range they had set.
//
// "Replaced" is `visibility`, not `display`: the slider still occupies
// its box, so the block is exactly as wide either way and the toolbar
// row doesn't reflow around a filter being switched between its two
// modes. The outcome then spans that reserved space (positioned in
// toolbar.css), which is also what left-aligns it.
//
// Mounted when the parent has confidence to show OR an outcome to
// offer (some reports surface neither); `show-range` says which of the
// two, since a report can carry a revalidation pass and no confidence
// at all.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

class ConfFilter extends StateElement {
  static properties = {
    showRange: { type: Boolean, attribute: 'show-range' },
    revalidateOptions: { attribute: false },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.showRange = false
    this.revalidateOptions = []
  }

  render() {
    const low = state.filterConfMin
    const high = state.filterConfMax
    const outcomes = this.revalidateOptions ?? []
    // Only a block that HAS a range can have it replaced; without one
    // the dropdown is the whole control and simply follows its label.
    const replaced = this.showRange && Boolean(state.filterRevalidate)
    return html`<span class=${classMap({ 'conf-range-label': true, replaced })}>
        ${this.showRange ? 'Confidence' : 'Revalidation'}
      </span>
      ${this.showRange
        ? html`<span class=${classMap({ 'conf-range': true, replaced })}>
            <range-slider
              id="conf-range" min="0" max="10" step="1"
              low=${low}
              high=${high}
              aria-label="Confidence range"
            ></range-slider>
            <conf-range-mirror
              id="conf-range-vals"
              class="conf-vals"
              for="conf-range"
              .low=${low}
              .high=${high}
            ></conf-range-mirror>
          </span>`
        : nothing}
      ${outcomes.length > 0
        ? html`<revalidate-filter class=${classMap({ replaces: replaced })} .options=${outcomes}></revalidate-filter>`
        : nothing}`
  }
}

customElements.define('conf-filter', ConfFilter)
