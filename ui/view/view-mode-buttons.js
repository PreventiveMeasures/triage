// `<view-mode-buttons>` — icon-button group for the toolbar's
// View: chooser. One button per mode (`table` / `list` / `grouped`),
// each carrying an inline SVG glyph that previews the layout it
// switches to. The active button picks up an outline + accent
// recolor via the toolbar's CSS.
//
// Replaces an inline `for (const mode of ...)` loop in render.js
// that interpolated the icon SVGs as raw strings, plus the
// `[data-view-mode]` click branch in events.js. Was a six-line
// loop with three icon string constants stitched together; making
// it a component lets the SVGs live as Lit `html` template
// fragments next to the click handler that switches modes, and
// gives the host one event to listen to instead of one selector
// per click delegation chain.
//
// Properties:
//   * `mode` — current `state.viewMode` (`table` | `list` | `grouped`).
//
// Events (bubble + composed:true):
//   * `view-mode-change(detail.mode)` — fired on click. The host
//     persists the value to localStorage and re-renders.
import { LitElement, html } from 'lit'

const VIEW_ICONS = {
  // table   — four dense rows, like a spreadsheet
  table: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <rect x="2" y="3" width="12" height="1.6"/><rect x="2" y="6" width="12" height="1.6"/>
    <rect x="2" y="9" width="12" height="1.6"/><rect x="2" y="12" width="12" height="1.6"/>
  </svg>`,
  // list    — three taller items with a row-bullet on the left
  list: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <rect x="2" y="3" width="2" height="2.2" rx=".4"/><rect x="6" y="3" width="9" height="2.2" rx=".4"/>
    <rect x="2" y="7" width="2" height="2.2" rx=".4"/><rect x="6" y="7" width="9" height="2.2" rx=".4"/>
    <rect x="2" y="11" width="2" height="2.2" rx=".4"/><rect x="6" y="11" width="9" height="2.2" rx=".4"/>
  </svg>`,
  // grouped — items under a section header band on top
  grouped: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <rect x="2" y="2" width="12" height="2.4" rx=".5"/>
    <rect x="3" y="6" width="11" height="1.6"/><rect x="3" y="8.5" width="11" height="1.6"/>
    <rect x="3" y="11" width="11" height="1.6"/><rect x="3" y="13.5" width="11" height="1.6"/>
  </svg>`,
  // graph   — three nodes connected by edges
  graph: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
    <line x1="4.5" y1="4.5" x2="11.5" y2="6.5"/>
    <line x1="4.5" y1="4.5" x2="6.5" y2="11.5"/>
    <line x1="11.5" y1="6.5" x2="6.5" y2="11.5"/>
    <circle cx="4.5" cy="4.5" r="2" fill="currentColor"/>
    <circle cx="11.5" cy="6.5" r="2" fill="currentColor"/>
    <circle cx="6.5" cy="11.5" r="2" fill="currentColor"/>
  </svg>`,
}

const VIEW_TITLES = {
  table:   'Table view (compact rows, click a row to expand)',
  list:    'List view (flat, one card per finding)',
  grouped: 'List view, grouped by file',
  graph:   'Graph view (canvas with imports / exports)',
}

const MODES = ['table', 'list', 'grouped', 'graph']

class ViewModeButtons extends LitElement {
  static properties = {
    mode: { type: String },
    // Comma-separated subset of MODES to expose. Default = all
    // three (table / list / grouped) for the findings tab; the
    // Files tab passes "table,list" since the grouped layout
    // doesn't apply there.
    modes: { type: String },
    // Identifies which state slot the host is wiring up. The
    // `view-mode-change` event carries this in its detail so the
    // events.js delegate routes to `state.viewMode` (default,
    // findings) vs. `state.filesViewMode` (kind="files").
    kind: { type: String },
  }

  // Light DOM so the existing `.view-mode-label` / `.view-mode-group`
  // / `.view-mode-btn` rules in toolbar.css apply directly. Same
  // pattern as `<severity-chips>` / `<triage-filter>`.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.mode = 'table'
    this.modes = MODES.join(',')
    this.kind = 'findings'
  }

  render() {
    const allowed = this.modes.split(',').map((s) => s.trim()).filter((s) => MODES.includes(s))
    const list = allowed.length > 0 ? allowed : MODES
    return html`<span class="view-mode-label">View:</span>
      <div class="view-mode-group" role="group" aria-label="View mode">
        ${list.map((m) => html`<button
          type="button"
          class=${`view-mode-btn${this.mode === m ? ' active' : ''}`}
          title=${VIEW_TITLES[m]}
          aria-label=${VIEW_TITLES[m]}
          aria-pressed=${String(this.mode === m)}
          @click=${() => this._select(m)}
        >${VIEW_ICONS[m]}</button>`)}
      </div>`
  }

  _select(mode) {
    if (mode === this.mode) return
    this.dispatchEvent(new CustomEvent('view-mode-change', {
      detail: { mode, kind: this.kind },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('view-mode-buttons', ViewModeButtons)
