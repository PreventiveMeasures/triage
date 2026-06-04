// `<bundle-search>` — the search bar atop the bundle Search tab: a
// github-style, full-bundle code search. A lens-prefixed text input
// (bound to `state.bundleSearchQuery`), an inline clear button shown
// only while the query is non-empty, and two trailing modifiers — an
// `Aa` case-sensitivity toggle (`state.bundleSearchCase`) and a `.*`
// regular-expression toggle (`state.bundleSearchRegex`).
//
// Distinct from `<bundle-code-search>` (the Code tab's compact rail
// filter): this drives the full-width Search tab, where every match
// renders with its surrounding lines. The two keep separate query
// state so typing in one never disturbs the other.
//
// Events (bubble + composed):
//   * `search-input(detail: { kind: 'bundle-search', value })` — on
//     native input and on clear click (value ''). events.js writes
//     `state.bundleSearchQuery` and re-renders.
//   * `bundle-search-regex-toggle` — on `.*` click. events.js flips
//     `state.bundleSearchRegex` and re-renders.
//   * `bundle-search-case-toggle` — on `Aa` click. events.js flips
//     `state.bundleSearchCase` and re-renders.
//
// Both state reads happen inside render(), so the StateElement autorun
// fires on either mutation. Lit reuses the `<input>` across re-renders
// so the caret survives every keystroke; `live()` lets the external
// resets (bundle change) push the cleared value back into the DOM.
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
        title="Clear search"
        aria-label="Clear search"
        @click=${this._onClear}
      >×</button>` : nothing}
      <span class="bundle-search-mods">
        <button
          type="button"
          class=${classMap({ 'bundle-search-mod': true, active: caseSensitive })}
          title=${caseSensitive ? 'Case-sensitive on — click to ignore case' : 'Match case'}
          aria-label="Match case"
          aria-pressed=${String(caseSensitive)}
          @click=${this._onToggleCase}
        >Aa</button>
        <button
          type="button"
          class=${classMap({ 'bundle-search-mod': true, active: regex })}
          title=${regex ? 'Regular expression on — click for plain text' : 'Match by regular expression'}
          aria-label="Match by regular expression"
          aria-pressed=${String(regex)}
          @click=${this._onToggleRegex}
        >.*</button>
      </span>`
  }

  _onInput = (e) => {
    this._dispatchInput(e.target.value)
  }

  _onClear = () => {
    this._dispatchInput('')
  }

  _dispatchInput(value) {
    this.dispatchEvent(new CustomEvent('search-input', {
      detail: { kind: 'bundle-search', value },
      bubbles: true,
      composed: true,
    }))
  }

  _onToggleRegex = () => {
    this.dispatchEvent(new CustomEvent('bundle-search-regex-toggle', {
      bubbles: true,
      composed: true,
    }))
  }

  _onToggleCase = () => {
    this.dispatchEvent(new CustomEvent('bundle-search-case-toggle', {
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('bundle-search', BundleSearch)
