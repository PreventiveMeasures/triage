// `<conf-range-mirror>` — the live low–high label of the range slider whose
// id is `for` (the toolbar's `conf-range` by default), following its
// `range-input` events so the page needn't re-render per drag tick. The host
// seeds `low` / `high` on each full render. A component rather than a
// patched span: mutating a span with a child interpolation poisons Lit's
// part cache and crashes `_commitText` on the next render.
import { LitElement, html } from 'lit'

class ConfRangeMirror extends LitElement {
  static properties = {
    low: { type: Number },
    high: { type: Number },
    for: { type: String },
  }

  // Light DOM, for the toolbar's `.conf-vals` rule.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.low = 0
    this.high = 10
    this.for = 'conf-range'
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

  // State commits only on release, so mid-drag a render for some unrelated
  // change re-binds the pre-drag values: keep the live ones until release.
  // Written in willUpdate, they join the same update.
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

  // The release's full render seeds the committed values.
  _onRangeChange = (e) => {
    if (e.target?.id !== this.for) return
    this._dragging = false
  }

  render() {
    return html`<span>${this.low}</span><span class="dash">–</span><span>${this.high}</span>`
  }
}

customElements.define('conf-range-mirror', ConfRangeMirror)
