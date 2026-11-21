// `<view-mode-buttons>` — the toolbar's View chooser, a button per mode whose
// glyph previews its layout, in the triage workflow's order: the board you
// sort findings on (also the default, state.ts), the one you work them
// through one at a time, the flat layouts, then the graph. The highlight
// follows `state.viewMode` (or `state.filesViewMode` for `kind="files"`)
// through the autorun; the selection is session-local. A click emits
// `view-mode-change`.
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { ensureHostAria } from './host-aria.js'
import { appMarkup } from './markup.js'
import { GRAPH_ICON_SVG } from './icons.js'
import { emit } from './emit.js'

// mode → [icon, title], in button order.
const MODES = {
  // Three columns of stacked cards.
  kanban: [html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <rect x="1.5" y="2" width="3.8" height="12" rx=".6" fill="none" stroke="currentColor" stroke-width="1"/>
    <rect x="6.1" y="2" width="3.8" height="12" rx=".6" fill="none" stroke="currentColor" stroke-width="1"/>
    <rect x="10.7" y="2" width="3.8" height="12" rx=".6" fill="none" stroke="currentColor" stroke-width="1"/>
    <rect x="2.4" y="3.6" width="2" height="1.4" rx=".2"/>
    <rect x="2.4" y="5.6" width="2" height="1.4" rx=".2"/>
    <rect x="7" y="3.6" width="2" height="1.4" rx=".2"/>
    <rect x="11.6" y="3.6" width="2" height="1.4" rx=".2"/>
    <rect x="11.6" y="5.6" width="2" height="1.4" rx=".2"/>
    <rect x="11.6" y="7.6" width="2" height="1.4" rx=".2"/>
  </svg>`, 'Kanban board, columns grouped by triage status'],
  // One finding centered, the queue of next ones beside it.
  focus: [html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <rect x="1.5" y="2.5" width="8.5" height="11" rx=".6" fill="none" stroke="currentColor" stroke-width="1"/>
    <rect x="3" y="4.4" width="5.5" height="1"/>
    <rect x="3" y="6.4" width="5.5" height="1"/>
    <rect x="3" y="8.4" width="3.5" height="1"/>
    <rect x="11.2" y="2.5" width="3.3" height="2.5" rx=".4" fill="currentColor" opacity=".55"/>
    <rect x="11.2" y="5.7" width="3.3" height="2.5" rx=".4" fill="currentColor" opacity=".35"/>
    <rect x="11.2" y="8.9" width="3.3" height="2.5" rx=".4" fill="currentColor" opacity=".22"/>
  </svg>`, 'Focus view (one finding centered + a queue of next findings)'],
  table: [html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <line x1="3" x2="21" y1="9" y2="9"/>
    <line x1="3" x2="21" y1="15" y2="15"/>
    <line x1="9" x2="9" y1="3" y2="21"/>
  </svg>`, 'Table view (compact rows, click a row to expand)'],
  list: [html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <line x1="3" x2="21" y1="6" y2="6"/>
    <line x1="3" x2="21" y1="12" y2="12"/>
    <line x1="3" x2="21" y1="18" y2="18"/>
  </svg>`, 'List view (flat, one card per finding)'],
  // Two header bands with their items: grouping, not a titled list.
  grouped: [html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <rect x="2" y="1.5" width="12" height="2" rx=".4"/>
    <rect x="5" y="4.4" width="9" height="1.3"/>
    <rect x="5" y="6.2" width="9" height="1.3"/>
    <rect x="2" y="8.5" width="12" height="2" rx=".4"/>
    <rect x="5" y="11.4" width="9" height="1.3"/>
    <rect x="5" y="13.2" width="9" height="1.3"/>
  </svg>`, 'List view, grouped by file'],
  graph: [html`${appMarkup(GRAPH_ICON_SVG)}`, 'Graph view (canvas with imports / exports)'],
}
const ALL_MODES = Object.keys(MODES)

class ViewModeButtons extends StateElement {
  static properties = {
    // A comma-separated subset of the modes (the Files tab's "table,list").
    modes: { type: String },
    // Which slot the highlight reads and `view-mode-change` writes.
    kind: { type: String },
  }

  // Light DOM, for toolbar.css's icon-group chrome.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.modes = ALL_MODES.join(',')
    this.kind = 'findings'
  }

  connectedCallback() {
    super.connectedCallback()
    ensureHostAria(this, { role: 'group', 'aria-label': 'View mode' })
  }

  render() {
    const current = this.kind === 'files' ? state.filesViewMode : state.viewMode
    const allowed = this.modes.split(',').map((s) => s.trim()).filter((s) => ALL_MODES.includes(s))
    const list = allowed.length > 0 ? allowed : ALL_MODES
    return html`${list.map((m) => html`<button
      type="button"
      class=${classMap({ 'view-mode-btn': true, active: current === m })}
      aria-label=${MODES[m][1]}
      aria-pressed=${String(current === m)}
      @click=${() => this._select(m, current)}
    >${MODES[m][0]}</button>`)}`
  }

  _select(mode, current) {
    if (mode !== current) emit(this, 'view-mode-change', { mode, kind: this.kind })
  }
}

customElements.define('view-mode-buttons', ViewModeButtons)
