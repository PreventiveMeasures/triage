// `<workspace-export-dialog>` — pre-download prompt for the per-workspace
// "Export workspace" affordance. Two tabs:
//
//   Export workspace   — the full portable workspace (reports + triage +
//     repo URLs + bundle pointers + the private key). Password + confirm
//     by default; opt-out is an explicit checkbox that disables the
//     password fields, surfaces a warning, and relabels the primary
//     button.
//   Raw reports export — just the report documents, gzipped, always
//     unencrypted. The panel warns about everything the file leaves
//     behind before the download fires.
//
// Extends `AppDialog` for the same shared shadow-DOM chrome the share-link
// dialogs use.
import { html, nothing, unsafeCSS } from 'lit'
import { buildRawReportsExportGzip, buildWorkspaceExportBundle } from '#client/index.js'
import { downloadBlob } from '../dom.js'
import { AppDialog, openAppDialogOrReject } from './app-dialog.js'
import shareCSS from './dialog-share.css'

const TABS = [
  { id: 'workspace', label: 'Export workspace' },
  { id: 'raw', label: 'Raw reports export' },
]

class WorkspaceExportDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(shareCSS)]

  static properties = {
    workspace: { attribute: false },
    _tab: { state: true },
    _password: { state: true },
    _confirm: { state: true },
    _noPassword: { state: true },
    _includeBundleBytes: { state: true },
    _busy: { state: true },
    _error: { state: true },
    _settled: { state: true },
  }

  constructor() {
    super()
    this.workspace = null
    this._tab = 'workspace'
    this._password = ''
    this._confirm = ''
    this._noPassword = false
    this._includeBundleBytes = false
    this._busy = false
    this._error = ''
    this._settled = false
  }

  // The base `focusInitial()` default focuses the first input — the
  // password field on the (default) workspace tab — so no override is
  // needed. Modal-conflict (another modal already open) is handled by
  // the base `firstUpdated`, which dispatches `modal-conflict`; the
  // open() wrapper wipes the wrapper-set `workspace` reference in that
  // listener.

  _finish(result) {
    if (this._settled) return
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
    super._finish(result)
  }

  _onClose = () => this._finish(null)
  _onCancel = () => this._finish(null)

  _reportCount() {
    return Array.isArray(this.workspace?.reports) ? this.workspace.reports.length : 0
  }

  _bundleCount() {
    return Array.isArray(this.workspace?.bundles) ? this.workspace.bundles.length : 0
  }

  // Tab switch. Blocked while an export is in flight so the primary
  // button can't relabel (or `_onExport` re-enter) under the running
  // build.
  _selectTab(tab) {
    if (this._busy || this._tab === tab) return
    this._tab = tab
    this._error = ''
    // Same hygiene as the opt-out flip: leaving the workspace tab
    // unmounts the password fields, so drop the typed-then-abandoned
    // secret rather than keeping it live in a hidden state slot.
    if (tab !== 'workspace') {
      this._password = ''
      this._confirm = ''
    }
  }

  // Arrow-key navigation across the tablist, as `role="tab"` implies.
  // Two tabs, so either arrow just flips to the other one; focus
  // follows the selection (automatic activation) once lit has painted
  // the new roving tabindex.
  _onTabsKeydown = async (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next = this._tab === 'workspace' ? 'raw' : 'workspace'
    this._selectTab(next)
    await this.updateComplete
    this.renderRoot.querySelector(`#wsl-tab-${next}`)?.focus()
  }

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
  _onIncludeBundleBytesToggle = (e) => {
    this._includeBundleBytes = e.target.checked
    this._error = ''
  }

  _canExport() {
    if (this._busy) return false
    // Raw tab: nothing to collect, but an empty workspace has nothing
    // to hand over either.
    if (this._tab === 'raw') return this._reportCount() > 0
    if (this._noPassword) return true
    return (this._password ?? '').length > 0 && this._password === this._confirm
  }

  _onExport = async () => {
    if (!this._canExport()) return
    if (!this.workspace) {
      this._error = 'No workspace selected.'
      return
    }
    const tab = this._tab
    this._busy = true
    this._error = ''
    try {
      const { blob, filename } = tab === 'raw'
        ? await buildRawReportsExportGzip(this.workspace)
        : await buildWorkspaceExportBundle(this.workspace, {
          password: this._noPassword ? undefined : this._password,
          includeBundleBytes: this._includeBundleBytes,
        })
      // PBKDF2 takes hundreds of ms; the user may have hit Cancel in the
      // meantime. Skip the download (and the success-resolve) if so.
      if (this._settled) return
      downloadBlob(blob, filename)
      this._finish({ ok: true, tab })
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

  // Selection lives on `aria-selected` alone — the CSS keys off the
  // attribute, so there's no parallel `active` class to keep in sync.
  _tabsTemplate() {
    return html`
      <div class="wsl-tabs" role="tablist" @keydown=${this._onTabsKeydown}>
        ${TABS.map((t) => html`<button
          type="button"
          role="tab"
          class="wsl-tab"
          id=${`wsl-tab-${t.id}`}
          aria-controls=${`wsl-panel-${t.id}`}
          aria-selected=${String(this._tab === t.id)}
          tabindex=${this._tab === t.id ? 0 : -1}
          ?disabled=${this._busy && this._tab !== t.id}
          @click=${() => this._selectTab(t.id)}
        >${t.label}</button>`)}
      </div>
    `
  }

  _workspacePanel() {
    const passwordsMatch = !this._password || !this._confirm || this._password === this._confirm
    const bundleCount = this._bundleCount()
    return html`
      <p class="nwd-note">
        The export file carries this workspace's reports, triage state,
        comments, fixes, references to attached bundles (integrities only
        by default), and its private key. Encrypting the file with a
        password ensures only those with the password can attach the
        workspace after download.
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
      ${bundleCount > 0 ? html`
        <label class="wsl-optout">
          <input
            type="checkbox"
            .checked=${this._includeBundleBytes}
            @change=${this._onIncludeBundleBytesToggle}
          >
          <span>Include bundle bytes (${bundleCount} bundle${bundleCount === 1 ? '' : 's'}; significantly larger file)</span>
        </label>
      ` : nothing}
      ${this._noPassword ? html`
        <p class="wsl-error wsl-warning">
          Anyone who obtains this file can attach the workspace and
          read every report, triage decision, comment, and fix.
          Only opt out when you control where the file goes.
        </p>
      ` : nothing}
      ${!this._noPassword && !passwordsMatch
        ? html`<p class="wsl-error" role="alert">Passwords don't match.</p>`
        : nothing}
    `
  }

  // The bundle clause only appears when this workspace actually has
  // bundles attached — naming blobs that don't exist would read as a
  // warning about someone else's workspace.
  _rawPanel() {
    const reportCount = this._reportCount()
    const bundleCount = this._bundleCount()
    return html`
      <p class="nwd-note">
        Downloads ${reportCount} report${reportCount === 1 ? '' : 's'} as a
        single gzipped JSON file (<code>.deepview-reports.json.gz</code>)
        holding just <code>{ reports: [{ name, content }] }</code> — the
        report documents exactly as stored, and nothing else. It is not a
        workspace file and cannot be imported back as one.
      </p>
      <p class="wsl-error wsl-warning">
        This is a raw form of the reports. It carries no triage data —
        no markers, triage states, comments, fixes, or per-report
        ignores${bundleCount > 0
          ? html` — and none of this workspace's ${bundleCount} attached
              bundle${bundleCount === 1 ? '' : 's'}`
          : nothing}.
        The file is written unencrypted: anyone who obtains it can read
        every report in it.
      </p>
      ${reportCount === 0
        ? html`<p class="wsl-error" role="alert">This workspace has no reports to export.</p>`
        : nothing}
    `
  }

  _primaryLabel() {
    if (this._busy) return 'Exporting…'
    if (this._tab === 'raw') return 'Download reports'
    return this._noPassword ? 'Export without password' : 'Export'
  }

  _body() {
    return html`
      ${this._tabsTemplate()}
      <div
        role="tabpanel"
        id=${`wsl-panel-${this._tab}`}
        aria-labelledby=${`wsl-tab-${this._tab}`}
      >${this._tab === 'raw' ? this._rawPanel() : this._workspacePanel()}</div>
      ${this._error ? html`<p class="wsl-error" role="alert">${this._error}</p>` : nothing}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button
          type="button"
          class="primary"
          ?disabled=${!this._canExport()}
          @click=${this._onExport}
        >${this._primaryLabel()}</button>
      </footer>
    `
  }

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Export workspace</h3>
      </header>
      ${this._body()}
    </dialog>`
  }
}

customElements.define('workspace-export-dialog', WorkspaceExportDialog)

// Resolves to `{ ok: true, tab }` after the download fires, or `null`
// on cancel. Rejects when another modal is already open so the caller
// can surface a contextual error.
export function openWorkspaceExportDialog({ workspace } = {}) {
  // Wipe the wrapper-set `workspace` (carrying `.privateKey`) on
  // modal-conflict before detaching.
  return openAppDialogOrReject('workspace-export-dialog', { workspace: workspace ?? null }, (el) => { el.workspace = null })
}
