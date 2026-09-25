import { LitElement, css, html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { repeat } from 'lit/directives/repeat.js'
import '../view/scan-model-picker.js'
import './depth-toggle.js'
import { effortName, modelName } from '../view/scan-models.js'
import { REGIME_MODES, duplicateRegimes, normalizeAppModel, normalizeRegimes, sharedRegimeModel } from './regimes.js'

export class RegimeEditor extends LitElement {
  static properties = {
    value: { attribute: false }, loadModels: { attribute: false }, appModel: { attribute: false }, appModelAutomatic: { attribute: false },
    _rows: { state: true }, _loading: { state: true }, _error: { state: true },
    _resolvedAppModel: { state: true }, _appModelOpen: { state: true },
  }
  constructor() {
    super()
    this.value = []
    // Follow the shared regime settings until the app picker is edited.
    this.appModel = null
    this.appModelAutomatic = true
    this._resolvedAppModel = null
    this._appModelOpen = false
    this._appModelsAgree = true
    this._rows = []
    this._catalogue = { models: [] }
    this._nextId = 0
    this._loading = true
    this._error = null
  }
  disconnectedCallback() { super.disconnectedCallback(); this._controller?.abort() }
  updated(changed) {
    if (changed.has('loadModels')) { void this._load(); return }
    if (changed.has('value') && this.value !== this._lastEmitted && !this._loading) {
      this._setRows(this.value)
      this._notify()
    } else if ((changed.has('appModel') || changed.has('appModelAutomatic')) && !this._loading) this._notify()
  }
  _setRows(rows) {
    this._rows = normalizeRegimes(rows, this._catalogue).map(row => ({ ...row, id: row.id ?? ++this._nextId }))
  }
  _notify() {
    const value = this._loading && this._rows.length === 0 ? this.value : this._rows.map(({ id: _id, ...row }) => row)
    if (!this._loading) this._syncAppModel()
    const ready = !this._loading && !this._error && this._resolvedAppModel != null && value.length > 0 && !duplicateRegimes(value).includes(true)
    this._lastEmitted = value
    this.dispatchEvent(new CustomEvent('regimes-change', {
      detail: { value, ready, appModel: this._resolvedAppModel ?? this.appModel, appModelAutomatic: this.appModelAutomatic }, bubbles: true, composed: true,
    }))
  }
  _syncAppModel() {
    const shared = sharedRegimeModel(this._rows)
    const selection = normalizeAppModel((this.appModelAutomatic ? shared : null) ?? this.appModel ?? this._rows[0], this._catalogue)
    if (this.appModel?.model !== selection?.model || this.appModel?.effort !== selection?.effort) this.appModel = selection
    this._resolvedAppModel = this.appModel
    const agree = !!shared && shared.model === selection?.model && shared.effort === selection?.effort
    // Only an agreement transition changes the default disclosure state.
    // Ordinary renders must preserve the user's manual expand/collapse choice.
    if (agree !== this._appModelsAgree) this._appModelOpen = !agree
    this._appModelsAgree = agree
  }
  _changeAppModel(selection) {
    if (selection.model === this._resolvedAppModel?.model && selection.effort === this._resolvedAppModel?.effort) return
    this.appModelAutomatic = false
    this.appModel = { model: selection.model, effort: selection.effort }
    this._notify()
  }
  async _load() {
    this._controller?.abort()
    const controller = this._controller = new AbortController()
    this._loading = true
    this._error = null
    this._notify()
    try {
      const catalogue = await this.loadModels(controller.signal)
      if (controller.signal.aborted) return
      this._catalogue = catalogue
      // One catalogue request per editor, shared by every row's model picker.
      this._sharedModels = () => Promise.resolve(catalogue)
      this._setRows(this._rows.length > 0 ? this._rows : this.value)
    } catch (err) {
      if (!controller.signal.aborted) this._error = String(err?.message ?? err)
    } finally {
      if (!controller.signal.aborted) { this._loading = false; this._notify() }
    }
  }
  _change(id, patch) {
    const row = this._rows.find(candidate => candidate.id === id)
    if (!row) return
    const candidate = normalizeRegimes([{ ...row, ...patch }], this._catalogue)[0]
    if (!candidate) return
    this._rows = this._rows.map(other => other.id === id ? candidate : other)
    this._notify()
  }
  _add() {
    const next = this._rows.at(-1)
    if (!next) return
    this._rows = [...this._rows, { ...next, id: ++this._nextId }]
    this._notify()
  }
  _remove(id) {
    if (this._rows.length <= 1) return
    this._rows = this._rows.filter(row => row.id !== id)
    this._notify()
  }
  render() {
    const pending = this._loading && this._rows.length === 0
    const rows = pending ? (this.value.length > 0 ? this.value : [{ mode: 'generic', isolate: false }]).map((row, index) => ({ ...row, id: `pending-${index}` })) : this._rows
    const duplicates = duplicateRegimes(this._rows)
    return html`<section aria-label="Scan regimes" aria-busy=${this._loading}>
      <div class="heading"><h2>Scan regimes</h2><span>${rows.length} ${rows.length === 1 ? 'regime' : 'regimes'}</span></div>
      ${this._error ? html`<p class="message" role="alert">Couldn’t load models: ${this._error} <button type="button" @click=${() => void this._load()}>Retry</button></p>` : nothing}
      ${repeat(rows, row => row.id, (row, index) => this._row(row, index, duplicates[index], pending))}
      <div class="footer"><button type="button" class="add" ?disabled=${this._loading || this._rows.length === 0} @click=${this._add}><span aria-hidden="true">＋</span> Add regime</button><span class="message" role="status">${duplicates.includes(true) ? 'Change or remove duplicate regimes to run the scan' : 'Results from these regimes will be merged'}</span></div>
      ${pending ? html`<div class="app-model"><div class="app-model-placeholder">App model: Loading…</div></div>` : this._appModelRow()}
    </section>`
  }

  _appModelRow() {
    const selection = this._resolvedAppModel
    if (!selection) return nothing
    return html`<details class="app-model" .open=${live(this._appModelOpen)} @toggle=${event => { this._appModelOpen = event.currentTarget.open }}>
      <summary><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg><span class="app-model-name">App model: <strong>${modelName(selection.model)}</strong></span><span class="app-model-effort">Effort: <strong>${effortName(selection.effort)}</strong></span></summary>
      <div class="app-model-controls"><scan-model-picker .loadModels=${this._sharedModels} .value=${live(selection.model)} .effort=${live(selection.effort)} @model-change=${event => { event.stopPropagation(); this._changeAppModel(event.detail) }}></scan-model-picker></div>
    </details>`
  }
  _row(row, index, duplicate, pending = false) {
    return html`<div class=${`row${duplicate ? ' duplicate' : ''}`} ?inert=${pending} role="group" aria-label=${`Regime ${index + 1}`} aria-describedby=${duplicate ? `duplicate-${row.id}` : nothing}>
      <div class="mode" role="radiogroup" aria-label="Scan mode">${REGIME_MODES.map(mode => html`<label class="mode-choice"><input type="radio" name=${`regime-mode-${row.id}`} .checked=${row.mode === mode} @change=${() => this._change(row.id, { mode })}><span>${mode[0].toUpperCase() + mode.slice(1)}</span></label>`)}</div>
      <scan-model-picker .pending=${pending} .loadModels=${this._sharedModels} .value=${live(row.model)} .effort=${live(row.effort)} @model-change=${e => { e.stopPropagation(); this._change(row.id, e.detail) }}></scan-model-picker>
      <div class="row-actions">
        <scan-depth-toggle vertical .isolate=${row.isolate} @depth-change=${event => { event.stopPropagation(); this._change(row.id, { isolate: event.detail.isolate }) }}></scan-depth-toggle>
        ${duplicate ? html`<span class="duplicate-label" id=${`duplicate-${row.id}`}>Duplicate regime</span>` : nothing}
      </div>
      <button type="button" class="remove" aria-label=${`Remove regime ${index + 1}`} ?disabled=${this._rows.length === 1} @click=${() => this._remove(row.id)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>
    </div>`
  }
  static styles = css`
    :host { display: block; min-width: 0; container: regime-editor / inline-size; }
    * { box-sizing: border-box; }
    .heading { display: flex; align-items: baseline; gap: .65rem; margin-bottom: .75rem; }
    h2 { margin: 0; color: var(--text); font-size: .85rem; font-weight: 600; }
    .heading > span { color: var(--muted); font-size: .7rem; }
    .row { position: relative; display: grid; grid-template-columns: 7.75rem minmax(0, 1fr) 5.8rem; align-items: start; gap: 1rem; padding: .85rem 0; border-top: 1px solid var(--border); }
    .mode { display: grid; min-width: 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--bg); }
    .mode-choice { position: relative; user-select: none; }
    .mode-choice + .mode-choice { border-top: 1px solid var(--border); }
    .mode-choice input { position: absolute; width: 1px; height: 1px; opacity: 0; }
    .mode-choice span { display: block; padding: .2rem .6rem; color: var(--muted); font-size: .72rem; line-height: 1.15rem; }
    .mode-choice:hover span { background: var(--surface-active); }
    .mode-choice input:checked + span { color: var(--accent); background: rgb(from var(--accent) r g b / .1); box-shadow: inset 2px 0 var(--accent); font-weight: 600; }
    .mode-choice input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: -2px; }
    button { border: 1px solid var(--border); border-radius: 5px; color: var(--text); background: var(--bg); font: inherit; font-size: .74rem; cursor: default; }
    button { padding: .4rem .55rem; user-select: none; }
    button:hover:not(:disabled) { background: var(--surface-active); }
    button:disabled { opacity: .35; }
    .row-actions { position: relative; display: flex; align-items: center; align-self: stretch; min-height: 4.65rem; padding: .8rem 0 .25rem; }
    .remove { position: absolute; top: .15rem; right: 0; display: grid; place-items: center; width: 1.5rem; height: 1.5rem; padding: .25rem; border: 0; background: transparent; color: var(--muted); }
    .duplicate-label { position: absolute; right: .15rem; bottom: -.05rem; transform: rotate(-7deg); padding: .1rem .3rem; border: 1px solid rgb(from var(--critical, #e5534b) r g b / .45); border-radius: 3px; color: var(--critical, #e5534b); background: var(--surface); font-size: .6rem; line-height: 1rem; white-space: nowrap; pointer-events: none; user-select: none; }
    svg { width: 1rem; height: 1rem; }
    .footer { display: flex; flex-wrap: wrap; align-items: center; gap: .7rem; padding-top: .6rem; border-top: 1px solid var(--border); }
    .add { display: flex; align-items: center; gap: .3rem; }
    .app-model { margin-top: .7rem; border-top: 1px solid var(--border); }
    .app-model-placeholder { padding: .65rem 0 .1rem; color: var(--muted); font-size: .74rem; }
    .app-model > summary { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem .8rem; padding: .65rem 0 .1rem; color: var(--muted); font-size: .74rem; list-style: none; cursor: default; user-select: none; }
    .app-model > summary::-webkit-details-marker { display: none; }
    .app-model > summary:hover { color: var(--text); }
    .app-model > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }
    .app-model > summary svg { width: .8rem; height: .8rem; flex: 0 0 .8rem; }
    .app-model[open] > summary svg { transform: rotate(90deg); }
    .app-model strong { color: var(--text); font-weight: 500; }
    .app-model-name { min-width: 0; overflow-wrap: anywhere; }
    .app-model-effort { white-space: nowrap; }
    .app-model-controls { padding: .85rem 0 .15rem; }
    .message { margin: 0; color: var(--muted); font-size: .7rem; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @container regime-editor (max-width: 54rem) {
      .row { grid-template-columns: minmax(0, 1fr) 5.8rem; }
      scan-model-picker { grid-row: 2; grid-column: 1 / -1; }
      .mode { grid-column: 1; max-width: 9rem; } .row-actions { grid-column: 2; }
    }
  `
}
if (!customElements.get('scan-regime-editor')) customElements.define('scan-regime-editor', RegimeEditor)
