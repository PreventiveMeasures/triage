// `<view-mode-buttons>` — icon-button group for the toolbar's
// View: chooser. One button per mode (`table` / `list` / `grouped`
// / `focus` / `kanban` / `graph`), each carrying an inline SVG glyph
// that previews the layout it switches to. The active button picks
// up an outline + accent recolor via the toolbar's CSS.
//
// Self-syncs against the global state store via StateElement: reads
// of `state.viewMode` (or `state.filesViewMode` when `kind="files"`)
// inside render() are auto-tracked, so flipping the active button
// doesn't require the parent to pass an updated `mode` prop — the
// highlight follows the state mutation on its own.
//
// `view-mode-change(detail.mode)` (bubbles + composed) fires on click;
// the host persists the value to localStorage and re-renders.
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { ensureHostAria } from './host-aria.js'

const VIEW_ICONS = {
  // table   — gridded cell layout
  table: html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <line x1="3" x2="21" y1="9" y2="9"/>
    <line x1="3" x2="21" y1="15" y2="15"/>
    <line x1="9" x2="9" y1="3" y2="21"/>
  </svg>`,
  // list    — three full-width horizontal lines (no bullet dots)
  list: html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <line x1="3" x2="21" y1="6" y2="6"/>
    <line x1="3" x2="21" y1="12" y2="12"/>
    <line x1="3" x2="21" y1="18" y2="18"/>
  </svg>`,
  // grouped — two header bands, each with two indented items: two
  // distinct groups (vs one header + rows) reads as "grouping" rather
  // than just "list with title".
  grouped: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <rect x="2" y="1.5" width="12" height="2" rx=".4"/>
    <rect x="5" y="4.4" width="9" height="1.3"/>
    <rect x="5" y="6.2" width="9" height="1.3"/>
    <rect x="2" y="8.5" width="12" height="2" rx=".4"/>
    <rect x="5" y="11.4" width="9" height="1.3"/>
    <rect x="5" y="13.2" width="9" height="1.3"/>
  </svg>`,
  // kanban  — three columns with stacked cards, status-board layout
  kanban: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <rect x="1.5" y="2" width="3.8" height="12" rx=".6" fill="none" stroke="currentColor" stroke-width="1"/>
    <rect x="6.1" y="2" width="3.8" height="12" rx=".6" fill="none" stroke="currentColor" stroke-width="1"/>
    <rect x="10.7" y="2" width="3.8" height="12" rx=".6" fill="none" stroke="currentColor" stroke-width="1"/>
    <rect x="2.4" y="3.6" width="2" height="1.4" rx=".2"/>
    <rect x="2.4" y="5.6" width="2" height="1.4" rx=".2"/>
    <rect x="7" y="3.6" width="2" height="1.4" rx=".2"/>
    <rect x="11.6" y="3.6" width="2" height="1.4" rx=".2"/>
    <rect x="11.6" y="5.6" width="2" height="1.4" rx=".2"/>
    <rect x="11.6" y="7.6" width="2" height="1.4" rx=".2"/>
  </svg>`,
  // focus   — large primary card left + three stacked small cards
  // right, mirroring the focus-view layout (one finding centered, a
  // queue of upcoming findings beside it).
  focus: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <rect x="1.5" y="2.5" width="8.5" height="11" rx=".6" fill="none" stroke="currentColor" stroke-width="1"/>
    <rect x="3" y="4.4" width="5.5" height="1"/>
    <rect x="3" y="6.4" width="5.5" height="1"/>
    <rect x="3" y="8.4" width="3.5" height="1"/>
    <rect x="11.2" y="2.5" width="3.3" height="2.5" rx=".4" fill="currentColor" opacity=".55"/>
    <rect x="11.2" y="5.7" width="3.3" height="2.5" rx=".4" fill="currentColor" opacity=".35"/>
    <rect x="11.2" y="8.9" width="3.3" height="2.5" rx=".4" fill="currentColor" opacity=".22"/>
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
  focus:   'Focus view (one finding centered + a queue of next findings)',
  kanban:  'Kanban board, columns grouped by triage status',
  graph:   'Graph view (canvas with imports / exports)',
}

const MODES = ['table', 'list', 'grouped', 'focus', 'kanban', 'graph']

class ViewModeButtons extends StateElement {
  static properties = {
    // Comma-separated subset of MODES to expose. Defaults to all of
    // them; the Files tab passes "table,list" since the other layouts
    // don't apply there.
    modes: { type: String },
    // Which state slot the host is wiring up — drives both which slice
    // the active highlight reads (`state.viewMode` vs
    // `state.filesViewMode`) AND which slot `view-mode-change` writes.
    kind: { type: String },
  }

  // Light DOM so toolbar.css's `view-mode-buttons` (bordered icon-group
  // chrome) and per-button `.view-mode-btn` rules apply directly to the
  // child buttons. Same pattern as `<severity-chips>` / `<triage-filter>`.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.modes = MODES.join(',')
    this.kind = 'findings'
  }

  connectedCallback() {
    super.connectedCallback()
    ensureHostAria(this, { role: 'group', 'aria-label': 'View mode' })
  }

  render() {
    // Read via StateElement's autorun — mutating the slot in events.js
    // re-renders just this element, no `mode` prop needed.
    const current = this.kind === 'files' ? state.filesViewMode : state.viewMode
    const allowed = this.modes.split(',').map((s) => s.trim()).filter((s) => MODES.includes(s))
    const list = allowed.length > 0 ? allowed : MODES
    // No leading "View:" label — the icons + tooltips carry the
    // affordance, and dropping it lets the sort dropdown sit flush
    // against the icon group.
    return html`${list.map((m) => html`<button
      type="button"
      class=${classMap({ 'view-mode-btn': true, active: current === m })}
      title=${VIEW_TITLES[m]}
      aria-label=${VIEW_TITLES[m]}
      aria-pressed=${String(current === m)}
      @click=${() => this._select(m, current)}
    >${VIEW_ICONS[m]}</button>`)}`
  }

  _select(mode, current) {
    if (mode === current) return
    this.dispatchEvent(new CustomEvent('view-mode-change', {
      detail: { mode, kind: this.kind },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('view-mode-buttons', ViewModeButtons)
