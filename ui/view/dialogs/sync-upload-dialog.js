// `<sync-upload-dialog>` — unified upload prompt for the workspace's
// remote inventory. Replaces the prior split between
// `<upload-report-dialog>` and `<upload-bundles-dialog>` so the
// page-header sync badge can surface a single "M local" chunk
// covering reports + bundles. Each item carries its kind so the
// dialog dispatches per-item to the right session method
// (`putFile` for reports, `putBundleToRemote` for bundles).
//
// Public API:
//   openSyncUploadDialog({ workspaceId, items })
//     items: Array<{ kind: 'report', identifier: filename }
//                 | { kind: 'bundle', identifier: integrity, label?: string }>
//   → Promise<{ uploaded, failed }> where each entry carries
//     `{ kind, identifier }`.

import { html, nothing, unsafeCSS } from 'lit'
import { readFileBytes } from '#client/index.js'
import { putBundleToRemote, putFile } from '../client-sync.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import listCSS from './dialog-list.css'

function bundleShortLabel(integrity) {
  return `bundle-${integrity.slice('sha512-'.length, 'sha512-'.length + 12)}…`
}

function itemDisplayLabel(item) {
  if (item.kind === 'bundle') return item.label ?? bundleShortLabel(item.identifier)
  return item.identifier
}

class SyncUploadDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS)]

  static properties = {
    workspaceId: { type: String },
    items: { type: Array },
    _uploading: { state: true },
    _errors: { state: true },
    _done: { state: true },
    _settled: { state: true },
  }

  constructor() {
    super()
    this.workspaceId = ''
    this.items = []
    this._uploading = false
    this._errors = []
    this._done = false
    this._settled = false
  }

  // Focus the Upload action. The base `_finish` (close + resolve) is
  // inherited unchanged; `_onClose` / `_onCancel` resolve the
  // empty-result shape callers expect.
  focusInitial() {
    this.renderRoot.querySelector('button[data-role="upload"]')?.focus()
  }

  _onClose = () => this._finish({ uploaded: [], failed: [] })
  _onCancel = () => this._finish({ uploaded: [], failed: [] })

  _onUpload = async () => {
    if (this._uploading) return
    this._uploading = true
    this._errors = []
    const uploaded = []
    const failed = []
    for (const item of this.items) {
      try {
        let result
        if (item.kind === 'bundle') {
          result = await putBundleToRemote(this.workspaceId, item.identifier)
        } else {
          const bytes = await readFileBytes(item.identifier)
          result = await putFile(this.workspaceId, item.identifier, bytes)
        }
        if (result.ok) uploaded.push({ kind: item.kind, identifier: item.identifier })
        else {
          const reason = result.reason ?? 'unknown'
          failed.push({ kind: item.kind, identifier: item.identifier, reason })
          this._errors = [...this._errors, { label: itemDisplayLabel(item), reason }]
        }
      } catch (err) {
        const reason = err?.message ?? String(err)
        failed.push({ kind: item.kind, identifier: item.identifier, reason })
        this._errors = [...this._errors, { label: itemDisplayLabel(item), reason }]
      }
    }
    this._uploading = false
    this._done = true
    if (failed.length === 0) this._finish({ uploaded, failed })
  }

  _errorsSection() {
    if (this._errors.length === 0) return nothing
    return html`<ul class="lwd-list" role="alert">
      ${this._errors.map((e) => html`<li><strong>${e.label}</strong> — ${e.reason}</li>`)}
    </ul>`
  }

  render() {
    const count = this.items.length
    const singular = count === 1
    const reportCount = this.items.filter((i) => i.kind === 'report').length
    const bundleCount = count - reportCount
    let kindLabel = 'items'
    if (bundleCount === 0) kindLabel = singular ? 'report' : 'reports'
    else if (reportCount === 0) kindLabel = singular ? 'bundle' : 'bundles'
    const intro = singular
      ? html`Upload <strong>"${itemDisplayLabel(this.items[0])}"</strong> to the workspace's remote inventory?`
      : html`Upload <strong>${count}</strong> local ${kindLabel} to the workspace's remote inventory?`
    const list = singular ? nothing : html`<ul class="lwd-list">
      ${this.items.map((i) => html`<li>${itemDisplayLabel(i)}${i.kind === 'bundle' ? html` <span class="lwd-kind-tag">bundle</span>` : nothing}</li>`)}
    </ul>`
    const uploadLabel = this._uploading
      ? (singular ? 'Uploading…' : `Uploading ${count} ${kindLabel}…`)
      : (singular ? 'Upload' : `Upload ${count}`)
    return html`<dialog @close=${this._onClose}>
      <header class="lwd-head"><h3>Upload to remote</h3></header>
      <p class="lwd-body">${intro}</p>
      ${list}
      ${this._errorsSection()}
      <footer class="lwd-actions">
        <span class="lwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel} ?disabled=${this._uploading}>
          ${this._done && this._errors.length > 0 ? 'Close' : 'Cancel'}
        </button>
        ${this._done && this._errors.length > 0 ? nothing : html`<button
          type="button"
          data-role="upload"
          @click=${this._onUpload}
          ?disabled=${this._uploading || count === 0}
        >${uploadLabel}</button>`}
      </footer>
    </dialog>`
  }
}

customElements.define('sync-upload-dialog', SyncUploadDialog)

export function openSyncUploadDialog({ workspaceId, items } = {}) {
  return openAppDialog('sync-upload-dialog', {
    workspaceId: workspaceId ?? '',
    items: Array.isArray(items) ? [...items] : [],
  })
}
