// `<slide-triage-tabs>` — the Invalid / Deleted bucket tabs in the header
// of the Packages / Repositories detail slides. `kind` picks the state
// slice the autorun reads (`state.packageSlideTriage` /
// `state.repositorySlideTriage`); a click dispatches `slide-triage-toggle`
// with `kind` + bucket and events.js writes that slice. Renders nothing
// when no bucket has findings or is selected. `counts` is
// `{ invalid, deleted }`.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { html } from '@rray/frontend/state-element'
import { ToolbarControl } from './toolbar-control.js'
import { kindConfig } from './kind-config.js'
import { state } from '#client/index.js'

const BUCKETS = ['invalid', 'deleted']

const KIND = {
  package:    { stateKey: 'packageSlideTriage' },
  repository: { stateKey: 'repositorySlideTriage' },
}

class SlideTriageTabs extends ToolbarControl {
  static properties = {
    counts: { attribute: false },
    kind:   { type: String },
  }

  groupLabel = 'Triage view'

  constructor() {
    super()
    this.counts = {}
    // No default: a host missing `kind` warns (kindConfig) rather than
    // silently reading one of the slices.
    this.kind = ''
  }

  render() {
    const config = kindConfig('slide-triage-tabs', KIND, this.kind)
    if (!config) return nothing
    const current = state[config.stateKey]
    const visible = BUCKETS.filter((b) => (this.counts[b] ?? 0) > 0 || current === b)
    if (visible.length === 0) return nothing
    return html`${visible.map((b) => {
      const active = current === b
      return html`<button
        type="button"
        class=${classMap({ 'triage-state-btn': true, [`triage-state-${b}`]: true, active })}
        aria-pressed=${String(active)}
        @click=${() => this.emit('slide-triage-toggle', { kind: this.kind, value: b })}
      >${b.charAt(0).toUpperCase() + b.slice(1)} (${this.counts[b] ?? 0})</button>`
    })}`
  }
}

customElements.define('slide-triage-tabs', SlideTriageTabs)
