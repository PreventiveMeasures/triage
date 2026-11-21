// `<conf-filter>` — the `Confidence [0—10]` dual-thumb range of the
// findings toolbar: `<range-slider>` + its `<conf-range-mirror>` label (both
// generic; the mirror suppresses drag updates itself). A drag's
// `range-input` touches no state; events.js writes `filterConfMin`/`Max`
// on the release's `range-change`. Each edge opts out of its half: 0
// includes unrated findings, 10 caps nothing (filters.js matchesFilters).
//
// The block also carries the revalidation-outcome dropdown
// (`<revalidate-filter>`) where the loaded set reaches an outcome. They are
// one control in two modes: picking an outcome REPLACES the range (filters.js
// then skips confidence), which keeps its numbers for when the outcome is
// cleared. Replaced is `visibility`, not `display`, so the block keeps its
// width and the toolbar doesn't reflow; the outcome spans the reserved box
// (toolbar.css).
//
// The range needs every finding on screen to have a spot on the 0—10 scale
// (render.js hasAnyConfidence) and the dropdown doesn't, so a blocked range
// is DISABLED (`range-disabled`) rather than dropped, reading 0—10 as
// render.js resets the bounds. An outcome replaces a disabled range too:
// left up, the dimmed range would leave the outcome no room to paint.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { html } from '@rray/frontend/state-element'
import { ToolbarControl } from './toolbar-control.js'
import { state } from '#client/index.js'

class ConfFilter extends ToolbarControl {
  static properties = {
    rangeDisabled: { type: Boolean, attribute: 'range-disabled' },
    revalidateOptions: { attribute: false },
    hasPartial: { type: Boolean, attribute: 'has-partial' },
  }

  constructor() {
    super()
    this.rangeDisabled = false
    this.revalidateOptions = []
    this.hasPartial = false
  }

  render() {
    const low = state.filterConfMin
    const high = state.filterConfMax
    const outcomes = this.revalidateOptions ?? []
    const disabled = this.rangeDisabled
    // With no dropdown, a stale outcome must not blank the range that is
    // the whole control.
    const replaced = outcomes.length > 0 && Boolean(state.filterRevalidate)
    const title = disabled ? 'No confidence range: some findings on screen carry no confidence score' : nothing
    return html`<span class=${classMap({ 'conf-range-label': true, replaced, disabled })} data-tooltip=${title}>Confidence</span>
      <span
        class=${classMap({ 'conf-range': true, replaced, disabled })}
        ?inert=${disabled || replaced}
      >
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
      </span>
      ${outcomes.length > 0
        ? html`<revalidate-filter
            class=${classMap({ replaces: replaced })}
            .options=${outcomes}
            ?has-partial=${this.hasPartial}
          ></revalidate-filter>`
        : nothing}`
  }
}

customElements.define('conf-filter', ConfFilter)
