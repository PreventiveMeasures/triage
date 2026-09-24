// `<objstore-recovery-dialog>` — re-checks the workspace's remote
// objstore state, repairs missing bytes from local copies, and brings
// stale report copies back in line. Opened from the page-header sync
// badge's "N cloud" chunk.
//
// On "Re-check" it calls `recheckRemoteStorage(workspaceId, …)` which:
//   1. re-fetches the authoritative remote listing from the server DB,
//   2. re-fetches each listed object,
//   3. re-uploads any whose bytes are gone (a persistent 503 — the row
//      is present but its content-addressed blob is missing) when a
//      matching local copy is held,
//   4. compares each healthy report with this workspace's local copy
//      and, when they differ, brings the stale one in line if it's
//      provably older ("local updated" / "cloud updated"), or else
//      marks the row "differs" with a "Use cloud copy" / "Upload mine"
//      choice (`resolveReportDifference`) — "Use cloud for all" in the
//      footer takes the cloud copy for every such row at once — and
//   5. reports a per-object status:
//      available / local updated / cloud updated / differs /
//      re-uploaded / failed / check failed / missing
//      Each status explains itself on hover (the shared styled
//      tooltip, with the failure reason appended where there is one).
//      ('failed' = a held copy whose re-UPLOAD errored; 'check failed' =
//      the verification DOWNLOAD errored on a transport/session hiccup or
//      decrypt failure, so health is unknown — distinct from a confirmed
//      'missing'; both retryable, reason shown on hover).
// Rows update live via the onList/onItem callbacks. Healthy objects we
// don't hold locally can be pulled down through the existing download
// dialog (the action the badge used to open directly).
//
// Public API:
//   openObjstoreRecoveryDialog({ workspaceId, cloudCount, localFileNames, localBundles, autoRun })
//     `autoRun` starts the re-check as the dialog opens (the badge's
//     "N differ" chunk — the user already asked for it).
//     → Promise<{ items, counts } | null>   (null if closed before any re-check)

import { html, nothing, unsafeCSS } from 'lit'
import { recheckRemoteStorage, resolveReportDifference } from '../client-sync.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { openSyncDownloadDialog } from './sync-download-dialog.js'
import detailActionCSS from '../../styles/detail-action.css'
import listCSS from './dialog-list.css'
import recoveryCSS from './dialog-recovery.css'

// Row label + the hover explanation. "local updated" / "cloud updated"
// name the copy that CHANGED, so the two directions read as a pair.
const STATUS = {
  checking: { label: 'checking…', hint: 'Checking the cloud copy…' },
  good: { label: 'available', hint: 'The cloud copy is intact.' },
  updated: { label: 'local updated', hint: 'Your copy was out of date. It was replaced with the cloud copy.' },
  uploaded: { label: 'cloud updated', hint: 'Your copy was newer. It was uploaded to the cloud.' },
  differs: { label: 'differs', hint: 'Your copy differs from the cloud copy, and nothing shows which one is newer. Choose which to keep.' },
  reuploaded: { label: 're-uploaded', hint: 'The cloud copy\'s data was missing. It was restored from your copy.' },
  failed: { label: 'failed', hint: 'Couldn\'t bring this back in line. Re-check again to retry.' },
  'check-failed': { label: 'check failed', hint: 'Couldn\'t download the cloud copy to check it, so its state is unknown. Re-check again to retry.' },
  missing: { label: 'missing', hint: 'The cloud copy\'s data is gone, and there\'s no matching copy here to restore it from.' },
}

function statusCounts(rows) {
  const counts = { good: 0, updated: 0, uploaded: 0, differs: 0, reuploaded: 0, failed: 0, 'check-failed': 0, missing: 0 }
  for (const r of rows) if (r.status in counts) counts[r.status] += 1
  return counts
}

const copies = (n) => (n === 1 ? 'copy' : 'copies')

class ObjstoreRecoveryDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(detailActionCSS), unsafeCSS(listCSS), unsafeCSS(recoveryCSS)]

  static properties = {
    workspaceId: { type: String },
    cloudCount: { type: Number },
    localFileNames: { type: Array },
    localBundles: { type: Array },
    autoRun: { type: Boolean },
    _rows: { state: true },
    _running: { state: true },
    _ran: { state: true },
    _error: { state: true },
    _settled: { state: true },
    _resolving: { state: true },
    _bulk: { state: true },
  }

  constructor() {
    super()
    this.workspaceId = ''
    this.cloudCount = 0
    this.localFileNames = []
    this.localBundles = []
    this.autoRun = false
    this._rows = []
    this._running = false
    this._ran = false
    this._error = null
    this._settled = false
    // resourceTags of `differs` rows whose "Use cloud copy" / "Upload
    // mine" choice is in flight.
    this._resolving = new Set()
    // True while "Use cloud for all" works through the `differs` rows.
    this._bulk = false
  }

  focusInitial() {
    this.renderRoot.querySelector('button[data-role="recheck"]')?.focus()
    if (this.autoRun) this._onRecheck()
  }

  // Resolve with the result once a re-check has run; null if the user
  // closes before running anything (mirrors the empty-result shape the
  // other badge dialogs return on cancel).
  _result() { return { items: this._rows, counts: this._counts() } }
  _onClose = () => this._finish(this._ran ? this._result() : null)
  _onCancel = () => this._finish(this._ran ? this._result() : null)

  _counts() { return statusCounts(this._rows) }

  // Settle a `differs` row the way the user chose: 'cloud' replaces the
  // local copy with the cloud one, 'local' uploads the local copy.
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
    const rest = new Set(this._resolving)
    rest.delete(row.resourceTag)
    this._resolving = rest
  }

  // "Use cloud for all": the "Use cloud copy" choice for every row still
  // waiting on one, one after another.
  _onUseCloudForAll = async () => {
    if (this._bulk || this._running) return
    this._bulk = true
    try {
      for (const row of this._differingRows()) await this._onResolve(row, 'cloud')
    } finally {
      this._bulk = false
    }
  }

  _differingRows() { return this._rows.filter((r) => r.status === 'differs') }

  _onRecheck = async () => {
    if (this._running || this._bulk) return
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

  // Hover text for a row's status: what happened, then the reason when
  // there is one (the shared tooltip keeps the newline).
  _statusHint(r) {
    let hint = STATUS[r.status]?.hint ?? ''
    if (r.status === 'good' && this._heldLocally(r)) hint = 'The cloud copy is intact and matches your copy.'
    return r.detail ? `${hint}\n${r.detail}` : hint
  }

  _heldLocally(r) {
    if (!r.identifier) return false
    return r.kind === 'bundle' ? this.localBundles.includes(r.identifier) : this.localFileNames.includes(r.identifier)
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

  _summarySection() {
    if (!this._ran || this._rows.length === 0) return nothing
    const c = this._counts()
    const parts = []
    if (c.good) parts.push(`${c.good} available`)
    if (c.updated) parts.push(`${c.updated} local ${copies(c.updated)} updated from the cloud`)
    if (c.uploaded) parts.push(`${c.uploaded} cloud ${copies(c.uploaded)} updated from yours`)
    if (c.differs) parts.push(`${c.differs} ${c.differs === 1 ? 'differs' : 'differ'} — choose which copy to keep`)
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
      : html`<p class="lwd-body">Re-check ${this.cloudCount > 0 ? html`the <strong>${this.cloudCount}</strong> ` : nothing}remote object${plural} for this workspace. Each is re-fetched from the relay and compared with your copy. When one copy is provably newer, the other is updated to match; when it isn't clear, you choose which to keep. Any whose bytes are missing are re-uploaded from a matching local copy.</p>`
    const empty = this._ran && this._rows.length === 0 && !this._error
      ? html`<p class="lwd-empty">No remote objects to check.</p>`
      : nothing
    const downloadable = this._ran ? this._downloadableItems().length : 0
    // "Use cloud for all" is offered from two differing rows up — for
    // one, the row's own "Use cloud copy" is the same action. While it's
    // offered the footer holds just it and "Re-check again": leaving is
    // the corner ×, and "Close" returns once the choice is made (the
    // button goes when no rows differ any more).
    const useCloud = this._differingRows().length > 1 || this._bulk
    // The corner × comes FIRST in the source (it's pinned, not laid out
    // in a row), so a reader tabbing in meets it where the eye finds it
    // — same as the export dialog's. Styled by the shared `.detail-action`
    // the finding popups' close uses.
    return html`<dialog @close=${this._onClose}>
      <button type="button" class="detail-action rec-close" data-role="close" aria-label="Close" @click=${this._onCancel}>×</button>
      <header><h3>Re-check cloud storage</h3></header>
      ${intro}
      ${this._rowsSection()}
      ${empty}
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
        <button type="button" data-role="recheck" @click=${this._onRecheck} ?disabled=${this._running || this._bulk}>
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
