// `<range-slider>` — a dual-thumb numeric range input. Two stacked
// native `<input type="range">` elements share a single track; the
// selected range between the thumbs is tinted via a CSS gradient on
// the track. Used as one filter, vs. the two adjacent `<select>`
// dropdowns it stands in for.
//
// Design notes:
//   * The range tint is a `linear-gradient` on a single track div
//     (not an absolutely-positioned `.range` div sized via `--low` /
//     `--high`) — one fewer element, no overlap fights with the inputs.
//   * Crossing thumbs SWAP roles cleanly: dragging the low thumb past
//     the high (or vice versa), the dragged thumb keeps following the
//     cursor and now represents the opposite end. `low` / `high` are
//     derived as `min` / `max` of the two raw inputs, so track and
//     property values stay consistent regardless of which native
//     `<input>` holds which logical value. The inputs are uncontrolled
//     (no reactive `.value=` binding) so a re-render mid-drag doesn't
//     yank the dragged thumb back to a sorted slot.
//   * Two events: `range-input` (continuous, during drag — host may
//     ignore for filter heaviness) and `range-change` (final, on
//     release). Both carry `{ low, high }` in `event.detail` and
//     bubble + compose so the host can listen on a parent without
//     piercing the shadow.
//   * `step` is forwarded to both inputs.
//   * `willUpdate` clamps externally-set values so a host pushing
//     invalid `low > high` doesn't briefly render a reversed range.
//
// Usage:
//   <range-slider min="0" max="10" step="1" low="3" high="8"
//     @range-input=${(e) => liveUpdate(e.detail.low, e.detail.high)}
//     @range-change=${(e) => commit(e.detail.low, e.detail.high)}>
//   </range-slider>
import { LitElement, html, unsafeCSS } from 'lit'
import sliderCSS from './range-slider.css'

class RangeSlider extends LitElement {
  static properties = {
    min:  { type: Number },
    max:  { type: Number },
    step: { type: Number },
    low:  { type: Number },
    high: { type: Number },
  }

  static styles = unsafeCSS(sliderCSS)

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
    // `.value=` is intentionally NOT bound — the inputs are
    // uncontrolled, so a mid-drag re-render (e.g. our own _onInput
    // updating `low` / `high`) won't reassign their values and yank the
    // held thumb. `firstUpdated` seeds initial values; `updated` syncs
    // only when external code changes `low` / `high`.
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

  // Sync inputs to `low` / `high` only on an external change. Mid-drag,
  // our own `_onInput` already set the inputs, so the diff guards below
  // short-circuit. The `inverted` check keeps the dragged thumb in
  // place when swapped: setting `low = 4` on a swapped slider writes to
  // whichever input currently holds the lower value, leaving the other
  // where the user dropped it.
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

  // Both raw inputs are sources of truth during drag. Recompute
  // `low` / `high` by sorting (min / max) so a thumb crossing its
  // companion swaps roles naturally — the dragged thumb stays under
  // the cursor as the opposite end. Lit's update re-renders the
  // gradient track but leaves the inputs alone (see render() comment).
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
