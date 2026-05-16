// `<upload-report-dialog>` — confirmation prompt for uploading
// local report bytes to the workspace's objstore inventory.
// Surfaces from the page-header sync-status badge:
//   - clicking the `local` chip on a single-file / all-local view
//     opens this with a single fileName,
//   - clicking the `M local` chunk on a mixed workspace badge
//     opens it with the M local fileNames.
//
// Shape:
//   - title + intro line explaining what's about to happen
//   - <ul> of the report file-names (truncated when very long)
//   - footer: Cancel + Upload buttons; Upload spins + disables
//     while the PUT(s) are in flight, then either resolves (badge
//     flips to `cloud` via the objstore-put broadcast presence
//     subscribes to) or surfaces an inline error toast.
//
// Public API:
//   openUploadDialog({ workspaceId, fileNames })
//     → Promise<{ uploaded, failed }> with the per-file outcome.
//
// Sibling of `<delete-report-dialog>` / `<leave-workspace-dialog>`:
// native <dialog> for focus-trap + Esc-to-cancel, light-DOM render
// so global stylesheet rules in sidebar.css apply.

import { LitElement, html, nothing } from 'lit'
import { readFileBytes } from '../../client/storage.js'
import { putFile } from './objstore-presence.js'

class UploadReportDialog extends LitElement {
  static properties = {
    workspaceId: { type: String },
    fileNames: { type: Array },
    _uploading: { state: true },
    _errors: { state: true },
    _done: { state: true },
  }

  // Light DOM — reuse `.leave-workspace-dialog` styles from
  // sidebar.css so the upload prompt visually matches the other
  // workspace dialogs without duplicating the chrome rules.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.workspaceId = ''
    this.fileNames = []
    this._uploading = false
    this._errors = []
    this._done = false
  }

  firstUpdated() {
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.showModal()
    const upload = this.querySelector('button[data-role="upload"]')
    if (upload) upload.focus()
  }

  _finish(result) {
    if (this._settled) return
    this._settled = true
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: result }))
  }

  _onClose = () => this._finish({ uploaded: [], failed: [] })
  _onCancel = () => this._finish({ uploaded: [], failed: [] })

  _onUpload = async () => {
    if (this._uploading) return
    this._uploading = true
    this._errors = []
    const uploaded = []
    const failed = []
    // Sequential PUTs — each one carries its own signed message,
    // so concurrency wouldn't speed up the relay round-trips
    // meaningfully and sequencing keeps the error feedback
    // attributable to the right filename. A future bulk-PUT
    // extension on the relay could collapse these.
    for (const name of this.fileNames) {
      try {
        // Ship the on-disk gzipped bytes as-is — `saveFile` stores
        // reports gzipped in OPFS, so this avoids a gunzip + re-
        // gzip round-trip and keeps a non-UTF-8 byte safely byte-
        // identical end-to-end (review r3242197802).
        const bytes = await readFileBytes(name)
        const result = await putFile(this.workspaceId, name, bytes)
        if (result.ok) uploaded.push(name)
        else {
          failed.push({ name, reason: result.reason ?? 'unknown' })
          this._errors = [...this._errors, { name, reason: result.reason ?? 'unknown' }]
        }
      } catch (err) {
        failed.push({ name, reason: err?.message ?? String(err) })
        this._errors = [...this._errors, { name, reason: err?.message ?? String(err) }]
      }
    }
    this._uploading = false
    this._done = true
    // Auto-close on full success; keep the dialog open with the
    // failures list when something went wrong so the user can read
    // it before dismissing.
    if (failed.length === 0) this._finish({ uploaded, failed })
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
      ? html`Upload <strong>"${this.fileNames[0]}"</strong> to the workspace's remote inventory?`
      : html`Upload <strong>${count}</strong> local reports to the workspace's remote inventory?`
    const fileList = singular ? nothing : html`<ul class="lwd-list">
      ${this.fileNames.map((n) => html`<li>${n}</li>`)}
    </ul>`
    const uploadLabel = this._uploading
      ? (singular ? 'Uploading…' : `Uploading ${count} reports…`)
      : (singular ? 'Upload' : `Upload ${count}`)
    return html`<dialog class="leave-workspace-dialog upload-report-dialog" @close=${this._onClose}>
      <header class="lwd-head"><h3>Upload to remote</h3></header>
      <p class="lwd-body">${intro}</p>
      ${fileList}
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

customElements.define('upload-report-dialog', UploadReportDialog)

// Public entry point. Resolves with { uploaded: [name], failed:
// [{ name, reason }] } once the user closes the dialog — either
// after a successful run (auto-close) or after explicitly
// dismissing the failures view. Cancel / Esc resolve with empty
// arrays.
export function openUploadDialog({ workspaceId, fileNames } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('upload-report-dialog')
    el.workspaceId = workspaceId ?? ''
    el.fileNames = Array.isArray(fileNames) ? [...fileNames] : []
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    document.body.append(el)
  })
}
