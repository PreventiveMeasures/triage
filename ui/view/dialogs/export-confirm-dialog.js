// `<export-confirm-dialog>` — fronts the toolbar Print and Download
// buttons. Both exports emit only the findings visible under the active
// filters (see export-summary.js); this dialog restates that selection
// — the included / excluded counts and the active filters in words — so
// the user knows exactly what's leaving before it prints or downloads.
//
// The Download mode adds two controls: a format switch (Markdown / CSV,
// default Markdown) and an "export everything" toggle (off by default)
// that bypasses the filters AND the triage bucket to dump every finding
// in every loaded report. Both modes carry a note that exports are
// unencrypted plain text.
//
// Sibling of `<delete-report-dialog>` etc.: extends `AppDialog` for
// the shared shadow-DOM <dialog> chrome (focus-trap + Esc-to-cancel).
// Public `openExportConfirmDialog(mode)` snapshots the current
// selection and resolves with `{ confirmed, format, all }`; Cancel /
// Esc / native close resolve `{ confirmed: false }`.
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
    // 'print' | 'download' — drives the title, intro wording, the
    // confirm button label and which controls show.
    mode: { type: String },
    included: { type: Number },
    excluded: { type: Number },
    total: { type: Number },
    // [{ label, value }] — active filters, already humanized.
    filters: { attribute: false },
    // Non-null only when viewing a trash bucket (e.g. 'Deleted').
    bucketLabel: { type: String },
    // Print from the focus view-mode emits only the single focused
    // finding (not the whole filtered set) — see export-summary.js.
    focusedOnly: { type: Boolean },
    // Count behind the "export everything" toggle (all findings, all
    // reports, filters + bucket ignored).
    everythingCount: { type: Number },
    // Download controls (reactive): chosen format + whether to bypass
    // the filters/bucket. Print ignores both.
    _format: { state: true },
    _all: { state: true },
  }

  constructor() {
    super()
    this.mode = 'print'
    this.included = 0
    this.excluded = 0
    this.total = 0
    this.filters = []
    this.bucketLabel = null
    this.focusedOnly = false
    this.everythingCount = 0
    this._format = 'md'
    this._all = false
  }

  // Findings the confirm button will actually export — the everything
  // count when the toggle is on, else the filtered set. Drives the
  // disabled state + initial focus.
  get _exportCount() {
    return this._all ? this.everythingCount : this.included
  }

  // Focus the primary action — this is a non-destructive confirm, so
  // Enter should commit the export rather than land on Cancel. With an
  // empty selection the primary is disabled, so focus Cancel instead.
  focusInitial() {
    const sel = this._exportCount === 0 ? 'button[data-role="cancel"]' : 'button.primary'
    this.renderRoot.querySelector(sel)?.focus()
  }

  // Resolve carries the download choices too; the print handler ignores
  // them.
  _finish(confirmed) {
    if (this._settled) return
    super._finish({ confirmed: Boolean(confirmed), format: this._format, all: this._all })
  }

  _onClose = () => this._finish(false)
  _onCancel = () => this._finish(false)
  _onConfirm = () => this._finish(true)

  _countSection() {
    const verb = this.mode === 'print' ? 'print' : 'download'
    // "Export everything" on (download only): every finding goes,
    // filters + triage status bypassed.
    if (this._all) {
      if (this.everythingCount === 0) {
        return html`<p class="ecd-count">No findings to ${verb}.</p>`
      }
      return html`
        <p class="ecd-count">Exporting all <strong>${this.everythingCount}</strong> ${this.everythingCount === 1 ? 'finding' : 'findings'}.</p>
        <p class="ecd-excluded">Filters and triage status are ignored.</p>
      `
    }
    if (this.total === 0) {
      return html`<p class="ecd-count">No findings to ${verb}.</p>`
    }
    // Focus view-mode: print emits only the focused finding. Lead with
    // that, and point the user to list / grouped to print the whole
    // filtered set (the focus queue, sized `included`). Only when the
    // queue is non-empty — with everything filtered out there's nothing
    // focused, so fall through to the normal "0 of N" (disabled) copy.
    if (this.focusedOnly && this.included > 0) {
      return html`
        <p class="ecd-count">Only the <strong>focused</strong> finding will be printed.</p>
        <p class="ecd-excluded">Focus mode prints just the finding you're viewing. Switch to the list or grouped view to print all ${this.included} matching ${this.included === 1 ? 'finding' : 'findings'}.</p>
      `
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
    // With "export everything" on the filters don't apply, so don't
    // list them (the count line already says they're ignored).
    if (this._all) return nothing
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

  // Download-only controls: format switch + "export everything" toggle.
  _optionsSection() {
    if (this.mode !== 'download') return nothing
    const fmt = (value, label) => html`<button
      type="button"
      role="radio"
      aria-checked=${String(this._format === value)}
      class=${this._format === value ? 'ecd-seg-btn active' : 'ecd-seg-btn'}
      @click=${() => { this._format = value }}
    >${label}</button>`
    return html`
      <div class="ecd-options">
        <div class="ecd-field">
          <span class="ecd-field-label">Format</span>
          <div class="ecd-segmented" role="radiogroup" aria-label="Export format">
            ${fmt('md', 'Markdown')}
            ${fmt('csv', 'CSV')}
          </div>
        </div>
        <label class="ecd-check">
          <input
            type="checkbox"
            .checked=${this._all}
            @change=${(e) => { this._all = e.target.checked }}
          >
          <span>Export everything <em>(ignore filters &amp; triage status)</em></span>
        </label>
      </div>
    `
  }

  render() {
    const isPrint = this.mode === 'print'
    const title = isPrint ? 'Print report' : 'Download report'
    const intro = this.focusedOnly
      ? "You're in focus mode — printing outputs just the finding you're focused on."
      : isPrint
        ? 'Prints only the findings matching your current filters — the same set shown on screen. Use the toolbar to change the selection first.'
        : 'Downloads the findings as a file. Choose the format and what to include below.'
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>${title}</h3>
      </header>
      <p class="nwd-intro">${intro}</p>
      ${this._optionsSection()}
      ${this._countSection()}
      ${this.bucketLabel && !this._all
        ? html`<p class="nwd-note">Scoped to the <strong>${this.bucketLabel}</strong> list — live findings are not included.</p>`
        : nothing}
      ${this._filtersSection()}
      <p class="ecd-warn">${isPrint
        ? 'Printed output (and any saved PDF) is unencrypted.'
        : 'The downloaded file is unencrypted plain text, even if this workspace is encrypted.'}</p>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="primary" ?disabled=${this._exportCount === 0} @click=${this._onConfirm}>${isPrint ? 'Print' : 'Download'}</button>
      </footer>
    </dialog>`
  }
}

customElements.define('export-confirm-dialog', ExportConfirmDialog)

// Public entry point. Snapshots the current export selection (counts +
// active filters, on the basis matching `mode`) and opens the dialog.
// Resolves with `{ confirmed, format, all }` (format / all are the
// Download choices; print ignores them).
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
      focusedOnly: summary.focusedOnly,
      everythingCount: summary.everythingCount,
    })
    const settle = (detail) => { el.remove(); resolve(detail) }
    el.addEventListener('resolve', (e) => settle(e.detail ?? { confirmed: false }))
    el.addEventListener('modal-conflict', () => settle({ confirmed: false }))
    document.body.append(el)
  })
}
