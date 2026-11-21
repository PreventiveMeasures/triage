// `<severity-mode-switch>` — the findings toolbar's Corrected / Original
// toggle for `state.severityMode`, the lens every severity is displayed,
// counted, sorted and filtered through (`displayedSeverity` in format.js).
// One chip is always active. Light DOM, for toolbar.css; a click emits
// `severity-mode-change`, which events.js persists and full-renders.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { ensureHostAria } from './host-aria.js'
import { emit } from './emit.js'

const MODES = [
  ['corrected', 'Corrected', 'Show corrected severities (application-specific re-ratings)'],
  ['original',  'Original',  nothing],
]

class SeverityModeSwitch extends StateElement {
  createRenderRoot() { return this }

  connectedCallback() {
    super.connectedCallback()
    ensureHostAria(this, { role: 'group', 'aria-label': 'Severity display mode' })
  }

  render() {
    const mode = state.severityMode
    return html`<span class="severity-mode-label">Severity</span><span class="severity-mode-chips">${MODES.map(([value, label, title]) => {
      const active = mode === value
      return html`<button
        type="button"
        class=${classMap({ 'severity-mode-chip': true, active })}
        aria-pressed=${String(active)}
        data-tooltip=${title}
        @click=${() => this._select(value)}
      >${label}</button>`
    })}</span>`
  }

  _select(mode) {
    if (mode !== state.severityMode) emit(this, 'severity-mode-change', { mode })
  }
}

customElements.define('severity-mode-switch', SeverityModeSwitch)
