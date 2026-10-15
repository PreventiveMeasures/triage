import { html, nothing } from 'lit'
import { styleMap } from './style-map.js'
import { renderCompareStats } from './bundle-compare-stats.js'
// A choice’s tags are cut short beyond this width.
const TAGS_FIT = 24

// Adapt a comparison source's choices for bundle-selector without losing its
// release dates or warnings. Review uses package-qualified values for its base.
export function compareSourceOptions(options, valueOf = option => option.id) {
  return options.map(option => ({ id: valueOf(option), integrity: valueOf(option), kind: option.format, format: option.format,
    detail: option.detail, ...option.date && { date: option.date }, ...option.dateWarning && { dateWarning: option.dateWarning },
    filename: option.name, displayLabel: option.displayLabel, size: '—', summary: null }))
}

// Both selects share a width, initially fitting the widest name or placeholder,
// then every loaded choice and as many of its smaller tags as fit TAGS_FIT.
// Menus size themselves.
export function comparePickerStyle(source) {
  if (!source) return nothing
  const fit = ({ name = '', detail = '' } = {}) => name.length + Math.min(detail.length, TAGS_FIT) * .87 + 1
  const chars = (source.choices ?? []).reduce((most, choice) => Math.max(most, fit(choice)), Math.max(`Choose a ${source.noun ?? 'bundle'}…`.length, fit(source.widest)))
  return styleMap({ '--compare-select-chars': `${Math.ceil(chars)}` })
}

// Both pages use this picker and header. The page owns navigation and supplies
// labels and actions; all selector markup, sizing and chrome live here.
export function renderComparisonPicker({ source, label = 'Compare', from, to, clear, swap, extras = nothing, comparison = null, disabled = false, openLine }) {
  const noun = source?.noun ?? 'bundle'
  const Noun = `${noun[0].toUpperCase()}${noun.slice(1)}`
  const select = (side, fallback) => html`<bundle-selector .bundles=${side.options} .value=${side.value} .noun=${noun} .versions=${Boolean(source)}
    label=${side.label ?? fallback} placeholder=${side.placeholder ?? `Choose a ${noun}…`} ?disabled=${disabled}
    @bundle-change=${event => { event.stopPropagation(); side.pick(event.detail.value) }}></bundle-selector>`
  return html`<div class=${source ? 'bundle-compare-picker is-versions' : 'bundle-compare-picker'} style=${comparePickerStyle(source)}
    @compare-open-line=${event => openLine?.(event.detail)}>
    <div class="bundle-compare-select-wrap"><span class="bundle-compare-select-hint">${label}</span>
      ${select(from, `${Noun} to compare with`)}
      ${clear ? html`<button type="button" class="bundle-compare-clear" aria-label=${clear.label ?? 'Clear comparison'} ?disabled=${disabled} @click=${clear.run}>×</button>` : nothing}</div>
    <span class="bundle-compare-arrow" aria-hidden="true">→</span>
    <div class="bundle-compare-select-wrap">${select(to, `${Noun} to compare`)}
      ${swap ? html`<button type="button" class="bundle-compare-swap" ?disabled=${disabled} @click=${swap} aria-label=${`Swap the two ${noun}s`}>
        <span class="bundle-compare-swap-icon" aria-hidden="true">↔</span>Swap</button>` : nothing}</div>
    ${extras}${comparison ? source?.badges?.(comparison.base, comparison.other, comparison.files) ?? nothing : nothing}
  </div>`
}

export function renderComparisonSummary(diff, actions = nothing) {
  return html`<div class="bundle-compare-summary">${renderCompareStats(diff)}${actions}</div>`
}

export function renderComparisonHeader(picker, summary = nothing) {
  return html`<header class="bundle-compare-head">${picker}${summary}</header>`
}
