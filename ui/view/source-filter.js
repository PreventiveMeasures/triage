// `<source-filter>` — `Sources` / `Dependencies` chip pair in the
// findings toolbar that filters the row set to OWN-source vs.
// node_modules findings. Replaces the inline `srcChip(...)` helper
// + `.source-toggle` wrapper div that lived in render.js's
// `toolbarTemplate`.
//
// Selection is SINGLE-SELECT WITH TOGGLE-OFF:
//   * Click an inactive chip → it becomes the active one
//   * Click the active chip again → clear (no filter; both shown)
//
// Reactivity: extends StateElement, so reads of `state.filterSources`
// during render() are tracked by observer-util — the active chip
// follows state mutations on its own. Matches the pattern used by
// the other toolbar chrome components (`<severity-chips>`,
// `<triage-filter>`, `<view-mode-buttons>`, `<triage-selector>`).
//
// Click dispatches a `source-toggle(detail: { source })` CustomEvent;
// events.js's listener applies the clear+add logic (a Set-based
// state slice rather than a single string keeps the predicate in
// filters.js stable as `size === 1` checks).
//
// The host element carries the bordered-pill chrome directly via
// the `source-filter` element selector in toolbar.css; the two
// chip buttons render as direct children.
import { html } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const SOURCES = [
  ['own',     'Sources'],
  ['modules', 'Dependencies'],
]

class SourceFilter extends StateElement {
  createRenderRoot() { return this }

  connectedCallback() {
    super.connectedCallback()
    if (!this.hasAttribute('role')) this.setAttribute('role', 'group')
    if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'Source filter')
  }

  render() {
    return html`${SOURCES.map(([value, label]) => {
      const active = state.filterSources.has(value)
      return html`<button
        type="button"
        class=${classMap({ 'source-chip': true, active })}
        aria-pressed=${String(active)}
        @click=${() => this._toggle(value)}
      >${label}</button>`
    })}`
  }

  _toggle(source) {
    this.dispatchEvent(new CustomEvent('source-toggle', {
      detail: { source },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('source-filter', SourceFilter)
