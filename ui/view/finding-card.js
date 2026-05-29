// `<finding-card>` — one dedup-group as a card, used in three places:
// the table view's side-details aside, the grouped-by-file list
// (`.file-body`), and the flat list (`.flat-group`). The host element
// IS the `.finding` card: group-derived classes plus the literal
// `finding` class are reflected onto `this.classList`, and
// `this.dataset.gid` carries the group key (events.js's
// `pathClosest('[data-gid]')` resolves the targeted card from
// action-button clicks).
//
// `inGroup` reflects to `in-group`, telling the shadow stylesheet to
// suppress the in-body `.line-row` — in flat-list mode the parent
// wrapper paints a header with the same info above the card.
//
// Reactivity: StateElement wraps render() in an observer-util
// reaction; state reads in the helpers (state.triage,
// state.activeTabByGroup, state.showDeleted) auto-track so an
// invalidating mutation triggers a targeted re-render. classList
// stamping lives inside render() so its `state.showDeleted` read
// joins the same tracked set.
//
// Click semantics: action buttons bubble composed:true to events.js's
// `pathClosest` delegate. No row-select equivalent — cards don't
// drive a side-details panel.
import { unsafeCSS } from 'lit'
import { StateElement, html } from '@rray/frontend/state-element'
import { findingCardClasses, findingCardGid, findingCardInnerTemplate } from './render-finding.js'
import cardCSS from './finding-card.css'

const MANAGED_HOST_CLASSES = [
  'finding',
  'is-critical',
  'mark-red', 'mark-blue', 'mark-green', 'mark-gray',
  'has-conflict',
  'triage-fixed', 'triage-invalid', 'triage-deleted', 'triage-ignored',
  'multi-case',
]

class FindingCard extends StateElement {
  static properties = {
    group: { attribute: false },
    inGroup: { type: Boolean, attribute: 'in-group', reflect: true },
    // Caller-stamped variant flag — `'focus'` opts into the inlined
    // triage actions + expanded button labels from
    // `findingCardInnerTemplate`. Reflected so the value reaches shadow
    // CSS via `:host([context='focus'])`.
    context: { type: String, reflect: true },
  }

  static styles = unsafeCSS(cardCSS)

  constructor() {
    super()
    this.group = null
    this.inGroup = false
    this.context = null
  }

  render() {
    if (!this.group) return html``
    // Stamp host attributes/classes inside render() so their state
    // reads join StateElement's tracked set and re-render on mutation.
    this.dataset.gid = findingCardGid(this.group)
    const next = new Set(findingCardClasses(this.group))
    for (const c of MANAGED_HOST_CLASSES) this.classList.toggle(c, next.has(c))
    // Visual chrome lives on the inner `.card`, not the host, so
    // theme.css's global `* { padding: 0 }` reset can't override our
    // padding/border via the shadow boundary's outer-wins cascade
    // rule. See finding-card.css.
    return html`<div class="card">${findingCardInnerTemplate(this.group, { context: this.context })}</div>`
  }

  connectedCallback() {
    super.connectedCallback()
    // Force a render on every (re)connect so StateElement re-registers
    // a fresh autorun. Covers render.js recreating these each pass, and
    // a card moved between parents (table-details aside vs file-group
    // body).
    if (this.hasUpdated) this.requestUpdate()
  }
}

customElements.define('finding-card', FindingCard)
