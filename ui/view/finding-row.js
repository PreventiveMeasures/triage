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
// Click semantics: a click anywhere on the row that didn't land on
// an action button / link / label dispatches a composed-bubbling
// `row-select` CustomEvent with the gid; events.js listens on
// `report` and toggles `state.tableSelectedGid`. Native button
// clicks (`.tab`, `.mark-dot`, `.mark-x`, `.mark-restore`) bubble
// out composed:true and reach events.js's `pathClosest`-based
// delegate without intervention from this component.
import { LitElement, html, unsafeCSS } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { tableRowGid, tableRowClasses, tableRowInnerHTML } from './render-finding.js'
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
  'deleted',
  'selected',
]

class FindingRow extends LitElement {
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

  willUpdate() {
    if (!this.group) return
    this.dataset.gid = tableRowGid(this.group)
    const next = new Set(tableRowClasses(this.group))
    if (this.selected) next.add('selected')
    for (const c of MANAGED_HOST_CLASSES) this.classList.toggle(c, next.has(c))
  }

  render() {
    if (!this.group) return html``
    return html`${unsafeHTML(tableRowInnerHTML(this.group))}`
  }

  connectedCallback() {
    super.connectedCallback()
    this.addEventListener('click', this._onClick)
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
