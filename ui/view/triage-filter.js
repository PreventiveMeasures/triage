// `<triage-filter>` — the mark-color filter pill: one circle per color
// (`none / red / blue / green / gray`) with its count, a click toggling the
// color in the filter. Tooltips name the color only: marks mean whatever
// the user assigned them.
//
// kind="findings" (default) reads `state.filterColors` through the
// StateElement autorun. kind="graph" reads the `selected` property instead:
// `graph2.*` lives outside the observed store, so events.js pushes a fresh
// array into `el.selected` on every toggle — DO NOT drop that push.
//
// Click dispatches `color-toggle(detail: { color, kind })`; events.js routes
// it by `kind`.
import { nothing } from 'lit'
import { html } from '@rray/frontend/state-element'
import { ToolbarControl } from './toolbar-control.js'
import { state } from '#client/index.js'

const COLORS = [
  ['none', 'none', 'unmarked'],
  ['red',  'r',    'red'],
  ['blue', 'b',    'blue'],
  ['green', 'g',   'green'],
  ['gray', 'x',    'gray'],
]

class TriageFilter extends ToolbarControl {
  static properties = {
    counts:   { attribute: false },
    selected: { attribute: false },
    kind:     { type: String },
  }

  groupLabel = 'Filter by mark color'

  constructor() {
    super()
    this.counts = {}
    this.selected = []
    this.kind = 'findings'
  }

  render() {
    const selected = this.kind === 'graph' ? new Set(this.selected) : state.filterColors
    // Nothing to filter from and nothing active: no pill at all.
    if (!COLORS.some(([color]) => (this.counts[color] ?? 0) || selected.has(color))) return nothing
    return html`${COLORS.map(([color, tdClass, label]) => {
      const count = this.counts[color] ?? 0
      const active = selected.has(color)
      return html`<button
        type="button"
        class=${active ? 'active' : ''}
        aria-label=${`${label} (${count})`}
        aria-pressed=${String(active)}
        @click=${() => this.emit('color-toggle', { color, kind: this.kind })}
      ><span class=${`td ${tdClass}`}></span><span class="count">${count}</span></button>`
    })}`
  }
}

customElements.define('triage-filter', TriageFilter)
