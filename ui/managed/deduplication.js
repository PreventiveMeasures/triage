import { html, unsafeCSS } from 'lit'
import { FileDrop, ManagedPage, emptyState, errorMessage } from './page.js'
import { openAdminPage } from './navigation.js'
import { jsonEndpoint } from './admin-api.js'
import { uploadFiles } from './file-uploads.js'
import commonStyles from './styles/common.css'
import reportsStyles from './styles/reports.css'
import linksStyles from './styles/links.css'

const request = jsonEndpoint('/api/admin/deduplication', {
  'storage-encryption-required': 'Configure MANAGED_STORAGE_ENCRYPTION_KEY on the server to import encrypted link reports.',
  'invalid-link-report': 'Choose a link report containing arrays of finding IDs, such as [["id1", "id2"]].',
  'too-large': 'This link report exceeds the server upload limit.',
})
const FAMILIES = ['deduplication', 'reports', 'teams']

class ManagedAdminDeduplication extends ManagedPage {
  static view = 'manage-deduplication'
  static properties = { _busy: { state: true } }
  static styles = [unsafeCSS(commonStyles), unsafeCSS(reportsStyles), unsafeCSS(linksStyles)]
  static collection = ['deduplication', 'deduplication reports', signal => request('', { signal })]

  constructor() {
    super()
    this._busy = false
    this._queue = []
    this._drop = new FileDrop(this)
  }

  _upload(files) {
    if (!this._csrf || this._role !== 'admin') return
    return uploadFiles(this, files, file => request('', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-report-filename': encodeURIComponent(file.name), 'x-csrf-token': this._csrf }, body: file,
    }), FAMILIES)
  }

  async _toggle(report) {
    if (this._busy || !this._csrf) return
    this._busy = true; this._error = null
    try {
      await this.appState.mutate(() => request(`/${encodeURIComponent(report.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': this._csrf }, body: JSON.stringify({ enabled: !report.enabled }),
      }), FAMILIES)
    } catch (err) { this._error = String(err?.message ?? err) }
    finally {
      this._busy = false
      await this._load({ preserveError: true })
      const queued = this._queue.splice(0)
      if (queued.length > 0) void this._upload(queued)
    }
  }

  render() {
    const reports = this._data?.reports ?? []
    return html`${this._drop.overlay('Drop link reports to import')}
      <div class="wrap">${this._nav()}
        <h1 class="sr-only">Deduplication</h1>
        <div class="page-intro"><p class="intro">Link duplicate findings across all teams.</p><span class="result-count">${this._data ? reports.length : '…'} reports</span><button type="button" class="btn" @click=${() => openAdminPage('manage-scans', { scanMode: 'link' })}>Link reports</button></div>
        <div class="drop-card">${this._drop.card('Import link reports', 'Drop *.link.json files anywhere on this page.', this._busy || !this._csrf, 'Saving…')}</div>
        ${errorMessage(this._error)}
        ${this._list(this._data, 'Loading deduplication reports…', () => reports.length === 0 ? emptyState('No link reports imported yet', 'Each row in a link report lists IDs for the same finding.') : html`
          <div class="link-table"><table><thead><tr><th>Report</th><th>Groups</th><th>Finding IDs</th><th>Imported by</th><th>Imported</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${reports.map(report => html`<tr><td>${report.filename}</td><td>${report.groupCount}</td><td>${report.findingCount}</td><td>${report.uploadedByLogin ?? 'Removed user'}</td><td>${new Date(report.uploadedAt).toLocaleDateString()}</td><td>${report.enabled ? 'Enabled' : 'Disabled'}</td><td><button type="button" class="btn" aria-label=${`View ${report.filename}`} @click=${() => openAdminPage('manage-deduplication', { linkId: report.id })}>View</button> <button type="button" class="btn" ?disabled=${this._busy} aria-label=${`${report.enabled ? 'Disable' : 'Enable'} ${report.filename}`} @click=${() => void this._toggle(report)}>${report.enabled ? 'Disable' : 'Enable'}</button></td></tr>`)}</tbody></table></div>`)}
      </div>`
  }
}
customElements.define('managed-admin-deduplication', ManagedAdminDeduplication)
