// `<finding-row>` — one table-view row, a Lit component nested in
// `<finding-table>`'s shadow DOM. The host element IS the row:
// group-derived classes plus a `selected` class are reflected onto
// `this.classList`, and `this.dataset.gid` carries the group key
// (events.js's `pathClosest('[data-gid]')` walks composedPath up
// through this host to resolve the targeted row). Inner DOM is built
// by render-finding.js as a string and injected via unsafeHTML.
//
// Reactivity: StateElement wraps render() in an observer-util
// reaction; reads of `state.triage`, `state.activeTabByGroup`,
// `state.showDeleted` (via render-finding.js + group.js helpers)
// auto-track so an invalidating mutation re-renders just this element.
// classList stamping lives inside render so its `state.showDeleted`
// read joins the tracked set; otherwise toggling trash wouldn't update
// the host's `.deleted` class.
//
// Click semantics: a click missing any action button / link / label
// dispatches composed-bubbling `row-select` with the gid; events.js
// toggles `state.tableSelectedGid`. Native button clicks bubble
// composed:true to events.js's `pathClosest` delegate untouched.
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
    // render() runs and re-registers a fresh autorun. render.js
    // detaches and re-inserts the persistent <finding-table> on each
    // render() call: this element disconnects (StateElement disposes
    // its autorun) then reconnects, but if neither `group` nor
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
