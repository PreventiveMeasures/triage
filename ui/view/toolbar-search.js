// `<toolbar-search>` — the icon-prefixed search field of the findings
// toolbar (`kind="findings"`, state.filterInclude) and the Files tab
// (`kind="files"`, state.filesSearch), emitting `search-input`. The findings
// field also shows a negate toggle while it has a query, emitting
// `search-negate-toggle`. The value binds through `live()`: resetFilters()
// and the graph's "jump to findings" rewrite the findings slice after the
// user has typed in the field. The `.search-row` around it and its
// `.result-count` stay in the parent template.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { live } from 'lit/directives/live.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { kindConfig } from './kind-config.js'
import { emit } from './emit.js'

const SEARCH_ICON = html`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
  <circle cx="11" cy="11" r="7"/>
  <path d="m20 20-3.5-3.5"/>
</svg>`

// The logic-NOT sign (¬), which reads as "negate the query" where a
// circle-slash would read as "clear the field".
const NEGATE_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 6h10v4"/>
</svg>`

const KIND = {
  findings: { stateKey: 'filterInclude', placeholder: 'Search findings…' },
  files:    { stateKey: 'filesSearch',   placeholder: 'Search files…' },
}

class ToolbarSearch extends StateElement {
  static properties = {
    kind: { type: String },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    // No default: a missing kind warns (kindConfig) rather than silently
    // routing to one.
    this.kind = ''
  }

  render() {
    const config = kindConfig('toolbar-search', KIND, this.kind)
    if (!config) return nothing
    const value = state[config.stateKey]
    return html`${SEARCH_ICON}
      <input
        type="text"
        aria-label=${config.placeholder}
        placeholder=${config.placeholder}
        .value=${live(value)}
        @input=${this._onInput}
      >
      ${this.kind === 'findings' && value ? this._negateToggle() : nothing}`
  }

  // Reads `state.filterIncludeNegate` only when rendered, so the files
  // variant's autorun never tracks it.
  _negateToggle() {
    const negate = state.filterIncludeNegate
    return html`<button
      type="button"
      class=${classMap({ 'search-negate-btn': true, active: negate })}
      data-tooltip=${negate ? 'Negation on — click to undo' : 'Negate: show non-matching findings'}
      aria-label="Negate search"
      aria-pressed=${String(negate)}
      @click=${this._onToggleNegate}
    >${NEGATE_ICON}</button>`
  }

  _onInput = (e) => { emit(this, 'search-input', { kind: this.kind, value: e.target.value }) }

  _onToggleNegate = () => { emit(this, 'search-negate-toggle') }
}

customElements.define('toolbar-search', ToolbarSearch)
