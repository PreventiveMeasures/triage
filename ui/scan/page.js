import { LitElement, html, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { live } from 'lit/directives/live.js'
import { repeat } from 'lit/directives/repeat.js'
import { BUNDLE_ICON_SVG } from '../view/icons.js'
import { fetchScanModels } from '../view/scan-models.js'
import '../view/scan-model-picker.js'
import '../view/repository-selector.js'
import '../view/bundle-selector.js'
import './report-inputs.js'
import './regime-editor.js'
import './depth-toggle.js'
import { SCAN_PAGE_STYLES } from './page-styles.js'
import { codeScanFiles, formatBytes, sourceMetrics } from './metrics.js'
import { scanScopeOptions } from './scopes.js'

const SCAN_MODE_ICONS = {
  dependencies: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="8" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M6 8h2M10.2 5.3 6 7.3M10.2 10.7 6 8.7"/></svg>`,
  code: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5.5 3-3 5 3 5M10.5 3l3 5-3 5M9 2.5 7 13.5"/></svg>`,
  agentic: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 1.8.8 4.4L12.5 8l-3.7 1.8L8 14.2l-.8-4.4L3.5 8l3.7-1.8Z"/><path d="m13 2 .25 1.25L14.5 3.5 13.25 3.25 13 2ZM3 11.5l.2 1 .95.2-.95.2-.2 1-.2-1-.95-.2.95-.2Z"/></svg>`,
  report: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 1.8h5l3 3V14H4zM9 1.8V5h3M6 8h4M6 10.5h4"/></svg>`,
}

export class ScanPage extends LitElement {
  static properties = {
    source: { attribute: false }, loadBundle: { attribute: false }, loadModels: { attribute: false }, loadReportSources: { attribute: false }, canRun: { attribute: false },
    _loadingBundle: { state: true }, _bundleError: { state: true },
    _tab: { state: true },
    _mode: { state: true },
    _bundles: { state: true },
    _repositories: { state: true },
    _reportMode: { state: true }, _reportInput: { state: true }, _reportRestore: { state: true },
    _scans: { state: true },
    _selectedRepoId: { state: true },
    _selectedBundleId: { state: true },
    _reason: { state: true },
    _excluded: { state: true },
    _excludedModules: { state: true },
    _prompts: { state: true },
    _options: { state: true }, _regimes: { state: true }, _regimesReady: { state: true },
    _notice: { state: true },
  }

  static styles = SCAN_PAGE_STYLES

  constructor() {
    super()
    this.loadModels = fetchScanModels
    this.canRun = true
    this._tab = 'new'
    this._mode = 'code'
    this.source = null
    this.loadBundle = null
    this._loadingBundle = false
    this._bundleError = null
    this._bundles = []
    this._repositories = []
    this._reportMode = 'link'
    this._reportInput = null
    this._reportRestore = null
    this._scans = []
    this._selectedRepoId = this._bundles[0]?.repoId ?? 'unattached'
    this._selectedBundleId = this._bundles[0]?.id ?? null
    this._reason = this._bundles[0]?.reasons[0]?.id ?? ''
    this._excluded = new Set()
    this._excludedModules = new Set()
    this._nextPromptId = 1
    this._prompts = [{ id: 1, text: '' }]
    this._options = { analyzer: 'generic', model: null, effort: null, cached: false, isolate: false }
    this._regimes = []
    this._regimesReady = false
    this._notice = null
    this._timers = new Set()
  }

  willUpdate(changed) {
    if (changed.has('source')) {
      this._bundles = this.source?.bundles ?? []
      this._repositories = this.source?.repositories ?? []
      this._scans = this.source?.scans ?? []
      this._excluded = new Set()
      this._excludedModules = new Set()
      const bundle = this._bundles.find(item => item.id === this._selectedBundleId) ?? this._bundles[0]
      this._selectedRepoId = bundle?.repoId ?? 'unattached'
      this._selectedBundleId = bundle?.id ?? null
      this._reason = bundle?.reasons?.[0]?.id ?? ''
    }
  }

  updated(changed) {
    if (changed.has('source') || changed.has('loadBundle')) void this._loadSelectedBundle()
  }

  async _loadSelectedBundle() {
    this._bundleController?.abort()
    this._loadingBundle = false
    this._bundleError = null
    const bundle = this._bundle
    if (!this.loadBundle || !bundle || Array.isArray(bundle.files)) return
    const controller = this._bundleController = new AbortController()
    this._loadingBundle = true
    try {
      const loaded = await this.loadBundle(bundle, controller.signal)
      if (controller.signal.aborted) return
      this._bundles = this._bundles.map(item => item.id === bundle.id ? loaded : item)
      this._reason = loaded.reasons?.[0]?.id ?? ''
    } catch (err) {
      if (!controller.signal.aborted) this._bundleError = String(err?.message ?? err)
    } finally { if (!controller.signal.aborted) this._loadingBundle = false }
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._bundleController?.abort()
    for (const timer of this._timers) clearTimeout(timer)
    this._timers.clear()
  }

  get _repoBundles() { return this._bundles.filter((bundle) => bundle.repoId === this._selectedRepoId) }

  get _bundle() { return this._repoBundles.find((bundle) => bundle.id === this._selectedBundleId) }

  get _reasonData() { return this._bundle?.reasons.find((reason) => reason.id === this._reason) ?? this._bundle?.reasons[0] }

  _packageLabel(module) { return module === '__own__' ? 'Own code' : module }

  get _files() {
    const reason = this._reasonData
    const modules = reason?.fileModules
    const paths = reason?.filePaths ? new Set(reason.filePaths) : null
    return codeScanFiles(this._bundle?.files).filter((file) => (modules == null || modules.includes(file.module)) && (paths == null || paths.has(file.path))).toSorted((a, b) => b.bytes - a.bytes)
  }

  render() {
    return html`<div class="wrap">
      <div class="head"><div class="head-title"><slot name="navigation"></slot><h1>Scans</h1></div>
        <div class="head-tabs" role="tablist" aria-label="Scan views">
          <button class=${this._tab === 'new' ? 'active' : ''} role="tab" aria-selected=${this._tab === 'new'} @click=${() => { this._tab = 'new' }}>New scan</button>
          <button class=${this._tab === 'history' ? 'active' : ''} role="tab" aria-selected=${this._tab === 'history'} @click=${() => { this._tab = 'history' }}>Scan history</button>
        </div>
      </div>
      <p class="intro">${this._mode === 'report' ? 'Choose inputs and start a scan. Save the report when it finishes.' : 'Choose a bundle and start a scan. Save the report when it finishes.'}</p>
      ${this._notice ? html`<p class="notice" role="status">${this._notice}</p>` : nothing}
      ${this._bundleError ? html`<p class="notice" role="alert">Couldn’t load bundle: ${this._bundleError}<button @click=${() => void this._loadSelectedBundle()}>Retry</button></p>` : nothing}
      ${this._tab === 'new' ? this._newScan() : this._history()}
    </div>`
  }

  _newScan() {
    const mode = this._mode
    const bundle = this._bundle
    const files = mode === 'code' ? this._files : (bundle?.files ?? [])
    const excluded = this._excluded
    const excludedModules = this._excludedModules
    const included = files.filter((file) => !excluded.has(file.path) && !excludedModules.has(file.module))
    const includedMetrics = sourceMetrics(bundle?.files ? included : null)
    const moduleStats = new Map()
    for (const file of files) {
      const stats = moduleStats.get(file.module) ?? { bytes: 0, count: 0, included: 0 }
      stats.bytes += file.bytes
      stats.count++
      if (!excluded.has(file.path)) stats.included++
      moduleStats.set(file.module, stats)
    }
    const modules = [...moduleStats.keys()].toSorted((a, b) => moduleStats.get(b).bytes - moduleStats.get(a).bytes || this._packageLabel(a).localeCompare(this._packageLabel(b)))
    const previewFiles = files.slice(0, 80)
    const includedPackages = modules.filter((module) => !excludedModules.has(module)).length
    const reportInputs = this._reportInput?.mode === this._reportMode ? this._reportInput.inputs : []
    return html`<div class="setup">
      <section class="panel mode-panel" aria-labelledby="scan-mode-heading">
        <div class="panel-head"><h2 id="scan-mode-heading">Scan mode</h2><p>Choose what the server should analyze</p></div>
        <div class="mode-grid" role="tablist" aria-label="Scan mode">
          ${[['dependencies', 'Dependency alerts', 'Revalidate incoming alerts against actual code'], ['code', 'Code', 'Run a full scan of the codebase'], ['agentic', 'Agentic', 'Free-form analysis with your instructions'], ['report', 'Reports', 'Link saved reports or merge scan results']].map(([id, label, text]) => html`<button type="button" role="tab" aria-selected=${mode === id} class=${`mode-option ${mode === id ? 'active' : ''}`} @click=${() => this._changeMode(id)}><span class="mode-title">${SCAN_MODE_ICONS[id]}<strong>${label}</strong></span><span>${text}</span></button>`)}
        </div>
        ${mode === 'code' ? html`<div class="subtype-wrap"><div class="subtype-options" role="radiogroup" aria-label="Code subtype">${[['security', 'Security', 'Security findings only'], ['generic', 'Generic', 'Free-form code scan: wide-scoped, most results'], ['correctness', 'Correctness', 'Guided correctness scan'], ['advanced', 'Advanced', 'Merge multiple regimes']].map(([id, label, text]) => html`<button type="button" role="radio" aria-checked=${this._options.analyzer === id} class=${`subtype-option ${this._options.analyzer === id ? 'active' : ''}`} @click=${() => this._setOption('analyzer', id)}><strong>${label}</strong><span>${text}</span></button>`)}</div><p class="subtype-help">Focusing controls how effort is spent: while Generic can also find security issues, a focused Security scan is likely to find more.</p></div>` : nothing}
        ${mode === 'report' ? html`<div class="subtype-wrap"><div class="subtype-options report-subtypes" role="radiogroup" aria-label="Reports submode">${[['link', 'Link', 'Link findings across saved reports'], ['merge', 'Merge', 'Combine scan results for one bundle']].map(([id, label, text]) => html`<button type="button" role="radio" aria-checked=${this._reportMode === id} class=${`subtype-option ${this._reportMode === id ? 'active' : ''}`} @click=${() => { this._reportMode = id; this._reportRestore = null }}><strong>${label}</strong><span>${text}</span></button>`)}</div></div>` : nothing}
      </section>
      ${mode === 'report' ? html`<scan-report-inputs .mode=${this._reportMode} .loadSources=${this.loadReportSources} .restore=${this._reportRestore} @report-inputs-change=${e => { this._reportInput = e.detail }}></scan-report-inputs>` : this._sourcePanel(bundle, files)}
      ${mode === 'code' ? html`<details class="panel scope-panel">
        <summary class="scope-head"><svg class="scope-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg><h2>Source filter</h2><p><span>${included.length} of ${files.length} files · ${includedPackages} of ${modules.length} packages</span> <span>${formatBytes(includedMetrics.bytes)} · ${includedMetrics.lines == null ? '—' : includedMetrics.lines.toLocaleString()} LoC</span></p></summary>
        <div class="scope-grid"><section class="scope-pane package-pane" aria-label="Packages in bundle"><div class="pane-head"><strong>Packages</strong><span>${modules.length} total · sorted by size</span></div><div class="package-list">${modules.map((module) => { const { bytes, count, included: includedCount } = moduleStats.get(module); const isIncluded = !excludedModules.has(module); return html`<label class=${`package-row ${isIncluded ? '' : 'excluded'}`}><input type="checkbox" .checked=${isIncluded} @change=${(_event) => this._toggleModule(module)}><span class="package-name">${this._packageLabel(module)}</span><span class="package-size">${formatBytes(bytes)} · ${includedCount}/${count}</span></label>` })}</div></section><section class="scope-pane file-panel" aria-label="Largest files in bundle"><div class="pane-head"><strong>Largest files</strong><span>showing ${previewFiles.length} of ${files.length}</span></div>${files.length === 0 ? html`<p class="empty">No files in this selection.</p>` : html`<div class="file-list">${previewFiles.map((file) => { const isIncluded = !excluded.has(file.path) && !excludedModules.has(file.module); return html`<label class=${`file ${isIncluded ? '' : 'excluded'}`}><input type="checkbox" .checked=${isIncluded} @change=${(e) => this._toggleFile(file, e.target.checked)}><span class="file-copy"><span class="file-path" title=${file.path}>${file.path}</span><span class="file-meta">${file.size} · ${this._packageLabel(file.module)}</span></span></label>` })}</div>`}</section></div>
      </details>` : nothing}
      ${mode === 'agentic' ? this._agenticPanel() : nothing}
      <slot name="access"></slot>
      ${this._optionsPanel(mode, bundle, mode === 'report' ? reportInputs.length : included.length)}
    </div>`
  }

  _sourcePanel(bundle, files) {
    const bundles = this._mode === 'code' ? this._repoBundles.map(item => item.files ? { ...item, files: codeScanFiles(item.files) } : item) : this._repoBundles
    const { lines } = sourceMetrics(bundle?.files ? files : null)
    const counts = new Map()
    for (const item of this._bundles) counts.set(item.repoId, (counts.get(item.repoId) ?? 0) + 1)
    const showRepositoryPicker = counts.size > 1
    // Sourcemaps have no named graph scopes; Stasis may discover them after loading.
    const reserveScope = ['code', 'agentic'].includes(this._mode) && bundle != null
      && (!bundle.filename.toLowerCase().endsWith('.map') || bundle.reasons?.some(reason => reason.id !== 'all'))
    const repositories = this._repositories.map(repo => { const count = counts.get(repo.id) ?? 0; return { value: repo.id, label: repo.label, detail: `${count} ${count === 1 ? 'bundle' : 'bundles'}`, special: repo.id === 'unattached' } })
    return html`<section class="panel source-panel" aria-busy=${this._loadingBundle}><div class="panel-head"><h2>Source</h2></div><div class=${`source-choice ${showRepositoryPicker ? '' : 'single-repository'}`}><!-- Repository is implicit when every bundle has the same owner. -->${showRepositoryPicker ? html`<div class="field"><span>Repository</span><repository-selector .options=${repositories} .value=${this._selectedRepoId} @repository-change=${(e) => this._selectRepoById(e.detail.value)}></repository-selector></div>` : nothing}<div class="field">${showRepositoryPicker ? html`<span>Bundle</span>` : nothing}${bundles.length > 0 ? html`<bundle-selector .bundles=${bundles} .value=${bundle?.id ?? null} @bundle-change=${event => this._selectBundleById(event.detail.value)}></bundle-selector>` : html`<div class="choice-empty">${this._bundles.length === 0 ? 'No stored bundles.' : 'No stored bundles for this repository.'}</div>`}</div><div class="source-footer"><div class="bundle-stats" aria-label="Bundle statistics"><div class="metric"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/></svg><strong>${bundle?.size ?? '—'}</strong><span>bundle size</span></div><div class="metric">${SCAN_MODE_ICONS.report}<strong>${files.length}</strong><span>files</span></div><div class="metric">${SCAN_MODE_ICONS.code}<strong>${lines == null ? '—' : lines.toLocaleString()}</strong><span>LoC</span></div><div class="metric">${unsafeHTML(BUNDLE_ICON_SVG)}<strong>${new Set(files.map((file) => file.module)).size}</strong><span>packages</span></div></div>${reserveScope ? html`<div class="scope-slot">${this._scopeField(bundle)}</div>` : nothing}</div></div></section>`
  }

  _scopeField(bundle) {
    if (!['code', 'agentic'].includes(this._mode)) return nothing
    const reasons = (bundle?.reasons ?? []).filter(reason => reason.id !== 'all')
    if (reasons.length === 0) return nothing
    const agentic = this._mode === 'agentic'
    const options = scanScopeOptions(reasons)
    if (options) {
      const selected = options.find(option => option.id === this._reason) ?? options[0]
      return html`<div class="scope-toggle"><div class="scope-options" role="radiogroup" aria-label=${agentic ? 'Choose agentic scope' : 'Choose scan scope'} aria-describedby="scan-scope-description">${options.map(option => html`<label class="scope-option"><input type="radio" name="scan-scope" value=${option.id} .checked=${selected.id === option.id} @change=${() => this._changeReason(option.id)}><span>${option.label}</span></label>`)}</div><span class="scope-description" id="scan-scope-description">${selected.subtitle}</span></div>`
    }
    return html`<label class="scope-field"><span>Scope</span><select id=${agentic ? 'scan-agentic-scope' : 'scan-reason'} aria-label=${agentic ? 'Choose agentic scope' : 'Choose scan scope'} @change=${event => this._changeReason(event.target.value)}><option value="" .selected=${live(!this._reason || this._reason === 'all')}>All files</option>${reasons.map(reason => html`<option value=${reason.id} .selected=${live(reason.id === this._reason)}>${reason.label ?? reason.id}</option>`)}</select></label>`
  }

  _optionsPanel(mode, bundle, count) {
    const summary = mode === 'report' ? `${count} ${this._reportMode === 'merge' ? 'scan results' : 'reports'} selected` : `${bundle?.filename ?? 'No bundle selected'} · ${count} files will be analyzed`
    const advanced = mode === 'code' && this._options.analyzer === 'advanced'
    const disabled = !this.canRun || (mode === 'report' ? count === 0 : bundle == null || count === 0 || (advanced && (!this._regimesReady || this._regimes.length === 0)))
    return html`<section class="panel options"><div class="options-grid">${advanced ? html`<scan-regime-editor .loadModels=${this.loadModels} .value=${this._regimes} @regimes-change=${e => { this._regimesReady = e.detail.ready; this._regimes = e.detail.value }}></scan-regime-editor>` : html`<scan-model-picker .loadModels=${this.loadModels} ?has-extra=${mode === 'code'} .value=${this._options.model} .effort=${this._options.effort} @model-change=${(event) => { this._options = { ...this._options, model: event.detail.model, effort: event.detail.effort } }}>${mode === 'code' ? html`<scan-depth-toggle slot="effort-extra" .isolate=${this._options.isolate} @depth-change=${event => this._setOption('isolate', event.detail.isolate)}></scan-depth-toggle>` : nothing}</scan-model-picker>`}</div><div class="options-footer"><slot name="before-run"></slot><button type="button" class="run" ?disabled=${disabled} @click=${() => this._runScan()}>${mode === 'report' ? this._reportMode === 'merge' ? 'Merge results' : 'Link reports' : 'Run scan'}</button><span class="summary">${summary}</span></div><div class="checks"><label class="switch"><input type="checkbox" aria-describedby=${this._options.cached ? 'offline-help' : nothing} .checked=${this._options.cached} @change=${(e) => this._setOption('cached', e.target.checked)}><span class="switch-track" aria-hidden="true"></span><span>Offline</span></label>${this._options.cached ? html`<small class="offline-help" id="offline-help">Cache only, no new model requests</small>` : nothing}</div></section>`
  }

  _history() {
    return html`<section class="panel history"><div class="panel-head"><h2>Scan history</h2><p>${this._scans.length} scans</p></div>${this._scans.length === 0 ? html`<p class="empty">No scans yet.</p>` : this._scans.map((scan) => this._scanRow(scan))}</section>`
  }

  _scanRow(scan) {
    const reportAction = scan.status === 'completed'
      ? (scan.reportSaved ? html`<button type="button" class="action" @click=${() => this._deleteSavedReport(scan)}>Delete saved report</button>` : html`<button type="button" class="action" @click=${() => this._saveReport(scan)}>Save report</button>`)
      : nothing
    return html`<div class="scan-row"><div class="scan-main"><div class="scan-title"><strong>${scan.bundleName}</strong><span class=${`status ${scan.status}`}>${scan.status}</span></div><span class="scan-meta">${scan.reason} · ${scan.files} ${scan.mode === 'report' ? scan.reportMode === 'merge' ? 'results' : 'reports' : 'files'} · ${scan.createdAt}${scan.duration ? ` · ${scan.duration}` : ''}${scan.reportSaved ? ' · Report saved' : scan.status === 'completed' ? ' · Report available' : ''}</span></div><span class="scan-actions">${reportAction}${scan.status === 'running' ? html`<button type="button" class="action" @click=${() => this._stopScan(scan)}>Stop</button>` : nothing}${scan.status === 'stopped' ? html`<button type="button" class="action" @click=${() => this._restartScan(scan)}>Restart as new scan</button>` : nothing}</span><span aria-hidden="true"></span></div>`
  }

  _selectBundle(bundle) {
    this._selectedRepoId = bundle.repoId
    this._selectedBundleId = bundle.id
    this._reason = bundle.reasons?.[0]?.id ?? ''
    this._excluded = new Set()
    this._excludedModules = new Set()
    this._notice = null
    void this._loadSelectedBundle()
  }

  _selectBundleById(id) {
    const bundle = this._repoBundles.find((candidate) => candidate.id === id)
    if (bundle != null) this._selectBundle(bundle)
  }

  _selectRepoById(id) {
    if (id === this._selectedRepoId || !this._repositories.some(repo => repo.id === id)) return
    this._selectedRepoId = id
    const bundle = this._bundles.find((candidate) => candidate.repoId === id)
    this._selectedBundleId = bundle?.id ?? null
    this._reason = bundle?.reasons[0]?.id ?? ''
    this._excluded = new Set()
    this._excludedModules = new Set()
    this._notice = null
    void this._loadSelectedBundle()
  }

  _changeMode(mode) {
    if (!['dependencies', 'code', 'agentic', 'report'].includes(mode) || mode === this._mode) return
    this._mode = mode
    this._reportInput = null
    this._reportRestore = null
    this._excluded = new Set()
    this._excludedModules = new Set()
    this._notice = null
  }

  _changeReason(value) {
    this._reason = value
    this._excluded = new Set()
    this._excludedModules = new Set()
  }

  _toggleFile(file, included) {
    const next = new Set(this._excluded)
    if (included) next.delete(file.path)
    else next.add(file.path)
    this._excluded = next
  }

  _toggleModule(module) {
    const next = new Set(this._excludedModules)
    if (next.has(module)) next.delete(module)
    else next.add(module)
    this._excludedModules = next
  }

  _setOption(key, value) {
    if (this._options[key] === value) return
    if (key === 'analyzer' && value === 'advanced') {
      this._regimesReady = false
      if (this._regimes.length === 0) this._regimes = [{ mode: this._options.analyzer, model: this._options.model, effort: this._options.effort, isolate: this._options.isolate }]
    }
    this._options = { ...this._options, [key]: value }
  }

  _agenticPanel() {
    return html`<section class="panel agentic-panel"><div class="panel-head"><h2>Agentic instructions</h2><button type="button" class="prompt-action" aria-label="Add prompt" @click=${() => this._addPrompt()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg></button></div><div class="agentic-fields">${repeat(this._prompts, prompt => prompt.id, (prompt, index) => html`<div class="prompt-row"><textarea aria-label=${`Prompt ${index + 1}`} rows="3" placeholder=${this._promptPlaceholder(index)} .value=${live(prompt.text)} @input=${e => { this._prompts = this._prompts.map(item => item.id === prompt.id ? { ...item, text: e.target.value } : item) }}></textarea>${this._prompts.length > 1 ? html`<button type="button" class="prompt-action" aria-label=${`Remove prompt ${index + 1}`} @click=${() => this._removePrompt(prompt.id)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>` : nothing}</div>`)}</div></section>`
  }

  _promptPlaceholder(index) {
    const ordinal = ['', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'][index]
    if (ordinal != null) return `What should the ${ordinal ? `${ordinal} ` : ''}agent focus on?`
    return `What should agent ${index + 1} focus on?`
  }

  async _addPrompt() {
    this._prompts = [...this._prompts, { id: ++this._nextPromptId, text: '' }]
    await this.updateComplete
    this.renderRoot?.querySelector('.prompt-row:last-child textarea')?.focus()
  }

  _removePrompt(id) {
    if (this._prompts.length > 1) this._prompts = this._prompts.filter(prompt => prompt.id !== id)
  }

  _runScan() {
    if (!this.canRun) return
    const mode = this._mode
    const advanced = mode === 'code' && this._options.analyzer === 'advanced'
    if (advanced && (!this._regimesReady || this._regimes.length === 0)) return
    const bundle = this._bundle
    const reportInput = this._reportInput?.mode === this._reportMode ? this._reportInput : null
    const reports = reportInput?.inputs ?? []
    const files = mode === 'code'
      ? this._files.filter((file) => !this._excluded.has(file.path) && !this._excludedModules.has(file.module))
      : (bundle?.files ?? [])
    if (mode === 'report' && (!reportInput?.source || reports.length === 0)) return
    if (mode !== 'report' && (!bundle || files.length === 0)) return
    const scan = { id: `scan-${Date.now()}`, mode, bundleId: mode === 'report' ? (this._reportMode === 'merge' ? reportInput.source.id : null) : bundle?.id ?? null, bundleName: mode === 'report' ? reportInput.source.label : bundle.filename, reason: mode === 'agentic' ? this._reasonData?.label ?? 'All files' : mode === 'report' ? this._reportMode === 'merge' ? 'Merge scan results' : 'Link saved reports' : mode === 'code' ? this._reasonData?.label ?? 'All files' : 'Dependencies', status: 'running', createdAt: 'Just now', duration: '', files: mode === 'report' ? reports.length : files.length, reportSaved: false, cached: this._options.cached, isolate: mode === 'code' && this._options.isolate, model: this._options.model, effort: this._options.effort }
    if (mode === 'code') scan.analyzer = this._options.analyzer
    if (advanced) {
      scan.regimes = this._regimes.map(regime => ({ ...regime }))
      scan.reason = `Advanced · ${scan.regimes.length} regimes · ${scan.reason}`
      scan.scopeId = this._reason
      scan.model = null
      scan.effort = null
      scan.isolate = false
    }
    if (mode === 'agentic') scan.prompts = this._prompts.map(prompt => prompt.text)
    if (mode === 'report') {
      scan.reportMode = this._reportMode
      scan.reportSource = { ...reportInput.source }
      scan.inputIds = reports.map(report => report.id)
    }
    this._scans = [scan, ...this._scans]
    this._tab = 'history'
    this._notice = 'Scan started. The server will update its status as work progresses.'
    const timer = setTimeout(() => {
      this._timers.delete(timer)
      if (scan.status !== 'running') return
      scan.status = 'completed'
      scan.duration = '2m 14s'
      this._notice = 'Scan completed. Its report is ready to save.'
      this.requestUpdate()
    }, 2200)
    this._timers.add(timer)
  }

  _stopScan(scan) {
    if (scan.status !== 'running') return
    scan.status = 'stopped'
    scan.duration = scan.duration || 'stopped by user'
    this._notice = 'Scan stopped. It cannot continue, but you can restart it as a new scan.'
    this.requestUpdate()
  }

  _restartScan(scan) {
    this._options = { ...this._options, model: scan.model ?? this._options.model, effort: scan.effort ?? this._options.effort,
      cached: scan.cached ?? false, isolate: scan.isolate ?? false, analyzer: scan.analyzer ?? 'generic' }
    if (scan.mode === 'report') {
      this._mode = 'report'
      this._reportMode = scan.reportMode === 'link' ? 'link' : 'merge'
      this._reportInput = null
      this._reportRestore = { mode: this._reportMode, source: scan.reportSource, inputIds: scan.inputIds ?? [] }
      this._tab = 'new'
      this._notice = 'New report scan settings restored from the stopped run.'
      return
    }
    const bundle = this._bundles.find(candidate => candidate.id === scan.bundleId)
    if (!bundle) return
    this._selectBundle(bundle)
    this._mode = scan.mode ?? 'dependencies'
    if (scan.mode === 'agentic') this._prompts = (scan.prompts?.length > 0 ? scan.prompts : ['']).map(text => ({ id: ++this._nextPromptId, text }))
    if (scan.regimes?.length > 0) {
      this._options = { ...this._options, analyzer: 'advanced' }
      this._regimes = scan.regimes.map(regime => ({ ...regime }))
      this._regimesReady = false
    }
    this._reason = bundle.reasons.find((reason) => reason.label === scan.reason)?.id ?? bundle.reasons[0]?.id ?? ''
    if (scan.regimes?.length > 0) this._reason = scan.scopeId ?? this._reason
    this._tab = 'new'
    this._notice = 'New scan settings restored from the stopped run.'
  }

  _saveReport(scan) {
    scan.reportSaved = true
    this._notice = 'Report saved. You can delete it from Reports and save this completed scan again.'
    this.requestUpdate()
  }

  _deleteSavedReport(scan) {
    scan.reportSaved = false
    this._notice = 'Saved report deleted. The completed scan can be saved again.'
    this.requestUpdate()
  }
}
if (!customElements.get('deepview-scan-page')) customElements.define('deepview-scan-page', ScanPage)
