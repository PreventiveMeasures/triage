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
//     re-render (filter reset, view switch).
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
  }

  connectedCallback() {
    super.connectedCallback()
    document.addEventListener('range-input', this._onRangeInput)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    document.removeEventListener('range-input', this._onRangeInput)
  }

  _onRangeInput = (e) => {
    if (e.target?.id !== this.for) return
    this.low = e.detail.low
    this.high = e.detail.high
  }

  render() {
    return html`${this.low}–${this.high}`
  }
}

customElements.define('conf-range-mirror', ConfRangeMirror)
