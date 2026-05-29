// `<slide-triage-tabs>` — Invalid / Deleted bucket tabs shown in the
// header of the Packages / Repositories detail slides. Both kinds
// share shape/classes/toggle behaviour but read different state slices
// (`state.packageSlideTriage` vs. `state.repositorySlideTriage`),
// discriminated by the `kind` property rather than per-page data
// attributes: a click dispatches `slide-triage-toggle` with the bound
// `kind` + picked bucket, and events.js's single listener writes the
// matching slice and re-renders. (Same custom-event pattern as
// `<severity-chips>`, `<triage-filter>`, `<color-marker>`.)
//
// Reactivity: extends StateElement. The render() autorun reads the
// `kind`-selected slice, so selecting an active bucket re-highlights
// the right tab without a parent prop hand-off.
//
// Returns `nothing` when no bucket is visible (no findings AND no
// active selection), so the host can drop it in unconditionally.
//
// `counts` is `{ invalid, deleted }` from the parent's filter pipeline.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { ensureHostAria } from './host-aria.js'
import { state } from '#client/index.js'

const BUCKETS = ['invalid', 'deleted']

const KIND = {
  package:    { stateKey: 'packageSlideTriage' },
  repository: { stateKey: 'repositorySlideTriage' },
}

class SlideTriageTabs extends StateElement {
  static properties = {
    counts: { attribute: false },
    kind:   { type: String },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.counts = {}
    // No sensible default — `kind` discriminates which state slice
    // the autorun reads. Leaving it empty surfaces a missing-attr
    // host as a dev warn (via the guard in render()) rather than a
    // silent route to one of the kinds.
    this.kind = ''
  }

  connectedCallback() {
    super.connectedCallback()
    ensureHostAria(this, { role: 'group', 'aria-label': 'Triage view' })
  }

  render() {
    const config = KIND[this.kind]
    if (!config) {
      console.warn(`<slide-triage-tabs>: unknown kind ${JSON.stringify(this.kind)}; ` +
        `expected one of ${Object.keys(KIND).map((k) => JSON.stringify(k)).join(', ')}.`)
      return nothing
    }
    const current = state[config.stateKey]
    const visible = BUCKETS.filter((b) => (this.counts[b] ?? 0) > 0 || current === b)
    if (visible.length === 0) return nothing
    return html`${visible.map((b) => {
      const active = current === b
      const n = this.counts[b] ?? 0
      return html`<button
        type="button"
        class=${classMap({ 'triage-state-btn': true, [`triage-state-${b}`]: true, active })}
        title=${active ? `Exit ${b} view` : `Show ${b} (${n})`}
        aria-pressed=${String(active)}
        @click=${() => this._toggle(b)}
      >${b.charAt(0).toUpperCase() + b.slice(1)} (${n})</button>`
    })}`
  }

  _toggle(value) {
    this.dispatchEvent(new CustomEvent('slide-triage-toggle', {
      detail: { kind: this.kind, value },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('slide-triage-tabs', SlideTriageTabs)
