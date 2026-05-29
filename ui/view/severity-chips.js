// `<severity-chips>` — multi-select pill row of severity filter chips
// for the toolbar. One chip per severity tier with at least one
// finding in the current load (the host filters out zero-count tiers
// before passing data in); each chip shows a colored swatch + tier
// name + count badge. CSS: toolbar.css `severity-chips` host +
// per-chip `.sev-chip`.
//
// Reactivity (kind="findings"): extends StateElement, so reads of
// `state.filterSeverities` inside render() are auto-tracked and the
// chips re-highlight without the host re-passing `selected`. Counts
// still arrive via the `counts` property — computing them needs the
// filter pipeline output the parent already has.
//
// Reactivity (kind="graph"): `graph2.*` lives outside the
// `store()`-wrapped state, so its reads aren't tracked by
// observer-util. The graph topbar passes `selected` via Lit property
// binding and events.js's severity-toggle handler pushes a fresh
// array into `el.selected` on every toggle — both drive updates
// through Lit's property setter, not the autorun. DO NOT drop the
// explicit `el.selected = [...]` push in events.js thinking
// StateElement will pick it up; for the graph kind, it won't.
//
// `severity-toggle` carries `kind` so events.js routes to
// `state.filterSeverities` (kind="findings", default — full
// re-render) vs. `graph2.selectedSeverities` (kind="graph" — surgical
// canvas redraw + chip property update, no full re-render).
// `selected` is consulted only when kind="graph".
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { ensureHostAria } from './host-aria.js'
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
    // Which state slot the host is wiring up (see header routing).
    // Default 'findings'.
    kind:     { type: String },
  }

  // Light DOM (no shadow root) so toolbar.css's `severity-chips` +
  // `.sev-chip` rules apply directly and the chips reuse the toolbar's
  // padding/hover/active-tint instead of restating them in a shadow root.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.counts = {}
    this.selected = []
    this.kind = 'findings'
  }

  connectedCallback() {
    super.connectedCallback()
    ensureHostAria(this, { role: 'group', 'aria-label': 'Filter by severity' })
  }

  render() {
    // Findings reads state directly (autorun); graph uses the
    // `selected` prop (graph2 is outside the store). See header.
    const selected = this.kind === 'graph'
      ? new Set(this.selected)
      : state.filterSeverities
    // Keep selected zero-count chips visible so the user can always
    // untoggle them — useful in the graph-tab usage where a severity
    // filter can outlive its data (toggling a severity off in the
    // canvas, then having the underlying graph data change).
    const visibleTiers = TIERS.filter(([sev]) => (this.counts[sev] ?? 0) || selected.has(sev))
    // Hide the whole pill when no tiers are visible — otherwise the
    // bordered shell collapses to a thin vertical line next to the
    // next toolbar control (visible glitch).
    if (visibleTiers.length === 0) return nothing
    return html`${visibleTiers.map(([sev, label]) => {
      const count = this.counts[sev] ?? 0
      const active = selected.has(sev)
      return html`<button
        type="button"
        class=${classMap({ 'sev-chip': true, [sev]: true, active })}
        aria-pressed=${String(active)}
        @click=${() => this._toggle(sev)}
      ><span class="sd"></span><span class="name">${label}</span><span class="n">${count}</span></button>`
    })}`
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
