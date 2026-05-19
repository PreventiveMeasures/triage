// `<sync-download-dialog>` — unified download prompt for the
// workspace's remote inventory. Replaces the prior
// `<download-report-dialog>` + `<download-bundles-dialog>` split so
// the page-header badge can offer a single "N cloud" chunk covering
// peer-uploaded reports + bundles. Each item carries its kind so
// the dialog dispatches per-item to the right session method
// (`fetchFile` → save + attach for reports;
// `fetchBundleFromRemote` for bundles, which already saves + fires
// the bundle auto-download listener so the UI refreshes).
//
// Public API:
//   openSyncDownloadDialog({ workspaceId, items })
//     items: Array<{ kind: 'report', identifier: filename }
//                 | { kind: 'bundle', identifier: integrity }>
//   → Promise<{ downloaded, failed }>

import { LitElement, html, nothing } from 'lit'
import { decodeUtf8 } from '../../common/utf8.js'
import { addBundleToWorkspace, addReportToWorkspace, analyzeContent, fetchBundleFromRemote, fetchFile, gunzipBytes, saveFileBytes, setCount, state } from '#client/index.js'
import { switchToWorkspace } from './ingest.js'

function bundleShortLabel(integrity) {
  return `bundle-${integrity.slice('sha512-'.length, 'sha512-'.length + 12)}…`
}

function itemDisplayLabel(item) {
  if (item.kind === 'bundle') return item.label ?? bundleShortLabel(item.identifier)
  return item.identifier
}

class SyncDownloadDialog extends LitElement {
  static properties = {
    workspaceId: { type: String },
    items: { type: Array },
    _running: { state: true },
    _errors: { state: true },
    _done: { state: true },
    _settled: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.workspaceId = ''
    this.items = []
    this._running = false
    this._errors = []
    this._done = false
    this._settled = false
  }

  firstUpdated() {
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.showModal()
    const dl = this.querySelector('button[data-role="download"]')
    if (dl) dl.focus()
  }

  _finish(result) {
    if (this._settled) return
    this._settled = true
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: result }))
  }

  _onClose = () => this._finish({ downloaded: [], failed: [] })
  _onCancel = () => this._finish({ downloaded: [], failed: [] })

  _onDownload = async () => {
    if (this._running) return
    this._running = true
    this._errors = []
    const downloaded = []
    const failed = []
    for (const item of this.items) {
      try {
        if (item.kind === 'bundle') {
          const r = await fetchBundleFromRemote(this.workspaceId, item.identifier)
          if (!r.ok) {
            const reason = r.reason ?? 'unknown'
            failed.push({ kind: 'bundle', identifier: item.identifier, reason })
            this._errors = [...this._errors, { label: itemDisplayLabel(item), reason }]
            continue
          }
          // fetchBundleFromRemote already saved + fired auto-download
          // listener (which the UI bridge subscribes to for refresh).
          // Attach to this workspace's bundles list.
          await addBundleToWorkspace(item.identifier, this.workspaceId)
          downloaded.push({ kind: 'bundle', identifier: item.identifier })
          continue
        }
        // Report path — mirror the prior download-dialog logic.
        const got = await fetchFile(this.workspaceId, item.identifier)
        if (!got) {
          failed.push({ kind: 'report', identifier: item.identifier, reason: 'not found in remote' })
          this._errors = [...this._errors, { label: itemDisplayLabel(item), reason: 'not found in remote' }]
          continue
        }
        let text
        try { text = decodeUtf8(await gunzipBytes(got.content)) }
        catch {
          const reason = 'remote payload is not gzipped UTF-8'
          failed.push({ kind: 'report', identifier: item.identifier, reason })
          this._errors = [...this._errors, { label: itemDisplayLabel(item), reason }]
          continue
        }
        const result = analyzeContent(text)
        if (!result.recognized) {
          const reason = 'remote payload is not a recognized report format'
          failed.push({ kind: 'report', identifier: item.identifier, reason })
          this._errors = [...this._errors, { label: itemDisplayLabel(item), reason }]
          continue
        }
        await saveFileBytes(item.identifier, got.content)
        setCount(item.identifier, result.count, result.source)
        await addReportToWorkspace(item.identifier, this.workspaceId)
        downloaded.push({ kind: 'report', identifier: item.identifier })
      } catch (err) {
        const reason = err?.message ?? String(err)
        failed.push({ kind: item.kind, identifier: item.identifier, reason })
        this._errors = [...this._errors, { label: itemDisplayLabel(item), reason }]
      }
    }
    this._running = false
    this._done = true
    // Reload the active workspace view so freshly-saved reports
    // show up in merged findings. Only run when the user is still
    // looking at the workspace we downloaded into (mirrors the
    // r3242639406 guard in the old download-dialog).
    if (downloaded.some((d) => d.kind === 'report')) {
      try {
        if (state.currentWorkspace === this.workspaceId) {
          await switchToWorkspace(this.workspaceId)
        }
      } catch {}
    }
    if (failed.length === 0) this._finish({ downloaded, failed })
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
      ? html`Download <strong>"${itemDisplayLabel(this.items[0])}"</strong> from the workspace's remote inventory?`
      : html`Download <strong>${count}</strong> remote ${kindLabel} into this workspace?`
    const list = singular ? nothing : html`<ul class="lwd-list">
      ${this.items.map((i) => html`<li>${itemDisplayLabel(i)}${i.kind === 'bundle' ? html` <span class="lwd-kind-tag">bundle</span>` : nothing}</li>`)}
    </ul>`
    const dlLabel = this._running
      ? (singular ? 'Downloading…' : `Downloading ${count} ${kindLabel}…`)
      : (singular ? 'Download' : `Download ${count}`)
    return html`<dialog class="leave-workspace-dialog sync-download-dialog" @close=${this._onClose}>
      <header class="lwd-head"><h3>Download from remote</h3></header>
      <p class="lwd-body">${intro}</p>
      ${list}
      ${this._errorsSection()}
      <footer class="lwd-actions">
        <span class="lwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel} ?disabled=${this._running}>
          ${this._done && this._errors.length > 0 ? 'Close' : 'Cancel'}
        </button>
        ${this._done && this._errors.length > 0 ? nothing : html`<button
          type="button"
          data-role="download"
          @click=${this._onDownload}
          ?disabled=${this._running || count === 0}
        >${dlLabel}</button>`}
      </footer>
    </dialog>`
  }
}

customElements.define('sync-download-dialog', SyncDownloadDialog)

export function openSyncDownloadDialog({ workspaceId, items } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('sync-download-dialog')
    el.workspaceId = workspaceId ?? ''
    el.items = Array.isArray(items) ? [...items] : []
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    document.body.append(el)
  })
}
