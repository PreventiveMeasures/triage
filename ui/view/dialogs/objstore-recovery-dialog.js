// Re-checks the workspace's remote objstore from the sync badge's "N cloud".
// `recheckRemoteStorage` re-fetches the server's listing and each object,
// re-uploads from a matching local copy any whose bytes are gone (a persistent
// 503: row present, content-addressed blob missing), and compares each healthy
// report with the local copy: the provably older is brought in line, else the
// row "differs" and the user keeps one (`resolveReportDifference`; "Use cloud
// for all" does every such row). Rows update live through onList / onItem,
// each status explained on hover with its reason. Healthy objects not held
// locally can be pulled through the download dialog.
//
//   openObjstoreRecoveryDialog({ workspaceId, cloudCount, localFileNames, localBundles, autoRun })
//     `autoRun` starts at once (the badge's "N differ": already asked for).
//     → Promise<{ items, counts } | null>   (null if closed before any re-check)
import { html, nothing, unsafeCSS } from 'lit'
import { recheckRemoteStorage, resolveReportDifference } from '../client-sync.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { openSyncDownloadDialog } from './sync-download-dialog.js'
import detailActionCSS from '../../styles/detail-action.css'
import listCSS from './dialog-list.css'
import recoveryCSS from './dialog-recovery.css'

const copies = (n) => (n === 1 ? 'copy' : 'copies')

// Each status's row label, hover text, and the summary of how many have it.
// "local updated" / "cloud updated" name the copy that CHANGED. 'failed' is a
// held copy whose re-UPLOAD errored; 'check failed' a verifying DOWNLOAD that
// did (transport, session, decrypt), so its health is unknown, unlike a
// confirmed 'missing'.
const STATUS = {
  checking: { label: 'checking…', hint: 'Checking the cloud copy…' },
  good: { label: 'available', hint: 'The cloud copy is intact.', summary: (n) => `${n} available` },
  updated: { label: 'local updated', hint: 'Your copy was out of date. It was replaced with the cloud copy.', summary: (n) => `${n} local ${copies(n)} updated from the cloud` },
  uploaded: { label: 'cloud updated', hint: 'Your copy was newer. It was uploaded to the cloud.', summary: (n) => `${n} cloud ${copies(n)} updated from yours` },
  differs: { label: 'differs', hint: 'Your copy differs from the cloud copy, and nothing shows which one is newer. Choose which to keep.', summary: (n) => `${n} ${n === 1 ? 'differs' : 'differ'} — choose which copy to keep` },
  reuploaded: { label: 're-uploaded', hint: 'The cloud copy\'s data was missing. It was restored from your copy.', summary: (n) => `${n} re-uploaded` },
  failed: { label: 'failed', hint: 'Couldn\'t bring this back in line. Re-check again to retry.', summary: (n) => `${n} failed` },
  'check-failed': { label: 'check failed', hint: 'Couldn\'t download the cloud copy to check it, so its state is unknown. Re-check again to retry.', summary: (n) => `${n} check failed` },
  missing: { label: 'missing', hint: 'The cloud copy\'s data is gone, and there\'s no matching copy here to restore it from.', summary: (n) => `${n} missing` },
}
const COUNTED = Object.keys(STATUS).filter((status) => STATUS[status].summary)

function statusCounts(rows) {
  const counts = Object.fromEntries(COUNTED.map((status) => [status, 0]))
  for (const r of rows) if (r.status in counts) counts[r.status] += 1
  return counts
}

class ObjstoreRecoveryDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(detailActionCSS), unsafeCSS(listCSS), unsafeCSS(recoveryCSS)]

  static properties = {
    _rows: { state: true },
    _running: { state: true },
    _ran: { state: true },
    _error: { state: true },
    _resolving: { state: true },
    _bulk: { state: true },
  }

  constructor() {
    super()
    this._rows = []
    this._running = false
    this._ran = false
    this._error = null
    // resourceTags of `differs` rows whose choice is in flight.
    this._resolving = new Set()
    // "Use cloud for all" is working through the `differs` rows.
    this._bulk = false
  }

  focusInitial() {
    this.renderRoot.querySelector('button[data-role="recheck"]')?.focus()
    if (this.autoRun) this._onRecheck()
  }

  _onClose = () => this._finish(this._ran ? { items: this._rows, counts: statusCounts(this._rows) } : null)

  _differingRows() { return this._rows.filter((r) => r.status === 'differs') }

  // 'cloud' replaces the local copy with the cloud's, 'local' uploads it.
  _onResolve = async (row, keep) => {
    if (this._resolving.has(row.resourceTag)) return
    this._resolving = new Set([...this._resolving, row.resourceTag])
    let next
    try {
      const r = await resolveReportDifference(this.workspaceId, row.identifier, keep, row.compared)
      next = r ? { status: r.status, detail: r.detail } : { status: 'failed', detail: 'sync is not available' }
    } catch (err) {
      next = { status: 'failed', detail: err?.message ?? String(err) }
    }
    this._rows = this._rows.map((r) => (r.resourceTag === row.resourceTag ? { ...r, ...next } : r))
    this._resolving = new Set([...this._resolving].filter((tag) => tag !== row.resourceTag))
  }

  _onUseCloudForAll = async () => {
    if (this._bulk || this._running) return
    this._bulk = true
    try {
      for (const row of this._differingRows()) await this._onResolve(row, 'cloud')
    } finally {
      this._bulk = false
    }
  }

  _onRecheck = async () => {
    // Not while a row's choice is in flight: it would judge copies mid-change
    // (review r4099376963; presence also re-fetches a copy that went stale).
    if (this._running || this._bulk || this._resolving.size > 0) return
    this._running = true
    this._error = null
    this._rows = []
    try {
      const { items } = await recheckRemoteStorage(this.workspaceId, {
        // Rows show as "checking" up front, and each changes as it resolves.
        onList: (rows) => { this._rows = rows },
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

  _heldLocally(r) {
    if (!r.identifier) return false
    return r.kind === 'bundle' ? this.localBundles.includes(r.identifier) : this.localFileNames.includes(r.identifier)
  }

  // Healthy remote objects not held here, for the download dialog.
  _downloadableItems() {
    return this._rows
      .filter((r) => r.status === 'good' && r.identifier && (r.kind === 'report' || r.kind === 'bundle') && !this._heldLocally(r))
      .map((r) => (r.kind === 'report' ? { kind: 'report', identifier: r.identifier } : { kind: 'bundle', identifier: r.identifier, label: r.label }))
  }

  _onDownload = async () => {
    const items = this._downloadableItems()
    if (items.length > 0) await openSyncDownloadDialog({ workspaceId: this.workspaceId, items })
  }

  // What happened, then the reason when there is one (the tooltip keeps the newline).
  _statusHint(r) {
    const hint = r.status === 'good' && this._heldLocally(r) ? 'The cloud copy is intact and matches your copy.' : STATUS[r.status]?.hint ?? ''
    return r.detail ? `${hint}\n${r.detail}` : hint
  }

  _choice(r) {
    if (r.status !== 'differs') return nothing
    const busy = this._running || this._bulk || this._resolving.has(r.resourceTag)
    return html`<span class="rec-choice">
      <button type="button" data-role="keep-cloud" data-tooltip="Replace your copy with the cloud copy"
        @click=${() => this._onResolve(r, 'cloud')} ?disabled=${busy}>Use cloud copy</button>
      <button type="button" data-role="keep-local" data-tooltip="Upload your copy, replacing the cloud copy"
        @click=${() => this._onResolve(r, 'local')} ?disabled=${busy}>Upload mine</button>
    </span>`
  }

  _rowsSection() {
    if (this._rows.length === 0) {
      return this._running ? html`<p class="lwd-body">Fetching remote listing…</p>` : nothing
    }
    return html`<ul class="rec-list">
      ${this._rows.map((r) => html`<li class="rec-row">
        <span class="rec-label">${r.label}${r.kind === 'bundle' ? html`<span class="lwd-kind-tag">bundle</span>` : nothing}</span>
        ${this._choice(r)}
        <span class=${`rec-status rec-status-${r.status}`} data-tooltip=${this._statusHint(r)}>${STATUS[r.status]?.label ?? r.status}</span>
      </li>`)}
    </ul>`
  }

  // A live region: the per-row updates aren't, so this announces the outcome.
  _summarySection() {
    if (!this._ran || this._rows.length === 0) return nothing
    const counts = statusCounts(this._rows)
    const parts = COUNTED.filter((status) => counts[status]).map((status) => STATUS[status].summary(counts[status]))
    return parts.length > 0 ? html`<p class="rec-summary" role="status" aria-live="polite">${parts.join(' · ')}</p>` : nothing
  }

  render() {
    const plural = this.cloudCount === 1 ? '' : 's'
    const objects = this.cloudCount > 0 ? html`the <strong>${this.cloudCount}</strong> remote` : 'remote'
    const downloadable = this._ran ? this._downloadableItems().length : 0
    // From two differing rows up (for one, its own "Use cloud copy" is the
    // same): then the footer holds it and "Re-check again" alone, leaving by
    // the corner ×, until no row differs.
    const useCloud = this._differingRows().length > 1 || this._bulk
    // The pinned corner × leads the source, where a reader tabbing in meets it.
    return html`<dialog @close=${this._onClose}>
      <button type="button" class="detail-action rec-close" data-role="close" aria-label="Close" @click=${this._onCancel}>×</button>
      <header><h3>Re-check cloud storage</h3></header>
      ${this._ran ? nothing
        : html`<p class="lwd-body">Re-check ${objects} object${plural} for this workspace. Each is re-fetched from the relay and compared with your copy. When one copy is provably newer, the other is updated to match; when it isn't clear, you choose which to keep. Any whose bytes are missing are re-uploaded from a matching local copy.</p>`}
      ${this._rowsSection()}
      ${this._ran && this._rows.length === 0 && !this._error ? html`<p class="lwd-empty">No remote objects to check.</p>` : nothing}
      ${this._summarySection()}
      ${this._error ? html`<p class="rec-error" role="alert">${this._error}</p>` : nothing}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        ${useCloud ? html`<button type="button" data-role="use-cloud-all"
          data-tooltip="Replace your copy of every report that differs with its cloud copy"
          @click=${this._onUseCloudForAll} ?disabled=${this._running || this._bulk}>
          ${this._bulk ? 'Using cloud copies…' : `Use cloud for all ${this._differingRows().length} conflicts`}
        </button>` : nothing}
        ${!useCloud && downloadable > 0 ? html`<button type="button" data-role="download" @click=${this._onDownload} ?disabled=${this._running}>
          Download ${downloadable} not stored locally
        </button>` : nothing}
        ${useCloud ? nothing : html`<button type="button" data-role="cancel" @click=${this._onCancel} ?disabled=${this._running}>
          ${this._ran ? 'Close' : 'Cancel'}
        </button>`}
        <button type="button" data-role="recheck" @click=${this._onRecheck} ?disabled=${this._running || this._bulk || this._resolving.size > 0}>
          ${this._running ? 'Re-checking…' : (this._ran ? 'Re-check again' : 'Re-check')}
        </button>
      </footer>
    </dialog>`
  }
}

customElements.define('objstore-recovery-dialog', ObjstoreRecoveryDialog)

export function openObjstoreRecoveryDialog({ workspaceId, cloudCount, localFileNames, localBundles, autoRun } = {}) {
  return openAppDialog('objstore-recovery-dialog', {
    workspaceId: workspaceId ?? '',
    cloudCount: typeof cloudCount === 'number' ? cloudCount : 0,
    localFileNames: Array.isArray(localFileNames) ? [...localFileNames] : [],
    localBundles: Array.isArray(localBundles) ? [...localBundles] : [],
    autoRun: autoRun === true,
  })
}
