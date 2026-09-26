// `<annotation-filter>` — comment | fix | flag after the Sources / Deps
// switch, or duplicates | cross-context | App-stacked | security beside App mode. Each
// chip cycles an INDEPENDENT, AND-combined tri-state filter (state.filterComment /
// filterFix / filterFlagged / filterDuplicates / filterCrossContext /
// filterAppStacked / filterSecurity: '' → 'with' → 'without' → ''):
// selecting more narrows the row set further
// (see matchesFilters in filters.js). Mirrors `<source-filter>`'s
// multi-chip pill, using the same glyphs as the per-finding marks.
//
// Self-gating: a chip renders only when at least one finding carries that
// annotation (the `has*` properties, computed once per render in
// render.js's toolbarTemplate over the loaded set) OR while its filter is
// active — so a left-active filter can always be switched off. The whole
// group is dropped by the toolbar when none of the chips would show.
// Duplicates is report-only and requires a resolved link outside the report;
// its selection is cleared when no qualifying row remains. Cross-context and
// App-stacked rows are mutually exclusive by lens, so each chip follows the
// switches that make it applicable.
//
// Reactivity: extends StateElement, so the active highlights follow the
// `state.filter*` tri-states. Click dispatches `annotation-filter-toggle`
// with the chip `key`; events.js cycles the matching tri-state and
// re-renders. The host carries the bordered-pill chrome via the
// `annotation-filter` selector in toolbar.css.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { ensureHostAria } from './host-aria.js'
import { LINKS_ICON_SVG } from './icons.js'

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
// Reuse the links-file identity from the sidebar so this filter reads as
// "linked issues" rather than the finding action that copies a link.
const DUPLICATES_GLYPH = unsafeHTML(LINKS_ICON_SVG.replace('width="14" height="14"', 'width="12" height="12"'))
const CROSS_CONTEXT_GLYPH = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <g fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 1.2 1.3 3.1v5.7L5 10.7l3.7-1.9V3.1Z M1.3 3.1 5 5l3.7-1.9 M5 5v5.7"/>
    <path d="M11 5.2 7.3 7.1v5.7l3.7 1.9 3.7-1.9V7.1Z M7.3 7.1 11 9l3.7-1.9 M11 9v5.7"/>
  </g>
</svg>`
const APP_STACKED_GLYPH = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3.4" y="1.5" width="10" height="3.6" rx=".8"/>
    <rect x="2.2" y="5.3" width="10" height="3.6" rx=".8"/>
    <rect x="1" y="9.1" width="10" height="3.6" rx=".8"/>
  </g>
</svg>`
const SECURITY_GLYPH = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <path d="M8 1.5 13 3.5v4c0 3-2.1 5.5-5 7-2.9-1.5-5-4-5-7v-4Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

const CHIPS = [
  { key: 'comment', glyph: COMMENT_GLYPH, label: 'commented', stateKey: 'filterComment', hasKey: 'hasComment' },
  { key: 'fix',     glyph: FIX_GLYPH,     label: 'fixed',      stateKey: 'filterFix',     hasKey: 'hasFix' },
  { key: 'flag',    glyph: FLAG_GLYPH,    label: 'flagged',    stateKey: 'filterFlagged', hasKey: 'hasFlagged' },
  { key: 'duplicates', glyph: DUPLICATES_GLYPH, label: 'rows with duplicates in other reports', stateKey: 'filterDuplicates', hasKey: 'hasDuplicates' },
  { key: 'cross-context', glyph: CROSS_CONTEXT_GLYPH, label: 'rows across multiple repos or packages', stateKey: 'filterCrossContext', hasKey: 'hasCrossContext' },
  { key: 'app-stacked', glyph: APP_STACKED_GLYPH, label: 'stacked App rows', stateKey: 'filterAppStacked', hasKey: 'hasAppStacked' },
  { key: 'security', glyph: SECURITY_GLYPH, label: 'security-related rows', stateKey: 'filterSecurity', hasKey: 'hasSecurityContrast' },
]
const CONTEXT_KEYS = new Set(['duplicates', 'cross-context', 'app-stacked', 'security'])

class AnnotationFilter extends StateElement {
  static properties = {
    group: { type: String },
    hasComment: { attribute: false },
    hasFix:     { attribute: false },
    hasFlagged: { attribute: false },
    hasDuplicates: { attribute: false },
    hasCrossContext: { attribute: false },
    hasAppStacked: { attribute: false },
    hasSecurityContrast: { attribute: false },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.group = 'marks'
    this.hasComment = false
    this.hasFix = false
    this.hasFlagged = false
    this.hasDuplicates = false
    this.hasCrossContext = false
    this.hasAppStacked = false
    this.hasSecurityContrast = false
  }

  connectedCallback() {
    super.connectedCallback()
    ensureHostAria(this, { role: 'group', 'aria-label': this.group === 'context' ? 'Finding row filters' : 'Annotation filter' })
  }

  render() {
    // Security requires both matching and nonmatching rows. Other chips show
    // when their annotation exists OR their filter is active (to clear it).
    const visible = CHIPS.filter((c) => (this.group === 'context') === CONTEXT_KEYS.has(c.key))
      .filter((c) => c.key === 'security' ? this.hasSecurityContrast : c.key === 'duplicates'
        ? !state.currentWorkspace && (this.hasDuplicates || state[c.stateKey])
        : this[c.hasKey] || state[c.stateKey])
    if (visible.length === 0) return nothing
    const renderChip = (c) => {
      // Tri-state: '' → 'with' (only) → 'without' (exclude) → ''.
      const sel = state[c.stateKey]
      const label = CONTEXT_KEYS.has(c.key)
        ? c.label : `${c.label} findings`
      const title = sel === 'with'
        ? `Showing only ${label} — click to exclude them`
        : sel === 'without'
          ? `Excluding ${label} — click to clear`
          : `Show only ${label}`
      return html`<button
        type="button"
        class=${classMap({ 'annotation-chip': true, 'sel-with': sel === 'with', 'sel-without': sel === 'without' })}
        aria-label=${title}
        aria-pressed=${String(sel !== '')}
        @click=${() => this._toggle(c.key)}
      >${c.glyph}</button>`
    }
    return html`${visible.map(renderChip)}`
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
