// `<severity-chips>` — the severity filter chips: one per tier with a
// finding in the current load (swatch, name, count), multi-select.
//
// kind="findings" (default) reads `state.filterSeverities` through the
// StateElement autorun; kind="graph" reads the `selected` property, as
// `graph2.*` lives outside the observed store — events.js pushes a fresh
// array into `el.selected` on every toggle, so DO NOT drop that push.
// `severity-toggle(detail: { severity, kind })` lets events.js route to
// the full re-render or the graph's surgical redraw.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { html } from '@rray/frontend/state-element'
import { ToolbarControl } from './toolbar-control.js'
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

class SeverityChips extends ToolbarControl {
  static properties = {
    counts:   { attribute: false },
    selected: { attribute: false },
    kind:     { type: String },
  }

  groupLabel = 'Filter by severity'

  constructor() {
    super()
    this.counts = {}
    this.selected = []
    this.kind = 'findings'
  }

  render() {
    const selected = this.kind === 'graph' ? new Set(this.selected) : state.filterSeverities
    // A selected tier stays even at zero, so it can always be untoggled
    // (a graph filter can outlive its data).
    const visibleTiers = TIERS.filter(([sev]) => (this.counts[sev] ?? 0) || selected.has(sev))
    // No tiers: no pill, or its bordered shell shows as a thin line.
    if (visibleTiers.length === 0) return nothing
    return html`${visibleTiers.map(([sev, label]) => {
      const active = selected.has(sev)
      return html`<button
        type="button"
        class=${classMap({ 'sev-chip': true, [sev]: true, active })}
        aria-pressed=${String(active)}
        @click=${() => this.emit('severity-toggle', { severity: sev, kind: this.kind })}
      ><span class="sd"></span><span class="name">${label}</span><span class="n">${this.counts[sev] ?? 0}</span></button>`
    })}`
  }
}

customElements.define('severity-chips', SeverityChips)
