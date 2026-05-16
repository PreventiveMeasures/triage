// `<workspace-export-dialog>` — pre-download prompt for the per-workspace
// "Export workspace" affordance. Password + confirm by default; opt-out
// is an explicit checkbox that disables the password fields, surfaces a
// warning, and relabels the primary button. Native <dialog> + light DOM
// for the same chrome the share-link dialogs use.
import { LitElement, html, nothing } from 'lit'
import { buildWorkspaceExportBundle } from '../../client/workspace-export.js'
import { downloadBlob, makeStackedModalError } from './dom.js'

class WorkspaceExportDialog extends LitElement {
  static properties = {
    workspace: { attribute: false },
    _password: { state: true },
    _confirm: { state: true },
    _noPassword: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _settled: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.workspace = null
    this._password = ''
    this._confirm = ''
    this._noPassword = false
    this._busy = false
    this._error = ''
    this._settled = false
  }

  firstUpdated() {
    const dialog = this.querySelector('dialog')
    if (!dialog) return
    try {
      dialog.showModal()
    } catch (err) {
      // Another modal is already open. Let the wrapper reject so the
      // caller surfaces a contextual error (sidebar's `.catch` adds
      // the workspace name).
      this._signalModalConflict(err)
      return
    }
    const input = this.querySelector('input[type="password"]')
    if (input) input.focus()
  }

  _signalModalConflict(err) {
    if (this._settled) return
    this._settled = true
    // `_finish` wipes user-typed fields too, but at modal-conflict time
    // those are still constructor defaults — the dialog never opened.
    // Only the wrapper-set `workspace` reference (carrying `.privateKey`)
    // needs an explicit wipe so it doesn't sit on the element until GC.
    this.workspace = null
    this.dispatchEvent(new CustomEvent('modal-conflict', { detail: { cause: err } }))
  }

  _finish(result) {
    if (this._settled) return
    this._settled = true
    // Drop sensitive state on every exit path, not just success.
    // `_password` / `_confirm` carry the typed secret; `workspace`
    // is the wrapper-set reference whose `.privateKey` flows into
    // the encrypted bundle. Lit's reactive setter briefly retains
    // the old value in its `_$changedProperties` Map until the next
    // microtask, so the wipe doesn't fully erase until `el.remove()`
    // detaches the host — but the property slot itself is empty
    // immediately.
    this._password = ''
    this._confirm = ''
    this.workspace = null
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: result }))
  }

  _onClose = () => this._finish(null)
  _onCancel = () => this._finish(null)

  _onPasswordInput = (e) => { this._password = e.target.value; this._error = '' }
  _onConfirmInput = (e) => { this._confirm = e.target.value; this._error = '' }
  _onNoPasswordToggle = (e) => {
    this._noPassword = e.target.checked
    this._error = ''
    // Wipe typed-then-abandoned password on opt-out flip.
    if (this._noPassword) {
      this._password = ''
      this._confirm = ''
    }
  }

  _canExport() {
    if (this._busy) return false
    if (this._noPassword) return true
    return (this._password ?? '').length > 0 && this._password === this._confirm
  }

  _onExport = async () => {
    if (!this._canExport()) return
    if (!this.workspace) {
      this._error = 'No workspace selected.'
      return
    }
    this._busy = true
    this._error = ''
    try {
      const { blob, filename } = await buildWorkspaceExportBundle(this.workspace, {
        password: this._noPassword ? undefined : this._password,
      })
      // PBKDF2 takes hundreds of ms; the user may have hit Cancel in the
      // meantime. Skip the download (and the success-resolve) if so.
      if (this._settled) return
      downloadBlob(blob, filename)
      this._finish({ ok: true })
    } catch (err) {
      if (this._settled) return
      this._error = err?.message ?? String(err)
    } finally {
      this._busy = false
    }
  }

  _onKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      this._onExport()
    }
  }

  _body() {
    const passwordsMatch = !this._password || !this._confirm || this._password === this._confirm
    return html`
      <p class="nwd-note">
        The export file carries this workspace's reports, triage state,
        comments, fixes, references to attached bundles (the integrities
        only — the bundle bytes are not included in this file), and
        its private key. Encrypting the file with a password ensures
        only those with the password can attach the workspace after
        download.
      </p>
      <label class="wsl-field">
        <span>Password</span>
        <input
          type="password"
          class="nwd-input"
          autocomplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          name="dv-export-pw"
          maxlength="1024"
          ?disabled=${this._noPassword}
          .value=${this._password}
          @input=${this._onPasswordInput}
          @keydown=${this._onKeydown}
        >
      </label>
      <label class="wsl-field">
        <span>Confirm password</span>
        <input
          type="password"
          class="nwd-input"
          autocomplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          name="dv-export-pw-confirm"
          maxlength="1024"
          ?disabled=${this._noPassword}
          .value=${this._confirm}
          @input=${this._onConfirmInput}
          @keydown=${this._onKeydown}
        >
      </label>
      <label class="wsl-optout">
        <input
          type="checkbox"
          .checked=${this._noPassword}
          @change=${this._onNoPasswordToggle}
        >
        <span>Export without password (not recommended)</span>
      </label>
      ${this._noPassword ? html`
        <p class="wsl-error wsl-warning">
          Anyone who obtains this file can attach the workspace and
          read every report, triage decision, comment, and fix.
          Only opt out when you control where the file goes.
        </p>
      ` : nothing}
      ${this._error ? html`<p class="wsl-error" role="alert">${this._error}</p>` : nothing}
      ${!this._noPassword && !passwordsMatch
        ? html`<p class="wsl-error" role="alert">Passwords don't match.</p>`
        : nothing}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button
          type="button"
          class="primary"
          ?disabled=${!this._canExport()}
          @click=${this._onExport}
        >${this._busy
            ? 'Exporting…'
            : (this._noPassword ? 'Export without password' : 'Export')}</button>
      </footer>
    `
  }

  render() {
    return html`<dialog class="new-workspace-dialog workspace-export-dialog" @close=${this._onClose}>
      <header class="nwd-head">
        <h3>Export workspace</h3>
      </header>
      ${this._body()}
    </dialog>`
  }
}

customElements.define('workspace-export-dialog', WorkspaceExportDialog)

// Resolves to `{ ok: true }` after the download fires, or `null` on
// cancel. Rejects when another modal is already open so the caller
// can surface a contextual error.
export function openWorkspaceExportDialog({ workspace } = {}) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('workspace-export-dialog')
    el.workspace = workspace ?? null
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(e.detail)
    })
    el.addEventListener('modal-conflict', (e) => {
      el.remove()
      reject(makeStackedModalError(e.detail?.cause))
    })
    document.body.append(el)
  })
}
