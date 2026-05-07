// `<severity-chips>` — multi-select pill row of severity filter chips
// for the toolbar. One chip per severity tier that has at least one
// finding in the current load (the host filters out zero-count tiers
// before passing data in); each chip shows a colored swatch + the
// tier name + a count badge.
//
// Replaces the inline `severityChipsHtml(counts)` builder in
// render.js. Was a string-concatenated block of ~20 lines that
// interpolated counts and per-tier classes; making it a component
// gives it its own scope for the click handler, lets the host pass
// props instead of having the function read `state.filterSeverities`
// directly, and keeps the rendered chips consistent with the
// per-tier styling that lives in toolbar.css's `.sev-chip` block.
//
// Properties (decoded from attributes so the host can render this
// element into innerHTML without a follow-up property assignment):
//   * `counts` — JSON object `{ critical, high, medium, low,
//     high_bug, bug, informational }`. Tiers with `0` (or missing)
//     are skipped.
//   * `selected` — JSON array of currently-active tier names.
//     Empty array = no filter (all chips read as inactive).
//
// Events (bubble + composed:true):
//   * `severity-toggle(detail.severity)` — fired when a chip is
//     clicked. The host adds/removes the value from
//     `state.filterSeverities` and re-renders.
import { LitElement, html, css } from 'lit'

const TIERS = [
  ['critical',      'Critical'],
  ['high',          'High'],
  ['medium',        'Medium'],
  ['low',           'Low'],
  ['high_bug',      'High bug'],
  ['bug',           'Bug'],
  ['informational', 'Info'],
]

class SeverityChips extends LitElement {
  static properties = {
    counts:   { type: Object },
    selected: { type: Array },
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
  }

  render() {
    const selected = new Set(this.selected)
    return html`<div class="sev-chips" role="group" aria-label="Filter by severity">
      ${TIERS.map(([sev, label]) => {
        const count = this.counts[sev] ?? 0
        if (!count) return null
        const active = selected.has(sev)
        return html`<button
          type="button"
          class=${`sev-chip ${sev}${active ? ' active' : ''}`}
          aria-pressed=${String(active)}
          @click=${() => this._toggle(sev)}
        ><span class="sd"></span><span class="name">${label}</span><span class="n">${count}</span></button>`
      })}
    </div>`
  }

  _toggle(severity) {
    this.dispatchEvent(new CustomEvent('severity-toggle', {
      detail: { severity },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('severity-chips', SeverityChips)
