// Console-only report comparison. Read original local/E2E storage bytes;
// never run the findings view's cross-report merge or change its active load.
import { html, nothing, unsafeCSS } from 'lit'
import { LINKS_KIND, getKind, isManagedUiMode, listFiles, readFile, state } from '#client/index.js'
import { findingTitle } from '../../../report/index.js'
import { computeReportDiff, parseComparisonReport, reportValues } from '../report-compare-diff.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import reportCompareCSS from './dialog-report-compare.css'

const emptySide = () => ({ key: '', name: '', report: null, error: '', loading: false })
const valueLabel = (values, field) => values.map(value => value === null ? 'Not supplied'
  : field === 'confidence' ? `${value}/10` : String(value).replaceAll('_', ' ')).join(' / ')
const PAGE_SIZE = 50

class ReportCompareDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(reportCompareCSS)]
  static properties = {
    _names: { state: true }, _sides: { state: true }, _catalogError: { state: true },
    _catalogLoading: { state: true }, _diff: { state: true }, _query: { state: true }, _limits: { state: true },
  }

  constructor() {
    super()
    this._names = []
    this._sides = [emptySide(), emptySide()]
    this._tokens = [0, 0]
    this._catalogError = ''
    this._catalogLoading = true
    this._diff = null
    this._query = ''
    this._limits = {}
  }

  beforeOpen() { void this._loadCatalog() }
  focusInitial() { this.renderRoot.querySelector('select')?.focus() }

  async _loadCatalog() {
    try {
      const names = await listFiles()
      if (this._settled) return
      this._names = names.filter(name => getKind(name) !== LINKS_KIND)
      const first = this._names.includes(state.currentFile) ? state.currentFile : this._names[0]
      // Don't overwrite a file chosen while the directory was still loading.
      if (first && !this._tokens[0]) void this._select(0, first)
      const second = this._names.find(name => name !== first)
      if (second && !this._tokens[1]) void this._select(1, second)
    } catch (err) {
      if (!this._settled) this._catalogError = `Couldn't list saved reports: ${err.message}`
    } finally {
      if (!this._settled) this._catalogLoading = false
    }
  }

  _setSide(index, side) {
    this._sides = this._sides.map((previous, i) => i === index ? side : previous)
    this._limits = {}
    const [before, after] = this._sides.map(item => item.report)
    this._diff = before && after ? computeReportDiff(before, after) : null
  }

  async _select(index, name, file) {
    const token = ++this._tokens[index]
    const side = { ...emptySide(), key: file ? '' : name, name, loading: Boolean(name) }
    this._setSide(index, side)
    if (!name) return
    try {
      const content = file ? await file.text() : await readFile(name)
      if (this._settled || this._tokens[index] !== token) return
      this._setSide(index, { ...side, loading: false, report: parseComparisonReport(content) })
    } catch (err) {
      if (!this._settled && this._tokens[index] === token) {
        this._setSide(index, { ...side, loading: false, error: `Couldn't read ${name}: ${err.message}` })
      }
    }
  }

  _file(index, event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void this._select(index, file.name, file)
  }

  _swap() {
    if (this._sides.some(side => side.loading)) return
    this._tokens = this._tokens.map(token => token + 1)
    this._sides = this._sides.toReversed()
    this._setSide(0, this._sides[0])
  }

  _picker(index) {
    const side = this._sides[index]
    const label = index === 0 ? 'Before' : 'After'
    return html`<section class="picker">
      <label for=${`report-${index}`}>${label}</label>
      <select id=${`report-${index}`} @change=${event => this._select(index, event.target.value)}>
        <option value="" .selected=${!side.key}>${side.name && !side.key ? side.name : 'Choose a saved report…'}</option>
        ${this._names.map(name => html`<option value=${name} .selected=${side.key === name}>${name}</option>`)}
      </select>
      <div class="file-picker"><label class="file-button">Open file…<input type="file" accept=".json,.md,.markdown" aria-label=${`Open ${label.toLowerCase()} report file`} @change=${event => this._file(index, event)}></label>
        <span class="muted">${side.loading ? 'Reading report…' : side.report ? `${side.report.byId.size.toLocaleString()} unique findings` : 'JSON or Markdown'}</span></div>
      ${side.error ? html`<p class="error" role="alert">${side.error}</p>` : nothing}
      ${side.report?.missingIds ? html`<p class="warning">${side.report.missingIds} findings without an id excluded.</p>` : nothing}
    </section>`
  }

  _finding(id) {
    const f = this._diff.after.byId.get(id)?.[0] ?? this._diff.before.byId.get(id)?.[0]
    return html`<span class="finding"><strong>${findingTitle(f) || id}</strong><code>${id}</code>${f.file ? html`<small>${f.file}</small>` : nothing}</span>`
  }

  _matches(id) {
    const query = this._query.trim().toLowerCase()
    if (!query) return true
    const findings = [...(this._diff.before.byId.get(id) ?? []), ...(this._diff.after.byId.get(id) ?? [])]
    return [id, ...findings.flatMap(f => [findingTitle(f), f.file])].filter(Boolean).some(text => text.toLowerCase().includes(query))
  }

  _section(key, title, rows, renderRow, tone = '') {
    const filtered = rows.filter(row => (Array.isArray(row) ? row : [row.id ?? row]).some(id => this._matches(id)))
    const limit = this._limits[key] ?? PAGE_SIZE
    return html`<section class=${`change-section ${tone}`} aria-label=${title}>
      <h4>${title}<span class="count">${this._query.trim() ? `${filtered.length} / ` : ''}${rows.length}</span></h4>
      ${filtered.length > 0 ? html`<ul>${filtered.slice(0, limit).map(renderRow)}</ul>` : html`<p class="empty">${rows.length > 0 ? 'No matching findings.' : 'No changes.'}</p>`}
      ${filtered.length > limit ? html`<button class="more" @click=${() => { this._limits = { ...this._limits, [key]: limit + PAGE_SIZE } }}>Show ${Math.min(PAGE_SIZE, filtered.length - limit)} more (${filtered.length - limit} remaining)</button>` : nothing}
    </section>`
  }

  _changeRow(change, field) {
    const originalChanged = field === 'severity' && JSON.stringify(change.originalBefore) !== JSON.stringify(change.originalAfter)
    return html`<li class="change-row">${this._finding(change.id)}<span class="change-value">
      <span class="from">${valueLabel(change.before, field)}</span><span aria-label="to">→</span><span>${valueLabel(change.after, field)}</span>
      ${originalChanged ? html`<small>Original: ${valueLabel(change.originalBefore)} → ${valueLabel(change.originalAfter)}</small>` : nothing}
    </span></li>`
  }

  _presenceRow(id, report) {
    const verdict = valueLabel(reportValues(report, id, 'verdict'))
    return html`<li class="change-row">${this._finding(id)}<span class="change-value">
      <span>${valueLabel(reportValues(report, id, 'severity'))}</span><span>${valueLabel(reportValues(report, id, 'confidence'), 'confidence')}</span>
      ${verdict === 'Not supplied' ? nothing : html`<small>${verdict}</small>`}
    </span></li>`
  }

  _groupRow(ids) {
    const held = new Set(ids)
    const groups = report => report.rows.map(row => row.filter(id => held.has(id))).filter(row => row.length)
      .map(row => row.join(', ')).filter((row, index, all) => all.indexOf(row) === index).join(' | ')
    return html`<li class="group-row"><div class="group-members">${ids.map(id => this._finding(id))}</div>
      <div class="group-shape"><span class="from">${groups(this._diff.before)}</span><span aria-label="to">→</span><span>${groups(this._diff.after)}</span></div></li>`
  }

  _verdictCount(report, verdict) {
    return [...report.byId.keys()].filter(id => reportValues(report, id, 'verdict').includes(verdict)).length
  }

  _results() {
    const d = this._diff
    if (!d) {
      return html`<p class="placeholder" role="status">${this._sides.some(side => side.loading) || this._catalogLoading
        ? 'Loading reports…' : 'Choose two saved reports or open two files to compare.'}</p>`
    }
    return html`
      <div class="summary" aria-label="Comparison summary">
        <div><span>Unique findings</span><strong>${d.before.byId.size} → ${d.after.byId.size}</strong></div>
        <div><span>In common</span><strong>${d.shared.length}</strong></div>
        <div class="verdict-confirmed"><span>Confirmed</span><strong>${this._verdictCount(d.before, 'confirmed')} → ${this._verdictCount(d.after, 'confirmed')}</strong></div>
        <div class="verdict-refuted"><span>Refuted</span><strong>${this._verdictCount(d.before, 'refuted')} → ${this._verdictCount(d.after, 'refuted')}</strong></div>
      </div>
      <div class="change-counts" aria-label="Change counts">
        <span>${d.added.length} added</span><span>${d.removed.length} removed</span>
        <span>${d.joined.length} joined</span><span>${d.split.length} split</span>
        <span>${d.confidence.length} confidence</span><span>${d.severity.length} severity</span>
      </div>
      <div class="results-head"><p>Changes from <strong>${this._sides[0].name}</strong> to <strong>${this._sides[1].name}</strong>.</p>
        <input class="search" type="search" aria-label="Filter comparison findings" placeholder="Filter by id, title or file…" .value=${this._query} @input=${event => { this._query = event.target.value; this._limits = {} }}></div>
      ${d.shared.length === 0 && (d.before.missingIds || d.after.missingIds)
        ? html`<p class="warning" role="status">No shared ids to compare. Findings without ids cannot be matched.</p>`
        : d.unchanged ? html`<p class="identical" role="status">No differences in finding ids, grouping, verdicts, confidence or severity.</p>` : nothing}
      <h3 class="section-title">Findings</h3>
      <div class="columns">
        ${this._section('added', 'Added', d.added, id => this._presenceRow(id, d.after), 'positive')}
        ${this._section('removed', 'Removed', d.removed, id => this._presenceRow(id, d.before), 'negative')}
      </div>
      <h3 class="section-title">Revalidation</h3><p class="note">Changed verdicts for shared ids, grouped by the after report’s verdict.</p>
      <div class="columns">
        ${this._section('confirmed', 'Confirmed', d.confirmed, row => this._changeRow(row, 'verdict'), 'verdict-confirmed')}
        ${this._section('refuted', 'Refuted', d.refuted, row => this._changeRow(row, 'verdict'), 'verdict-refuted')}
      </div>
      ${d.otherVerdicts.length > 0 ? this._section('other', 'Other verdict changes', d.otherVerdicts, row => this._changeRow(row, 'verdict')) : nothing}
      <h3 class="section-title">Grouping</h3><p class="note">Only shared ids. Each cluster connects changed pairs; added or removed findings do not count as regrouping.</p>
      <div class="columns">
        ${this._section('joined', 'Joined', d.joined, ids => this._groupRow(ids), 'positive')}
        ${this._section('split', 'Split', d.split, ids => this._groupRow(ids), 'negative')}
      </div>
      <h3 class="section-title">Ratings</h3><p class="note">Shared ids only. Severity includes report corrections; changes to original severity are also shown.</p>
      <div class="columns">
        ${this._section('confidence', 'Confidence changes', d.confidence, row => this._changeRow(row, 'confidence'))}
        ${this._section('severity', 'Severity changes', d.severity, row => this._changeRow(row, 'severity'))}
      </div>`
  }

  render() {
    return html`<dialog aria-labelledby="compare-title" @close=${this._onClose}>
      <header><div><h3 id="compare-title">Compare reports</h3><p>Compare findings, grouping and ratings between two reports.</p></div><button aria-label="Close report comparison" @click=${this._onClose}>Close</button></header>
      <div class="pickers">${this._picker(0)}<button class="swap" aria-label="Swap before and after reports" ?disabled=${this._sides.some(side => side.loading)} @click=${this._swap}>⇄</button>${this._picker(1)}</div>
      ${this._catalogError ? html`<p class="error" role="alert">${this._catalogError} You can still open files directly.</p>` : nothing}
      <div class="results">${this._results()}</div>
    </dialog>`
  }
}

customElements.define('report-compare-dialog', ReportCompareDialog)

export function openReportCompareDialog() {
  if (isManagedUiMode()) throw new Error('Report comparison is available in local/E2E mode.')
  return openAppDialog('report-compare-dialog')
}
