// `<triage-selector>` — Fixed / Invalid / Deleted (+ Ignored for the
// findings tab) bucket-switcher buttons. Consolidates four near-
// duplicate inline templates (the findings toolbar in render.js, the
// graph topbar in graph/render.js, and the Packages / Repositories
// page toolbars in render-packages.js / render-repositories.js).
// All four read `state.shownTriage` and emit the same button shape;
// the variants differed only in an extra marker class
// (`graph2-triage-selector` or `packages-triage-selector`) that
// events.js uses to route the click to a teardown-aware path
// (graph variant tears down the canvas before re-rendering) rather
// than the plain render() flow.
//
// Reactivity: extends StateElement, so reads of `state.shownTriage`
// inside render() are tracked by observer-util — the active
// highlight self-syncs without the host re-passing a `shown` prop.
// Counts still arrive via `counts` because computing them requires
// the filter-pipeline output the parent already has.
//
// Returns `nothing` when there is nothing to switch to (zero counts
// AND no active bucket) so the host can drop it in unconditionally
// and let the component decide its own visibility. Pair with
// `triage-selector { display: contents }` in toolbar.css so the host
// stays transparent in flex layouts when the component renders.
//
// Properties (`attribute: false` — passed by reference via Lit's
// `.prop=${...}` property binding; no attribute reflection):
//   * `counts` — `{ fixed?, invalid?, deleted?, ignored? }`. Missing
//                or zero buckets render no button.
//   * `states` — array picking which buckets the selector renders.
//                Defaults to all four; Packages / Repositories pass
//                `['fixed', 'invalid', 'deleted']` because ignore is
//                per-report and treated as untriaged in those views.
//
// Attributes:
//   * `variant` — adds an extra class to the inner wrapper so
//                 events.js can route the click correctly:
//                   `graph`    → `.graph2-triage-selector`
//                   `packages` → `.packages-triage-selector`
//                 Empty (default, findings toolbar) → no extra class.
import { html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const DEFAULT_STATES = ['fixed', 'invalid', 'deleted', 'ignored']
const VARIANT_CLASS = {
  graph:    'graph2-triage-selector',
  packages: 'packages-triage-selector',
}

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

  render() {
    const states = this.states ?? DEFAULT_STATES
    const total = states.reduce((n, s) => n + (this.counts[s] ?? 0), 0)
    if (total === 0 && !state.shownTriage) return nothing
    // Unknown variants would silently drop the marker class and
    // mis-route clicks (graph variant without the class falls through
    // to the toolbar handler, which skips canvas teardown). Warn so
    // typos surface in dev rather than as a subtle interaction bug.
    const extra = this.variant ? VARIANT_CLASS[this.variant] : null
    if (this.variant && extra === undefined) {
      console.warn(`<triage-selector>: unknown variant ${JSON.stringify(this.variant)}; ` +
        `expected one of ${Object.keys(VARIANT_CLASS).map((k) => JSON.stringify(k)).join(', ')} or "".`)
    }
    const wrapperClasses = { 'triage-selector': true }
    if (extra) wrapperClasses[extra] = true
    return html`<div class=${classMap(wrapperClasses)} role="group" aria-label="Triage view">
      ${states.map((s) => {
        const n = this.counts[s] ?? 0
        const active = state.shownTriage === s
        // Hidden when the bucket is empty AND not the current view —
        // so the user can always click the active button to exit
        // its bucket even when the count drops mid-session.
        if (n === 0 && !active) return nothing
        return html`<button
          type="button"
          class=${classMap({ 'triage-state-btn': true, [`triage-state-${s}`]: true, active })}
          data-triage-show=${s}
          title=${active ? `Exit ${s} view` : `Show ${s} (${n})`}
          aria-pressed=${String(active)}
        >${s.charAt(0).toUpperCase() + s.slice(1)} (${n})</button>`
      })}
    </div>`
  }
}

customElements.define('triage-selector', TriageSelector)
