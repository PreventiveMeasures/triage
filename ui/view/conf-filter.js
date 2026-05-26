// `<conf-filter>` — `Confidence [0—10]` dual-thumb range filter
// in the findings toolbar. Wraps the existing `<range-slider>` +
// `<conf-range-mirror>` pair (both stay as generic property-driven
// components — `<range-slider>` is a reusable UI primitive and
// `<conf-range-mirror>` carries its own event-based drag suppression
// that shouldn't depend on state reactivity).
//
// Slider edge semantics (see filters.js / matchesFilters): lower
// bound at 0 means "include findings without a confidence rating"
// and upper bound at 10 means "no upper cap (allow >10 outliers)"
// — both edges are how the user opts out of that half of the
// filter, NOT a literal 0-or-10 match.
//
// Replaces an inline `<div class="conf-filter">…</div>` template
// in render.js's `toolbarTemplate` that bound `state.filterConfMin`
// and `state.filterConfMax` to both inner components four times
// over (low / high on the slider, .low / .high on the mirror).
// The `<conf-filter>` host element now carries the layout styling
// directly (element selector in toolbar.css) — no wrapping div
// needed.
//
// Reactivity: extends StateElement, so the autorun tracks the two
// state reads and re-renders the inner property bindings when state
// changes (typically on `range-change` release — `range-input`
// during a drag doesn't touch state, the mirror handles the live
// label update event-side; the parent gets the committed values
// back via the same autorun after release).
//
// Event flow stays unchanged: the slider dispatches `range-input`
// (drag) and `range-change` (release) CustomEvents that bubble out
// composed; events.js listens on `report` and writes
// `state.filterConfMin`/`Max` on `range-change`. The component
// doesn't intercept either event — it just owns the layout +
// state-to-prop hand-off.
//
// `<conf-filter>` is mounted only when the parent's `showConfidence`
// flag is true (some reports don't surface confidence). The
// component itself doesn't know that flag — visibility stays at
// the parent.
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

class ConfFilter extends StateElement {
  createRenderRoot() { return this }

  render() {
    const low = state.filterConfMin
    const high = state.filterConfMax
    return html`<span class="conf-range-label">Confidence</span>
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
      ></conf-range-mirror>`
  }
}

customElements.define('conf-filter', ConfFilter)
