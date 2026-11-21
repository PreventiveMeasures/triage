// `<annotation-filter>` — comment | issue | fix | flag after the Sources /
// Deps switch, or (group="context") duplicates | cross-context | App-stacked
// | security beside App mode. Each chip cycles an independent, AND-combined
// tri-state (`state.filterComment` … `filterSecurity`: '' → 'with' →
// 'without' → ''; filters.js matchesFilters).
//
// A chip shows while some finding carries its annotation (the `has*`
// properties, scanned by render.js over the loaded set) OR while its filter
// is on, so a left-active filter can always be switched off. Duplicates is
// report-only; Security needs both matching and nonmatching rows. Click
// dispatches `annotation-filter-toggle(detail: { key })`; events.js cycles
// the tri-state.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { appMarkup } from './markup.js'
import { html } from '@rray/frontend/state-element'
import { ToolbarControl } from './toolbar-control.js'
import { state } from '#client/index.js'
import { LINKS_ICON_SVG } from './icons.js'

// The per-finding marks' glyphs (render-finding.js), inlined so this chip
// doesn't import the finding-render module.
const COMMENT_GLYPH = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <path class="bubble" d="M2.5 3h11a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-.5.5H8.4l-3 2.6V10.5H2.5a.5.5 0 0 1-.5-.5V3.5a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`
const ISSUE_GLYPH = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <circle cx="8" cy="8" r="1.7" fill="currentColor"/>
</svg>`
const FIX_GLYPH = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <path class="wrench" d="M10.4 2.6a3 3 0 0 0-3.6 4.5L2 12l2 2 4.9-4.8a3 3 0 0 0 4.5-3.6l-1.8 1.8-1.5-.4-.4-1.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`
const FLAG_GLYPH = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <path class="flag-cloth" d="M5 1.5h6v13l-3-2.7-3 2.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
</svg>`
// The sidebar's links-file mark: "linked issues", not the copy-link action.
const DUPLICATES_GLYPH = appMarkup(LINKS_ICON_SVG.replace('width="14" height="14"', 'width="12" height="12"'))
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
  { key: 'comment', glyph: COMMENT_GLYPH, label: 'commented findings', stateKey: 'filterComment', hasKey: 'hasComment' },
  { key: 'issue',   glyph: ISSUE_GLYPH,   label: 'findings with an issue', stateKey: 'filterIssue', hasKey: 'hasIssue' },
  { key: 'fix',     glyph: FIX_GLYPH,     label: 'fixed findings',     stateKey: 'filterFix',     hasKey: 'hasFix' },
  { key: 'flag',    glyph: FLAG_GLYPH,    label: 'flagged findings',   stateKey: 'filterFlagged', hasKey: 'hasFlagged' },
  { key: 'duplicates', glyph: DUPLICATES_GLYPH, label: 'rows with duplicates in other reports', stateKey: 'filterDuplicates', hasKey: 'hasDuplicates' },
  { key: 'cross-context', glyph: CROSS_CONTEXT_GLYPH, label: 'rows across multiple repos or packages', stateKey: 'filterCrossContext', hasKey: 'hasCrossContext' },
  { key: 'app-stacked', glyph: APP_STACKED_GLYPH, label: 'stacked App rows', stateKey: 'filterAppStacked', hasKey: 'hasAppStacked' },
  { key: 'security', glyph: SECURITY_GLYPH, label: 'security-related rows', stateKey: 'filterSecurity', hasKey: 'hasSecurityContrast' },
]
const CONTEXT_KEYS = new Set(['duplicates', 'cross-context', 'app-stacked', 'security'])

class AnnotationFilter extends ToolbarControl {
  static properties = {
    group: { type: String },
    hasComment: { attribute: false },
    hasIssue:   { attribute: false },
    hasFix:     { attribute: false },
    hasFlagged: { attribute: false },
    hasDuplicates: { attribute: false },
    hasCrossContext: { attribute: false },
    hasAppStacked: { attribute: false },
    hasSecurityContrast: { attribute: false },
  }

  constructor() {
    super()
    this.group = 'marks'
    for (const { hasKey } of CHIPS) this[hasKey] = false
  }

  get groupLabel() {
    return this.group === 'context' ? 'Finding row filters' : 'Annotation filter'
  }

  render() {
    const visible = CHIPS.filter((c) => (this.group === 'context') === CONTEXT_KEYS.has(c.key))
      .filter((c) => c.key === 'security' ? this.hasSecurityContrast : c.key === 'duplicates'
        ? !state.currentWorkspace && (this.hasDuplicates || state[c.stateKey])
        : this[c.hasKey] || state[c.stateKey])
    if (visible.length === 0) return nothing
    return html`${visible.map(({ key, glyph, label, stateKey }) => {
      const sel = state[stateKey]
      const title = sel === 'with' ? `Showing only ${label} — click to exclude them`
        : sel === 'without' ? `Excluding ${label} — click to clear`
        : `Show only ${label}`
      return html`<button
        type="button"
        class=${classMap({ 'annotation-chip': true, 'sel-with': sel === 'with', 'sel-without': sel === 'without' })}
        aria-label=${title}
        aria-pressed=${String(sel !== '')}
        @click=${() => this.emit('annotation-filter-toggle', { key })}
      >${glyph}</button>`
    })}`
  }
}

customElements.define('annotation-filter', AnnotationFilter)
