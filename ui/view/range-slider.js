// `<range-slider>` — a dual-thumb numeric range input. Two stacked
// native `<input type="range">` elements share a single track; the
// selected range between the thumbs is highlighted via a CSS
// gradient on the track underneath. Replaces the prior pair of
// `<select id="conf-min/max">` dropdowns in the toolbar — the two
// thumbs read as one filter rather than two adjacent controls.
//
// Improvements over the old in-tree implementation this is based on:
//   * The selected-range tint is a `linear-gradient` on a single
//     track div instead of an absolutely-positioned `.range` div
//     resized via `--low` / `--high` CSS vars (one fewer element,
//     no overlap fights with the inputs).
//   * Crossing thumbs SWAP roles cleanly: when the user drags the
//     low thumb past the high thumb (or vice versa), the dragged
//     thumb keeps following the cursor and now represents the
//     opposite end of the range. `low` / `high` are derived as
//     `min` / `max` of the two raw inputs, so the visual track
//     and the property values stay consistent regardless of which
//     native `<input>` element holds which logical value. The
//     inputs are uncontrolled (no reactive `.value=` binding) so
//     a re-render mid-drag doesn't yank the dragged thumb back to
//     a sorted slot.
//   * Two events: `range-input` (continuous, fires during drag —
//     host can choose to ignore for filter heaviness reasons) and
//     `range-change` (final, fires on release). Both carry
//     `{ low, high }` in `event.detail` and bubble + compose so
//     the host can listen on a parent without piercing the shadow.
//   * `step` is honored end-to-end (forwarded to both inputs).
//   * A `willUpdate` hook clamps externally-set values so a host
//     that pushes invalid `low > high` doesn't briefly render a
//     reversed range before the next event corrects it.
//
// Usage:
//   <range-slider min="0" max="10" step="1" low="3" high="8"
//     @range-input=${(e) => liveUpdate(e.detail.low, e.detail.high)}
//     @range-change=${(e) => commit(e.detail.low, e.detail.high)}>
//   </range-slider>
//
// `event.detail` shape: `{ low: number, high: number }`.
import { LitElement, html, css } from 'lit'

class RangeSlider extends LitElement {
  static properties = {
    min:  { type: Number },
    max:  { type: Number },
    step: { type: Number },
    low:  { type: Number },
    high: { type: Number },
  }

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      width: 8.5rem;
      height: 16px;
      /* Color hooks — host can override via inline style or CSS
         vars on an ancestor. Defaults inherit from the surrounding
         text color (track) and pick up currentColor for the
         selected range / thumbs (which the host typically tints to
         the page accent). */
      --rs-thumb-size: 14px;
      --rs-track-height: 3px;
      --rs-rail: rgb(from currentColor r g b / .25);
      --rs-fill: var(--accent, currentColor);
    }

    .track-wrap {
      position: relative;
      flex: 1;
      height: var(--rs-thumb-size);
    }

    /* Single track with a gradient that paints the selected range
       in --rs-fill between --low% and --high%, and the rail
       elsewhere. var(--low) / var(--high) come from inline style
       on the wrapper (set by render() each tick). */
    .track {
      position: absolute;
      left: 0; right: 0;
      top: 50%;
      height: var(--rs-track-height);
      transform: translateY(-50%);
      border-radius: 99px;
      background:
        linear-gradient(to right,
          var(--rs-rail) 0,
          var(--rs-rail) var(--low, 0%),
          var(--rs-fill) var(--low, 0%),
          var(--rs-fill) var(--high, 100%),
          var(--rs-rail) var(--high, 100%));
    }

    /* Both inputs overlap the same area; pointer-events:none on
       the input itself + pointer-events:auto on the thumb lets
       the user grab whichever thumb is closer without the input's
       full-width hitbox blocking the other. */
    input[type="range"] {
      appearance: none; -webkit-appearance: none;
      position: absolute;
      left: 0; right: 0; top: 0;
      width: 100%; height: var(--rs-thumb-size);
      background: transparent;
      pointer-events: none;
      margin: 0; padding: 0;
      outline: none;
    }
    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      pointer-events: auto;
      width: var(--rs-thumb-size); height: var(--rs-thumb-size);
      border-radius: 50%;
      background: var(--rs-fill);
      border: 0;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .5);
      cursor: pointer;
    }
    input[type="range"]::-moz-range-thumb {
      pointer-events: auto;
      width: var(--rs-thumb-size); height: var(--rs-thumb-size);
      border-radius: 50%;
      background: var(--rs-fill);
      border: 0;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .5);
      cursor: pointer;
    }
    input[type="range"]::-webkit-slider-runnable-track {
      background: transparent; height: var(--rs-thumb-size);
    }
  `

  constructor() {
    super()
    this.min = 0
    this.max = 100
    this.step = 1
    this.low = 0
    this.high = 100
  }

  willUpdate() {
    if (this.low < this.min) this.low = this.min
    if (this.high > this.max) this.high = this.max
    if (this.low > this.high) this.low = this.high
  }

  render() {
    const span = (this.max - this.min) || 1
    const lowPct = ((this.low - this.min) / span) * 100
    const highPct = ((this.high - this.min) / span) * 100
    // `.value=` is intentionally NOT bound on the inputs — they're
    // uncontrolled so a re-render triggered mid-drag (e.g. by our own
    // _onInput updating `low` / `high`) doesn't reassign their values
    // and yank the thumb the user is holding. `firstUpdated` seeds
    // the initial values; `updated` syncs only when external code
    // changes `low` / `high`.
    return html`<div class="track-wrap" style=${`--low:${lowPct}%;--high:${highPct}%`}>
      <div class="track"></div>
      <input type="range" min=${this.min} max=${this.max} step=${this.step}
        @input=${this._onInput}
        @change=${this._onChange}>
      <input type="range" min=${this.min} max=${this.max} step=${this.step}
        @input=${this._onInput}
        @change=${this._onChange}>
    </div>`
  }

  firstUpdated() {
    this._inputs = [...this.renderRoot.querySelectorAll('input[type="range"]')]
    this._inputs[0].value = this.low
    this._inputs[1].value = this.high
  }

  // Sync inputs to current `low` / `high` only when an external update
  // changed them. Mid-drag, our own `_onInput` derives `low` / `high`
  // from the inputs (so the inputs already match) and the diff guards
  // below short-circuit. The `inverted` check keeps the dragged thumb
  // in place when the slider is in a swapped state — programmatically
  // setting `low = 4` on a swapped slider writes to whichever input
  // currently represents the lower value, leaving the other where the
  // user dropped it.
  updated(changed) {
    if (!this._inputs) return
    if (!(changed.has('low') || changed.has('high'))) return
    const cur = this._inputs.map((x) => Number(x.value))
    const inverted = cur[0] > cur[1]
    const lowIdx = inverted ? 1 : 0
    const highIdx = inverted ? 0 : 1
    if (this.low !== cur[lowIdx]) this._inputs[lowIdx].value = this.low
    if (this.high !== cur[highIdx]) this._inputs[highIdx].value = this.high
  }

  // Both raw input values are sources of truth during drag. Recompute
  // `low` / `high` by sorting (min / max) so the thumb that crosses
  // its companion swaps roles naturally — the dragged thumb stays
  // under the user's cursor and now represents the opposite end of
  // the range. Lit's reactive update on `low` / `high` triggers a
  // re-render that updates the gradient track but leaves the inputs
  // alone (see render() comment).
  _onInput = () => {
    const a = Number(this._inputs[0].value)
    const b = Number(this._inputs[1].value)
    this.low = Math.min(a, b)
    this.high = Math.max(a, b)
    this._emit('range-input')
  }

  _onChange = () => { this._emit('range-change') }

  _emit(name) {
    this.dispatchEvent(new CustomEvent(name, {
      detail: { low: this.low, high: this.high },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('range-slider', RangeSlider)
