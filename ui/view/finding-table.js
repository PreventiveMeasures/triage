// `<finding-table>` — the table view's rows (`items`, the dedup groups) and
// selection (`selectedGid`): the glass-card wrapper around one
// `<finding-row>` per group, each handling its own clicks (events.js holds
// the delegate).
import { LitElement, html, unsafeCSS } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { groupKey } from './group.js'
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

  // Keyed by gid, so a re-sort or filter moves the rows rather than
  // handing each a neighbour's group: an unchanged row skips re-rendering.
  render() {
    return html`${repeat(
      this.items ?? [],
      (g) => groupKey(g),
      (g) => html`<finding-row
        .group=${g}
        ?selected=${groupKey(g) === this.selectedGid}
      ></finding-row>`,
    )}`
  }
}

customElements.define('finding-table', FindingTable)
