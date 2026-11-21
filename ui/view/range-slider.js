// `<range-slider>` — a dual-thumb numeric range: two stacked native range
// inputs over one track, the span between the thumbs tinted by a gradient.
// Emits `range-input` while dragging and `range-change` on release, both
// with `{ low, high }`.
//
// `low` / `high` are the min / max of the two inputs, so thumbs crossing
// swap roles and the dragged one keeps following the cursor. The inputs are
// uncontrolled (no `.value=` binding), so a mid-drag render — this
// element's own, on input — never yanks the held thumb back to a sorted
// slot; `firstUpdated` seeds them and `updated` follows an external change.
import { LitElement, html, unsafeCSS } from 'lit'
import { styleMap } from './style-map.js'
import sliderCSS from './range-slider.css'
import { emit } from './emit.js'

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

  // A host pushing `low > high` doesn't briefly render a reversed range.
  willUpdate() {
    if (this.low < this.min) this.low = this.min
    if (this.high > this.max) this.high = this.max
    if (this.low > this.high) this.low = this.high
  }

  render() {
    const span = (this.max - this.min) || 1
    const lowPct = ((this.low - this.min) / span) * 100
    const highPct = ((this.high - this.min) / span) * 100
    return html`<div class="track-wrap" style=${styleMap({ '--low': `${lowPct}%`, '--high': `${highPct}%` })}>
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

  // Mid-drag `_onInput` already set the inputs, so the diff guards skip it.
  // On swapped thumbs, `low` goes to whichever input holds the lower value,
  // leaving the other where the user dropped it.
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

  _onInput = () => {
    const a = Number(this._inputs[0].value)
    const b = Number(this._inputs[1].value)
    this.low = Math.min(a, b)
    this.high = Math.max(a, b)
    this._emit('range-input')
  }

  _onChange = () => { this._emit('range-change') }

  _emit(name) {
    emit(this, name, { low: this.low, high: this.high })
  }
}

customElements.define('range-slider', RangeSlider)
