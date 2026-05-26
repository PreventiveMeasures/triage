// `<slide-triage-tabs>` — Invalid / Deleted bucket tabs shown in the
// header of the Packages / Repositories detail slides. Replaces two
// near-duplicate inline templates (`packageSlideTriageTabsTemplate`
// in render-packages.js, `repositorySlideTriageTabsTemplate` in
// render-repositories.js) that read different state slices
// (`state.packageSlideTriage` vs. `state.repositorySlideTriage`)
// and emit different data attributes
// (`data-package-slide-triage` vs. `data-repository-slide-triage`)
// but otherwise share their shape, classes, and toggle behaviour.
//
// The component drops the per-page data-attribute scheme — clicks
// dispatch a `slide-triage-toggle` CustomEvent with the bound `kind`
// and the picked bucket value. events.js's single listener then
// writes the matching state slice and calls render(). Matches the
// existing custom-event pattern used by `<severity-chips>`,
// `<triage-filter>`, `<color-marker>`.
//
// Reactivity: extends StateElement. The render() autorun reads
// `state.packageSlideTriage` or `state.repositorySlideTriage`
// depending on `kind` — selecting an active bucket re-highlights
// the right tab without needing a parent prop hand-off.
//
// Returns `nothing` when no bucket is visible (no findings AND no
// active selection), so the host can drop it in unconditionally.
//
// Properties:
//   * `counts` (`attribute: false`) — `{ invalid, deleted }` from
//                the parent's filter pipeline.
//   * `kind`   — `"package"` or `"repository"`. Default `"package"`.
//
// Events (bubble + composed:true):
//   * `slide-triage-toggle(detail: { kind, value })` — fired on
//     button click. events.js routes the toggle to the matching
//     `state.${kind}SlideTriage` slot.
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
