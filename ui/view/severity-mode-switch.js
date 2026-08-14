// `<severity-mode-switch>` — Corrected / Original segmented toggle for the
// findings toolbar. Flips `state.severityMode`, the global lens through
// which every finding's severity is displayed, counted, sorted, and
// filtered (the one accessor is `displayedSeverity` in view/format.js).
//
// Unlike `<source-filter>` (a Set with a toggle-off "neither" state), this
// is a single-string mode like `viewMode` — one of the two chips is ALWAYS
// active, so there's no empty state. 'corrected' is the default.
//
// Reactivity: extends StateElement, so the active chip follows
// `state.severityMode` mutations on its own. Light DOM (no shadow root) so
// the `severity-mode-switch` rules in toolbar.css apply directly.
//
// Click dispatches a composed `severity-mode-change(detail: { mode })`;
// events.js sets `state.severityMode`, persists it to localStorage, and
// full-renders (the mode changes badges, chip counts, sort order, and the
// header status bar — not just the badges).
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { ensureHostAria } from './host-aria.js'

const MODES = [
  ['corrected', 'Corrected', 'Show corrected severities (application-specific re-ratings)'],
  ['original',  'Original',  'Show the original analyzer severities'],
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
        title=${title}
        @click=${() => this._select(value)}
      >${label}</button>`
    })}</span>`
  }

  _select(mode) {
    if (mode === state.severityMode) return
    this.dispatchEvent(new CustomEvent('severity-mode-change', {
      detail: { mode },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('severity-mode-switch', SeverityModeSwitch)
