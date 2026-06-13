// `<export-confirm-dialog>` — fronts the toolbar Print and Download
// (Markdown) buttons. Both exports emit only the findings visible
// under the active filters (see export-summary.js); this dialog
// restates that selection — the included / excluded counts and the
// active filters in words — so the user knows exactly what's leaving
// before it prints or downloads.
//
// Sibling of `<delete-report-dialog>` etc.: extends `AppDialog` for
// the shared shadow-DOM <dialog> chrome (focus-trap + Esc-to-cancel).
// Public `openExportConfirmDialog(mode)` snapshots the current
// selection and resolves with `{ confirmed }`; Cancel / Esc / native
// close all resolve to `{ confirmed: false }`.
//
// Native Ctrl+P / browser-menu printing bypasses this dialog — those
// can't be intercepted with an async confirm — so it only guards the
// in-app buttons (the `print-requested` / `download-requested` events).
import { html, nothing, unsafeCSS } from 'lit'
import { AppDialog } from './app-dialog.js'
import { exportSelectionSummary } from '../export-summary.js'
import exportConfirmCSS from './dialog-export-confirm.css'

class ExportConfirmDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(exportConfirmCSS)]

  static properties = {
    // 'print' | 'download' — drives the title, intro wording and the
    // confirm button label.
    mode: { type: String },
    included: { type: Number },
    excluded: { type: Number },
    total: { type: Number },
    // [{ label, value }] — active filters, already humanized.
    filters: { attribute: false },
    // Non-null only when viewing a trash bucket (e.g. 'Deleted').
    bucketLabel: { type: String },
  }

  constructor() {
    super()
    this.mode = 'print'
    this.included = 0
    this.excluded = 0
    this.total = 0
    this.filters = []
    this.bucketLabel = null
  }

  // Focus the primary action — this is a non-destructive confirm, so
  // Enter should commit the export rather than land on Cancel. With an
  // empty selection the primary is disabled, so focus Cancel instead.
  focusInitial() {
    const sel = this.included === 0 ? 'button[data-role="cancel"]' : 'button.primary'
    this.renderRoot.querySelector(sel)?.focus()
  }

  _finish(confirmed) {
    if (this._settled) return
    super._finish({ confirmed: Boolean(confirmed) })
  }

  _onClose = () => this._finish(false)
  _onCancel = () => this._finish(false)
  _onConfirm = () => this._finish(true)

  _countSection() {
    if (this.total === 0) {
      return html`<p class="ecd-count">No findings to ${this.mode === 'print' ? 'print' : 'download'}.</p>`
    }
    // "All N" only when nothing is filtered at all; with active filters
    // that happen to exclude nothing, "N of N" makes the filtering
    // visible rather than implying an unfiltered export.
    const allIn = this.excluded === 0 && this.filters.length === 0
    const headline = allIn
      ? html`All <strong>${this.included}</strong> ${this.included === 1 ? 'finding' : 'findings'} included.`
      : html`<strong>${this.included}</strong> of ${this.total} ${this.total === 1 ? 'finding' : 'findings'} included.`
    return html`
      <p class="ecd-count">${headline}</p>
      ${this.excluded > 0
        ? html`<p class="ecd-excluded">${this.excluded} filtered out and ${this.mode === 'print' ? "won't be printed" : "won't be downloaded"}.</p>`
        : nothing}
    `
  }

  _filtersSection() {
    if (this.filters.length === 0) {
      return html`<p class="ecd-filters-label">No filters active — the full ${this.bucketLabel ? `${this.bucketLabel.toLowerCase()} ` : ''}set is included.</p>`
    }
    return html`
      <p class="ecd-filters-label">Active filters</p>
      <dl class="ecd-filters">
        ${this.filters.map((f) => html`<dt>${f.label}</dt><dd>${f.value}</dd>`)}
      </dl>
    `
  }

  render() {
    const isPrint = this.mode === 'print'
    const title = isPrint ? 'Print report' : 'Download report'
    const intro = isPrint
      ? 'Prints only the findings matching your current filters — the same set shown on screen. Use the toolbar to change the selection first.'
      : 'Downloads a Markdown file of the findings matching your current filters — the same set shown on screen. Use the toolbar to change the selection first.'
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>${title}</h3>
      </header>
      <p class="nwd-intro">${intro}</p>
      ${this._countSection()}
      ${this.bucketLabel
        ? html`<p class="nwd-note">Scoped to the <strong>${this.bucketLabel}</strong> list — live findings are not included.</p>`
        : nothing}
      ${this._filtersSection()}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="primary" ?disabled=${this.included === 0} @click=${this._onConfirm}>${isPrint ? 'Print' : 'Download'}</button>
      </footer>
    </dialog>`
  }
}

customElements.define('export-confirm-dialog', ExportConfirmDialog)

// Public entry point. Snapshots the current export selection (counts +
// active filters, on the basis matching `mode`) and opens the dialog.
// Resolves with `{ confirmed }`.
//
// Custom open helper rather than the shared `openAppDialog`: the Print
// / Download buttons stay clickable while another modal is up (the
// toolbar isn't inert behind a dialog), so `AppDialog.firstUpdated`'s
// showModal() can throw and dispatch `modal-conflict` instead of
// `resolve`. The shared helper only listens for `resolve`, so it would
// hang the `await` in events.js forever and leak the element. Settle to
// `{ confirmed: false }` on BOTH paths — a conflict collapses to a
// no-op cancel (the user can retry once the blocking modal closes).
export function openExportConfirmDialog(mode) {
  const summary = exportSelectionSummary(mode)
  return new Promise((resolve) => {
    const el = document.createElement('export-confirm-dialog')
    Object.assign(el, {
      mode,
      included: summary.included,
      excluded: summary.excluded,
      total: summary.total,
      filters: summary.filters,
      bucketLabel: summary.bucketLabel,
    })
    const settle = (confirmed) => { el.remove(); resolve({ confirmed }) }
    el.addEventListener('resolve', (e) => settle(Boolean(e.detail?.confirmed)))
    el.addEventListener('modal-conflict', () => settle(false))
    document.body.append(el)
  })
}
