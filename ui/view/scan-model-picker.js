import { LitElement, css, html, nothing } from 'lit'
import { defaultEffort, effortName, fetchScanModels, modelDeveloper, modelName } from './scan-models.js'

const CHEVRON = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>`

function developerIcon(key) {
  // Google is the one provider mark whose identity depends on its four
  // colours.  The other local marks are deliberately monochrome SVG masks so
  // they inherit the provider colour from the surrounding icon slot; keeping
  // this one inline lets the picker retain Google's recognisable palette.
  if (key === 'google') {
    return html`<svg class="google-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.35 12.27c0-.79-.07-1.55-.2-2.27H12v4.3h5.24a4.48 4.48 0 0 1-1.94 2.94v2.45h3.15c1.85-1.7 2.9-4.2 2.9-7.42Z"/>
      <path fill="#34A853" d="M12 21.8c2.64 0 4.86-.87 6.48-2.35l-3.15-2.45c-.87.58-1.98.92-3.33.92-2.56 0-4.73-1.73-5.51-4.06H3.24v2.52A9.8 9.8 0 0 0 12 21.8Z"/>
      <path fill="#FBBC05" d="M6.49 13.86a5.9 5.9 0 0 1 0-3.72V7.62H3.24a9.8 9.8 0 0 0 0 8.76l3.25-2.52Z"/>
      <path fill="#EA4335" d="M12 6.08c1.43 0 2.72.49 3.74 1.45l2.8-2.8C16.85 3.14 14.63 2.2 12 2.2a9.8 9.8 0 0 0-8.76 5.42l3.25 2.52C7.27 7.81 9.44 6.08 12 6.08Z"/>
    </svg>`
  }
  const iconFiles = { openai: 'openai', anthropic: 'claude', moonshotai: 'moonshot', nvidia: 'nvidia', qwen: 'qwen', deepseek: 'deepseek' }
  if (iconFiles[key]) return html`<span class="provider-mark" style=${`--provider-icon: url('/provider-icons/${iconFiles[key]}.svg')`} aria-hidden="true"></span>`
  return html`<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="3"/><path d="M8 1v3m4-3v3M8 16v3m4-3v3M1 8h3m-3 4h3m12-4h3m-3 4h3"/></svg>`
}

function modelSections(models) {
  const groups = Map.groupBy(models, model => modelDeveloper(model.id).key)
  return [...groups].flatMap(([key, entries]) => {
    // A long provider can use several columns instead of making one tall
    // column beside short groups. Repeat its heading at each continuation,
    // and balance the chunks so the final one is not a single stranded model.
    const size = Math.ceil(entries.length / Math.ceil(entries.length / 8))
    const sections = []
    for (let start = 0; start < entries.length; start += size) sections.push({ key, models: entries.slice(start, start + size) })
    return sections
  })
}

class ScanModelPicker extends LitElement {
  static properties = {
    value: { attribute: false }, effort: { attribute: false },
    hasExtra: { type: Boolean, attribute: 'has-extra' },
    _models: { state: true }, _error: { state: true },
  }

  static styles = css`
    :host { display: block; min-width: 0; }
    * { box-sizing: border-box; }
    .layout { display: grid; grid-template-columns: minmax(13rem, 1fr) minmax(14rem, 1fr); gap: 1.25rem; align-items: start; }
    .layout.with-extra { grid-template-columns: minmax(13rem, .9fr) minmax(14rem, 1.2fr) minmax(14rem, auto); }
    .field { min-width: 0; }
    .label { display: flex; justify-content: space-between; align-items: center; margin-bottom: .4rem; color: var(--muted); font-size: .72rem; }
    output { color: var(--text); font-size: .72rem; font-weight: 500; }
    details { position: relative; }
    summary { display: flex; align-items: center; gap: .55rem; padding: .5rem .6rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); list-style: none; transition: border-color .12s, background .12s; }
    summary:hover, details[open] summary { border-color: var(--muted); background: var(--surface-active); }
    summary::-webkit-details-marker { display: none; }
    summary > svg { width: .9rem; height: .9rem; margin-left: auto; color: var(--muted); }
    .selected-copy { display: grid; gap: .1rem; min-width: 0; }
    .selected-copy strong { font-size: .8rem; font-weight: 500; }
    .selected-copy small { color: var(--muted); font-size: .63rem; }
    /* Every provider and model row shares the same visual column.  Keeping a
       real slot (rather than letting each SVG size itself) prevents wide
       marks such as Moonshot and Qwen from shifting the text column. */
    .icon { display: inline-grid; place-items: center; width: 1.7rem; height: 1.5rem; flex: 0 0 1.7rem; color: var(--text); }
    .icon svg { display: block; width: 1.1rem; height: 1.1rem; }
    .provider-mark { display: block; width: 1.12rem; height: 1.12rem; background: currentColor; -webkit-mask: var(--provider-icon) center / contain no-repeat; mask: var(--provider-icon) center / contain no-repeat; }
    .icon.openai { color: #10a37f; }
    .icon.anthropic { color: #d97757; }
    .icon.moonshotai { color: #8068d9; }
    .icon.google { color: #4285f4; }
    .icon.nvidia { color: #76b900; }
    .icon.qwen { color: #f97316; }
    .icon.deepseek { color: #4d8dff; }
    /* These marks have generous or unusually dense source viewBoxes.  A
       small optical correction keeps every provider mark the same apparent
       weight in both the selected value and the menu heading. */
    .icon.moonshotai .provider-mark { transform: scale(.78); }
    .icon.qwen .provider-mark { transform: scale(.82); }
    .icon.nvidia .provider-mark { transform: scale(.86); }
    .icon.deepseek .provider-mark { transform: scale(.9); }
    .extra { display: flex; min-width: 0; min-height: 4.9rem; align-items: flex-end; align-self: end; padding-bottom: .05rem; }
    ::slotted(.effort-switch) { margin-top: 0 !important; }
    /* The picker lives low in a long scan form. A fixed menu, positioned from
       the summary at open time, keeps it above the viewport edge and outside
       any panel's clipping context. */
    .menu { position: fixed; z-index: 1000; width: min(46rem, calc(100vw - 1rem)); max-height: calc(100dvh - 1rem); overflow: auto; overscroll-behavior: contain; padding: .65rem; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-active); color: var(--text); box-shadow: 0 .65rem 1.8rem rgb(0 0 0 / .55); }
    /* Balance whole provider groups down the columns. Keep the unconstrained
       column container inside the scrollport so short screens scroll down,
       rather than creating more columns outside the menu. */
    .groups { column-count: var(--model-columns, 1); column-gap: 1rem; }
    fieldset { min-width: 0; margin: 0 0 .6rem; padding: 0; border: 0; break-inside: avoid; }
    legend { display: flex; align-items: center; gap: .45rem; width: 100%; min-height: 1.9rem; padding: .35rem .5rem .25rem; border-bottom: 1px solid rgb(from var(--border) r g b / .7); color: var(--muted); font-size: .64rem; font-weight: 700; letter-spacing: .055em; text-transform: uppercase; }
    /* Keep provider names on the same text column as model choices.  The
       radio and provider mark both occupy a fixed slot, while the marks are
       optically normalized so their source viewBoxes cannot dominate. */
    legend .icon { width: .88rem; height: 1.25rem; flex-basis: .88rem; }
    legend .icon svg { width: .88rem; height: .88rem; }
    legend .provider-mark { width: .88rem; height: .88rem; }
    .choice { display: flex; align-items: center; gap: .5rem; padding: .4rem .5rem; border-radius: 4px; font-size: .76rem; }
    .choice:hover { background: rgb(from var(--text) r g b / .05); }
    .choice:has(:checked) { color: var(--accent); background: rgb(from var(--accent) r g b / .1); }
    .choice input { margin: 0; accent-color: var(--accent); }
    .choice span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .slider { padding: .15rem .3rem 0; }
    input[type=range] { display: block; width: 100%; margin: .4rem 0 .5rem; accent-color: var(--accent); }
    .steps { display: flex; justify-content: space-between; margin: 0 -.3rem; }
    .step { position: relative; padding: .35rem .3rem 0; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: .62rem; cursor: default; }
    .step::before { content: ''; position: absolute; top: 0; left: 50%; width: 1px; height: .2rem; background: var(--muted); }
    .step.active { color: var(--accent); }
    :is(summary, input, button):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .message { margin: 0; color: var(--muted); font-size: .75rem; }
    .error { color: var(--critical, #e5534b); }
    .retry { margin-left: .5rem; padding: .2rem .4rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text); font: inherit; }
    @media (max-width: 60rem) { .layout.with-extra { grid-template-columns: minmax(13rem, 1fr) minmax(14rem, 1fr); } .layout.with-extra .extra { grid-column: 1 / -1; align-self: start; min-height: 0; } }
    @media (max-width: 45rem) { .layout, .layout.with-extra { grid-template-columns: 1fr; gap: 1rem; } .layout.with-extra .extra { grid-column: auto; } }
  `

  constructor() {
    super()
    this.value = null
    this.effort = null
    this.hasExtra = false
    this._models = []
    this._error = null
    this._onOutside = (event) => { if (!event.composedPath().includes(this)) this._close() }
    this._onViewportChange = () => this._positionMenu()
  }

  connectedCallback() {
    super.connectedCallback()
    document.addEventListener('pointerdown', this._onOutside)
    window.addEventListener('resize', this._onViewportChange)
    window.addEventListener('scroll', this._onViewportChange, true)
    void this._load()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._controller?.abort()
    document.removeEventListener('pointerdown', this._onOutside)
    window.removeEventListener('resize', this._onViewportChange)
    window.removeEventListener('scroll', this._onViewportChange, true)
  }

  async _load() {
    this._controller?.abort()
    const controller = new AbortController()
    this._controller = controller
    this._error = null
    try {
      const data = await fetchScanModels(controller.signal)
      if (controller.signal.aborted) return
      this._models = data.models
      const selected = data.models.find((model) => model.id === this.value)
      if (!selected) this._select(data.defaultModel)
      else if (!selected.efforts.includes(this.effort)) this._setEffort(defaultEffort(selected))
    } catch (err) {
      if (!controller.signal.aborted) this._error = String(err?.message ?? err)
    }
  }

  _close() {
    const details = this.renderRoot.querySelector('details')
    if (details) details.open = false
  }

  _positionMenu() {
    const details = this.renderRoot.querySelector('details')
    const summary = this.renderRoot.querySelector('summary')
    const menu = this.renderRoot.querySelector('.menu')
    if (!details?.open || !summary || !menu) return
    const rect = summary.getBoundingClientRect()
    const gap = 6
    const margin = 8
    const sections = modelSections(this._models)
    const preferredColumns = Math.min(3, sections.length, Math.ceil((this._models.length + sections.length * 1.5) / 9))
    // Measure the untruncated labels instead of stretching every group to a
    // fixed wide cell. Bound very long future names, which can still ellipsize.
    const fontSize = parseFloat(getComputedStyle(menu).fontSize)
    let contentWidth = 0
    for (const label of menu.querySelectorAll('.choice span, legend')) {
      const range = document.createRange()
      range.selectNodeContents(label)
      contentWidth = Math.max(contentWidth, range.getBoundingClientRect().width)
    }
    const columnWidth = Math.max(11 * fontSize, Math.min(18 * fontSize, contentWidth + 2.5 * fontSize))
    const padding = 1.3 * fontSize + 2
    const columns = Math.max(1, Math.min(preferredColumns, Math.floor((window.innerWidth - margin * 2 - padding + fontSize) / (columnWidth + fontSize))))
    const width = Math.min(columns * columnWidth + (columns - 1) * fontSize + padding, window.innerWidth - margin * 2)
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))
    menu.style.left = `${left}px`
    menu.style.width = `${width}px`
    menu.style.setProperty('--model-columns', columns)
    menu.style.maxHeight = `${Math.max(0, window.innerHeight - margin * 2)}px`
    // Measure after reflow: a wide picker needs much less height. Prefer the
    // side that fits it, then clamp within the viewport on short screens.
    const height = menu.getBoundingClientRect().height
    const below = window.innerHeight - rect.bottom - gap - margin
    const above = rect.top - gap - margin
    const top = below < height && above > below ? rect.top - gap - height : rect.bottom + gap
    menu.style.bottom = 'auto'
    menu.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`
  }

  _select(id) {
    const model = this._models.find((entry) => entry.id === id)
    if (!model) return
    this.value = id
    this._setEffort(defaultEffort(model))
    this._close()
  }

  _setEffort(effort) {
    this.effort = effort
    this.dispatchEvent(new CustomEvent('model-change', { detail: { model: this.value, effort }, bubbles: true, composed: true }))
  }

  render() {
    if (this._error) return html`<p class="message error" role="alert">Couldn’t load models: ${this._error}<button class="retry" @click=${() => void this._load()}>Retry</button></p>`
    const selected = this._models.find((model) => model.id === this.value)
    if (!selected) return html`<p class="message" role="status">Loading models…</p>`
    const developer = modelDeveloper(selected.id)
    const sections = modelSections(this._models)
    return html`<div class=${`layout ${this.hasExtra ? 'with-extra' : ''}`}>
      <div class="field"><span class="label" id="model-label">Model</span>
        <details @toggle=${() => requestAnimationFrame(() => this._positionMenu())} @keydown=${(event) => { if (event.key === 'Escape') { this._close(); this.renderRoot.querySelector('summary')?.focus() } }}>
          <summary aria-labelledby="model-label selected-model"><span class=${`icon ${developer.key}`}>${developerIcon(developer.key)}</span><span class="selected-copy"><strong id="selected-model">${modelName(selected.id)}</strong><small>${developer.name}</small></span>${CHEVRON}</summary>
          <div class="menu"><div class="groups">${sections.map(({ key, models }) => html`<fieldset><legend><span class=${`icon ${key}`}>${developerIcon(key)}</span>${modelDeveloper(models[0].id).name}</legend>${models.map((model) => html`<label class="choice"><input type="radio" name="scan-model" value=${model.id} .checked=${model.id === this.value} @change=${() => { this._select(model.id); this.renderRoot.querySelector('summary')?.focus() }}><span>${modelName(model.id)}</span></label>`)}</fieldset>`)}</div></div>
        </details>
      </div>
      ${selected.efforts.length > 0 ? this._effortSlider(selected.efforts) : nothing}
      ${this.hasExtra ? html`<div class="extra"><slot name="effort-extra"></slot></div>` : nothing}
    </div>`
  }

  _effortSlider(efforts) {
    const index = Math.max(0, efforts.indexOf(this.effort))
    return html`<div class="field"><div class="label"><label for="effort">Effort</label><output for="effort">${effortName(efforts[index])}</output></div>
      <div class="slider"><input id="effort" type="range" min="0" max=${Math.max(1, efforts.length - 1)} step="1" .value=${String(index)} ?disabled=${efforts.length === 1} aria-valuetext=${effortName(efforts[index])} @input=${(event) => this._setEffort(efforts[Number(event.target.value)])}>
        <div class="steps">${efforts.map((effort) => html`<button type="button" class=${`step ${effort === this.effort ? 'active' : ''}`} aria-label=${`Set effort to ${effortName(effort)}`} aria-pressed=${effort === this.effort} @click=${() => this._setEffort(effort)}>${effortName(effort)}</button>`)}</div>
      </div></div>`
  }
}

customElements.define('scan-model-picker', ScanModelPicker)
