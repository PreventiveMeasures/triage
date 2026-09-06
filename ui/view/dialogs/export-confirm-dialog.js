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
// selection and resolves with `{ confirmed, view, fields }`; Cancel /
// Esc / native close all resolve to both flags false. Download also
// offers View, which resolves `{ view: true }` and leaves it to the
// caller to show the Markdown — this dialog's job is the selection,
// not the file.
//
// Each listed filter can be dropped from the export with its × — the
// counts move as it goes, and `fields` comes back carrying the relaxed
// selection for the caller to export under. What it never touches is
// the toolbar: the dialog works on a CLONE of the filter state (see
// filters.js cloneFilterFields), so dropping Severity here narrows
// nothing on screen and the app is exactly as the user left it whether
// they export or cancel.
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
    // [{ key, label, value, clear }] — active filters, already
    // humanized, each with the patch that drops it.
    filters: { attribute: false },
    // The filter selection the counts above were computed under: a
    // clone of the toolbar's, minus whatever has been dropped here.
    fields: { attribute: false },
    // Non-null only when viewing a trash bucket (e.g. 'Deleted').
    bucketLabel: { type: String },
    // Print from the focus view-mode emits only the single focused
    // finding (not the whole filtered set) — see export-summary.js.
    focusedOnly: { type: Boolean },
  }

  constructor() {
    super()
    this.mode = 'print'
    this.included = 0
    this.excluded = 0
    this.total = 0
    this.filters = []
    this.fields = null
    // Set once a filter has been dropped, so an untouched dialog hands
    // back no override at all rather than a clone of what is already
    // in force. Not reactive — nothing renders from it.
    this._relaxed = false
    this.bucketLabel = null
    this.focusedOnly = false
  }

  // Focus the primary action — this is a non-destructive confirm, so
  // Enter should commit the export rather than land on Cancel. With an
  // empty selection the primary is disabled, so focus Cancel instead.
  focusInitial() {
    const sel = this.included === 0 ? 'button[data-role="cancel"]' : 'button.primary'
    this.renderRoot.querySelector(sel)?.focus()
  }

  // One of 'cancel' | 'view' | 'confirm'. Spelled out rather than a
  // boolean because there are now three ways out and two of them are
  // not a cancel.
  //
  // `fields` rides along only once a filter has actually been dropped.
  // Null means "export under the toolbar's own selection", which lets
  // the caller skip installing an override that would change nothing —
  // and for print, skip the re-render that would come with it.
  _finish(action) {
    if (this._settled) return
    super._finish({
      confirmed: action === 'confirm',
      view: action === 'view',
      fields: this._relaxed ? this.fields : null,
    })
  }

  _onClose = () => this._finish('cancel')
  _onCancel = () => this._finish('cancel')
  _onView = () => this._finish('view')
  _onConfirm = () => this._finish('confirm')

  // Drop one filter from this export. Recounts against the relaxed
  // clone — `included` climbs, `excluded` falls — and re-describes it,
  // which is what removes the row: `activeFilterDescriptions` lists a
  // filter iff it still narrows something, so a cleared field simply
  // stops being described.
  async _onDropFilter(key) {
    const at = this.filters.findIndex((f) => f.key === key)
    if (at === -1) return
    const summary = exportSelectionSummary(this.mode, { ...this.fields, ...this.filters[at].clear })
    this._relaxed = true
    this.fields = summary.fields
    this.filters = summary.filters
    this.included = summary.included
    this.excluded = summary.excluded
    this.total = summary.total
    // The button that was just pressed is gone. Hand focus to the row
    // that took its place — or to the last one, when the bottom row
    // went — so a keyboard user can drop several without tabbing back
    // in each time, and doesn't get dumped at the top of the document.
    await this.updateComplete
    const buttons = [...this.renderRoot.querySelectorAll('button[data-drop]')]
    const next = buttons[Math.min(at, buttons.length - 1)]
      ?? this.renderRoot.querySelector('button.primary')
      ?? this.renderRoot.querySelector('button[data-role="cancel"]')
    next?.focus()
  }

  _countSection() {
    if (this.total === 0) {
      return html`<p class="ecd-count">No findings to ${this.mode === 'print' ? 'print' : 'download'}.</p>`
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
    if (this.filters.length === 0) {
      return html`<p class="ecd-filters-label">No filters active — the full ${this.bucketLabel ? `${this.bucketLabel.toLowerCase()} ` : ''}set is included.</p>`
    }
    return html`
      <p class="ecd-filters-label">Active filters</p>
      <dl class="ecd-filters">
        ${this.filters.map((f) => html`
          <dt>${f.label}</dt>
          <dd>
            <span class="ecd-filter-value">${f.value}</span>
            <button
              type="button"
              class="ecd-filter-drop"
              data-drop=${f.key}
              aria-label=${`Drop the ${f.label.toLowerCase()} filter (${f.value}) from this export`}
              @click=${() => this._onDropFilter(f.key)}
            >×</button>
          </dd>
        `)}
      </dl>
    `
  }

  render() {
    const isPrint = this.mode === 'print'
    const title = isPrint ? 'Print report' : 'Download report'
    const intro = this.focusedOnly
      ? "You're in focus mode — printing outputs just the finding you're focused on."
      : isPrint
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
        <!-- Download only: View shows the Markdown this selection would
             write. Print has no such artefact to show — the page IS the
             preview. Disabled alongside the primary on an empty
             selection, where there would be nothing to look at. -->
        ${isPrint ? nothing : html`<button type="button" data-role="view" ?disabled=${this.included === 0} @click=${this._onView}>View</button>`}
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
      fields: summary.fields,
      bucketLabel: summary.bucketLabel,
      focusedOnly: summary.focusedOnly,
    })
    const settle = (detail) => { el.remove(); resolve(detail) }
    el.addEventListener('resolve', (e) => settle({
      confirmed: Boolean(e.detail?.confirmed),
      view: Boolean(e.detail?.view),
      fields: e.detail?.fields ?? null,
    }))
    el.addEventListener('modal-conflict', () => settle({ confirmed: false, view: false, fields: null }))
    document.body.append(el)
  })
}
