// Before a workspace's "Export workspace" download, in two tabs:
//   Export workspace   — the portable workspace (reports, triage, repo URLs,
//     bundle pointers, the private key), password-encrypted unless explicitly
//     opted out, which warns and relabels the action.
//   Raw reports export — the report documents (with the repository named for
//     each), gzipped and never encrypted, warning what the file leaves behind.
//     Dropped back in, it imports as those reports (client/raw-reports-import.js).
import { html, nothing, unsafeCSS } from 'lit'
import { buildRawReportsExportGzip, buildWorkspaceExportBundle } from '#client/index.js'
import { downloadBlob } from '../dom.js'
import { dialogTabs } from '../header-tabs.js'
import { openAppDialog, rejectStacked } from './app-dialog.js'
import { PasswordDialog, onEnter } from './shared.js'
import shareCSS from './dialog-share.css'
import tabsCSS from './dialog-tabs.css'

const TABS = [
  { id: 'workspace', label: 'Export workspace' },
  { id: 'raw', label: 'Raw reports export' },
]

const count = (list) => (Array.isArray(list) ? list.length : 0)

class WorkspaceExportDialog extends PasswordDialog {
  static styles = [...PasswordDialog.styles, unsafeCSS(shareCSS), unsafeCSS(tabsCSS)]

  static properties = { _tab: { state: true }, _noPassword: { state: true }, _includeBundleBytes: { state: true } }

  // The typed password, and the workspace (its private key) the open helper set.
  static secrets = { _password: '', _confirm: '', workspace: null }

  constructor() {
    super()
    this._tab = 'workspace'
    this._noPassword = false
    this._includeBundleBytes = false
  }

  // Unmounting the password fields drops what was typed in them.
  _forgetPassword() {
    this._password = ''
    this._confirm = ''
  }

  // Not while exporting, which would relabel the running action.
  _selectTab(tab) {
    if (this._busy || this._tab === tab) return
    this._tab = tab
    this._error = ''
    if (tab !== 'workspace') this._forgetPassword()
  }

  _onNoPasswordToggle = (e) => {
    this._noPassword = e.target.checked
    this._error = ''
    if (this._noPassword) this._forgetPassword()
  }
  _onIncludeBundleBytesToggle = (e) => {
    this._includeBundleBytes = e.target.checked
    this._error = ''
  }

  _canExport() {
    if (this._busy) return false
    if (this._tab === 'raw') return count(this.workspace?.reports) > 0
    return this._noPassword || (this._password.length > 0 && this._password === this._confirm)
  }

  // Once cancelled, nothing downloads.
  _onExport = () => {
    if (!this._canExport()) return
    if (!this.workspace) {
      this._error = 'No workspace selected.'
      return
    }
    const { workspace, _tab: tab } = this
    const build = tab === 'raw'
      ? () => buildRawReportsExportGzip(workspace)
      : () => buildWorkspaceExportBundle(workspace, {
        password: this._noPassword ? undefined : this._password,
        includeBundleBytes: this._includeBundleBytes,
      })
    void this._attempt(build, ({ blob, filename }) => {
      downloadBlob(blob, filename)
      this._finish({ ok: true, tab })
    })
  }

  _onKeydown = onEnter(this._onExport)

  _workspacePanel() {
    const mismatch = this._password && this._confirm && this._password !== this._confirm
    const bundleCount = count(this.workspace?.bundles)
    return html`
      <p class="nwd-note ui-hint">
        The export file carries this workspace's reports, triage state,
        comments, fixes, references to attached bundles (integrities only
        by default), and its private key. Encrypting the file with a
        password ensures only those with the password can attach the
        workspace after download.
      </p>
      ${this.newPasswordFields('dv-export-pw', this._noPassword)}
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
      ${!this._noPassword && mismatch
        ? html`<p class="wsl-error" role="alert">Passwords don't match.</p>`
        : nothing}
    `
  }

  // The bundle clause only where there are bundles: naming blobs that don't
  // exist would read as a warning about someone else's workspace.
  _rawPanel() {
    const bundleCount = count(this.workspace?.bundles)
    return html`
      <div class="wsl-error wsl-warning">
        <p>This is the raw form of the reports.</p>
        <p>
          It carries no triage data — no markers, triage states,
          comments, fixes, or per-report ignores${bundleCount > 0
            ? html` — and none of this workspace's ${bundleCount} attached
                bundle${bundleCount === 1 ? '' : 's'}`
            : nothing}.
        </p>
        <p>
          This file is written unencrypted: anyone who obtains it can
          read every report in it.
        </p>
      </div>
      ${count(this.workspace?.reports) === 0
        ? html`<p class="wsl-error" role="alert">This workspace has no reports to export.</p>`
        : nothing}
    `
  }

  render() {
    const raw = this._tab === 'raw'
    const label = this._busy ? 'Exporting…' : raw ? 'Download reports' : this._noPassword ? 'Export without password' : 'Export'
    // The tab strip is the header; a title would repeat the first tab. The
    // two actions writing an unencrypted file wear the critical colour.
    return html`<dialog @close=${this._onClose}>
      <header>${dialogTabs({ tabs: TABS, current: this._tab, prefix: 'wsl', disabled: this._busy, select: (id) => this._selectTab(id) })}</header>
      <div
        role="tabpanel"
        id=${`wsl-panel-${this._tab}`}
        aria-labelledby=${`wsl-tab-${this._tab}`}
      >${raw ? this._rawPanel() : this._workspacePanel()}</div>
      ${this._error ? html`<p class="wsl-error" role="alert">${this._error}</p>` : nothing}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onCancel}>Cancel</button>
        <button
          type="button"
          class=${raw || this._noPassword ? 'primary danger' : 'primary'}
          ?disabled=${!this._canExport()}
          @click=${this._onExport}
        >${label}</button>
      </footer>
    </dialog>`
  }
}

customElements.define('workspace-export-dialog', WorkspaceExportDialog)

// Resolves `{ ok: true, tab }` once the download fires, or null on cancel.
// Rejects when another modal is open, so the caller can say so.
export function openWorkspaceExportDialog({ workspace } = {}) {
  return openAppDialog('workspace-export-dialog', { workspace: workspace ?? null }, { exclusive: true, conflict: rejectStacked })
}
