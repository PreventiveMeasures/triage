// `<finding-card>` — one dedup-group rendered as a card. Used in
// three places: the table view's side details aside, the
// grouped-by-file list (inside `<div class="file-body">`), and the
// flat list (inside `<div class="flat-group">`). The host element
// IS the `.finding` card: classes derived from the dedup group
// (`is-critical`, `mark-{red|blue|green|gray}`, `has-conflict`,
// `deleted`, `multi-case`) plus the literal `finding` class are
// reflected onto `this.classList`, and `this.dataset.gid` carries
// the group key (events.js's `pathClosest('[data-gid]')` finds the
// targeted card from action-button clicks).
//
// `inGroup` reflects to the `in-group` attribute and tells the
// shadow stylesheet to suppress the in-body `.line-row` — the parent
// flat-group wrapper paints a header above the card with the same
// info. Used only by the flat list mode.
//
// Reactivity: extends StateElement, which wraps render() in an
// observer-util reaction. Reads of state inside the helpers
// (state.markers, state.deletedIds, state.activeTabByGroup,
// state.showDeleted) get auto-tracked, so a mutation that
// invalidates the card triggers a targeted re-render. The
// classList stamping happens inside render() so its
// `state.showDeleted` read joins the same tracked set.
//
// Click semantics: action buttons (`.tab`, `.mark-dot`, `.mark-x`,
// `.mark-restore`) bubble out composed:true and reach events.js's
// `pathClosest`-based delegate. No row-select equivalent — cards
// don't drive a side-details panel.
import { html, unsafeCSS } from 'lit'
import { StateElement } from '../../rray-modules/frontend/state-element.mjs'
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
  }

  static styles = unsafeCSS(cardCSS)

  constructor() {
    super()
    this.group = null
    this.inGroup = false
  }

  render() {
    if (!this.group) return html``
    // Stamp host attributes/classes inside render() so the state
    // reads (state.showDeleted via findingCardClasses, state.markers
    // / state.deletedIds via findingCardInnerHTML) join StateElement's
    // tracked set and trigger a re-render on mutation.
    this.dataset.gid = findingCardGid(this.group)
    const next = new Set(findingCardClasses(this.group))
    for (const c of MANAGED_HOST_CLASSES) this.classList.toggle(c, next.has(c))
    // Visual chrome is on the inner `.card` wrapper rather than the
    // host so the global `* { padding: 0 }` reset in theme.css can't
    // override our padding/border via the shadow boundary's
    // outer-wins-over-inner cascade rule. See finding-card.css.
    return html`<div class="card">${findingCardInnerTemplate(this.group)}</div>`
  }

  connectedCallback() {
    super.connectedCallback()
    // Force a render after every (re)connect so StateElement's
    // wrapped render() runs and a fresh autorun gets registered.
    // render.js recreates these elements on every render() call;
    // this also covers the case of a card being moved between
    // parents (e.g. table-details aside vs. file-group body).
    if (this.hasUpdated) this.requestUpdate()
  }
}

customElements.define('finding-card', FindingCard)
