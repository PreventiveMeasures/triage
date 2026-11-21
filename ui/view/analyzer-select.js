// `<analyzer-select>` — the toolbar dropdown filtering findings along
// run-meta dimensions: analyzer and model, and in App mode the validation
// model too. A 30px trigger pill like the sort select, opening a custom
// popover with one column per dimension, so the user can pick an analyzer,
// a model, or both (the analyzer+model pairs the header combo tags show).
//
// The validation model is that of a revalidation pass's own row; Model is
// then that of every other row, the scans App mode folds under the pass's.
// A row matches each where any of its rows does (filters.js matchesRunRow).
//
// Per column: single-select with toggle-off plus an "All …" row clearing
// the dimension. The panel stays open after a pick (a combination takes two
// clicks) and closes through native `popover="auto"` (outside click /
// Escape / trigger) in the top layer, where no `overflow` parent clips it.
//
// Each value's count is CROSS-FILTERED by the other dimensions' selection
// (filters.js runFilterCounts), so a combination that doesn't exist reads
// 0 and dims, though it stays clickable. Counts are groups over the rows
// left after the source / confidence / outcome selectors and the lens.
//
// A row click dispatches `analyzer-change` with EVERY dimension in
// `detail` (`{ analyzer, model, validationModel }`, the clicked one
// updated); events.js writes the state and renders.
//
// Properties: `analyzers` / `models` / `validationModels`, each column's
// ordered values (strings or `null`, from render.js; `validationModels`
// empty outside App mode), and `groups`, the rows the counts run over.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { html } from '@rray/frontend/state-element'
import { ToolbarControl } from './toolbar-control.js'
import { state } from '#client/index.js'
import { NULL_ANALYZER_SENTINEL, NULL_MODEL_SENTINEL, runFilterCounts, runFilterValue } from './filters.js'
import { SOURCE_LABELS } from '@preventive/report'

// Producers named by a `source` marker read as the report library names
// them; unknown keys verbatim.
const analyzerLabel = (a) => a == null ? '(none)' : SOURCE_LABELS[a] ?? a

// "(no model)" rather than "(none)": the trigger shows the value bare
// (`Claude Security · (no model)`), where "(none)" wouldn't say which
// dimension it came from.
const modelLabel = (m) => m == null ? '(no model)' : m

// The columns, in order. `values` / counts are the `${dim}s` property and
// runFilterCounts key. A column shows when its values reach `min`: the
// analyzer and model columns only where they vary, the validation model's
// with a single value too (Model then means the scans beneath the passes,
// and a row with no pass matches none; filters.js runFiltersOffered).
const DIMENSIONS = [
  { dim: 'analyzer', heading: 'Analyzer', allLabel: 'All analyzers', stateKey: 'filterAnalyzer',
    sentinel: NULL_ANALYZER_SENTINEL, labelOf: analyzerLabel, min: 2, picked: analyzerLabel },
  { dim: 'model', heading: 'Model', allLabel: 'All models', stateKey: 'filterModel',
    sentinel: NULL_MODEL_SENTINEL, labelOf: modelLabel, min: 2, picked: modelLabel },
  { dim: 'validationModel', heading: 'Validation model', allLabel: 'All validation models', stateKey: 'filterValidationModel',
    sentinel: NULL_MODEL_SENTINEL, labelOf: modelLabel, min: 1, picked: (v) => `validated by ${modelLabel(v)}` },
]

class AnalyzerSelect extends ToolbarControl {
  static properties = {
    analyzers: { attribute: false },
    models:    { attribute: false },
    validationModels: { attribute: false },
    groups:    { attribute: false },
    // Mirrors the popover's open state (set from `beforetoggle`), so
    // opening triggers an update whose `updated()` re-measures the panel:
    // `beforetoggle` fires while it is still display:none.
    _open: { state: true },
  }

  constructor() {
    super()
    this.analyzers = []
    this.models = []
    this.validationModels = []
    this.groups = []
    this._open = false
  }

  render() {
    const shown = DIMENSIONS.filter((d) => this[`${d.dim}s`].length >= d.min)
    if (shown.length === 0) return nothing
    const counts = runFilterCounts(this.groups)
    // The selection reads like the header combo tags (`security · opus 4 7`,
    // `validated by opus 4 7`); unfiltered, it names the first dimension
    // that varies.
    const selected = DIMENSIONS.flatMap((d) => {
      const want = runFilterValue(state[d.stateKey], d.sentinel)
      return want === undefined ? [] : [d.picked(want)]
    })
    const filtering = selected.length > 0
    const summary = filtering ? selected.join(' · ') : shown[0].allLabel
    const showValidation = shown.at(-1).dim === 'validationModel'
    return html`<button
      type="button"
      class=${classMap({ 'analyzer-btn': true, active: filtering })}
      popovertarget="analyzer-select-menu"
      popovertargetaction="toggle"
      aria-label=${`Filter by ${showValidation ? 'analyzer / model / validation model' : 'analyzer / model'}: ${summary}`}
    >
      <span class="analyzer-btn-label">${summary}</span>
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div popover="auto" id="analyzer-select-menu" class="analyzer-menu" @beforetoggle=${this._onToggle}>
      ${shown.map((d, i) => (i === 0 ? this._column(d, counts) : html`<div class="analyzer-menu-sep"></div>${this._column(d, counts)}`))}
    </div>`
  }

  // One dimension column: heading, the "All …" clear row, then a row per
  // value with its count. Plain toggle buttons (`aria-pressed`) in a
  // labelled group, not a `listbox`, which would promise arrow-key
  // navigation the popover doesn't implement.
  _column({ dim, heading, allLabel, stateKey, sentinel, labelOf }, counts) {
    const current = state[stateKey]
    return html`<div class="analyzer-menu-col" role="group" aria-label=${`Filter by ${heading.toLowerCase()}`}>
      <div class="analyzer-menu-head">${heading}</div>
      <button
        type="button"
        aria-pressed=${String(current === '')}
        class=${classMap({ 'analyzer-menu-item': true, active: current === '' })}
        @click=${() => this._pick(dim, '')}
      ><span class="analyzer-menu-label">${allLabel}</span></button>
      ${this[`${dim}s`].map((v) => {
        const value = v == null ? sentinel : v
        const n = counts[`${dim}s`].get(v) ?? 0
        const active = current === value
        return html`<button
          type="button"
          aria-pressed=${String(active)}
          class=${classMap({ 'analyzer-menu-item': true, active, zero: n === 0 })}
          @click=${() => this._pick(dim, value)}
        ><span class="analyzer-menu-label">${labelOf(v)}</span><span class="analyzer-menu-count">${n}</span></button>`
      })}
    </div>`
  }

  _pick(dim, value) {
    const detail = Object.fromEntries(DIMENSIONS.map((d) => [d.dim, state[d.stateKey]]))
    // Re-clicking the active value clears the dimension.
    detail[dim] = value !== '' && detail[dim] === value ? '' : value
    this.emit('analyzer-change', detail)
  }

  _onToggle = (e) => {
    this._open = e.newState === 'open'
    if (this._open) this._position()
  }

  // Drop the panel below the trigger, left edges aligned; clamp into the
  // viewport and flip above when the bottom would clip. Re-run from
  // `updated()` while open, correcting the `beforetoggle` pass's fallback
  // measurements and any shift from a re-render while picking.
  _position() {
    const pop = this.querySelector('.analyzer-menu')
    const btn = this.querySelector('.analyzer-btn')
    if (!pop || !btn) return
    const btnRect = btn.getBoundingClientRect()
    const menuW = pop.offsetWidth || 240
    const menuH = pop.offsetHeight || 200
    const gap = 4
    let left = btnRect.left
    if (left + menuW > window.innerWidth - 4) left = window.innerWidth - menuW - 4
    if (left < 4) left = 4
    let top = btnRect.bottom + gap
    if (top + menuH > window.innerHeight - 4 && btnRect.top > menuH + gap) {
      top = btnRect.top - menuH - gap
    }
    pop.style.top = `${top}px`
    pop.style.left = `${left}px`
  }

  updated() {
    if (this._open && this.querySelector('.analyzer-menu')?.matches(':popover-open')) {
      this._position()
    }
  }
}

customElements.define('analyzer-select', AnalyzerSelect)
