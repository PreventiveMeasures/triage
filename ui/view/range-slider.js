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
//   * Crossing thumbs CLAMP rather than swap. The old impl sorted
//     values on every input and re-pointed the inputs, which felt
//     unpredictable (the thumb you grab can suddenly become the
//     other thumb mid-drag). Clamping pins the dragged thumb at
//     its companion's value — same constraint, more intuitive.
//   * Two events: `input` (continuous, fires during drag — host
//     can choose to ignore for filter heaviness reasons) and
//     `change` (final, fires on release). Both carry
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
    return html`<div class="track-wrap" style=${`--low:${lowPct}%;--high:${highPct}%`}>
      <div class="track"></div>
      <input type="range" min=${this.min} max=${this.max} step=${this.step}
        .value=${String(this.low)}
        @input=${this._onLowInput}
        @change=${this._onChange}>
      <input type="range" min=${this.min} max=${this.max} step=${this.step}
        .value=${String(this.high)}
        @input=${this._onHighInput}
        @change=${this._onChange}>
    </div>`
  }

  _onLowInput = (e) => {
    let v = Number(e.target.value)
    if (v > this.high) v = this.high
    this.low = v
    this._emit('range-input')
  }

  _onHighInput = (e) => {
    let v = Number(e.target.value)
    if (v < this.low) v = this.low
    this.high = v
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
