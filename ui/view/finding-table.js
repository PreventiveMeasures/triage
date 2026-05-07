// `<finding-table>` — table-view rows + selection container, owned as
// a Lit component instead of a raw `<div class="finding-table">`
// baked into render.js. Takes the dedup groups via the `items`
// property and the active selection via `selectedGid`; each row is a
// `<finding-row>` Lit child (see view/finding-row.js) that owns its
// own click handling and dispatches a composed-bubbling `row-select`
// event when clicked outside an action button. This component is
// just the glass-card wrapper + the row layout; the click delegate
// lives in events.js.
import { LitElement, html, unsafeCSS } from 'lit'
import { tableRowGid } from './render-finding.js'
import './finding-row.js'
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
      (g) => html`<finding-row
        .group=${g}
        ?selected=${tableRowGid(g) === this.selectedGid}
      ></finding-row>`,
    )}`
  }
}

customElements.define('finding-table', FindingTable)
