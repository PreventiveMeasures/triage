// `<triage-filter>` — five-button mark-color filter pill ported
// from the DeepView.0 prototype's `.triage-filter` block. One pill
// containing one circle per mark color (`none / red / blue / green
// / gray`); clicking toggles membership in the host's
// `state.filterColors` set. Per-button counts sit as a small chip
// in the upper-right of each circle.
//
// Replaces the inline `triageFilterHtml(colorCounts)` builder in
// render.js. Was a string-concatenated block that interpolated
// counts and per-color classes; making it a component scopes the
// click handler, keeps the rendered chips consistent with the
// per-color styling in toolbar.css's `.triage-filter` block, and
// (for the findings kind) lets the active highlight self-sync via
// StateElement instead of riding on a parent-passed prop.
//
// Tooltips intentionally name the color only — these dots are
// user-assigned during triage and the meaning is whatever the user
// wants, so the chrome doesn't presume "confirmed", "needs review",
// etc.
//
// Reactivity (kind="findings"): extends StateElement, so reads of
// `state.filterColors` inside render() are auto-tracked and the
// chips re-highlight without the host re-passing a `selected`
// prop. Counts still come in via the `counts` attribute because
// computing them requires the filter pipeline output the parent
// already has in hand.
//
// Reactivity (kind="graph"): `graph2.*` lives outside the
// `store()`-wrapped state, so its reads aren't tracked by
// observer-util. The graph topbar keeps passing `selected` via Lit
// property binding and events.js's color-toggle handler pushes a
// fresh array into `el.selected` on every toggle — both paths drive
// updates through Lit's property setter, not the autorun. DO NOT
// drop the explicit `el.selected = [...]` push in events.js thinking
// StateElement will pick it up; for the graph kind, it won't.
//
// Properties (`attribute: false` — passed by reference via Lit's
// `.prop=${...}` property binding; no attribute reflection):
//   * `counts`   — `{ none, red, blue, green, gray }` (per-color
//                  totals from the parent's filter pipeline).
//   * `selected` — array of currently-active color names; consulted
//                  only when kind="graph".
//
// Events (bubble + composed:true):
//   * `color-toggle(detail.color)` — fired when a button is
//     clicked. The host adds/removes the value from
//     `state.filterColors` and re-renders.
import { nothing } from 'lit'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const COLORS = [
  ['none', 'none', 'unmarked'],
  ['red',  'r',    'red'],
  ['blue', 'b',    'blue'],
  ['green', 'g',   'green'],
  ['gray', 'x',    'gray'],
]

class TriageFilter extends StateElement {
  static properties = {
    counts:   { attribute: false },
    selected: { attribute: false },
    // Identifies which state slot the host wires up — events.js
    // routes 'graph' to graph2.selectedColors (surgical canvas
    // redraw) vs the default findings-tab state.filterColors
    // (full re-render). Mirrors severity-chips' kind attribute.
    kind:     { type: String },
  }

  // CSS lives in styles/toolbar.css under the `triage-filter`
  // host selector. Light DOM keeps those rules applying directly —
  // same pattern as `<severity-chips>`, lets the host's existing
  // theming hold.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.counts = {}
    this.selected = []
    this.kind = 'findings'
  }

  connectedCallback() {
    super.connectedCallback()
    // ARIA on the host — the element selector now carries the
    // `.triage-filter` shell layout (no wrapping div), so the
    // group semantics live here too.
    if (!this.hasAttribute('role')) this.setAttribute('role', 'group')
    if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'Filter by mark color')
  }

  render() {
    // Findings kind reads state directly via StateElement's autorun;
    // graph kind keeps using the `selected` prop because graph2 lives
    // outside the observable store. See module header.
    const selected = this.kind === 'graph'
      ? new Set(this.selected)
      : state.filterColors
    // Hide the whole pill when there is nothing to filter from — no
    // color (including `none`) has any count and nothing is active.
    // Mirrors `<severity-chips>`'s empty-set guard so an empty
    // toolbar row stays clean of placeholder chrome.
    const hasAnything = COLORS.some(([color]) => (this.counts[color] ?? 0) || selected.has(color))
    if (!hasAnything) return nothing
    return html`${COLORS.map(([color, tdClass, label]) => {
      const count = this.counts[color] ?? 0
      const active = selected.has(color)
      return html`<button
        type="button"
        class=${active ? 'active' : ''}
        title=${`${label} (${count})`}
        aria-pressed=${String(active)}
        @click=${() => this._toggle(color)}
      ><span class=${`td ${tdClass}`}></span><span class="count">${count}</span></button>`
    })}`
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
