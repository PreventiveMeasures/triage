// `<analyzer-select>` — toolbar dropdown that filters findings to a
// single analyzer (or `(none)` for findings that don't carry one).
// Replaces the inline `<select id="analyzer-select" .value=${live(
// state.filterAnalyzer)}>` + the id-keyed branch in events.js's
// generic toolbar `change` listener. Hidden by the parent (via the
// `analyzerOptions.length > 1` guard) when the report only has one
// analyzer to begin with — the component itself doesn't filter that
// edge case since the visibility decision lives in the parent's
// flow.
//
// Reactivity: extends StateElement, so reads of `state.filterAnalyzer`
// during render() are tracked. The native `<select>`'s value is bound
// through Lit's `live()` directive so a stale-filter clear in the
// parent (e.g. a report swap drops the previously-selected analyzer)
// reflects on the actual browser select.value rather than just on
// the `?selected` attribute of options (which the browser ignores
// once user interaction has touched the field).
//
// On native `change`, dispatches an `analyzer-change(detail.value)`
// CustomEvent. events.js's listener writes `state.filterAnalyzer`
// and calls render() (the body needs to repaint since the filtered
// set changes).
//
// Properties:
//   * `options` (`attribute: false`) — array of analyzer keys (strings
//                or `null`). The component prepends an implicit
//                "All analyzers" option and translates `null` to
//                `NULL_ANALYZER_SENTINEL` for the option `value`.
import { html } from 'lit'
import { live } from 'lit/directives/live.js'
import { StateElement } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { NULL_ANALYZER_SENTINEL } from './filters.js'

// Friendly labels for analyzers reported with a `source: <key>` field.
// Unknown keys render verbatim. Exported so render.js's analyzerOptions
// sort can group known source-marked imports first (the dropdown
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

class AnalyzerSelect extends StateElement {
  static properties = {
    options: { attribute: false },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.options = []
  }

  render() {
    return html`<select
      class="sort-select"
      aria-label="Filter by analyzer"
      .value=${live(state.filterAnalyzer)}
      @change=${this._onChange}
    >
      <option value="">All analyzers</option>
      ${this.options.map((a) => {
        const value = a == null ? NULL_ANALYZER_SENTINEL : a
        return html`<option value=${value}>${analyzerLabel(a)}</option>`
      })}
    </select>`
  }

  _onChange = (e) => {
    this.dispatchEvent(new CustomEvent('analyzer-change', {
      detail: { value: e.target.value },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('analyzer-select', AnalyzerSelect)
