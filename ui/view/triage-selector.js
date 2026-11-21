// `<triage-selector>` — the In progress / Fixed / Invalid / Deleted /
// Ignored bucket buttons of the findings toolbar, the graph topbar and the
// Packages / Repositories toolbars, switching `state.shownTriage` (which the
// highlight follows through the autorun). `counts` come from the parent's
// filter pipeline; an empty bucket shows only while it is the active one,
// so it can always be clicked out of. `states` picks the buckets (all five
// by default). `variant` marks the host `graph2-triage-selector` or
// `packages-triage-selector`, which events.js routes on (the graph's
// tears its canvas down).
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
    // An unknown variant would silently drop the marker and mis-route.
    const extra = this.variant ? VARIANT_CLASS[this.variant] : null
    if (this.variant && extra === undefined) {
      console.warn(`<triage-selector>: unknown variant ${JSON.stringify(this.variant)}; ` +
        `expected one of ${Object.keys(VARIANT_CLASS).map((k) => JSON.stringify(k)).join(', ')} or "".`)
    }
    for (const cls of Object.values(VARIANT_CLASS)) this.classList.toggle(cls, cls === extra)
    // With nothing to show, the host (the bordered pill, toolbar.css) hides
    // by class: `:empty` misses the part markers Lit leaves for `nothing`.
    const isEmpty = total === 0 && !state.shownTriage
    this.classList.toggle('is-empty', isEmpty)
    if (isEmpty) return nothing
    return html`${states.map((s) => {
      const n = this.counts[s] ?? 0
      const active = state.shownTriage === s
      if (n === 0 && !active) return nothing
      const label = labelFor(s)
      return html`<button
        type="button"
        class=${classMap({ 'triage-state-btn': true, [`triage-state-${s}`]: true, active })}
        data-triage-show=${s}
        aria-pressed=${String(active)}
      ><span>${label}</span><span class="n">${n}</span></button>`
    })}`
  }
}

customElements.define('triage-selector', TriageSelector)
