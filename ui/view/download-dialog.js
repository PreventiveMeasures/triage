// `<download-report-dialog>` — confirmation prompt for pulling
// remote-only reports from the workspace's objstore inventory
// into local OPFS. Sibling of `<upload-report-dialog>`; surfaces
// from the page-header sync-status badge's "cloud" chunk when
// `remoteOnly.length > 0` (peer-uploaded reports the local user
// hasn't yet ingested — including the empty-workspace boot case).
//
// Shape:
//   - title + intro line
//   - <ul> of the remote file-names (truncated when very long)
//   - footer: Cancel + Download buttons; Download disables while
//     the FETCH loop is in flight, then either auto-closes or
//     keeps the dialog open with the per-file failures list.
//
// Each fetched payload goes through the same content-recognition
// gate `ingest.js` uses for file drops (`analyzeContent`), so a
// peer can't poison an empty workspace's OPFS by uploading an
// arbitrary blob — the dialog rejects and surfaces the error.
//
// Public API:
//   openDownloadDialog({ workspaceId, fileNames })
//     → Promise<{ downloaded, failed }>.

import { LitElement, html, nothing } from 'lit'
import { decodeUtf8 } from '../../common/utf8.js'
import { analyzeContent, setCount } from '../../client/counts.js'
import { gunzipBytes, saveFileBytes } from '../../client/storage.js'
import { setReportWorkspace } from '../../client/workspaces.js'
import { fetchFile } from './objstore-presence.js'

class DownloadReportDialog extends LitElement {
  static properties = {
    workspaceId: { type: String },
    fileNames: { type: Array },
    _running: { state: true },
    _errors: { state: true },
    _done: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.workspaceId = ''
    this.fileNames = []
    this._running = false
    this._errors = []
    this._done = false
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
    for (const name of this.fileNames) {
      try {
        const got = await fetchFile(this.workspaceId, name)
        if (!got) {
          failed.push({ name, reason: 'not found in remote' })
          this._errors = [...this._errors, { name, reason: 'not found in remote' }]
          continue
        }
        // The wire payload is the on-disk gzipped representation
        // — gunzip + UTF-8 decode (strict) drives the
        // analyzeContent validator, then `saveFileBytes` lands the
        // ORIGINAL gzipped bytes back on disk byte-identical
        // (review r3242197838: avoids a lossy fatal:false replace
        // for non-UTF-8 content).
        let text
        try { text = decodeUtf8(await gunzipBytes(got.content)) }
        catch {
          failed.push({ name, reason: 'remote payload is not gzipped UTF-8' })
          this._errors = [...this._errors, { name, reason: 'remote payload is not gzipped UTF-8' }]
          continue
        }
        const result = analyzeContent(text)
        if (!result.recognized) {
          failed.push({ name, reason: 'remote payload is not a recognized report format' })
          this._errors = [...this._errors, { name, reason: 'remote payload is not a recognized report format' }]
          continue
        }
        await saveFileBytes(name, got.content)
        setCount(name, result.count, result.source)
        await setReportWorkspace(name, this.workspaceId)
        downloaded.push(name)
      } catch (err) {
        failed.push({ name, reason: err?.message ?? String(err) })
        this._errors = [...this._errors, { name, reason: err?.message ?? String(err) }]
      }
    }
    this._running = false
    this._done = true
    // Reload the active workspace view so freshly-saved reports
    // show up in the merged findings without a manual refresh —
    // BUT only if the user is still looking at the workspace we
    // downloaded into. If they've navigated away (to another
    // workspace, a single-file view, or one of the side tabs)
    // re-running `switchToWorkspace` would slam them back here
    // unexpectedly (review r3242639406).
    if (downloaded.length > 0) {
      try {
        const { state } = await import('../../client/state.ts')
        if (state.currentWorkspace === this.workspaceId) {
          const { switchToWorkspace } = await import('./ingest.js')
          await switchToWorkspace(this.workspaceId)
        }
      } catch {}
    }
    if (failed.length === 0) this._finish({ downloaded, failed })
  }

  _errorsSection() {
    if (this._errors.length === 0) return nothing
    return html`<ul class="lwd-list" role="alert">
      ${this._errors.map((e) => html`<li><strong>${e.name}</strong> — ${e.reason}</li>`)}
    </ul>`
  }

  render() {
    const count = this.fileNames.length
    const singular = count === 1
    const intro = singular
      ? html`Download <strong>"${this.fileNames[0]}"</strong> from the workspace's remote inventory?`
      : html`Download <strong>${count}</strong> remote reports into this workspace?`
    const fileList = singular ? nothing : html`<ul class="lwd-list">
      ${this.fileNames.map((n) => html`<li>${n}</li>`)}
    </ul>`
    const dlLabel = this._running
      ? (singular ? 'Downloading…' : `Downloading ${count} reports…`)
      : (singular ? 'Download' : `Download ${count}`)
    return html`<dialog class="leave-workspace-dialog download-report-dialog" @close=${this._onClose}>
      <header class="lwd-head"><h3>Download from remote</h3></header>
      <p class="lwd-body">${intro}</p>
      ${fileList}
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

customElements.define('download-report-dialog', DownloadReportDialog)

// Public entry point. Resolves with { downloaded: [name], failed:
// [{ name, reason }] } once the user closes the dialog.
export function openDownloadDialog({ workspaceId, fileNames } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('download-report-dialog')
    el.workspaceId = workspaceId ?? ''
    el.fileNames = Array.isArray(fileNames) ? [...fileNames] : []
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    document.body.append(el)
  })
}
