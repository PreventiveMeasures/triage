// `<finding-table>` — table-view rows + selection container. Each row
// is a `<finding-row>` Lit child dispatching composed-bubbling
// `row-select`; the click delegate lives in events.js.
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
    // Keyed by gid via `repeat`: on reorder Lit moves existing
    // <finding-row> elements rather than reassigning `group`, so
    // unchanged rows skip re-rendering. Default `.map()` matches by
    // position and would dirty every row whose neighbour shifted.
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
