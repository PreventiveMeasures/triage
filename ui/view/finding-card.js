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
// observer-util reaction. State reads inside the helpers
// (state.triage, state.activeTabByGroup, state.showDeleted) get
// auto-tracked, so a mutation that invalidates the card triggers a
// targeted re-render. The classList stamping happens inside render()
// so its `state.showDeleted` read joins the same tracked set.
//
// Click semantics: action buttons (`.tab`, `.mark-dot`, `.mark-x`,
// `.mark-restore`) bubble out composed:true and reach events.js's
// `pathClosest`-based delegate. No row-select equivalent — cards
// don't drive a side-details panel.
import { unsafeCSS } from 'lit'
import { StateElement, html } from '@rray/frontend/state-element'
import { findingCardClasses, findingCardGid, findingCardInnerTemplate } from './render-finding.js'
import cardCSS from './finding-card.css'

const MANAGED_HOST_CLASSES = [
  'finding',
  'is-critical',
  'mark-red', 'mark-blue', 'mark-green', 'mark-gray',
  'has-conflict',
  'triage-inprogress', 'triage-fixed', 'triage-invalid', 'triage-deleted', 'triage-ignored',
  'multi-case',
]

class FindingCard extends StateElement {
  static properties = {
    group: { attribute: false },
    inGroup: { type: Boolean, attribute: 'in-group', reflect: true },
    // Caller-stamped variant flag — `'focus'` opts into the inlined
    // triage actions + expanded button labels variants emitted by
    // `findingCardInnerTemplate`. Reflected so the same value reaches
    // the shadow CSS via `:host([context='focus'])`.
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
    // Stamp host attributes/classes inside render() so the state reads
    // (state.showDeleted via findingCardClasses, state.triage /
    // state.deletedIds via findingCardInnerHTML) join StateElement's
    // tracked set and re-render on mutation.
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
    // Force a render after every (re)connect so StateElement's wrapped
    // render() runs and re-registers a fresh autorun. Lit's keyed
    // repeat keeps cards connected across steady-state list renders,
    // but view-mode switches rebuild them and a card can move between
    // parents (e.g. table-details aside vs. file-group body) —
    // reconnects where Lit wouldn't re-render on its own when `group`
    // didn't change.
    if (this.hasUpdated) this.requestUpdate()
  }
}

customElements.define('finding-card', FindingCard)
