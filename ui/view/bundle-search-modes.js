// `<bundle-search-modes>` — the Files / Code / Issues tab strip
// next to `<bundle-code-search>` in the Bundle / Code rail. Toggles
// the rail's search MODE (which dataset the search query filters
// against) rather than the query itself; sibling component to
// `<bundle-code-search>` (which owns the query text input).
//
// Replaces the inline `<span class="bundle-code-search-modes">…
// {searchModes.map(...)}</span>` block in render-bundle.js's
// `renderBundleCodeView` and the `[data-bundle-search-mode]`
// branch in events.js's click delegate.
//
// Reactivity: extends StateElement, reads `state.bundleCodeSearchMode`
// via the autorun for the active-tab highlight. The available mode
// list arrives as `.modes=${modesArray}` (parent-computed: the
// 'issues' mode is only offered when the bundle has any issues to
// search through).
//
// Click dispatches a `bundle-search-mode-change(detail.mode)`
// CustomEvent — events.js's listener writes
// `state.bundleCodeSearchMode` and calls render(). The mode-tabs
// `id` / `data-bundle-search-mode` attribute scheme drops entirely.
import { html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const MODE_LABEL = {
  files:  'Filter files',
  code:   'Search code',
  issues: 'Search issues',
}

const MODE_ICONS = {
  // files  — folder/tree glyph (same shape family as the sidebar's
  // packages button) for the file-tree filter mode.
  files: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z"/>
  </svg>`,
  // code   — angle brackets, the universal "code" marker, used to
  // signal the full-text source-content search mode.
  code: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5.5 4.5L2 8l3.5 3.5"/>
    <path d="M10.5 4.5L14 8l-3.5 3.5"/>
  </svg>`,
  // issues — circle with an exclamation, matching the warning idiom
  // used elsewhere for findings/severity.
  issues: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <circle cx="8" cy="8" r="6"/>
    <path d="M8 4.8v3.6" stroke-linecap="round"/>
    <circle cx="8" cy="11" r=".7" fill="currentColor" stroke="none"/>
  </svg>`,
}

class BundleSearchModes extends StateElement {
  static properties = {
    modes: { attribute: false },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.modes = []
  }

  render() {
    if (!this.modes || this.modes.length === 0) return nothing
    // Active-tab fallback — mirror render-bundle.js's `searchMode`
    // computation. If the stored mode isn't in `this.modes` (e.g.
    // the user was on `issues` on bundle A, switches to bundle B
    // with no issues), the rail body falls back to `'files'`, and
    // the tab highlight has to follow or nothing reads as active.
    const stored = state.bundleCodeSearchMode
    const active = this.modes.includes(stored) ? stored : 'files'
    return html`<span class="bundle-code-search-modes" role="tablist">
      ${this.modes.map((m) => html`<button
        type="button"
        class=${classMap({ 'bundle-code-search-mode': true, active: active === m })}
        role="tab"
        aria-selected=${String(active === m)}
        title=${MODE_LABEL[m] ?? m}
        aria-label=${MODE_LABEL[m] ?? m}
        @click=${() => this._select(m)}
      >${MODE_ICONS[m] ?? nothing}</button>`)}
    </span>`
  }

  _select(mode) {
    this.dispatchEvent(new CustomEvent('bundle-search-mode-change', {
      detail: { mode },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('bundle-search-modes', BundleSearchModes)
