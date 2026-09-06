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
// The row's content is built only once the row is within a viewport
// of being seen (view/lazy-render.js): the table holds a row per
// dedup group, thousands for a big report, and building every row's
// shadow tree up front was what made a mode switch or a cleared
// search take seconds. Until then the row is an empty shell at about
// a row's height.
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
import { installShadowTooltipListener } from './tooltip.js'
import { unwatchNearViewport, watchNearViewport } from './lazy-render.js'
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

  // Whether the row's content is (to be) rendered — flipped by the
  // observer's answer in `_onNear`, and back on a reconnect that lands
  // the row out of range. Same shape as `<finding-card>`'s.
  _near = false
  _watching = false

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
    if (!this._near) {
      // Out of range: the row's chrome with nothing in it, at about a
      // row's height (`.row-pending`, finding-row.css). The selection
      // outline still applies — a deep link can select a row before
      // it is built — but the group-derived classes wait for the body:
      // reading the group's triage here would subscribe every unbuilt
      // row to it for a colour nobody can see.
      this.classList.toggle('selected', this.selected)
      return html`<div class="row row-pending" aria-busy="true"></div>`
    }
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
    // The GitHub marks inside carry `data-tooltip`; the shared tooltip
    // (view/tooltip.js) draws it. Its document-level listener can't see
    // in here — `closest` stops at the boundary — so this root gets its
    // own. Idempotent, and reconnects are how this component is used.
    installShadowTooltipListener(this.renderRoot)
    this.addEventListener('click', this._onClick)
    // Ask where the row is, on every connect. The persistent
    // <finding-table> stays connected across steady-state table
    // renders, but a re-sort moves rows (Lit's keyed repeat detaches
    // and re-inserts them) and a view-mode switch detaches the whole
    // table and later re-inserts it: this element disconnects
    // (StateElement disposes its autorun) then reconnects, and the
    // observer's answer is what decides whether it renders again —
    // re-registering a fresh autorun for a row in range, dropping the
    // body of one that is not.
    this._watching = true
    watchNearViewport(this, (near) => this._onNear(near))
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._onClick)
    if (this._watching) {
      unwatchNearViewport(this)
      this._watching = false
    }
    super.disconnectedCallback()
  }

  // See `<finding-card>`'s `_onNear`: in range renders (and re-registers
  // the autorun) and stops watching; out of range on a reconnect drops
  // the body back to the shell.
  _onNear(near) {
    if (near) {
      if (this._watching) {
        unwatchNearViewport(this)
        this._watching = false
      }
      this._near = true
      this.requestUpdate()
    } else if (this._near) {
      this._near = false
      this.requestUpdate()
    }
  }

  // Render now whether or not the row is in range — for the deep-link
  // reveal, which scrolls to the row and wants it at its real height.
  // Resolves once the content is in the DOM. `sync` performs the update
  // before returning, as on `<finding-card>` (see there for why).
  ensureRendered({ sync = false } = {}) {
    if (!this._near) this._onNear(true)
    if (sync && this.isConnected && this.isUpdatePending) this.performUpdate()
    return this.updateComplete
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
