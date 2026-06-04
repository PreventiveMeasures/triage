// `<annotation-filter>` — a comment | fix | flag chip group in the
// findings toolbar, right after the Sources / Dependencies switch. Each
// chip toggles an INDEPENDENT, AND-combined filter (state.filterComment /
// filterFix / filterFlagged): selecting more narrows the row set further
// (see matchesFilters in filters.js). Mirrors `<source-filter>`'s
// multi-chip pill, using the same glyphs as the per-finding marks.
//
// Self-gating: a chip renders only when at least one finding carries that
// annotation (the `has*` properties, computed once per render in
// render.js's toolbarTemplate over the loaded set) OR while its filter is
// active — so a left-active filter can always be switched off. The whole
// group is dropped by the toolbar when none of the chips would show.
//
// Reactivity: extends StateElement, so the active highlights follow the
// `state.filter*` booleans. Click dispatches `annotation-filter-toggle`
// with the chip `key`; events.js flips the matching boolean and
// re-renders. The host carries the bordered-pill chrome via the
// `annotation-filter` selector in toolbar.css.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { ensureHostAria } from './host-aria.js'

// Inlined glyphs (same path data as render-finding.js's COMMENT_ICON /
// FIX_ICON / FLAG_ICON) so this toolbar chip stays a light StateElement
// rather than importing the finding-render module.
const COMMENT_GLYPH = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <path class="bubble" d="M2.5 3h11a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-.5.5H8.4l-3 2.6V10.5H2.5a.5.5 0 0 1-.5-.5V3.5a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`
const FIX_GLYPH = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <path class="wrench" d="M10.4 2.6a3 3 0 0 0-3.6 4.5L2 12l2 2 4.9-4.8a3 3 0 0 0 4.5-3.6l-1.8 1.8-1.5-.4-.4-1.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`
const FLAG_GLYPH = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <path class="flag-cloth" d="M5 1.5h6v13l-3-2.7-3 2.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
</svg>`

const CHIPS = [
  { key: 'comment', glyph: COMMENT_GLYPH, label: 'commented', stateKey: 'filterComment', hasKey: 'hasComment' },
  { key: 'fix',     glyph: FIX_GLYPH,     label: 'fixed',      stateKey: 'filterFix',     hasKey: 'hasFix' },
  { key: 'flag',    glyph: FLAG_GLYPH,    label: 'flagged',    stateKey: 'filterFlagged', hasKey: 'hasFlagged' },
]

class AnnotationFilter extends StateElement {
  static properties = {
    hasComment: { attribute: false },
    hasFix:     { attribute: false },
    hasFlagged: { attribute: false },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.hasComment = false
    this.hasFix = false
    this.hasFlagged = false
  }

  connectedCallback() {
    super.connectedCallback()
    ensureHostAria(this, { role: 'group', 'aria-label': 'Annotation filter' })
  }

  render() {
    // A chip shows when its annotation exists in the loaded set OR its
    // filter is currently on (so it can be turned back off).
    const visible = CHIPS.filter((c) => this[c.hasKey] || state[c.stateKey])
    if (visible.length === 0) return nothing
    return html`${visible.map((c) => {
      const active = state[c.stateKey]
      const title = active
        ? `Showing only ${c.label} findings — click to clear`
        : `Show only ${c.label} findings`
      return html`<button
        type="button"
        class=${classMap({ 'annotation-chip': true, active })}
        title=${title}
        aria-label=${title}
        aria-pressed=${String(active)}
        @click=${() => this._toggle(c.key)}
      >${c.glyph}</button>`
    })}`
  }

  _toggle(key) {
    this.dispatchEvent(new CustomEvent('annotation-filter-toggle', {
      detail: { key },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('annotation-filter', AnnotationFilter)
