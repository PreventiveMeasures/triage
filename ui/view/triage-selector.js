// `<triage-selector>` — In progress / Fixed / Invalid / Deleted
// (+ Ignored for the findings tab) bucket-switcher buttons, shared by the findings
// toolbar, the graph topbar, and the Packages / Repositories page
// toolbars. All read `state.shownTriage` and emit the same button
// shape; variants differ only in an extra marker class
// (`graph2-triage-selector` or `packages-triage-selector`) that
// events.js uses to route the click to a teardown-aware path (graph
// variant tears down the canvas before re-rendering) rather than the
// plain render() flow.
//
// Reactivity: extends StateElement, so reads of `state.shownTriage`
// inside render() are tracked by observer-util — the active
// highlight self-syncs without the host re-passing a `shown` prop.
// Counts still arrive via `counts` because computing them requires
// the filter-pipeline output the parent already has.
//
// Returns `nothing` when there is nothing to switch to (zero counts
// AND no active bucket) so the host can drop it in unconditionally
// and let the component decide its own visibility. The bordered-pill
// shell layout lives on the `triage-selector` element selector in
// toolbar.css; the buttons render as direct children of the host.
//
// Properties (`attribute: false` — passed by reference via Lit's
// `.prop=${...}` property binding; no attribute reflection):
//   * `counts` — `{ inprogress?, fixed?, invalid?, deleted?, ignored? }`.
//                Missing or zero buckets render no button.
//   * `states` — array picking which buckets the selector renders.
//                Defaults to all five; Packages / Repositories pass
//                `['inprogress', 'fixed', 'invalid', 'deleted']` because
//                ignore is per-report and treated as untriaged in those
//                views.
//
// Attributes:
//   * `variant` — adds an extra class onto the host element so
//                 events.js can route the click correctly:
//                   `graph`    → `.graph2-triage-selector`
//                   `packages` → `.packages-triage-selector`
//                 Empty (default, findings toolbar) → no extra class.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { ensureHostAria } from './host-aria.js'
import { state } from '#client/index.js'

const DEFAULT_STATES = ['inprogress', 'fixed', 'invalid', 'deleted', 'ignored']
const VARIANT_CLASS = {
  graph:    'graph2-triage-selector',
  packages: 'packages-triage-selector',
}

// Display labels for bucket keys that don't title-case cleanly from
// the key alone (multi-word). Everything else falls back to
// capitalize-first-letter so single-word keys need no entry here.
const STATE_LABELS = { inprogress: 'In progress' }
const labelFor = (s) => STATE_LABELS[s] ?? (s.charAt(0).toUpperCase() + s.slice(1))

class TriageSelector extends StateElement {
  static properties = {
    counts:  { attribute: false },
    states:  { attribute: false },
    variant: { type: String },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.counts = {}
    this.states = null
    this.variant = ''
  }

  connectedCallback() {
    super.connectedCallback()
    ensureHostAria(this, { role: 'group', 'aria-label': 'Triage view' })
  }

  render() {
    const states = this.states ?? DEFAULT_STATES
    const total = states.reduce((n, s) => n + (this.counts[s] ?? 0), 0)
    // Variant marker class lives on the HOST element so events.js can
    // distinguish graph-variant clicks (canvas teardown path) from
    // toolbar-variant clicks (plain render). Unknown variants would
    // silently drop the marker class and mis-route — warn in dev so
    // typos surface rather than reading as a subtle interaction bug.
    const extra = this.variant ? VARIANT_CLASS[this.variant] : null
    if (this.variant && extra === undefined) {
      console.warn(`<triage-selector>: unknown variant ${JSON.stringify(this.variant)}; ` +
        `expected one of ${Object.keys(VARIANT_CLASS).map((k) => JSON.stringify(k)).join(', ')} or "".`)
    }
    for (const cls of Object.values(VARIANT_CLASS)) this.classList.toggle(cls, cls === extra)
    // Self-hide the host (it carries the bordered-pill chrome in toolbar.css)
    // when there are no buckets to render — otherwise an empty bordered box
    // lingers in the toolbar. Light-DOM host (createRenderRoot returns this),
    // so a class toggle is more reliable than `:empty` (Lit leaves part-marker
    // comment nodes behind when the template is `nothing`).
    const isEmpty = total === 0 && !state.shownTriage
    this.classList.toggle('is-empty', isEmpty)
    if (isEmpty) return nothing
    return html`${states.map((s) => {
      const n = this.counts[s] ?? 0
      const active = state.shownTriage === s
      // Hidden when the bucket is empty AND not the current view —
      // so the user can always click the active button to exit
      // its bucket even when the count drops mid-session.
      if (n === 0 && !active) return nothing
      const label = labelFor(s)
      return html`<button
        type="button"
        class=${classMap({ 'triage-state-btn': true, [`triage-state-${s}`]: true, active })}
        data-triage-show=${s}
        title=${active ? `Exit ${label.toLowerCase()} view` : `Show ${label.toLowerCase()} (${n})`}
        aria-pressed=${String(active)}
      >${label} (${n})</button>`
    })}`
  }
}

customElements.define('triage-selector', TriageSelector)
