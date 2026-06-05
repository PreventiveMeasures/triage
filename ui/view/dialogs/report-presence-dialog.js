// `<report-presence-dialog>` — per-workspace cloud/local breakdown
// for a report that belongs to more than one workspace.
//
// Each workspace has its own objstore tag (HMAC per workspace key),
// so "synced" is per-workspace: the same report can sit in the cloud
// for one workspace and be local-only in another. The page-header
// sync badge collapses that to a single 'cloud' / 'local' / 'mixed'
// chip; clicking the chip opens this dialog so the user can see WHICH
// workspaces hold a synced copy and upload the report to the ones
// that only have it locally.
//
// Extends `AppDialog` for the shared shadow-DOM <dialog> chrome and
// composes the `.lwd-*` list layer plus a small inline `.rpd-*` row
// layer. Public `openReportPresenceDialog({ reportName, entries })`
// resolves `{ action, workspaceId }` — `action` is 'upload' (with the
// chosen `workspaceId`) or null on close. Uploading is left to the
// caller (render.js) AFTER this dialog closes, so no modal nests
// inside another (showModal throws on a stacked open).
import { css, html, nothing, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import listCSS from './dialog-list.css'

class ReportPresenceDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS), css`
    .rpd-list {
      margin: .2rem 0 .65rem;
      border: 1px solid var(--border); border-radius: 6px;
      background: rgb(from var(--text) r g b / .03);
    }
    .rpd-row {
      display: flex; align-items: center; gap: .6rem;
      padding: .45rem .6rem;

      & + .rpd-row { border-top: 1px solid rgb(from var(--text) r g b / .05); }
    }
    .rpd-name {
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--text); font-size: .82rem;
    }
    .rpd-status {
      flex-shrink: 0;
      font-size: .68rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: .05em;
    }
    .rpd-status.cloud { color: var(--accent); }
    .rpd-status.local { color: var(--muted); }
    .rpd-upload {
      flex-shrink: 0;
      background: transparent; border: 1px solid var(--border);
      color: var(--text); border-radius: 5px;
      padding: .2rem .6rem; font: inherit; font-size: .74rem; cursor: pointer;

      &:hover { border-color: var(--accent); color: var(--accent); }
    }
  `]

  static properties = {
    reportName: { type: String },
    // `[{ workspaceId, workspaceName, status: 'cloud' | 'local' }]`.
    // Assigned by the open() helper; `attribute: false` keeps the
    // array off the DOM attribute surface.
    entries: { attribute: false },
  }

  constructor() {
    super()
    this.reportName = ''
    this.entries = []
  }

  // Focus Close (the only footer button) — purely informational
  // dialog, no destructive default to guard against.
  focusInitial() {
    this.renderRoot.querySelector('button[data-role="close"]')?.focus()
  }

  _onClose = () => this._finish({ action: null })
  _onCancel = () => this._finish({ action: null })
  _onUpload(workspaceId) { this._finish({ action: 'upload', workspaceId }) }

  render() {
    const cloudCount = this.entries.filter((e) => e.status === 'cloud').length
    const total = this.entries.length
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Sync status</h3>
      </header>
      <p class="lwd-body">
        <strong>"${this.reportName}"</strong> is in ${total} workspaces —
        synced in ${cloudCount}, local-only in ${total - cloudCount}.
      </p>
      <div class="rpd-list">
        ${this.entries.map((e) => html`<div class="rpd-row">
          <span class="rpd-name">${e.workspaceName}</span>
          <span class=${`rpd-status ${e.status}`}>${e.status === 'cloud' ? 'Cloud' : 'Local only'}</span>
          ${e.status === 'local'
            ? html`<button type="button" class="rpd-upload" @click=${() => this._onUpload(e.workspaceId)}>Upload</button>`
            : nothing}
        </div>`)}
      </div>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="close" class="primary" @click=${this._onCancel}>Close</button>
      </footer>
    </dialog>`
  }
}

customElements.define('report-presence-dialog', ReportPresenceDialog)

// Public entry point. Resolves `{ action, workspaceId }`: `action` is
// 'upload' with the chosen `workspaceId` when an Upload button is
// clicked, or null on Close / Esc / native close.
export function openReportPresenceDialog({ reportName, entries } = {}) {
  return openAppDialog('report-presence-dialog', {
    reportName: reportName ?? '',
    entries: Array.isArray(entries) ? entries : [],
  })
}
