// `<bundle-search>`: the Search tab's bar, its query
// (`state.bundleSearchQuery`) with a clear button while there is one, and
// its `Aa` case (`state.bundleSearchCase`) and `.*` regular-expression
// (`state.bundleSearchRegex`) toggles; its state is apart from the Code
// rail's `<bundle-code-search>`. It emits `search-input` (`{ kind:
// 'bundle-search', value }`), `bundle-search-regex-toggle` and
// `bundle-search-case-toggle`, which events.js writes to state. `live()`
// lets a reset (another bundle) clear the kept `<input>`.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { live } from 'lit/directives/live.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const SEARCH_ICON = html`<svg class="bundle-search-icon" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  <circle cx="6.5" cy="6.5" r="4.5"/>
  <path d="M9.7 9.7L13 13" stroke-linecap="round"/>
</svg>`

class BundleSearch extends StateElement {
  createRenderRoot() { return this }

  render() {
    const query = state.bundleSearchQuery
    const regex = state.bundleSearchRegex
    const caseSensitive = state.bundleSearchCase
    const placeholder = regex ? 'Search by regular expression…' : 'Search all source…'
    return html`${SEARCH_ICON}
      <input
        type="text"
        class="bundle-search-input"
        placeholder=${placeholder}
        aria-label=${placeholder}
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        .value=${live(query)}
        @input=${this._onInput}
      >
      ${query ? html`<button
        type="button"
        class="bundle-search-clear"
        aria-label="Clear search"
        @click=${this._onClear}
      >×</button>` : nothing}
      <span class="bundle-search-mods">
        <button
          type="button"
          class=${classMap({ 'bundle-search-mod': true, active: caseSensitive })}
          data-tooltip=${caseSensitive ? 'Case-sensitive on — click to ignore case' : 'Match case'}
          aria-label="Match case"
          aria-pressed=${String(caseSensitive)}
          @click=${this._onToggleCase}
        >Aa</button>
        <button
          type="button"
          class=${classMap({ 'bundle-search-mod': true, active: regex })}
          data-tooltip=${regex ? 'Regular expression on — click for plain text' : 'Match by regular expression'}
          aria-label="Match by regular expression"
          aria-pressed=${String(regex)}
          @click=${this._onToggleRegex}
        >.*</button>
      </span>`
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }))
  }

  _onInput = (e) => { this._emit('search-input', { kind: 'bundle-search', value: e.target.value }) }

  _onClear = () => { this._emit('search-input', { kind: 'bundle-search', value: '' }) }

  _onToggleRegex = () => { this._emit('bundle-search-regex-toggle') }

  _onToggleCase = () => { this._emit('bundle-search-case-toggle') }
}

customElements.define('bundle-search', BundleSearch)
