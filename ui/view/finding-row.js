// `<finding-row>` — one row of the table view, inside `<finding-table>`'s
// shadow DOM. The host IS the row: the group-derived classes
// (tableRowClasses) and `selected` go on `this.classList`, and
// `data-gid` names the group for events.js's `pathClosest('[data-gid]')`.
// The inner DOM is render-finding.js's `tableRowInnerTemplate`.
//
// A row's content is built only once it is within a viewport of being seen
// (view/lazy-render.js): thousands of rows built up front made a mode
// switch or a cleared search take seconds. Until then it is an empty shell
// about a row high.
//
// StateElement tracks the state reads of render() — the class stamping
// included, on purpose, so a triage view switch updates the host's
// `.triage-*` class. A click outside an action button / link / label
// dispatches a composed `row-select(detail.gid)`; the buttons' own clicks
// reach events.js's delegate unaided.
import { unsafeCSS } from 'lit'
import { StateElement, html } from '@rray/frontend/state-element'
import { installShadowTooltipListener } from './tooltip.js'
import { NearViewport } from './lazy-render.js'
import { groupKey } from './group.js'
import { tableRowClasses, tableRowInnerTemplate } from './render-finding.js'
import rowCSS from './finding-row.css'
import marksCSS from './finding-marks.css'
import tabsCSS from './finding-tabs.css'
import fileIconsCSS from '../styles/file-icon.css'
import reportButtonCSS from '../styles/report-button.css'
import actionsCSS from './finding-actions.css'

// Every class this component might put on the host, so a toggle removes
// one that no longer applies.
const MANAGED_HOST_CLASSES = [
  'is-critical',
  'mark-red', 'mark-blue', 'mark-green', 'mark-gray',
  'has-conflict',
  'triage-inprogress', 'triage-fixed', 'triage-invalid', 'triage-deleted', 'triage-ignored',
  'selected',
]

class FindingRow extends NearViewport(StateElement) {
  static properties = {
    group: { attribute: false },
    selected: { type: Boolean },
  }

  static styles = [unsafeCSS(fileIconsCSS), unsafeCSS(reportButtonCSS), unsafeCSS(marksCSS), unsafeCSS(rowCSS), unsafeCSS(actionsCSS), unsafeCSS(tabsCSS)]

  // Always waits for the viewport (NearViewport).
  lazy = true

  constructor() {
    super()
    this.group = null
    this.selected = false
  }

  render() {
    if (!this.group) return html``
    // Host stamping inside render(), so its state reads join the tracked
    // set: StateElement wraps render alone, not willUpdate.
    this.dataset.gid = groupKey(this.group)
    if (!this._near) {
      // The shell (`.row-pending`) keeps the selection outline — a deep
      // link can select a row before it is built — but not the group's
      // classes: reading its triage would subscribe every unbuilt row.
      this.classList.toggle('selected', this.selected)
      return html`<div class="row row-pending" aria-busy="true"></div>`
    }
    const next = new Set(tableRowClasses(this.group))
    if (this.selected) next.add('selected')
    for (const c of MANAGED_HOST_CLASSES) this.classList.toggle(c, next.has(c))
    // The chrome is on the inner `.row`: theme.css's global `* { padding: 0 }`
    // would win over the host's across the shadow boundary.
    return html`<div class="row">${tableRowInnerTemplate(this.group)}</div>`
  }

  connectedCallback() {
    super.connectedCallback()
    // The GitHub marks' `data-tooltip`s: the document-level listener can't
    // see into this root. Idempotent across reconnects.
    installShadowTooltipListener(this.renderRoot)
    this.addEventListener('click', this._onClick)
    // Asked on every connect: a re-sort or a view-mode switch detaches and
    // re-inserts rows (StateElement disposing the autorun), and the answer
    // decides whether one renders again or drops back to its shell.
    this._watchNear(this)
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick)
    super.disconnectedCallback()
  }

  _onClick = (e) => {
    if (e.composedPath().some((el) => el?.matches?.('a, button, label'))) return
    if (!this.dataset.gid) return
    this.dispatchEvent(new CustomEvent('row-select', { detail: { gid: this.dataset.gid }, bubbles: true, composed: true }))
  }
}

customElements.define('finding-row', FindingRow)
