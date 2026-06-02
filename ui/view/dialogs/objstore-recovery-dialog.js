// `<objstore-recovery-dialog>` — re-checks the workspace's remote
// objstore state and repairs missing bytes from local copies. Opened
// from the page-header sync badge's "N cloud" chunk.
//
// On "Re-check" it calls `recheckRemoteStorage(workspaceId, …)` which:
//   1. re-fetches the authoritative remote listing from the server DB,
//   2. re-fetches each listed object,
//   3. re-uploads any whose bytes are gone (a persistent 503 — the row
//      is present but its content-addressed blob is missing) when a
//      matching local copy is held, and
//   4. reports a per-object status:
//      good / re-uploaded / failed / check failed / missing
//      ('failed' = a held copy whose re-UPLOAD errored; 'check failed' =
//      the verification DOWNLOAD errored on a transport/session hiccup or
//      decrypt failure, so health is unknown — distinct from a confirmed
//      'missing'; both retryable, reason shown on hover).
// Rows update live via the onList/onItem callbacks. Healthy objects we
// don't hold locally can be pulled down through the existing download
// dialog (the action the badge used to open directly).
//
// Public API:
//   openObjstoreRecoveryDialog({ workspaceId, cloudCount, localFileNames, localBundles })
//     → Promise<{ items, counts } | null>   (null if closed before any re-check)

import { html, nothing, unsafeCSS } from 'lit'
import { recheckRemoteStorage } from '../client-sync.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { openSyncDownloadDialog } from './sync-download-dialog.js'
import listCSS from './dialog-list.css'
import recoveryCSS from './dialog-recovery.css'

const STATUS_LABEL = { checking: 'checking…', good: 'available', reuploaded: 're-uploaded', failed: 're-upload failed', 'check-failed': 'check failed', missing: 'missing' }

class ObjstoreRecoveryDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS), unsafeCSS(recoveryCSS)]

  static properties = {
    workspaceId: { type: String },
    cloudCount: { type: Number },
    localFileNames: { type: Array },
    localBundles: { type: Array },
    _rows: { state: true },
    _running: { state: true },
    _ran: { state: true },
    _error: { state: true },
    _settled: { state: true },
  }

  constructor() {
    super()
    this.workspaceId = ''
    this.cloudCount = 0
    this.localFileNames = []
    this.localBundles = []
    this._rows = []
    this._running = false
    this._ran = false
    this._error = null
    this._settled = false
  }

  focusInitial() {
    this.renderRoot.querySelector('button[data-role="recheck"]')?.focus()
  }

  // Resolve with the result once a re-check has run; null if the user
  // closes before running anything (mirrors the empty-result shape the
  // other badge dialogs return on cancel).
  _result() { return { items: this._rows, counts: this._counts() } }
  _onClose = () => this._finish(this._ran ? this._result() : null)
  _onCancel = () => this._finish(this._ran ? this._result() : null)

  _counts() {
    const counts = { good: 0, reuploaded: 0, failed: 0, 'check-failed': 0, missing: 0 }
    for (const r of this._rows) if (r.status in counts) counts[r.status] += 1
    return counts
  }

  _onRecheck = async () => {
    if (this._running) return
    this._running = true
    this._error = null
    this._rows = []
    try {
      const { items } = await recheckRemoteStorage(this.workspaceId, {
        // Seed the pending list so rows render as "checking" up front.
        onList: (rows) => { this._rows = rows },
        // Each object resolves → reassign the array (not in-place
        // mutation) so Lit re-renders the changed row's status live.
        onItem: (row) => { this._rows = this._rows.map((r) => (r.resourceTag === row.resourceTag ? row : r)) },
      })
      this._rows = items
    } catch (err) {
      this._error = err?.message ?? String(err)
    } finally {
      this._running = false
      this._ran = true
    }
  }

  // Healthy remote objects we don't hold locally — downloadable via the
  // existing sync-download dialog (the action the badge used to open
  // before this dialog took over the "cloud" chunk).
  _downloadableItems() {
    const localReports = new Set(this.localFileNames)
    const localBundles = new Set(this.localBundles)
    const items = []
    for (const r of this._rows) {
      if (r.status !== 'good' || !r.identifier) continue
      if (r.kind === 'report' && !localReports.has(r.identifier)) {
        items.push({ kind: 'report', identifier: r.identifier })
      } else if (r.kind === 'bundle' && !localBundles.has(r.identifier)) {
        items.push({ kind: 'bundle', identifier: r.identifier, label: r.label })
      }
    }
    return items
  }

  _onDownload = async () => {
    const items = this._downloadableItems()
    if (items.length === 0) return
    await openSyncDownloadDialog({ workspaceId: this.workspaceId, items })
  }

  _rowsSection() {
    if (this._rows.length === 0) {
      return this._running ? html`<p class="lwd-body">Fetching remote listing…</p>` : nothing
    }
    return html`<ul class="rec-list">
      ${this._rows.map((r) => html`<li class="rec-row">
        <span class="rec-label">${r.label}${r.kind === 'bundle' ? html`<span class="lwd-kind-tag">bundle</span>` : nothing}</span>
        <span class=${`rec-status rec-status-${r.status}`} title=${r.detail ?? nothing}>${STATUS_LABEL[r.status] ?? r.status}</span>
      </li>`)}
    </ul>`
  }

  _summarySection() {
    if (!this._ran || this._rows.length === 0) return nothing
    const c = this._counts()
    const parts = []
    if (c.good) parts.push(`${c.good} available`)
    if (c.reuploaded) parts.push(`${c.reuploaded} re-uploaded`)
    if (c.failed) parts.push(`${c.failed} failed`)
    if (c['check-failed']) parts.push(`${c['check-failed']} check failed`)
    if (c.missing) parts.push(`${c.missing} missing`)
    // role="status"/aria-live so a screen reader announces the outcome
    // when the re-check finishes (the per-row updates above aren't a live
    // region, so this is the assistive summary of the run).
    return parts.length > 0 ? html`<p class="rec-summary" role="status" aria-live="polite">${parts.join(' · ')}</p>` : nothing
  }

  render() {
    const plural = this.cloudCount === 1 ? '' : 's'
    const intro = this._ran
      ? nothing
      : html`<p class="lwd-body">Re-check ${this.cloudCount > 0 ? html`the <strong>${this.cloudCount}</strong> ` : nothing}remote object${plural} for this workspace. Each is re-fetched from the relay; any whose bytes are missing are re-uploaded from a matching local copy.</p>`
    const empty = this._ran && this._rows.length === 0 && !this._error
      ? html`<p class="lwd-empty">No remote objects to check.</p>`
      : nothing
    const downloadable = this._ran ? this._downloadableItems().length : 0
    return html`<dialog @close=${this._onClose}>
      <header><h3>Re-check cloud storage</h3></header>
      ${intro}
      ${this._rowsSection()}
      ${empty}
      ${this._summarySection()}
      ${this._error ? html`<p class="rec-error" role="alert">${this._error}</p>` : nothing}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        ${downloadable > 0 ? html`<button type="button" data-role="download" @click=${this._onDownload} ?disabled=${this._running}>
          Download ${downloadable} not stored locally
        </button>` : nothing}
        <button type="button" data-role="cancel" @click=${this._onCancel} ?disabled=${this._running}>
          ${this._ran ? 'Close' : 'Cancel'}
        </button>
        <button type="button" data-role="recheck" @click=${this._onRecheck} ?disabled=${this._running}>
          ${this._running ? 'Re-checking…' : (this._ran ? 'Re-check again' : 'Re-check')}
        </button>
      </footer>
    </dialog>`
  }
}

customElements.define('objstore-recovery-dialog', ObjstoreRecoveryDialog)

export function openObjstoreRecoveryDialog({ workspaceId, cloudCount, localFileNames, localBundles } = {}) {
  return openAppDialog('objstore-recovery-dialog', {
    workspaceId: workspaceId ?? '',
    cloudCount: typeof cloudCount === 'number' ? cloudCount : 0,
    localFileNames: Array.isArray(localFileNames) ? [...localFileNames] : [],
    localBundles: Array.isArray(localBundles) ? [...localBundles] : [],
  })
}
