// `<finding-card>`: one dedup group as a card, in the table's details, the
// grouped list and the flat list. The host is the `.finding` card, its
// group's classes (findingCardClasses) stamped on it and `data-gid`
// naming it for events.js's delegate, which the action buttons' composed
// clicks reach. `inGroup` (`in-group`) hides the in-body `.line-row` under
// the flat list's header. A StateElement: the state its render reads is
// tracked, so a change to it re-renders the card alone.
import { unsafeCSS } from 'lit'
import { StateElement, html } from '@rray/frontend/state-element'
import { installShadowTooltipListener } from './tooltip.js'
import { unwatchNearViewport, watchNearViewport } from './lazy-render.js'
import { groupKey } from './group.js'
import { findingCardClasses, findingCardInnerTemplate } from './render-finding.js'
import { revealCitedLines } from './reveal-cited.js'
import cardCSS from './finding-card.css'
import quoteCSS from '../styles/md-quote.css'
import marksCSS from './finding-marks.css'
import tabsCSS from './finding-tabs.css'
import fileIconsCSS from '../styles/file-icon.css'
import reportButtonCSS from '../styles/report-button.css'
import actionsCSS from './finding-actions.css'
import codeTokensCSS from '../styles/code-tokens.css'
import managedCommentCSS from './managed-comment.css'

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
    // `'focus'` for the focus view's labelled actions, reflected for
    // `:host([context='focus'])`.
    context: { type: String, reflect: true },
    // The body rendered only once the card nears the viewport (the lists,
    // render.js findingCardPlaceholder); eager on the single-card surfaces.
    lazy: { type: Boolean },
  }

  // Shared with table rows (tabs), the export preview (Prism tokens) and
  // the prose dialogs (quotes and alerts).
  static styles = [unsafeCSS(fileIconsCSS), unsafeCSS(reportButtonCSS), unsafeCSS(marksCSS), unsafeCSS(cardCSS), unsafeCSS(quoteCSS), unsafeCSS(actionsCSS), unsafeCSS(tabsCSS), unsafeCSS(codeTokensCSS), unsafeCSS(managedCommentCSS)]

  // Whether a lazy card's body is rendered (_onNear); not reactive, as the
  // flip requests its own update.
  _near = false
  // What the observer watches for it, kept to unwatch: a detached card can
  // no longer find its wrapper.
  _watched = null

  constructor() {
    super()
    this.group = null
    this.inGroup = false
    this.context = null
    this.lazy = false
  }

  render() {
    if (!this.group) return html``
    // Stamped in render(), so the state these read is tracked with it.
    this.dataset.gid = groupKey(this.group)
    if (this.lazy && !this._near) {
      // Out of range: an empty shell reading no state, so a change elsewhere
      // costs it nothing; `.card-pending` holds a card's height.
      this.classList.add('finding')
      return html`<div class="card card-pending" aria-busy="true"></div>`
    }
    const next = new Set(findingCardClasses(this.group))
    for (const c of MANAGED_HOST_CLASSES) this.classList.toggle(c, next.has(c))
    // The chrome on the inner `.card`, which theme.css's global
    // `* { padding: 0 }` can't override across the shadow boundary.
    return html`<div class="card">${findingCardInnerTemplate(this.group, { context: this.context })}</div>`
  }

  // A source preview taller than its cap scrolled to its cited lines
  // (reveal-cited.js), after the paint that drew them. On every pass, as its
  // content arrives in stages that can move the scroll; but only while it
  // sits where it was put (`revealedTo`), else the reader scrolled it.
  updated() {
    // The list's headers may show only once the body is in the DOM.
    this.classList.toggle('content-ready', !!this.group && (!this.lazy || this._near))
    for (const preview of this.renderRoot.querySelectorAll('.code-preview')) {
      const ours = preview.dataset.revealedTo
      if (ours !== undefined && Math.round(preview.scrollTop) !== Number(ours)) continue
      const cited = preview.querySelectorAll('.code-preview-lineno.cited')
      if (cited.length === 0) continue
      revealCitedLines(preview, cited)
      preview.dataset.revealedTo = String(Math.round(preview.scrollTop))
    }
  }

  connectedCallback() {
    super.connectedCallback()
    // Its own tooltip listener: the document's `closest` stops at the
    // shadow boundary. Idempotent.
    installShadowTooltipListener(this.renderRoot)
    if (this.lazy) {
      // The flat list's `.flat-group` wrapper has the box while skipped
      // (`content-visibility`). Asked afresh on every connect: a keyed
      // `repeat` moves a card by reinserting it, perhaps far from view.
      this._watched = this.closest('.flat-group') ?? this
      watchNearViewport(this._watched, (near) => this._onNear(near))
      return
    }
    // Rendered again on every reconnect, so StateElement registers a fresh
    // autorun where Lit, `group` unchanged, wouldn't update.
    if (this.hasUpdated) this.requestUpdate()
  }

  disconnectedCallback() {
    if (this._watched) {
      unwatchNearViewport(this._watched)
      this._watched = null
    }
    super.disconnectedCallback()
  }

  // In range: the body rendered (on a reconnect, its autorun registered
  // again) and kept, unwatched, while connected. Out of range on a
  // reconnect: back to the shell, so a sort costs no more than the viewport.
  _onNear(near) {
    if (near) {
      if (this._watched) {
        unwatchNearViewport(this._watched)
        this._watched = null
      }
      this._near = true
      this.requestUpdate()
    } else if (this._near) {
      this._near = false
      this.requestUpdate()
    }
  }

  // The body rendered now, in range or not, for print and the deep-link
  // reveal; resolves once it is in the DOM. `sync` performs the update on
  // the spot: a `beforeprint` handler can't await, and the browser may
  // snapshot as it returns.
  ensureRendered({ sync = false } = {}) {
    if (this.lazy && !this._near) this._onNear(true)
    if (sync && this.isConnected && this.isUpdatePending) this.performUpdate()
    return this.updateComplete
  }
}

customElements.define('finding-card', FindingCard)
