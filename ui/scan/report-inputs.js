import { LitElement, css, html, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { REPORT_FILE_ICONS } from '../view/report-logos.js'
import { modelName } from '../view/scan-models.js'
import '../view/bundle-selector.js'
import '../view/repository-selector.js'
import '../view/workspace-selector.js'

const emptySelection = kind => ({ kind, sourceId: null, ids: new Set() })

export class ReportInputs extends LitElement {
  static properties = {
    mode: { type: String }, loadSources: { attribute: false }, restore: { attribute: false },
    _sources: { state: true }, _loading: { state: true }, _error: { state: true },
    _merge: { state: true }, _link: { state: true },
  }
  constructor() {
    super()
    this.mode = 'link'
    this._sources = null
    this._loading = false
    this._error = null
    this._merge = emptySelection('bundle')
    this._link = emptySelection('repository')
  }
  disconnectedCallback() { super.disconnectedCallback(); this._controller?.abort() }
  updated(changed) {
    if (changed.has('loadSources')) { void this._load(); return }
    if (changed.has('mode')) this._selectOnlySource()
    if (changed.has('restore')) this._restore()
    if (['_sources', '_merge', '_link', 'mode', 'restore'].some(key => changed.has(key))) this._notify()
  }
  get _current() { return this.mode === 'merge' ? this._merge : this._link }
  get _parents() {
    if (this.mode === 'merge') return this._sources?.merge?.bundles ?? []
    const reports = this._sources?.link?.reports ?? []
    return this._current.kind === 'workspace'
      ? (this._sources?.link?.workspaces ?? []).filter(workspace => reports.some(report => workspace.reports.includes(report.id)))
      : (this._sources?.link?.repositories ?? []).filter(repo => reports.some(report => report.repoIds.includes(repo.id)))
  }
  get _parent() { return this._parents.find(parent => parent.id === this._current.sourceId) }
  get _scopeOptions() {
    const reports = this._sources?.link?.reports ?? []
    return this._parents.map(parent => {
      const count = reports.filter(report => this._current.kind === 'workspace' ? parent.reports.includes(report.id) : report.repoIds.includes(parent.id)).length
      return { value: parent.id, label: parent.label, detail: `${count} ${count === 1 ? 'report' : 'reports'}` }
    })
  }
  get _inputs() {
    if (!this._parent) return []
    if (this.mode === 'merge') return (this._sources?.merge?.results ?? []).filter(result => result.bundleId === this._parent.id)
    return (this._sources?.link?.reports ?? []).filter(report => this._current.kind === 'workspace'
      ? this._parent.reports.includes(report.id) : report.repoIds.includes(this._parent.id))
  }
  get selection() {
    const parent = this._parent
    return { mode: this.mode, source: parent ? { kind: this._current.kind, id: parent.id, label: parent.label ?? parent.filename } : null,
      inputs: this._loading || this._error ? [] : this._inputs.filter(input => this._current.ids.has(input.id)) }
  }
  _notify() { this.dispatchEvent(new CustomEvent('report-inputs-change', { detail: this.selection, bubbles: true, composed: true })) }
  async _load() {
    this._controller?.abort()
    const controller = this._controller = new AbortController()
    this._loading = true
    this._error = null
    this._notify()
    try {
      const sources = this.loadSources ? await this.loadSources(controller.signal) : { merge: { bundles: [], results: [] }, link: { repositories: [], reports: [] } }
      if (controller.signal.aborted) return
      this._sources = sources
      this._merge = emptySelection('bundle')
      this._link = emptySelection(Array.isArray(sources.link?.workspaces) ? 'workspace' : 'repository')
      this._selectOnlySource()
      this._restore()
    } catch (err) {
      if (!controller.signal.aborted) this._error = String(err?.message ?? err)
    } finally {
      if (!controller.signal.aborted) { this._loading = false; this._notify() }
    }
  }
  _setCurrent(value) { if (this.mode === 'merge') this._merge = value; else this._link = value }
  _selectSource(id) {
    if (id === this._current.sourceId || !this._parents.some(parent => parent.id === id)) return
    this._setCurrent({ ...this._current, sourceId: id, ids: new Set() })
    this._setCurrent({ ...this._current, ids: new Set(this._inputs.map(input => input.id)) })
    this._notify()
  }
  _changeKind(kind) {
    if (!['workspace', 'repository'].includes(kind)) return
    if (kind === 'workspace' && !Array.isArray(this._sources?.link?.workspaces)) return
    if (kind !== this._link.kind) this._link = emptySelection(kind)
    this._selectOnlySource()
    this._notify()
  }
  _selectOnlySource() {
    if (this.mode === 'link' && this._current.sourceId == null && this._parents.length === 1) this._selectSource(this._parents[0].id)
  }
  _toggle(id, checked) {
    if (!this._inputs.some(input => input.id === id)) return
    const ids = new Set(this._current.ids)
    if (checked) ids.add(id); else ids.delete(id)
    this._setCurrent({ ...this._current, ids })
    this._notify()
  }
  _selectAll(checked) {
    this._setCurrent({ ...this._current, ids: new Set(checked ? this._inputs.map(input => input.id) : []) })
    this._notify()
  }
  _restore() {
    const restore = this.restore
    if (!this._sources || restore?.mode !== this.mode || !restore.source) return
    const kind = this.mode === 'merge' ? 'bundle' : restore.source.kind
    if (this.mode === 'link' && (kind === 'workspace' ? !Array.isArray(this._sources.link?.workspaces) : kind !== 'repository')) return
    this._setCurrent({ kind, sourceId: restore.source.id, ids: new Set() })
    this._setCurrent({ ...this._current, ids: new Set(this._inputs.filter(input => restore.inputIds.includes(input.id)).map(input => input.id)) })
  }
  render() {
    const merge = this.mode === 'merge'
    const inputs = this._inputs
    const selected = this.selection.inputs.length
    const hasWorkspaces = Array.isArray(this._sources?.link?.workspaces)
    const empty = this._parent ? (merge ? 'No scan results for this bundle.' : `No saved reports in this ${this._current.kind}.`)
      : merge ? 'Choose a bundle to see its scan results.' : this._parents.length === 0 ? 'No saved reports with app findings.' : `Choose a ${this._current.kind} to see its saved reports.`
    return html`<section class="panel" aria-label=${merge ? 'Merge scan results' : 'Link saved reports'} aria-busy=${this._loading}>
      <div class="source">
        ${!merge && hasWorkspaces ? html`<div class="kinds" role="radiogroup" aria-label="Report source">${[['workspace', 'Workspace'], ['repository', 'Repository']].map(([kind, label]) => html`<button type="button" role="radio" aria-checked=${kind === this._link.kind} @click=${() => this._changeKind(kind)}>${label}</button>`)}</div>` : nothing}
        <div class="field">${merge ? html`<span>Bundle with scan results</span>` : nothing}
          ${merge ? html`<bundle-selector .bundles=${this._parents} .value=${this._current.sourceId} ?disabled=${this._loading || this._parents.length === 0} @bundle-change=${e => this._selectSource(e.detail.value)}></bundle-selector>`
            : this._current.kind === 'workspace' ? html`<workspace-selector .options=${this._scopeOptions} .value=${this._current.sourceId} ?disabled=${this._loading} @workspace-change=${e => this._selectSource(e.detail.value)}></workspace-selector>`
              : html`<repository-selector .options=${this._scopeOptions} .value=${this._current.sourceId} ?disabled=${this._loading} @repository-change=${e => this._selectSource(e.detail.value)}></repository-selector>`}
        </div>
      </div>
      ${this._error ? html`<p class="empty" role="alert">Couldn’t load report inputs: ${this._error} <button type="button" @click=${() => void this._load()}>Retry</button></p>`
        : this._loading ? html`<p class="empty" role="status">Loading report inputs…</p>`
          : inputs.length > 0 ? html`<div class="list-head"><label><input type="checkbox" aria-label="Select all" .checked=${selected === inputs.length} .indeterminate=${selected > 0 && selected < inputs.length} @change=${e => this._selectAll(e.target.checked)}><strong>All</strong></label><span>${selected} of ${inputs.length} selected</span></div><div class="list">${inputs.map(input => this._row(input))}</div>`
            : html`<p class="empty">${merge && this._parents.length === 0 ? 'No scan results available.' : empty}</p>`}
    </section>`
  }
  _row(input) {
    const count = this.mode === 'link' ? input.appFindings : input.findings
    const details = [input.model ? modelName(input.model) : null, count == null ? null : `${count} ${this.mode === 'link' ? 'app ' : ''}${count === 1 ? 'finding' : 'findings'}`, input.createdAt,
      input.repo ? `${input.repo}${input.directory ? `/${input.directory}` : ''}` : null].filter(Boolean)
    return html`<label class="option"><input type="checkbox" .checked=${this._current.ids.has(input.id)} @change=${e => this._toggle(input.id, e.target.checked)}>${unsafeHTML(REPORT_FILE_ICONS[input.analyzer] ?? REPORT_FILE_ICONS.default)}<span class="copy"><strong>${input.title ?? input.filename}</strong><span>${details.join(' · ')}</span></span></label>`
  }
  static styles = css`
    :host { display: block; min-width: 0; }
    * { box-sizing: border-box; }
    .panel { border: 1px solid var(--border); border-radius: 9px; background: var(--surface); overflow: hidden; }
    .source { display: flex; flex-wrap: wrap; align-items: center; gap: .7rem; padding: .85rem .9rem; border-bottom: 1px solid var(--border); }
    .field { display: grid; flex: 1 1 14rem; gap: .3rem; max-width: 32rem; min-width: 0; }
    .field > span { color: var(--muted); font-size: .72rem; }
    button { padding: .3rem .55rem; border: 1px solid var(--border); border-radius: 5px; color: var(--text); background: var(--bg); font: inherit; font-size: .74rem; cursor: default; }
    .kinds { display: flex; width: fit-content; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }
    .kinds button { padding-block: .5rem; border: 0; border-radius: 0; color: var(--muted); }
    .kinds button + button { border-left: 1px solid var(--border); }
    .kinds button[aria-checked=true] { color: var(--text); background: var(--surface-active); }
    .list-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .55rem .9rem; border-bottom: 1px solid var(--border); }
    .list-head label { display: flex; align-items: center; gap: .55rem; user-select: none; }
    .list-head strong { color: var(--text); font-size: .74rem; font-weight: 600; }
    .list-head > span { color: var(--muted); font-size: .68rem; }
    .list { max-height: 24rem; overflow: auto; overscroll-behavior: none; }
    .option { display: flex; align-items: center; gap: .55rem; min-width: 0; padding: .35rem .9rem; user-select: none; }
    .option + .option { border-top: 1px solid var(--border); }
    .option:hover { background: var(--surface-active); }
    input { width: .85rem; height: .85rem; margin: 0; flex: 0 0 auto; accent-color: var(--accent); }
    .file-icon { width: 1.4rem; height: 1.4rem; flex: 0 0 auto; }
    .copy { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex: 1; min-width: 0; }
    .copy strong, .copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .copy strong { flex: 1; color: var(--text); font-size: .74rem; font-weight: 500; }
    .copy span { max-width: 55%; color: var(--muted); font-size: .66rem; }
    .empty { margin: 0; padding: 1rem .9rem; color: var(--muted); font-size: .76rem; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `
}
if (!customElements.get('scan-report-inputs')) customElements.define('scan-report-inputs', ReportInputs)
