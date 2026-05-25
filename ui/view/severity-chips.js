// `<severity-chips>` — multi-select pill row of severity filter chips
// for the toolbar. One chip per severity tier that has at least one
// finding in the current load (the host filters out zero-count tiers
// before passing data in); each chip shows a colored swatch + the
// tier name + a count badge.
//
// Replaces the inline `severityChipsHtml(counts)` builder in
// render.js. Was a string-concatenated block of ~20 lines that
// interpolated counts and per-tier classes; making it a component
// scopes the click handler, keeps the rendered chips consistent
// with the per-tier styling in toolbar.css's `.sev-chip` block, and
// (for the findings kind) lets the active highlight self-sync via
// StateElement instead of riding on a parent-passed prop.
//
// Reactivity (kind="findings"): extends StateElement, so reads of
// `state.filterSeverities` inside render() are auto-tracked and
// the chips re-highlight without the host re-passing `selected`.
// Counts still come in via the `counts` property because computing
// them requires the filter pipeline output the parent already has.
//
// Reactivity (kind="graph"): `graph2.*` lives outside the
// `store()`-wrapped state, so its reads aren't tracked by
// observer-util. The graph topbar keeps passing `selected` via Lit
// property binding and events.js's severity-toggle handler pushes a
// fresh array into `el.selected` on every toggle — both paths drive
// updates through Lit's property setter, not the autorun. DO NOT
// drop the explicit `el.selected = [...]` push in events.js thinking
// StateElement will pick it up; for the graph kind, it won't.
//
// Properties (`attribute: false` — passed by reference via Lit's
// `.prop=${...}` property binding; no attribute reflection):
//   * `counts`   — `{ critical, high, medium, low, high_bug, bug,
//                  informational }`. Tiers with `0` (or missing)
//                  are skipped.
//   * `selected` — array of currently-active tier names; consulted
//                  only when kind="graph".
//
// Events (bubble + composed:true):
//   * `severity-toggle(detail.severity, detail.kind)` — fired when a
//     chip is clicked. `kind` rides along so events.js routes to
//     `state.filterSeverities` (kind="findings", default — full
//     re-render) vs. `graph2.selectedSeverities` (kind="graph" —
//     surgical canvas redraw + chip property update only, no full
//     re-render).
import { html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const TIERS = [
  ['critical',      'Critical'],
  ['high',          'High'],
  ['medium',        'Medium'],
  ['low',           'Low'],
  ['high_bug',      'High bug'],
  ['bug',           'Bug'],
  ['informational', 'Info'],
]

class SeverityChips extends StateElement {
  static properties = {
    counts:   { attribute: false },
    selected: { attribute: false },
    // Identifies which state slot the host is wiring up — see the
    // `severity-toggle` description above. Default 'findings'.
    kind:     { type: String },
  }

  // CSS lives in styles/toolbar.css under the `.sev-chips` /
  // `.sev-chip` rules. We render light DOM (no shadow root) so those
  // rules apply directly — the chips reuse the toolbar's padding,
  // hover, active-tint patterns, and sharing styles with the
  // surrounding chrome reads cleaner than re-stating the same
  // declarations inside a shadow root.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.counts = {}
    this.selected = []
    this.kind = 'findings'
  }

  render() {
    // Findings kind reads state directly via StateElement's autorun;
    // graph kind keeps using the `selected` prop because graph2 lives
    // outside the observable store. See module header.
    const selected = this.kind === 'graph'
      ? new Set(this.selected)
      : state.filterSeverities
    // Keep selected zero-count chips visible so the user can always
    // untoggle them — useful in the graph-tab usage where a severity
    // filter can outlive its data (toggling a severity off in the
    // canvas, then having the underlying graph data change).
    const visibleTiers = TIERS.filter(([sev]) => (this.counts[sev] ?? 0) || selected.has(sev))
    // Hide the whole wrapper when no tiers are visible — otherwise
    // the bordered `.sev-chips` shell collapses to a thin vertical
    // line next to the next toolbar control (visible glitch).
    if (visibleTiers.length === 0) return nothing
    return html`<div class="sev-chips" role="group" aria-label="Filter by severity">
      ${visibleTiers.map(([sev, label]) => {
        const count = this.counts[sev] ?? 0
        const active = selected.has(sev)
        return html`<button
          type="button"
          class=${classMap({ 'sev-chip': true, [sev]: true, active })}
          aria-pressed=${String(active)}
          @click=${() => this._toggle(sev)}
        ><span class="sd"></span><span class="name">${label}</span><span class="n">${count}</span></button>`
      })}
    </div>`
  }

  _toggle(severity) {
    this.dispatchEvent(new CustomEvent('severity-toggle', {
      detail: { severity, kind: this.kind },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('severity-chips', SeverityChips)
