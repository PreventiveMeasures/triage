// `<conf-range-mirror>` — live label that tracks a range-slider's
// current low–high pair without forcing the host to re-render on
// every drag tick. Listens at the document for `range-input`
// events bubbling out of the matching slider (id given by the
// `for` attribute) and updates its own state; the rest of the
// page stays paint-free until release fires `range-change`.
//
// Properties (decoded from attributes):
//   * `low` / `high` — current values; the host seeds them on
//     full render so the label stays in sync after a full
//     re-render (filter reset, view switch). Re-binds during a
//     drag are ignored (see `willUpdate`) — the slider's reactive
//     state isn't committed until release, so a re-render
//     triggered by an unrelated state mutation (cross-tab sync
//     push, etc.) would otherwise snap the label back to pre-drag
//     values and flicker.
//   * `for` — id of the slider whose events to mirror. Defaults
//     to `conf-range`, the confidence-filter slider in the
//     findings toolbar.
//
// Replaces the previous `<span id="conf-range-vals" .textContent
// =${...}>` that events.js patched imperatively during drag —
// that direct mutation poisoned Lit's part-cache when the span
// carried a child interpolation, which crashed `_commitText` on
// the next full render.
import { LitElement, html } from 'lit'

class ConfRangeMirror extends LitElement {
  static properties = {
    low: { type: Number },
    high: { type: Number },
    for: { type: String },
  }

  // Light DOM — the host span's `.conf-vals` rule lives in the
  // toolbar stylesheet and applies directly. No shadow boundary
  // needed; there's no encapsulated content.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.low = 0
    this.high = 10
    this.for = 'conf-range'
    // Drag state — set on the first range-input, cleared on
    // range-change. While true, willUpdate restores low/high to
    // the live drag values if anything (host re-binding) tried to
    // write them.
    this._dragging = false
    this._liveLow = 0
    this._liveHigh = 10
  }

  connectedCallback() {
    super.connectedCallback()
    document.addEventListener('range-input', this._onRangeInput)
    document.addEventListener('range-change', this._onRangeChange)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    document.removeEventListener('range-input', this._onRangeInput)
    document.removeEventListener('range-change', this._onRangeChange)
  }

  // Lit calls willUpdate with the set of changed properties before
  // render(). During a drag the host's reactive state lags the
  // slider (events.js commits state.filterConfMin/Max only on
  // range-change), so re-renders triggered by unrelated state
  // mutations re-bind .low/.high to pre-drag values. Restore the
  // live drag values here so the label keeps following the
  // user's thumb until release. Lit consolidates property writes
  // inside willUpdate into the same update cycle — no infinite
  // loop, no extra render.
  willUpdate(changed) {
    if (!this._dragging) return
    if (changed.has('low') && this.low !== this._liveLow) this.low = this._liveLow
    if (changed.has('high') && this.high !== this._liveHigh) this.high = this._liveHigh
  }

  _onRangeInput = (e) => {
    if (e.target?.id !== this.for) return
    this._dragging = true
    this._liveLow = e.detail.low
    this._liveHigh = e.detail.high
    this.low = e.detail.low
    this.high = e.detail.high
  }

  _onRangeChange = (e) => {
    if (e.target?.id !== this.for) return
    // Release: events.js's range-change handler updates state and
    // triggers a full host render, which seeds us via the property
    // bindings with the committed values. Just clear the drag flag
    // so the next host render isn't gated.
    this._dragging = false
  }

  render() {
    return html`${this.low}–${this.high}`
  }
}

customElements.define('conf-range-mirror', ConfRangeMirror)
