// `<import-conflict-dialog>` — surfaces when a dropped report name
// matches an existing local report whose content differs. Replaces
// the previous silent overwrite (which left workspace-attached
// reports out of sync with the cloud because saveFile bumps local
// bytes but doesn't touch remote).
//
// The dialog offers three outcomes:
//   - Replace: overwrite the local file. Callers re-upload the new
//     bytes to every workspace that lists this name so the
//     workspace's cloud copy stays in lockstep.
//   - Rename: save under a different filename. Live-validated
//     against the caller-supplied `existingNames` so the user can't
//     pick a name that would just re-collide.
//   - Cancel: skip this file entirely.
//
// Sibling of `<delete-report-dialog>`: extends `AppDialog` for the
// shared shadow-DOM <dialog> chrome (focus-trap + Esc-to-cancel),
// with the `.lwd-*` list-dialog layer added on top.
import { html, nothing, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import listCSS from './dialog-list.css'

class ImportConflictDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS)]

  static properties = {
    reportName: { type: String },
    // Workspace display names that already list `reportName`. Empty
    // when the conflict is on an unfiled report. Drives the
    // upload-warning copy under the Replace option.
    workspaceNames: { type: Array },
    // Set of names already on disk in this drop, including the
    // colliding name. Used by the live-validation under Rename so
    // the user can't pick a name that would just collide again.
    existingNames: { type: Object },
    _choice: { state: true },
    _newName: { state: true },
  }

  constructor() {
    super()
    this.reportName = ''
    this.workspaceNames = []
    this.existingNames = new Set()
    // Default to Replace — that's the most common intent for a
    // re-drop of the same filename (the user is updating the report).
    // The Cancel button still requires an explicit click, so an
    // accidental Enter from the Replace radio is the worst case.
    this._choice = 'replace'
    // Caller-seeded via the `openImportConflictDialog` wrapper so
    // the input shows the non-colliding suggestion on the FIRST
    // paint (computing it in `beforeOpen` would leave the input
    // empty for the frame between the initial render and the
    // post-firstUpdated re-render).
    this._newName = ''
  }

  // Focus the Cancel button so an accidental Enter from a stray
  // keystroke doesn't immediately commit the overwrite. Matches the
  // delete-report-dialog convention for destructive defaults.
  focusInitial() {
    this.renderRoot.querySelector('button[data-role="cancel"]')?.focus()
  }

  _onClose = () => this._finish({ action: 'cancel' })
  _onCancel = () => this._finish({ action: 'cancel' })
  _onChoiceChange = (e) => { this._choice = e.target.value }
  _onNewNameInput = (e) => { this._newName = e.target.value }

  // Enter on a focused field commits the current choice when valid.
  // Mirrors the new-workspace dialog's Enter handler — single-line
  // input, no Ctrl/Cmd gate.
  _onNewNameKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      this._onConfirm()
    }
  }

  _onConfirm = () => {
    if (this._choice === 'rename') {
      const trimmed = (this._newName ?? '').trim()
      if (!trimmed || trimmed === this.reportName) return
      if (this.existingNames.has(trimmed)) return
      this._finish({ action: 'rename', newName: trimmed })
      return
    }
    this._finish({ action: 'replace' })
  }

  _replaceHint() {
    const n = this.workspaceNames.length
    if (n === 0) {
      return html`<span class="lwd-option-hint">The local file will be overwritten.</span>`
    }
    const label = n === 1
      ? html`workspace <strong>"${this.workspaceNames[0]}"</strong>`
      : html`<strong>${n}</strong> workspaces (${this.workspaceNames.join(', ')})`
    return html`<span class="lwd-option-hint">
      The local file will be overwritten and re-uploaded to ${label} so the cloud copy matches.
    </span>`
  }

  _renameValidationTpl(trimmed) {
    if (!trimmed) {
      return html`<p class="lwd-rename-error">Enter a new name.</p>`
    }
    if (trimmed === this.reportName) {
      return html`<p class="lwd-rename-error">Pick a name different from the original.</p>`
    }
    if (this.existingNames.has(trimmed)) {
      return html`<p class="lwd-rename-error">A file named "${trimmed}" already exists — pick something else.</p>`
    }
    return nothing
  }

  render() {
    const renameSelected = this._choice === 'rename'
    const trimmed = (this._newName ?? '').trim()
    const renameValid = renameSelected
      && trimmed.length > 0
      && trimmed !== this.reportName
      && !this.existingNames.has(trimmed)
    const confirmDisabled = renameSelected && !renameValid
    const confirmLabel = renameSelected ? 'Rename' : 'Replace'
    const confirmClass = renameSelected ? 'primary' : 'danger'
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Import conflict</h3>
      </header>
      <p class="lwd-body">
        <strong>"${this.reportName}"</strong> already exists with different content.
      </p>
      <fieldset class="lwd-choice">
        <legend>What should happen?</legend>
        <label class="lwd-option">
          <input
            type="radio"
            name="icd-choice"
            value="replace"
            ?checked=${this._choice === 'replace'}
            @change=${this._onChoiceChange}
          >
          <span class="lwd-option-text">
            <span class="lwd-option-title">Replace</span>
            ${this._replaceHint()}
          </span>
        </label>
        <label class="lwd-option">
          <input
            type="radio"
            name="icd-choice"
            value="rename"
            ?checked=${this._choice === 'rename'}
            @change=${this._onChoiceChange}
          >
          <span class="lwd-option-text">
            <span class="lwd-option-title">Rename to</span>
            <input
              type="text"
              class="nwd-input lwd-rename-input"
              maxlength="200"
              .value=${this._newName}
              ?disabled=${!renameSelected}
              @input=${this._onNewNameInput}
              @keydown=${this._onNewNameKeydown}
              @focus=${() => { this._choice = 'rename' }}
            >
            ${renameSelected ? this._renameValidationTpl(trimmed) : nothing}
          </span>
        </label>
      </fieldset>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        <button
          type="button"
          class=${confirmClass}
          ?disabled=${confirmDisabled}
          @click=${this._onConfirm}
        >${confirmLabel}</button>
      </footer>
    </dialog>`
  }
}

customElements.define('import-conflict-dialog', ImportConflictDialog)

// Public entry point. Resolves with:
//   { action: 'replace' }
//   { action: 'rename', newName }
//   { action: 'cancel' }
// Cancel / Esc / native close all resolve to `{ action: 'cancel' }`.
//
// The rename suggestion is computed up front so it lands as the
// initial value of `_newName` BEFORE the dialog's first render —
// seeding it inside the element (e.g. via `beforeOpen`) would leave
// the input empty for one frame between the initial paint and the
// post-firstUpdated re-render.
export function openImportConflictDialog({ name, workspaceNames, existingNames } = {}) {
  const existing = existingNames instanceof Set ? existingNames : new Set(existingNames ?? [])
  return openAppDialog('import-conflict-dialog', {
    reportName: name ?? '',
    workspaceNames: Array.isArray(workspaceNames) ? workspaceNames : [],
    existingNames: existing,
    _newName: suggestUniqueName(name ?? '', existing),
  })
}

// Derive a non-colliding name from `original` by inserting `-N`
// before the final extension and bumping N until the result isn't
// in `taken`. " (N)" would clash with browser download-duplicate
// markers (see `stripDownloadDup` in ingest.js); using `-N` keeps
// the two conventions distinct so a renamed import doesn't look
// like a redownload to the drop router.
function suggestUniqueName(original, taken) {
  if (typeof original !== 'string' || original.length === 0) return ''
  const dot = original.lastIndexOf('.')
  // No extension (or a leading dot like ".hidden") — append the
  // counter at the end so we don't change the "extension" segment.
  const stem = dot > 0 ? original.slice(0, dot) : original
  const ext = dot > 0 ? original.slice(dot) : ''
  // Strip an existing `-N` suffix so re-renaming `foo-2.json` lands
  // at `foo-3.json` (and so on) rather than `foo-2-2.json`.
  const baseStem = stem.replace(/-\d+$/u, '')
  for (let i = 2; i < 1000; i++) {
    const candidate = `${baseStem}-${i}${ext}`
    if (!taken.has(candidate)) return candidate
  }
  return ''
}
