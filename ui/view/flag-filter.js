// `<flag-filter>` — a single flag-icon toggle in the findings toolbar,
// placed right after the Sources / Dependencies switch. When active it
// restricts the row set to flagged findings (`state.filterFlagged`); the
// same pennant glyph as the per-finding flag keeps it compact.
//
// Reactivity: extends StateElement, so the active highlight follows
// `state.filterFlagged` on its own. Click dispatches a
// `flag-filter-toggle` CustomEvent; events.js flips the boolean and
// re-renders (mirrors `<source-filter>`'s `source-toggle`). The host
// carries the bordered-pill chrome via the `flag-filter` selector in
// toolbar.css; the single chip button renders as its only child.
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { ensureHostAria } from './host-aria.js'

// Inlined (not imported from render-finding.js) so this toolbar chip
// stays a light StateElement like `<source-filter>` rather than dragging
// in the finding-render module. Same path data as render-finding's
// FLAG_ICON so the two glyphs match.
const FLAG_GLYPH = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <path class="flag-pole" d="M4 1.8v12.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
  <path class="flag-cloth" d="M4 2.5h7.4l-1.8 2.4 1.8 2.4H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

class FlagFilter extends StateElement {
  createRenderRoot() { return this }

  connectedCallback() {
    super.connectedCallback()
    ensureHostAria(this, { role: 'group', 'aria-label': 'Flag filter' })
  }

  render() {
    const active = state.filterFlagged
    const title = active ? 'Showing only flagged findings — click to clear' : 'Show only flagged findings'
    return html`<button
      type="button"
      class=${classMap({ 'flag-chip': true, active })}
      title=${title}
      aria-label=${title}
      aria-pressed=${String(active)}
      @click=${() => this._toggle()}
    >${FLAG_GLYPH}</button>`
  }

  _toggle() {
    this.dispatchEvent(new CustomEvent('flag-filter-toggle', {
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('flag-filter', FlagFilter)
