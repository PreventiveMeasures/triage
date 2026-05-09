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
// observer-util reaction. Reads of `state.markers`, `state.deletedIds`,
// `state.activeTabByGroup`, `state.showDeleted` performed during
// render — via the helpers in render-finding.js + group.js — are
// auto-tracked, and a mutation that invalidates the row triggers a
// targeted re-render of just this element. The classList stamping
// is intentionally done inside render so its `state.showDeleted`
// read joins the same tracked set; otherwise toggling trash would
// fail to update the host's `.deleted` class.
//
// Click semantics: a click anywhere on the row that didn't land on
// an action button / link / label dispatches a composed-bubbling
// `row-select` CustomEvent with the gid; events.js listens on
// `report` and toggles `state.tableSelectedGid`. Native button
// clicks (`.tab`, `.mark-dot`, `.mark-x`, `.mark-restore`) bubble
// out composed:true and reach events.js's `pathClosest`-based
// delegate without intervention from this component.
import { html, unsafeCSS } from 'lit'
import { StateElement } from '../../rray-modules/frontend/state-element.mjs'
import { tableRowClasses, tableRowGid, tableRowInnerTemplate } from './render-finding.js'
import rowCSS from './finding-row.css'

// Every class this component might apply to the host. Listed
// explicitly so `classList.toggle(c, …)` cleanly removes any class
// that no longer applies after the group's state changes (e.g.
// switching colors mid-render). `selected` is driven by the
// `selected` property; the rest come from tableRowClasses().
const MANAGED_HOST_CLASSES = [
  'is-critical',
  'mark-red', 'mark-blue', 'mark-green', 'mark-gray',
  'has-conflict',
  'triage-fixed', 'triage-invalid', 'triage-deleted', 'triage-ignored',
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
    // Stamp host attributes/classes inside render() so the state
    // reads (e.g. state.showDeleted via tableRowClasses,
    // state.markers / state.deletedIds via tableRowInnerHTML) join
    // StateElement's tracked set and trigger a re-render on
    // mutation. Doing this in willUpdate would skip the autorun
    // entirely, since StateElement only wraps render.
    this.dataset.gid = tableRowGid(this.group)
    const next = new Set(tableRowClasses(this.group))
    if (this.selected) next.add('selected')
    for (const c of MANAGED_HOST_CLASSES) this.classList.toggle(c, next.has(c))
    // Visual chrome is on the inner `.row` wrapper rather than the
    // host so the global `* { padding: 0 }` reset in theme.css can't
    // override our padding/border via the shadow boundary's
    // outer-wins-over-inner cascade rule. See finding-row.css.
    return html`<div class="row">${tableRowInnerTemplate(this.group)}</div>`
  }

  connectedCallback() {
    super.connectedCallback()
    this.addEventListener('click', this._onClick)
    // Force a render after every (re)connect so StateElement's
    // wrapped render() runs and a fresh autorun gets registered.
    // Necessary because render.js detaches and re-inserts the
    // persistent <finding-table> on each render() call: this
    // element disconnects (StateElement disposes its autorun) then
    // reconnects, but if neither `group` nor `selected` changed Lit
    // wouldn't call render again on its own and reactivity would
    // silently break.
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
