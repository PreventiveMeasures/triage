// `<sync-download-dialog>` — unified download prompt for the
// workspace's remote inventory, so the page-header badge can offer a
// single "N cloud" chunk covering peer-uploaded reports + bundles.
// Each item carries its kind so the dialog dispatches per-item to
// the right session method
// (`fetchFile` → save + attach for reports;
// `fetchBundleFromRemote` for bundles, which already saves + fires
// the bundle auto-download listener so the UI refreshes).
//
// Public API:
//   openSyncDownloadDialog({ workspaceId, items })
//     items: Array<{ kind: 'report', identifier: filename }
//                 | { kind: 'bundle', identifier: integrity }>
//   → Promise<{ downloaded, failed }>

import { html, nothing, unsafeCSS } from 'lit'
import { decodeUtf8 } from '../../../common/utf8.js'
import { addBundleToWorkspace, addReportToWorkspace, analyzeContent, gunzipBytes, saveFileBytes, setCount, state } from '#client/index.js'
import { fetchBundleFromRemote, fetchFile } from '../client-sync.js'
import { switchToWorkspace } from '../ingest.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import listCSS from './dialog-list.css'
import { itemDisplayLabel, transferErrorsList, transferItemsList, transferSummary } from './shared.js'

class SyncDownloadDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS)]

  static properties = {
    workspaceId: { type: String },
    items: { type: Array },
    _running: { state: true },
    _errors: { state: true },
    _done: { state: true },
    _settled: { state: true },
  }

  constructor() {
    super()
    this.workspaceId = ''
    this.items = []
    this._running = false
    this._errors = []
    this._done = false
    this._settled = false
  }

  // Focus the Download action. The base `_finish` (close + resolve)
  // is inherited unchanged; `_onClose` / `_onCancel` resolve the
  // empty-result shape callers expect.
  focusInitial() {
    this.renderRoot.querySelector('button[data-role="download"]')?.focus()
  }

  _onClose = () => this._finish({ downloaded: [], failed: [] })
  _onCancel = () => this._finish({ downloaded: [], failed: [] })

  // Record one failure on both the resolve payload and the rendered
  // error list. `kind` is explicit: the per-branch sites label by the
  // branch taken, the catch-all by `item.kind`.
  _fail(failed, item, kind, reason) {
    failed.push({ kind, identifier: item.identifier, reason })
    this._errors = [...this._errors, { label: itemDisplayLabel(item), reason }]
  }

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
            this._fail(failed, item, 'bundle', r.reason ?? 'unknown')
            continue
          }
          // fetchBundleFromRemote already saved + fired auto-download
          // listener (which the UI bridge subscribes to for refresh).
          // Attach to this workspace's bundles list.
          await addBundleToWorkspace(item.identifier, this.workspaceId)
          downloaded.push({ kind: 'bundle', identifier: item.identifier })
          continue
        }
        // Report path.
        const got = await fetchFile(this.workspaceId, item.identifier)
        if (!got) {
          this._fail(failed, item, 'report', 'not found in remote')
          continue
        }
        let text
        try { text = decodeUtf8(await gunzipBytes(got.content)) }
        catch {
          this._fail(failed, item, 'report', 'remote payload is not gzipped UTF-8')
          continue
        }
        const result = analyzeContent(text)
        if (!result.recognized) {
          this._fail(failed, item, 'report', 'remote payload is not a recognized report format')
          continue
        }
        await saveFileBytes(item.identifier, got.content)
        setCount(item.identifier, result.count, result.source)
        await addReportToWorkspace(item.identifier, this.workspaceId)
        downloaded.push({ kind: 'report', identifier: item.identifier })
      } catch (err) {
        this._fail(failed, item, item.kind, err?.message ?? String(err))
      }
    }
    this._running = false
    this._done = true
    // Reload the active workspace view so freshly-saved reports
    // show up in merged findings. Only when the user is still looking
    // at the workspace we downloaded into (guard r3242639406).
    if (downloaded.some((d) => d.kind === 'report')) {
      try {
        if (state.currentWorkspace === this.workspaceId) {
          await switchToWorkspace(this.workspaceId)
        }
      } catch {}
    }
    if (failed.length === 0) this._finish({ downloaded, failed })
  }

  render() {
    const { count, singular, kindLabel } = transferSummary(this.items)
    const intro = singular
      ? html`Download <strong>"${itemDisplayLabel(this.items[0])}"</strong> from the workspace's remote inventory?`
      : html`Download <strong>${count}</strong> remote ${kindLabel} into this workspace?`
    const list = singular ? nothing : transferItemsList(this.items)
    const dlLabel = this._running
      ? (singular ? 'Downloading…' : `Downloading ${count} ${kindLabel}…`)
      : (singular ? 'Download' : `Download ${count}`)
    return html`<dialog @close=${this._onClose}>
      <header><h3>Download from remote</h3></header>
      <p class="lwd-body">${intro}</p>
      ${list}
      ${transferErrorsList(this._errors)}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
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
  return openAppDialog('sync-download-dialog', {
    workspaceId: workspaceId ?? '',
    items: Array.isArray(items) ? [...items] : [],
  })
}
