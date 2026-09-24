import { LitElement, css, html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { repeat } from 'lit/directives/repeat.js'
import '../view/scan-model-picker.js'
import './depth-toggle.js'
import { REGIME_MODES, duplicateRegimes, normalizeRegimes } from './regimes.js'

export class RegimeEditor extends LitElement {
  static properties = {
    value: { attribute: false }, loadModels: { attribute: false },
    _rows: { state: true }, _loading: { state: true }, _error: { state: true },
  }
  constructor() {
    super()
    this.value = []
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
    }
  }
  _setRows(rows) {
    this._rows = normalizeRegimes(rows, this._catalogue).map(row => ({ ...row, id: row.id ?? ++this._nextId }))
  }
  _notify() {
    const value = this._loading && this._rows.length === 0 ? this.value : this._rows.map(({ id: _id, ...row }) => row)
    const ready = !this._loading && !this._error && value.length > 0 && !duplicateRegimes(value).includes(true)
    this._lastEmitted = value
    this.dispatchEvent(new CustomEvent('regimes-change', { detail: { value, ready }, bubbles: true, composed: true }))
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
    const duplicates = duplicateRegimes(this._rows)
    return html`<section aria-label="Scan regimes" aria-busy=${this._loading}>
      <div class="heading"><h2>Scan regimes</h2><span>${this._rows.length} ${this._rows.length === 1 ? 'regime' : 'regimes'}</span></div>
      ${this._error ? html`<p class="message" role="alert">Couldn’t load models: ${this._error} <button type="button" @click=${() => void this._load()}>Retry</button></p>`
        : this._loading && this._rows.length === 0 ? html`<p class="message" role="status">Loading models…</p>`
          : html`${repeat(this._rows, row => row.id, (row, index) => this._row(row, index, duplicates[index]))}
            <div class="footer"><button type="button" class="add" ?disabled=${this._rows.length === 0} @click=${this._add}><span aria-hidden="true">＋</span> Add regime</button><span class="message" role="status">${duplicates.includes(true) ? 'Change or remove duplicate regimes to run the scan' : 'Results from these regimes will be merged'}</span></div>`}
    </section>`
  }
  _row(row, index, duplicate) {
    return html`<div class=${`row${duplicate ? ' duplicate' : ''}`} role="group" aria-label=${`Regime ${index + 1}`} aria-describedby=${duplicate ? `duplicate-${row.id}` : nothing}>
      <div class="mode" role="radiogroup" aria-label="Scan mode">${REGIME_MODES.map(mode => html`<label class="mode-choice"><input type="radio" name=${`regime-mode-${row.id}`} .checked=${row.mode === mode} @change=${() => this._change(row.id, { mode })}><span>${mode[0].toUpperCase() + mode.slice(1)}</span></label>`)}</div>
      <scan-model-picker .loadModels=${this._sharedModels} .value=${live(row.model)} .effort=${live(row.effort)} @model-change=${e => { e.stopPropagation(); this._change(row.id, e.detail) }}></scan-model-picker>
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
