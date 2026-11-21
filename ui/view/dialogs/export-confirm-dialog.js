// What the toolbar's export button opens, its two TABS the two exports:
// Markdown writes the file, Print sends the page to paper. Both emit only the
// findings the active filters show (export-summary.js), so it restates that
// selection: the counts, and the filters in words, each droppable from this
// export with its ×. Dropping works on a CLONE of the filter state
// (filters.js cloneFilterFields), so the toolbar is left as it was either way.
//
// Native Ctrl+P / menu printing can't wait on an async confirm, so only the
// in-app button (`download-requested`) comes through here.
import { html, nothing, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { dialogTabs } from '../header-tabs.js'
import { MARKDOWN_ICON, PRINT_ICON } from '../export-icons.js'
import { exportSelectionSummary } from '../export-summary.js'
import exportConfirmCSS from './dialog-export-confirm.css'
import tabsCSS from './dialog-tabs.css'

// Named for what comes out; the committing button says what happens
// (Download / Print). Ids are the caller's export modes. Markdown leads: it
// always has something to give, where the page may be the wrong shape to print.
const TABS = [
  { id: 'download', label: 'Markdown', icon: MARKDOWN_ICON },
  { id: 'print', label: 'Print', icon: PRINT_ICON },
]

class ExportConfirmDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(exportConfirmCSS), unsafeCSS(tabsCSS)]

  static properties = {
    // 'download' | 'print', the open tab.
    mode: { type: String },
    included: { type: Number },
    excluded: { type: Number },
    total: { type: Number },
    // [{ key, label, value, clear }]: the active filters, humanized, each with
    // the patch that drops it.
    filters: { attribute: false },
    // The selection the counts are of: the toolbar's, less what was dropped.
    fields: { attribute: false },
    // Set only while viewing a trash bucket (e.g. 'Deleted').
    bucketLabel: { type: String },
    // Whether Print would emit only the focused finding (focus view-mode),
    // taken once at open: the counts are the same for both exports.
    focusedOnly: { type: Boolean },
    oneSamplePerGroup: { type: Boolean },
  }

  constructor() {
    super()
    this.mode = 'download'
    this.filters = []
    this.fields = null
    // A filter was dropped. Until then no override goes back, rather than a
    // clone of what's already in force.
    this._relaxed = false
    this.bucketLabel = null
    this.focusedOnly = false
    this.oneSamplePerGroup = false
  }

  get _focusedOnly() { return this.mode === 'print' && this.focusedOnly }

  // Enter commits: this is no destructive confirm. Cancel while there's
  // nothing to export.
  focusInitial() {
    this.renderRoot.querySelector(this.included === 0 ? 'button[data-role="cancel"]' : 'button.primary')?.focus()
  }

  // `action`: 'cancel' | 'view' | 'confirm'. `fields` is null for the
  // toolbar's own selection, which spares the caller an override (and print a
  // re-render); `mode` is the tab confirmed under, which decides the export.
  _finish(action) {
    if (this._settled) return
    super._finish({
      confirmed: action === 'confirm',
      view: action === 'view',
      fields: this._relaxed ? this.fields : null,
      mode: this.mode,
      oneSamplePerGroup: this.oneSamplePerGroup,
    })
  }

  _onClose = () => this._finish('cancel')
  _onView = () => this._finish('view')
  _onConfirm = () => this._finish('confirm')

  // Recounts under the relaxed clone. A filter is described while it still
  // narrows something, so a cleared one's row goes; focus moves to the row
  // that took its place, or the last, for dropping several by keyboard.
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
    await this.updateComplete
    const buttons = [...this.renderRoot.querySelectorAll('button[data-drop]')]
    const next = buttons[Math.min(at, buttons.length - 1)]
      ?? this.renderRoot.querySelector('button.primary')
      ?? this.renderRoot.querySelector('button[data-role="cancel"]')
    next?.focus()
  }

  _countSection() {
    const print = this.mode === 'print'
    if (this.total === 0) return html`<p class="ecd-count">No findings to ${print ? 'print' : 'download'}.</p>`
    // With everything filtered out nothing is focused: the plain "0 of N".
    if (this._focusedOnly && this.included > 0) {
      return html`
        <p class="ecd-count">Only the <strong>focused</strong> finding will be printed.</p>
        <p class="ecd-excluded">Focus mode prints just the finding you're viewing. Switch to the list or grouped view to print all ${this.included} matching ${this.included === 1 ? 'finding' : 'findings'}.</p>
      `
    }
    // "All N" only when nothing is filtered: filters that happen to exclude
    // nothing still read "N of N".
    const headline = this.excluded === 0 && this.filters.length === 0
      ? html`All <strong>${this.included}</strong> ${this.included === 1 ? 'finding' : 'findings'} included.`
      : html`<strong>${this.included}</strong> of ${this.total} ${this.total === 1 ? 'finding' : 'findings'} included.`
    return html`
      <p class="ecd-count">${headline}</p>
      ${this.excluded > 0
        ? html`<p class="ecd-excluded">${this.excluded} filtered out and ${print ? "won't be printed" : "won't be downloaded"}.</p>`
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
    const intro = this._focusedOnly
      ? "You're in focus mode — printing outputs just the finding you're focused on."
      : isPrint
        ? 'Prints only the findings matching your current filters — the same set shown on screen. Use the toolbar to change the selection first.'
        : 'Downloads a Markdown file of the findings matching your current filters — the same set shown on screen. Use the toolbar to change the selection first.'
    // The tab strip is the header. Flipping tabs recounts nothing: both
    // exports run over the same selection. View (Download only) shows the
    // Markdown it would write; for Print the page is the preview.
    return html`<dialog @close=${this._onClose}>
      <header>${dialogTabs({ tabs: TABS, current: this.mode, prefix: 'ecd', select: (id) => { this.mode = id } })}</header>
      <div
        role="tabpanel"
        id=${`ecd-panel-${this.mode}`}
        aria-labelledby=${`ecd-tab-${this.mode}`}
      >
      <p class="nwd-intro">${intro}</p>
      ${this._countSection()}
      ${this.bucketLabel
        ? html`<p class="nwd-note">Scoped to the <strong>${this.bucketLabel}</strong> list — live findings are not included.</p>`
        : nothing}
      ${this._filtersSection()}
      <label class="ecd-samples">
        <input type="checkbox" .checked=${this.oneSamplePerGroup}
          @change=${(event) => { this.oneSamplePerGroup = event.target.checked }}>
        <span>One sample per group<span class="ecd-samples-hint">Include only the currently selected sample from each group.</span></span>
      </label>
      </div>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        ${isPrint ? nothing : html`<button type="button" data-role="view" ?disabled=${this.included === 0} @click=${this._onView}>View</button>`}
        <button type="button" class="primary" ?disabled=${this.included === 0} @click=${this._onConfirm}>${isPrint ? 'Print' : 'Download'}</button>
      </footer>
    </dialog>`
  }
}

customElements.define('export-confirm-dialog', ExportConfirmDialog)

// Snapshots the selection and opens on the `mode` tab. Resolves
// `{ confirmed, view, fields, mode, oneSamplePerGroup }`; one that can't show
// is a cancel.
export function openExportConfirmDialog(mode = 'download') {
  const summary = exportSelectionSummary(mode)
  // The one thing the two bases disagree on, and the reader may flip to Print
  // later: take it on the print basis now rather than recount per tab click.
  const focusedOnly = mode === 'print' ? summary.focusedOnly : exportSelectionSummary('print').focusedOnly
  return openAppDialog('export-confirm-dialog', {
    mode,
    included: summary.included,
    excluded: summary.excluded,
    total: summary.total,
    filters: summary.filters,
    fields: summary.fields,
    bucketLabel: summary.bucketLabel,
    focusedOnly,
  }, { conflict: () => ({ confirmed: false, view: false, fields: null, mode }) })
}
