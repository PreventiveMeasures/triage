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

// Cloud glyph for cloud-synced rows (same outline as the page-header
// badge's). Local-only rows render no icon — the absence is the
// signal, so the column reads "synced rows are marked, the rest
// aren't".
function cloudStatusIcon() {
  return html`<svg class="rpd-status-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M17.5 19a4.5 4.5 0 1 0-1-8.9A6 6 0 0 0 5.07 13.5 4 4 0 0 0 6 21h11.5z"/>
  </svg>`
}

class ReportPresenceDialog extends AppDialog {
  // NOTE: keep these rules FLAT — no `&` nesting. Inline `css` tagged
  // templates are minified by `minify-html-literals` (build.js), whose
  // CSS pass doesn't understand CSS nesting and silently drops nested
  // blocks AND the rule that follows them. (`.css` files go through
  // esbuild and DO support nesting; inline templates do not.)
  static styles = [...AppDialog.styles, unsafeCSS(listCSS), css`
    .rpd-list {
      margin: .2rem 0 .65rem;
      border: 1px solid var(--border); border-radius: 6px;
      background: rgb(from var(--text) r g b / .03);
    }
    .rpd-row {
      display: flex; align-items: center; gap: .6rem;
      padding: .45rem .6rem;
    }
    .rpd-row + .rpd-row { border-top: 1px solid rgb(from var(--text) r g b / .05); }
    .rpd-name {
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--text); font-size: .82rem;
    }
    .rpd-status {
      flex-shrink: 0;
      display: inline-flex; align-items: center; gap: .3rem;
      font-size: .68rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: .05em;
    }
    .rpd-status-icon { flex-shrink: 0; }
    .rpd-status.cloud { color: var(--accent); }
    .rpd-status.local { color: var(--muted); }
    /* Reserved right-hand column so the Upload button sits flush at
       the row's right edge and the status labels line up across rows
       whether or not a row carries an Upload action. */
    .rpd-action {
      flex-shrink: 0;
      min-width: 4.5rem;
      display: flex; justify-content: flex-end;
    }
    .rpd-upload {
      background: transparent; border: 1px solid var(--border);
      color: var(--text); border-radius: 5px;
      padding: .2rem .6rem; font: inherit; font-size: .74rem;
    }
    .rpd-upload:hover { border-color: var(--accent); color: var(--accent); }
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
          <span class=${`rpd-status ${e.status}`}>
            ${e.status === 'cloud' ? cloudStatusIcon() : nothing}${e.status === 'cloud' ? 'Cloud' : 'Local only'}
          </span>
          <span class="rpd-action">
            ${e.status === 'local'
              ? html`<button type="button" class="rpd-upload" @click=${() => this._onUpload(e.workspaceId)}>Upload</button>`
              : nothing}
          </span>
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
