import { LitElement, css, html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { scanScopeOptions } from '../scan/scopes.js'

// Full scope control shared by Scan, Compare, Advisories, Treemap, and the bundle graph. Keep IDs
// intact: presentation recognizes standard scopes, while custom bundle scopes remain selectable.
// `--scope-height` lets a host toolbar match its control height (default 2rem options, auto select).
export class BundleScopeSelector extends LitElement {
  static properties = { reasons: { attribute: false }, value: { attribute: false }, label: { type: String } }
  constructor() { super(); this.reasons = []; this.value = ''; this.label = 'Choose scope' }
  _select(value) { this.dispatchEvent(new CustomEvent('scope-change', { detail: { value }, bubbles: true, composed: true })) }
  render() {
    const reasons = this.reasons.filter(reason => reason.id !== 'all')
    if (reasons.length === 0) return nothing
    const options = scanScopeOptions(reasons)
    if (!options) return html`<label class="scope-field"><span>Scope</span><select aria-label=${this.label} .value=${live(this.value === 'all' ? '' : this.value)} @change=${event => this._select(event.target.value)}><option value="">All files</option>${reasons.map(reason => html`<option value=${reason.id}>${reason.label ?? reason.id}</option>`)}</select></label>`
    const selected = options.find(option => option.id === this.value) ?? options[0]
    return html`<div class="scope-toggle"><div class="scope-options" role="radiogroup" aria-label=${this.label} aria-describedby="scope-description">${options.map(option => html`<label class="scope-option"><input type="radio" name="scope" value=${option.id} .checked=${selected.id === option.id} @change=${() => this._select(option.id)}><span>${option.label}</span></label>`)}</div><span class="scope-description" id="scope-description">${selected.subtitle}</span></div>`
  }
  static styles = css`
    :host { display: block; min-width: 0; }
    * { box-sizing: border-box; }
    .scope-toggle, .scope-field { cursor: default; user-select: none; -webkit-user-select: none; }
    .scope-toggle { display: flex; align-items: center; justify-content: end; flex-wrap: wrap; gap: .4rem .7rem; min-width: 0; min-height: var(--scope-height, 2rem); }
    .scope-options { display: flex; flex-shrink: 0; min-width: 0; border: 1px solid var(--border); border-radius: var(--ui-radius, 5px); overflow: hidden; background: var(--bg); }
    .scope-option { position: relative; flex: 1 0 auto; }
    .scope-option + .scope-option { border-left: 1px solid var(--border); }
    .scope-option input { position: absolute; width: 1px; height: 1px; opacity: 0; }
    .scope-option span { display: grid; place-items: center; height: calc(var(--scope-height, 2rem) - 2px); padding: .3rem .55rem; color: var(--muted); font-size: .74rem; white-space: nowrap; }
    .scope-option:hover span { color: var(--text); background: var(--surface-active); }
    .scope-option input:checked + span { color: var(--text); background: var(--surface-active); font-weight: 500; }
    .scope-option input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: -2px; }
    .scope-description { order: -1; min-width: 0; color: var(--muted); font-size: .66rem; line-height: 1rem; text-align: right; }
    .scope-field { display: flex; align-items: center; justify-content: end; gap: .5rem; min-width: 0; max-width: 100%; margin-left: auto; color: var(--muted); font-size: .7rem; }
    select { width: 13rem; height: var(--scope-height, auto); min-width: 0; max-width: 100%; padding: .35rem .5rem; border: 1px solid var(--border); border-radius: var(--ui-radius, 5px); background: var(--bg); color: var(--text); font: inherit; font-size: .76rem; }
    :host([compact]) .scope-toggle { min-height: 0; gap: .3rem .5rem; }
    :host([compact]) .scope-option span { height: auto; padding: 2px 8px; font-size: .68rem; line-height: 1.2; }
    :host([compact]) .scope-field { font-size: .68rem; }
    :host([compact]) .scope-description { display: none; }
    :host([compact]) select { width: auto; max-width: 22ch; padding: 2px 6px; font-size: .68rem; line-height: 1.2; }
  `
}
if (!customElements.get('bundle-scope-selector')) customElements.define('bundle-scope-selector', BundleScopeSelector)
