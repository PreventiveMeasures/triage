// `<triage-filter>` — five-button mark-color filter pill ported
// from the DeepView.0 prototype's `.triage-filter` block. One pill
// containing one circle per mark color (`none / red / blue / green
// / gray`); clicking toggles membership in the host's
// `state.filterColors` set. Per-button counts sit as a small chip
// in the upper-right of each circle.
//
// Replaces the inline `triageFilterHtml(colorCounts)` builder in
// render.js. Was a string-concatenated block that interpolated
// counts and per-color classes; making it a component lets the
// host pass props instead of having the function reach into
// `state.filterColors`, and keeps the rendered chips consistent
// with the per-color styling that lives in toolbar.css's
// `.triage-filter` block.
//
// Tooltips intentionally name the color only — these dots are
// user-assigned during triage and the meaning is whatever the user
// wants, so the chrome doesn't presume "confirmed", "needs review",
// etc.
//
// Properties (decoded from attributes so the host can render this
// element into innerHTML without a follow-up property assignment):
//   * `counts` — JSON object `{ none, red, blue, green, gray }`.
//   * `selected` — JSON array of currently-active color names.
//
// Events (bubble + composed:true):
//   * `color-toggle(detail.color)` — fired when a button is
//     clicked. The host adds/removes the value from
//     `state.filterColors` and re-renders.
import { LitElement, html, nothing } from 'lit'

const COLORS = [
  ['none', 'none', 'unmarked'],
  ['red',  'r',    'red'],
  ['blue', 'b',    'blue'],
  ['green', 'g',   'green'],
  ['gray', 'x',    'gray'],
]

class TriageFilter extends LitElement {
  static properties = {
    counts:   { type: Object },
    selected: { type: Array },
    // Identifies which state slot the host wires up — events.js
    // routes 'graph' to graph2.selectedColors (surgical canvas
    // redraw) vs the default findings-tab state.filterColors
    // (full re-render). Mirrors severity-chips' kind attribute.
    kind:     { type: String },
  }

  // CSS lives in styles/toolbar.css under the `.triage-filter`
  // block. Light DOM keeps those rules applying directly — same
  // pattern as `<severity-chips>`, lets the host's existing
  // theming hold.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.counts = {}
    this.selected = []
    this.kind = 'findings'
  }

  render() {
    const selected = new Set(this.selected)
    // Hide the whole pill when there is nothing to filter from — no
    // color (including `none`) has any count and nothing is active.
    // Mirrors `<severity-chips>`'s empty-set guard so an empty
    // toolbar row stays clean of placeholder chrome.
    const hasAnything = COLORS.some(([color]) => (this.counts[color] ?? 0) || selected.has(color))
    if (!hasAnything) return nothing
    return html`<div class="triage-filter" role="group" aria-label="Filter by mark color">
      ${COLORS.map(([color, tdClass, label]) => {
        const count = this.counts[color] ?? 0
        const active = selected.has(color)
        return html`<button
          type="button"
          class=${active ? 'active' : ''}
          title=${`${label} (${count})`}
          aria-pressed=${String(active)}
          @click=${() => this._toggle(color)}
        ><span class=${`td ${tdClass}`}></span><span class="count">${count}</span></button>`
      })}
    </div>`
  }

  _toggle(color) {
    this.dispatchEvent(new CustomEvent('color-toggle', {
      detail: { color, kind: this.kind },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('triage-filter', TriageFilter)
