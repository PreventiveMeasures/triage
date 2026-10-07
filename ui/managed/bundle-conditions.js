import { LitElement, html, nothing, svg, unsafeCSS } from 'lit'
import commonStyles from './styles/common.css'
import styles from './styles/bundle-conditions.css'

// The conditions Stasis always resolves with: Node's own for Node.js builds, and
// a bundler's (as esbuild, webpack and Metro assert) for Browser and Metro.
const BUNDLER_AUTOMATIC = ['import', 'require', 'default']
const NODE_AUTOMATIC = [...BUNDLER_AUTOMATIC, 'node', 'node-addons', 'module-sync']
const PRESETS = [
  { id: 'node', label: 'Node.js', conditions: ['node'], automatic: NODE_AUTOMATIC, icon: svg`<path d="m8 1.5 5.5 3.2v6.6L8 14.5l-5.5-3.2V4.7Z"/><path d="M6 10V6l4 4V6"/>` },
  { id: 'browser', label: 'Browser', conditions: ['browser', 'module'], automatic: BUNDLER_AUTOMATIC, icon: svg`<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 6h13M4 4.3h.1m2 0h.1"/>` },
  { id: 'metro', label: 'Metro', conditions: ['react-native'], automatic: BUNDLER_AUTOMATIC, icon: svg`<rect x="4" y="1.5" width="8" height="13" rx="2"/><path d="M6.5 3.5h3M7 12.5h2"/>` },
]
// Manual conditions follow every preset, so they must fit beside the longest
// one within the server's limit of 16.
const MANUAL_LIMIT = 16 - Math.max(...PRESETS.map(preset => preset.conditions.length))
const PLATFORMS = [{ id: 'ios', label: 'iOS' }, { id: 'android', label: 'Android' }]
const conjunction = new Intl.ListFormat('en', { type: 'conjunction' })

export function defaultBundleConditions() {
  return { preset: 'node', conditions: ['node'], platforms: [] }
}

export class BundleConditions extends LitElement {
  static styles = [unsafeCSS(commonStyles), unsafeCSS(styles)]
  static properties = {
    showConditions: { attribute: false },
    _preset: { state: true }, _manual: { state: true }, _platforms: { state: true },
    _draft: { state: true }, _error: { state: true }, _manualOpen: { state: true },
  }

  constructor() {
    super()
    this.showConditions = true
    this._preset = 'node'
    this._manual = []
    this._platforms = ['ios', 'android']
    this._draft = ''
    this._error = ''
    this._manualOpen = false
  }

  get value() {
    return { preset: this._preset, conditions: this.conditions, platforms: this._preset === 'metro' ? [...this._platforms] : [] }
  }

  get presetConditions() {
    return PRESETS.find(item => item.id === this._preset).conditions
  }

  get automaticConditions() {
    return PRESETS.find(item => item.id === this._preset).automatic
  }

  // The preset's condition leads and cannot be removed. Manual conditions follow
  // it and survive preset switches, except under Metro, which sets its own.
  get conditions() {
    return [...new Set([...this.presetConditions, ...(this._preset === 'metro' ? [] : this._manual)])]
  }

  notifyChange() {
    this.dispatchEvent(new CustomEvent('conditions-change', { detail: this.value, bubbles: true, composed: true }))
  }

  selectPreset(id) {
    const preset = PRESETS.find(item => item.id === id)
    if (!preset) return
    this._preset = id
    this._draft = ''
    this._error = ''
    this.notifyChange()
  }

  togglePlatform(platform) {
    if (!PLATFORMS.some(item => item.id === platform)) return
    const selected = this._platforms.includes(platform)
    if (selected && this._platforms.length === 1) return
    this._platforms = PLATFORMS.map(item => item.id).filter(id => id === platform ? !selected : this._platforms.includes(id))
    this.notifyChange()
  }

  addConditions() {
    if (this._preset === 'metro') return
    const names = this._draft.trim().split(/[\s,]+/u).filter(Boolean)
    if (names.length === 0) return
    if (names.some(name => this.automaticConditions.includes(name) && !this.presetConditions.includes(name))) {
      this._error = `${conjunction.format(this.automaticConditions)} are handled automatically.`
      return
    }
    if (names.some(name => name.length > 64 || name.startsWith('.') || /^\d+$/u.test(name))) {
      this._error = 'Use condition names of up to 64 characters, without a leading dot or an all-numeric name.'
      return
    }
    const manual = [...new Set([...this._manual, ...names.filter(name => !this.presetConditions.includes(name))])]
    if (manual.length > MANUAL_LIMIT) {
      this._error = `Use up to ${MANUAL_LIMIT} manual conditions.`
      return
    }
    this._manual = manual
    this._draft = ''
    this._error = ''
    this.notifyChange()
  }

  removeCondition(name) {
    if (this.presetConditions.includes(name)) return
    this._manual = this._manual.filter(condition => condition !== name)
    this._error = ''
    this.notifyChange()
  }

  render() {
    // Stasis's Metro preset sets its own conditions, so they are not editable.
    const manual = this._preset !== 'metro'
    // The help line names import / require together, then the rest.
    const others = this.automaticConditions.filter(name => name !== 'import' && name !== 'require')
    return html`<section aria-label=${this.showConditions ? 'Conditions' : 'Bundle actions'}>
      <div class="conditions-head" ?data-conditions-hidden=${!this.showConditions}>
        <h2 id="conditions-heading">Conditions</h2>
        <div class="presets" role="group" aria-label="Condition preset">${PRESETS.map(preset => html`<button type="button" aria-pressed=${this._preset === preset.id} @click=${() => this.selectPreset(preset.id)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${preset.icon}</svg>${preset.label}</button>`)}</div>
        ${this._preset === 'metro' ? html`<div class="platforms" role="group" aria-label="Metro platforms"><span>Platforms</span>${PLATFORMS.map(({ id, label }) => html`<label><input type="checkbox" .checked=${this._platforms.includes(id)} ?disabled=${this._platforms.includes(id) && this._platforms.length === 1} @change=${() => this.togglePlatform(id)}>${label}</label>`)}</div>` : nothing}
        <button type="button" class="manual-toggle" ?hidden=${!manual} aria-expanded=${this._manualOpen} aria-controls="manual-conditions" @click=${() => { this._manualOpen = !this._manualOpen }}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>Manual conditions</button>
        <slot name="actions"></slot>
      </div>
      <div id="manual-conditions" ?hidden=${!this.showConditions || !manual || !this._manualOpen}>
        <form class="condition-editor" @submit=${event => { event.preventDefault(); this.addConditions() }}>
        <ul aria-label="Export conditions">${this.conditions.map(name => this.presetConditions.includes(name) ? html`<li class="preset"><code>${name}</code></li>` : html`<li><code>${name}</code><button type="button" aria-label=${`Remove condition ${name}`} @click=${() => this.removeCondition(name)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></li>`)}</ul>
        <div class="condition-input"><input type="text" aria-label="Add conditions" aria-describedby="conditions-help" aria-invalid=${Boolean(this._error)} aria-errormessage="condition-error" placeholder="Add condition…" autocomplete="off" maxlength="1040" .value=${this._draft} @input=${event => { this._draft = event.target.value; this._error = '' }}
          @keydown=${event => { if (event.key === ' ' && !event.isComposing) { event.preventDefault(); this.addConditions() } }} @blur=${() => this.addConditions()}></div>
        </form>
        <p id="conditions-help">Package export conditions. <code>import</code> / <code>require</code>${others.map((name, i) => html`${i < others.length - 1 ? ', ' : others.length > 1 ? ', and ' : ' and '}<code>${name}</code>`)} are automatic.</p>
        ${this._error ? html`<p id="condition-error" class="error" role="alert">${this._error}</p>` : nothing}
      </div>
    </section>`
  }
}

customElements.define('bundle-conditions', BundleConditions)
