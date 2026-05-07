// `<finding-table>` — table-view rows + selection, owned as a Lit
// component instead of a raw `<div class="finding-table">` baked into
// render.js. Takes the dedup groups via the `items` property and the
// active selection via `selectedGid`. Row HTML still comes out of
// renderTableRow (it produces the badge / marks / tabs structure
// shared with the rest of the codebase) and is injected via the
// unsafeHTML directive — the styles live next door in
// finding-table.css and ship inside this component's shadow DOM.
//
// Click semantics:
//  - Action buttons inside rows (`.mark-dot`, `.mark-x`,
//    `.mark-restore`, `.tab`) keep their native click bubble. Native
//    click events are composed:true, so they cross the shadow
//    boundary and reach the global delegate in events.js, which now
//    walks event.composedPath() rather than e.target.closest() so the
//    retargeted target doesn't hide the inner element.
//  - Click on the row itself (anything not a button / link) dispatches
//    a composed-bubbling `row-select` CustomEvent carrying the gid;
//    events.js listens for that and toggles state.tableSelectedGid.
import { LitElement, html, unsafeCSS } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { renderTableRow } from './render-finding.js'
import tableCSS from './finding-table.css'

class FindingTable extends LitElement {
  static properties = {
    items: { attribute: false },
    selectedGid: { attribute: false },
  }

  static styles = unsafeCSS(tableCSS)

  constructor() {
    super()
    this.items = []
    this.selectedGid = null
  }

  render() {
    return html`${(this.items ?? []).map(
      (g) => html`${unsafeHTML(renderTableRow(g, { selectedGid: this.selectedGid }))}`,
    )}`
  }

  connectedCallback() {
    super.connectedCallback()
    this.addEventListener('click', this._onClick)
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick)
    super.disconnectedCallback()
  }

  // Row-selection click: matches the previous behaviour from
  // events.js — closest .finding-row, ignoring clicks that landed on
  // an action button / link / label. composedPath finds the inner
  // element even though e.target retargets to the host on bubble.
  _onClick = (e) => {
    const path = e.composedPath()
    const isButton = path.some((el) => el?.matches?.('a, button, label'))
    if (isButton) return
    const row = path.find((el) => el?.classList?.contains?.('finding-row'))
    if (!row) return
    const gid = row.dataset.gid
    if (!gid) return
    this.dispatchEvent(new CustomEvent('row-select', {
      detail: { gid },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('finding-table', FindingTable)
