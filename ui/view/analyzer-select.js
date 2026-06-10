// `<analyzer-select>` — toolbar dropdown that filters findings along
// two run-meta dimensions: analyzer and model. Still a dropdown (a
// 30px trigger pill matching the sibling sort select), but the panel
// is a custom popover with one column per dimension, so the user can
// pick an analyzer, a model, or BOTH — the combination narrows to
// findings that carry that exact analyzer+model pair (the same tuples
// the header combo tags and per-finding run-meta lines display).
//
// Selection model per column: single-select with toggle-off (the
// `source-filter` convention) plus an explicit "All …" row that
// clears the dimension. The panel intentionally stays open after a
// pick — composing a combination takes two clicks — and dismisses on
// outside click / Escape / trigger re-click via the native
// `popover="auto"` machinery (same approach as the per-finding triage
// menu: top layer, so no `overflow` parent can clip it).
//
// Each value row shows a group count CROSS-FILTERED by the other
// dimension's current selection — pick a model and the analyzer
// column previews how many groups each analyzer would show under
// that model (and vice versa), which is what makes nonexistent
// combinations visible before clicking (they read 0 and dim, but
// stay clickable). Counts are group-level over the same set the
// toolbar's "X of Y" denominator uses, matching the severity-chip
// convention ("counts preview filter-click results"); a group counts
// for a value when SOME tab passes both that value and the other
// dimension's filter — exactly matchesFilters' per-finding
// conjunction.
//
// Reactivity: extends StateElement, so reads of
// `state.filterAnalyzer` / `state.filterModel` during render() are
// tracked — a stale-filter clear in the parent (report swap drops the
// selected analyzer or model) re-renders the trigger label and row
// highlights without the parent re-passing anything.
//
// On a row click, dispatches `analyzer-change` with BOTH dimensions
// in `detail` (`{ analyzer, model }` — the clicked one updated, the
// other passed through). events.js's listener writes both state
// fields and calls render() (the body repaints since the filtered
// set changes).
//
// Properties (all `attribute: false`):
//   * `analyzers` — ordered analyzer keys (strings or `null`), as
//                   computed by render.js. A column renders only when
//                   its dimension has more than one distinct value.
//   * `models`    — ordered pretty model names (strings or `null`).
//   * `groups`    — the dedup-group list the counts run over (the
//                   parent's `allGroups`, i.e. the current triage
//                   bucket — NOT the filtered output, so counts don't
//                   feed back into themselves).
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { NULL_ANALYZER_SENTINEL, NULL_MODEL_SENTINEL, modelOfFinding } from './filters.js'

// Friendly labels for analyzers reported with a `source: <key>` field.
// Unknown keys render verbatim. Exported so render.js's analyzer
// ordering can group known source-marked imports first (the column
// reads better when DeepSec / Codex Security / Claude Security
// cluster ahead of bare analyzer names).
export const ANALYZER_LABELS = {
  'claude-security': 'Claude Security',
  'codex-security':  'Codex Security',
  'deepsec':         'DeepSec',
}

function analyzerLabel(a) {
  if (a == null) return '(none)'
  return ANALYZER_LABELS[a] ?? a
}

// "(no model)" rather than the analyzer column's "(none)" — the
// trigger pill shows the selected value bare (`Claude Security ·
// (no model)`), where a context-free "(none)" wouldn't say which
// dimension it came from.
function modelLabel(m) {
  return m == null ? '(no model)' : m
}

class AnalyzerSelect extends StateElement {
  static properties = {
    analyzers: { attribute: false },
    models:    { attribute: false },
    groups:    { attribute: false },
    // Mirrors the popover's open state (set from `beforetoggle`).
    // Reactive so opening triggers a Lit update whose `updated()`
    // re-measures the panel at its real size — `beforetoggle` fires
    // while the popover is still display:none, so the first
    // positioning pass runs on fallback dimensions.
    _open: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.analyzers = []
    this.models = []
    this.groups = []
    this._open = false
  }

  render() {
    const showAnalyzers = this.analyzers.length > 1
    const showModels = this.models.length > 1
    if (!showAnalyzers && !showModels) return nothing

    // Active filter values mapped back to dimension values:
    // `undefined` = dimension unfiltered, `null` = the no-value bucket.
    const wantA = state.filterAnalyzer === ''
      ? undefined
      : (state.filterAnalyzer === NULL_ANALYZER_SENTINEL ? null : state.filterAnalyzer)
    const wantM = state.filterModel === ''
      ? undefined
      : (state.filterModel === NULL_MODEL_SENTINEL ? null : state.filterModel)

    // One pass over the groups builds both columns' cross-filtered
    // counts. Per group, collect the analyzer values whose tabs pass
    // the MODEL filter (and vice versa); each collected value then
    // counts the group once — the per-finding conjunction + group
    // `some()` semantics of matchesFilters/applyFilters, dimension by
    // dimension.
    const analyzerCounts = new Map()
    const modelCounts = new Map()
    for (const g of this.groups) {
      const as = new Set()
      const ms = new Set()
      for (const f of g) {
        const a = f._analyzer ?? null
        const m = modelOfFinding(f)
        if (wantM === undefined || m === wantM) as.add(a)
        if (wantA === undefined || a === wantA) ms.add(m)
      }
      for (const a of as) analyzerCounts.set(a, (analyzerCounts.get(a) ?? 0) + 1)
      for (const m of ms) modelCounts.set(m, (modelCounts.get(m) ?? 0) + 1)
    }

    // Trigger label — the selection reads like the header combo tags:
    // `Claude Security`, `opus 4 7`, or `security · opus 4 7` for a
    // combination. Unfiltered, name the dimension that actually
    // varies ("All models" when every finding shares one analyzer but
    // models differ).
    const aSel = wantA === undefined ? null : analyzerLabel(wantA)
    const mSel = wantM === undefined ? null : modelLabel(wantM)
    const summary = aSel != null && mSel != null
      ? `${aSel} · ${mSel}`
      : (aSel ?? mSel ?? (showAnalyzers ? 'All analyzers' : 'All models'))
    const filtering = aSel != null || mSel != null

    return html`<button
      type="button"
      class=${classMap({ 'analyzer-btn': true, active: filtering })}
      popovertarget="analyzer-select-menu"
      popovertargetaction="toggle"
      title="Filter by analyzer / model"
      aria-label=${`Filter by analyzer / model: ${summary}`}
    >
      <span class="analyzer-btn-label">${summary}</span>
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div popover="auto" id="analyzer-select-menu" class="analyzer-menu" @beforetoggle=${this._onToggle}>
      ${showAnalyzers ? this._column({
        dim: 'analyzer',
        heading: 'Analyzer',
        allLabel: 'All analyzers',
        values: this.analyzers,
        sentinel: NULL_ANALYZER_SENTINEL,
        labelOf: analyzerLabel,
        counts: analyzerCounts,
        current: state.filterAnalyzer,
      }) : nothing}
      ${showAnalyzers && showModels ? html`<div class="analyzer-menu-sep"></div>` : nothing}
      ${showModels ? this._column({
        dim: 'model',
        heading: 'Model',
        allLabel: 'All models',
        values: this.models,
        sentinel: NULL_MODEL_SENTINEL,
        labelOf: modelLabel,
        counts: modelCounts,
        current: state.filterModel,
      }) : nothing}
    </div>`
  }

  // One dimension column: heading, the "All …" clear row, then a row
  // per value with its cross-filtered count. Zero-count rows dim
  // (`.zero`) but stay clickable — picking one empties the list
  // visibly and recoverably rather than the menu refusing the
  // combination.
  //
  // Rows are plain toggle buttons (`aria-pressed`) in a labelled
  // group, the same semantics `<severity-chips>` uses — NOT a
  // `listbox`/`option` pattern, which would promise arrow-key
  // navigation the popover doesn't implement (Tab between native
  // buttons + Enter + the popover's own Escape handling cover
  // keyboard use).
  _column({ dim, heading, allLabel, values, sentinel, labelOf, counts, current }) {
    return html`<div class="analyzer-menu-col" role="group" aria-label=${`Filter by ${dim}`}>
      <div class="analyzer-menu-head">${heading}</div>
      <button
        type="button"
        aria-pressed=${String(current === '')}
        class=${classMap({ 'analyzer-menu-item': true, active: current === '' })}
        @click=${() => this._pick(dim, '')}
      ><span class="analyzer-menu-label">${allLabel}</span></button>
      ${values.map((v) => {
        const value = v == null ? sentinel : v
        const n = counts.get(v) ?? 0
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
    const current = dim === 'analyzer' ? state.filterAnalyzer : state.filterModel
    // Toggle-off: re-clicking the active value clears that dimension
    // (the "All …" row's `value === ''` always lands on the clear
    // branch's value directly).
    const next = value !== '' && current === value ? '' : value
    this.dispatchEvent(new CustomEvent('analyzer-change', {
      detail: {
        analyzer: dim === 'analyzer' ? next : state.filterAnalyzer,
        model: dim === 'model' ? next : state.filterModel,
      },
      bubbles: true,
      composed: true,
    }))
  }

  _onToggle = (e) => {
    this._open = e.newState === 'open'
    if (this._open) this._position()
  }

  // Drop the panel below the trigger, left edges aligned (this is a
  // leading-edge toolbar control, unlike the row-trailing triage menu
  // which right-aligns); clamp into the viewport and flip above when
  // the bottom would clip. Re-run from `updated()` while open so the
  // first post-open render (and any layout shift from a re-render
  // while picking) corrects the `beforetoggle` pass's fallback
  // measurements.
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
