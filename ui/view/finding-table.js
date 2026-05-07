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
import { repeat } from 'lit/directives/repeat.js'
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
    // Keyed by gid via lit's `repeat` directive: when the items list
    // reorders (sort change, filter add/remove) Lit moves the existing
    // <finding-row> elements to the new positions instead of swapping
    // their `group` property — each row stays associated with its
    // group, so unchanged rows skip re-rendering. Without the key,
    // the default `.map()` matches by position and would dirty every
    // row whose neighbour shifted.
    return html`${repeat(
      this.items ?? [],
      (g) => tableRowGid(g),
      (g) => html`<finding-row
        .group=${g}
        ?selected=${tableRowGid(g) === this.selectedGid}
      ></finding-row>`,
    )}`
  }
}

customElements.define('finding-table', FindingTable)
