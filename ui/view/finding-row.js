// `<finding-row>` — one row of the table view, owned as a Lit
// component nested inside `<finding-table>`'s shadow DOM. The host
// element IS the row: classes derived from the dedup group
// (`is-critical`, `mark-{red|blue|green|gray}`, `has-conflict`,
// `deleted`) plus a `selected` class driven by the `selected`
// property are reflected onto `this.classList`, and `this.dataset.gid`
// carries the group key (events.js's `pathClosest('[data-gid]')`
// walks the composedPath up through this host to identify the
// targeted row from action-button clicks). Inner DOM (badge, title
// + meta + optional tab strip, action buttons) is built by
// render-finding.js as an HTML string and injected via unsafeHTML.
//
// Reactivity: extends StateElement, which wraps render() in an
// observer-util reaction. Reads of `state.triage`,
// `state.activeTabByGroup`, `state.showDeleted` during render — via
// the helpers in render-finding.js + group.js — are auto-tracked, so
// a mutation that invalidates the row re-renders just this element.
// The classList stamping is intentionally inside render so its
// `state.showDeleted` read joins the same tracked set; otherwise
// toggling trash wouldn't update the host's `.deleted` class.
//
// Click semantics: a click anywhere on the row that didn't land on
// an action button / link / label dispatches a composed-bubbling
// `row-select` CustomEvent with the gid; events.js listens on
// `report` and toggles `state.tableSelectedGid`. Native button
// clicks (`.tab`, `.mark-dot`, `.mark-x`, `.mark-restore`) bubble
// out composed:true and reach events.js's `pathClosest`-based
// delegate without intervention from this component.
import { unsafeCSS } from 'lit'
import { StateElement, html } from '@rray/frontend/state-element'
import { tableRowClasses, tableRowGid, tableRowInnerTemplate } from './render-finding.js'
import rowCSS from './finding-row.css'

// Every class this component might apply to the host. Listed
// explicitly so `classList.toggle(c, …)` cleanly removes any that no
// longer applies after the group's state changes (e.g. switching
// colors mid-render). `selected` comes from the `selected` property;
// the rest from tableRowClasses().
const MANAGED_HOST_CLASSES = [
  'is-critical',
  'mark-red', 'mark-blue', 'mark-green', 'mark-gray',
  'has-conflict',
  'triage-inprogress', 'triage-fixed', 'triage-invalid', 'triage-deleted', 'triage-ignored',
  'selected',
]

class FindingRow extends StateElement {
  static properties = {
    group: { attribute: false },
    selected: { type: Boolean },
  }

  static styles = unsafeCSS(rowCSS)

  constructor() {
    super()
    this.group = null
    this.selected = false
  }

  render() {
    if (!this.group) return html``
    // Stamp host attributes/classes inside render() so the state reads
    // (e.g. state.showDeleted via tableRowClasses, state.markers /
    // state.deletedIds via tableRowInnerHTML) join StateElement's
    // tracked set and re-render on mutation. willUpdate would skip the
    // autorun entirely, since StateElement only wraps render.
    this.dataset.gid = tableRowGid(this.group)
    const next = new Set(tableRowClasses(this.group))
    if (this.selected) next.add('selected')
    for (const c of MANAGED_HOST_CLASSES) this.classList.toggle(c, next.has(c))
    // Visual chrome lives on the inner `.row`, not the host, so
    // theme.css's global `* { padding: 0 }` reset can't override our
    // padding/border via the shadow boundary's outer-wins cascade
    // rule. See finding-row.css.
    return html`<div class="row">${tableRowInnerTemplate(this.group)}</div>`
  }

  connectedCallback() {
    super.connectedCallback()
    this.addEventListener('click', this._onClick)
    // Force a render after every (re)connect so StateElement's wrapped
    // render() runs and re-registers a fresh autorun. The persistent
    // <finding-table> stays connected across steady-state table
    // renders, but a view-mode / shape switch detaches and later
    // re-inserts it: this element disconnects (StateElement disposes
    // its autorun) then reconnects, and if neither `group` nor
    // `selected` changed Lit wouldn't call render on its own and
    // reactivity would silently break.
    if (this.hasUpdated) this.requestUpdate()
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick)
    super.disconnectedCallback()
  }

  _onClick = (e) => {
    const path = e.composedPath()
    if (path.some((el) => el?.matches?.('a, button, label'))) return
    if (!this.dataset.gid) return
    this.dispatchEvent(new CustomEvent('row-select', {
      detail: { gid: this.dataset.gid },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('finding-row', FindingRow)
