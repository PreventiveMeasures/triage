// `<triage-export-dialog>` — full triage backup / restore dialog
// invoked from the console via `DeepView.export()`. Bundles all
// persisted-id triage entries plus all saved repo URLs into a
// single gzipped JSON file, and accepts the same shape back for
// import with three merge modes.
//
// Sibling of `<triage-conflict-dialog>` — extends `AppDialog` for
// the shared shadow-DOM <dialog> chrome (focus-trap + Esc-to-cancel)
// plus a public `open*` Promise wrapper.
import { html, nothing, unsafeCSS } from 'lit'
import {
  applyTriageImport,
  buildTriageExportGzip,
  parseTriageExportGzip,
} from '#client/index.js'
import { downloadBlob } from '../dom.js'
import { render as renderApp } from '../render.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import triageExportCSS from './dialog-triage-export.css'

class TriageExportDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(triageExportCSS)]

  static properties = {
    parsed: { state: true },
    parseError: { state: true },
    mode: { state: true },
    busy: { state: true },
    status: { state: true },
  }

  constructor() {
    super()
    this.parsed = null
    this.parseError = null
    // Default to 'prefer-current' — least destructive option;
    // user has to pick a stronger mode to overwrite anything.
    this.mode = 'prefer-current'
    this.busy = false
    this.status = null
  }

  // Focus the primary Download button (the base default would grab
  // the import file input instead). Base `firstUpdated` (showModal),
  // `_finish` (close + resolve) and `_onClose` (Esc / backdrop) are
  // inherited; this dialog resolves with no value — callers just
  // await the close.
  focusInitial() {
    this.renderRoot.querySelector('button.primary')?.focus()
  }

  async _onDownload() {
    this.busy = true
    this.status = null
    try {
      const { blob, filename } = await buildTriageExportGzip()
      downloadBlob(blob, filename)
      this.status = { kind: 'ok', text: `Downloaded ${filename}` }
    } catch (err) {
      this.status = { kind: 'err', text: `Export failed: ${err.message}` }
    } finally {
      this.busy = false
    }
  }

  async _onFile(e) {
    const file = e.target.files?.[0]
    this.parsed = null
    this.parseError = null
    this.status = null
    if (!file) return
    try {
      this.parsed = await parseTriageExportGzip(file)
    } catch (err) {
      this.parseError = err.message
    }
  }

  _onMode(e) { this.mode = e.target.value }

  async _onApply() {
    if (!this.parsed || this.busy) return
    this.busy = true
    this.status = null
    try {
      const result = await applyTriageImport(this.parsed, this.mode)
      // Re-render so adopted markers / triage states light up the
      // current view immediately. Bail-safe when nothing's loaded.
      renderApp()
      this.status = {
        kind: 'ok',
        text: `Applied ${result.triageEntries} triage entries and ${result.repoUrls} repo URLs (${this.mode}).`,
      }
      // Clear parsed so the file picker resets — user can pick
      // another file or close.
      this.parsed = null
      const input = this.renderRoot.querySelector('input[type="file"]')
      if (input) input.value = ''
    } catch (err) {
      this.status = { kind: 'err', text: `Import failed: ${err.message}` }
    } finally {
      this.busy = false
    }
  }

  render() {
    const p = this.parsed
    return html`<dialog @close=${this._onClose}>
      <header class="te-head">
        <h3>Triage backup</h3>
        <p>Bundles every triage entry (markers, triage states, comments, fixes, per-report ignores) and all saved repo URLs into a single gzipped JSON file.</p>
      </header>

      <section class="te-section">
        <h4>Export</h4>
        <p>Download the current triage + repo-URL set as a portable backup.</p>
        <button type="button" class="primary" @click=${this._onDownload} ?disabled=${this.busy}>
          ${this.busy ? 'Working…' : 'Download backup'}
        </button>
      </section>

      <hr>

      <section class="te-section">
        <h4>Import</h4>
        <p>Pick a previously-exported backup. Nothing is applied until you click Apply.</p>
        <input type="file" accept=".gz,application/gzip" @change=${this._onFile} ?disabled=${this.busy}>
        ${this.parseError
          ? html`<div class="te-error">Failed to parse: ${this.parseError}</div>`
          : nothing}
        ${p ? html`
          <div class="te-summary">
            Found <strong>${Object.keys(p.triage).length}</strong> triage entries and
            <strong>${Object.keys(p.repoUrls).length}</strong> repo URLs.
            ${p.exportedAt ? html`<span class="te-meta">Exported ${p.exportedAt}.</span>` : nothing}
          </div>
          <fieldset class="te-mode">
            <legend>Merge mode</legend>
            <label>
              <input type="radio" name="te-mode" value="prefer-current"
                .checked=${this.mode === 'prefer-current'} @change=${this._onMode}>
              <span>Merge — keep current on conflict <em>(safest, only fills gaps)</em></span>
            </label>
            <label>
              <input type="radio" name="te-mode" value="prefer-imported"
                .checked=${this.mode === 'prefer-imported'} @change=${this._onMode}>
              <span>Merge — prefer imported on conflict <em>(overwrites where both have a value)</em></span>
            </label>
            <label>
              <input type="radio" name="te-mode" value="replace"
                .checked=${this.mode === 'replace'} @change=${this._onMode}>
              <span>Replace all <em>(drops every current persisted entry first — destructive)</em></span>
            </label>
          </fieldset>
          <button type="button" class="primary" @click=${this._onApply} ?disabled=${this.busy}>
            ${this.busy ? 'Applying…' : 'Apply import'}
          </button>
        ` : nothing}
      </section>

      ${this.status
        ? html`<div class=${`te-status te-status-${this.status.kind}`}>${this.status.text}</div>`
        : nothing}

      <footer class="te-actions">
        <button type="button" @click=${this._onClose}>Close</button>
      </footer>
    </dialog>`
  }
}

customElements.define('triage-export-dialog', TriageExportDialog)

// Public entry point. Returns a Promise that resolves when the
// dialog closes (cancel or after a successful action). Caller
// doesn't get the import result — the dialog already re-rendered
// the app and showed a confirmation; nothing more to do here.
export function openTriageExportDialog() {
  return openAppDialog('triage-export-dialog')
}
