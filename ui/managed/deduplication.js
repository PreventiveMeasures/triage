import { html, nothing, unsafeCSS } from 'lit'
import { managedFetch } from '../../client/managed/request.js'
import { ManagedPage, loadingRows } from './page.js'
import { adminIcon, adminNavigation } from './navigation.js'
import { installFileDropZone, pickFiles, uploadFiles } from './file-uploads.js'
import commonStyles from './styles/common.css'
import reportsStyles from './styles/reports.css'
import linksStyles from './styles/links.css'

const path = '/api/admin/deduplication'
async function request(suffix = '', options = {}) {
  const response = await managedFetch(`${path}${suffix}`, { credentials: 'same-origin', ...options })
  const body = await response.json()
  if (!response.ok) {
    const messages = {
      'storage-encryption-required': 'Configure MANAGED_STORAGE_ENCRYPTION_KEY on the server to import encrypted link reports.',
      'invalid-link-report': 'Choose a link report containing arrays of finding IDs, such as [["id1", "id2"]].',
      'too-large': 'This link report exceeds the server upload limit.',
    }
    throw new Error(messages[body?.error] ?? `HTTP ${response.status}`)
  }
  return body
}

class ManagedAdminDeduplication extends ManagedPage {
  static properties = { _data: { state: true }, _error: { state: true }, _busy: { state: true }, _dragOver: { state: true } }
  static styles = [unsafeCSS(commonStyles), unsafeCSS(reportsStyles), unsafeCSS(linksStyles)]
  constructor() { super(); this._data = null; this._error = null; this._busy = false; this._dragOver = false; this._queue = [] }
  connectedCallback() {
    super.connectedCallback()
    void this._load()
    this._teardownDrop = installFileDropZone(this, files => void this._upload(files), active => { this._dragOver = active })
  }
  disconnectedCallback() { this._teardownDrop?.(); super.disconnectedCallback() }
  async _load({ preserveError = false } = {}) {
    if (!preserveError) this._error = null
    await this._loadCollection('deduplication', 'deduplication reports', signal => request('', { signal }), data => { this._data = data })
  }
  _upload(files) {
    if (!this._csrf || this._role !== 'admin') return
    return uploadFiles(this, files, file => request('', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-report-filename': encodeURIComponent(file.name), 'x-csrf-token': this._csrf }, body: file,
    }), ['deduplication', 'reports', 'teams'])
  }
  async _toggle(report) {
    if (this._busy || !this._csrf) return
    this._busy = true; this._error = null
    try {
      await this.appState.mutate(() => request(`/${encodeURIComponent(report.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': this._csrf }, body: JSON.stringify({ enabled: !report.enabled }),
      }), ['deduplication', 'reports', 'teams'])
    } catch (err) { this._error = String(err?.message ?? err) }
    finally {
      this._busy = false
      await this._load({ preserveError: true })
      const queued = this._queue.splice(0)
      if (queued.length > 0) void this._upload(queued)
    }
  }
  _view(report) {
    document.dispatchEvent(new CustomEvent('managed-admin-navigate', { detail: { view: 'manage-deduplication', linkId: report.id }, bubbles: true, composed: true }))
  }
  _linkReports() {
    document.dispatchEvent(new CustomEvent('managed-admin-navigate', { detail: { view: 'manage-scans', scanMode: 'link' }, bubbles: true, composed: true }))
  }
  render() {
    const reports = this._data?.reports ?? []
    return html`${this._dragOver ? html`<div class="dropzone">Drop link reports to import</div>` : nothing}
      <div class="wrap">${adminNavigation('manage-deduplication', this._role, this.allowShare)}
        <h1 class="sr-only">Deduplication</h1>
        <div class="page-intro"><p class="intro">Link duplicate findings across all teams.</p><span class="result-count">${this._data ? reports.length : '…'} reports</span><button type="button" class="btn" @click=${() => this._linkReports()}>Link reports</button></div>
        <div class="drop-card"><span class="drop-icon" aria-hidden="true">${adminIcon('upload')}</span><span class="drop-copy"><strong>Import link reports</strong><span>Drop *.link.json files anywhere on this page.</span></span><button type="button" class="drop-browse" ?disabled=${this._busy || !this._csrf} @click=${() => pickFiles(files => void this._upload(files))}>${this._busy ? 'Saving…' : 'Browse files'}</button></div>
        ${this._error ? html`<p class="msg error" role="alert">${this._error}</p>` : nothing}
        <div class="manage-list" aria-busy=${this._loading}>${this._data === null ? (this._error ? nothing : loadingRows('Loading deduplication reports…')) : reports.length === 0 ? html`<div class="empty"><strong>No link reports imported yet</strong><p>Each row in a link report lists IDs for the same finding.</p></div>` : html`
          <div class="link-table"><table><thead><tr><th>Report</th><th>Groups</th><th>Finding IDs</th><th>Imported by</th><th>Imported</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${reports.map(report => html`<tr><td>${report.filename}</td><td>${report.groupCount}</td><td>${report.findingCount}</td><td>${report.uploadedByLogin ?? 'Removed user'}</td><td>${new Date(report.uploadedAt).toLocaleDateString()}</td><td>${report.enabled ? 'Enabled' : 'Disabled'}</td><td><button type="button" class="btn" aria-label=${`View ${report.filename}`} @click=${() => this._view(report)}>View</button> <button type="button" class="btn" ?disabled=${this._busy} aria-label=${`${report.enabled ? 'Disable' : 'Enable'} ${report.filename}`} @click=${() => void this._toggle(report)}>${report.enabled ? 'Disable' : 'Enable'}</button></td></tr>`)}</tbody></table></div>`}</div>
      </div>`
  }
}
customElements.define('managed-admin-deduplication', ManagedAdminDeduplication)
