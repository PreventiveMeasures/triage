// Shown when a dropped report's name matches a local report with different
// content, instead of a silent overwrite that would leave workspace copies out
// of step with the cloud (saveFile doesn't touch remote). Replace overwrites
// (callers re-upload to every workspace listing the name), Rename saves under a
// new name checked against `existingNames`, Cancel skips the file.
import { html, nothing } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { onEnter } from './shared.js'
import { ConfirmationDialog, optionHint, radioOption } from './confirmation-dialog.js'

class ImportConflictDialog extends ConfirmationDialog {
  static properties = { _choice: { state: true }, _newName: { state: true } }

  constructor() {
    super()
    // Replace is pre-selected, the likeliest intent of a re-drop; Cancel still
    // has focus, so a stray Enter writes nothing.
    this._choice = 'replace'
    // Seeded by the open helper, so the suggestion is in the first paint.
    this._newName = ''
  }

  get _trimmed() { return (this._newName ?? '').trim() }

  confirmationResult(confirmed) {
    if (!confirmed) return { action: 'cancel' }
    return this._choice === 'rename' ? { action: 'rename', newName: this._trimmed } : { action: 'replace' }
  }

  _onConfirm = () => {
    if (this._choice !== 'rename' || this._renameError(this._trimmed) === null) this._finish(true)
  }
  _onChoiceChange = (e) => { this._choice = e.target.value }
  _onNameInput = (e) => { this._newName = e.target.value }
  _onNameKeydown = onEnter(() => this._onConfirm())

  _replaceHint() {
    const n = this.workspaceNames.length
    if (n === 0) return 'The local file will be overwritten.'
    const label = n === 1
      ? html`workspace <strong>"${this.workspaceNames[0]}"</strong>`
      : html`<strong>${n}</strong> workspaces (${this.workspaceNames.join(', ')})`
    // "When sync is online": `uploadReportToWorkspaces` no-ops while sync is
    // off or its chunk isn't loaded, though the local overwrite always runs.
    return html`
      The local file will be overwritten. When sync is online, the new bytes are also uploaded to ${label} so the cloud copy matches.
    `
  }

  // The message for the rule `trimmed` breaks, or null. NUL separates
  // `state.ignoredIds` keys and slashes break OPFS keys, both of which saveFile
  // would reject behind a generic alert.
  _renameError(trimmed) {
    if (!trimmed) return 'Enter a new name.'
    if (trimmed === this.reportName) return 'Pick a name different from the original.'
    if (trimmed.includes('\0')) return 'The new name cannot contain a NUL byte.'
    if (trimmed.includes('/') || trimmed.includes('\\')) return 'The new name cannot contain "/" or "\\".'
    if (this.existingNames.has(trimmed)) return `A file named "${trimmed}" already exists — pick something else.`
    return null
  }

  render() {
    const renaming = this._choice === 'rename'
    const renameError = renaming ? this._renameError(this._trimmed) : null
    const option = { name: 'icd-choice', current: this._choice, change: this._onChoiceChange }
    // A fresh filename has no workspace attachment.
    const renameHint = this.workspaceNames.length > 0
      ? optionHint('Saved as an unfiled report — the renamed copy isn\'t added to any workspace.')
      : nothing
    return this.prompt({
      title: 'Import conflict',
      body: html`<strong>"${this.reportName}"</strong> already exists with different content.`,
      notes: html`<fieldset class="lwd-choice">
        <legend>What should happen?</legend>
        ${radioOption({ ...option, value: 'replace', title: 'Replace' }, optionHint(this._replaceHint()))}
        ${radioOption({ ...option, value: 'rename', title: 'Rename to' }, html`<input
            type="text"
            class="nwd-input lwd-rename-input"
            maxlength="200"
            .value=${this._newName}
            ?disabled=${!renaming}
            @input=${this._onNameInput}
            @keydown=${this._onNameKeydown}
            @focus=${() => { this._choice = 'rename' }}
          >
          ${renameHint}
          ${renameError === null ? nothing : html`<p class="lwd-rename-error">${renameError}</p>`}`)}
      </fieldset>`,
      action: renaming ? 'Rename' : 'Replace',
      kind: renaming ? 'primary' : 'danger',
      disabled: renameError !== null,
    })
  }
}

customElements.define('import-conflict-dialog', ImportConflictDialog)

// Resolves `{ action: 'replace' | 'cancel' }` or `{ action: 'rename', newName }`.
// Opened from `addFiles`, perhaps over another modal (it stacks); one that
// can't show cancels, so the import flow doesn't hang and the user can re-drop.
export function openImportConflictDialog({ name, workspaceNames, existingNames } = {}) {
  const existing = existingNames instanceof Set ? existingNames : new Set(existingNames ?? [])
  return openAppDialog('import-conflict-dialog', {
    reportName: name ?? '',
    workspaceNames: Array.isArray(workspaceNames) ? workspaceNames : [],
    existingNames: existing,
    _newName: suggestUniqueName(name ?? '', existing),
  }, { conflict: () => ({ action: 'cancel' }) })
}

// `original` with `-N` before its extension, N the first not in `taken`. Not
// " (N)", which the drop router reads as a browser's download-duplicate marker
// (`stripDownloadDup` in ingest.js). An existing `-N` is replaced, not stacked.
function suggestUniqueName(original, taken) {
  if (typeof original !== 'string' || original.length === 0) return ''
  const dot = original.lastIndexOf('.')
  // No extension, or a leading dot (".hidden"): the counter goes at the end.
  const stem = dot > 0 ? original.slice(0, dot) : original
  const ext = dot > 0 ? original.slice(dot) : ''
  const baseStem = stem.replace(/-\d+$/u, '')
  for (let i = 2; i < 1000; i++) {
    const candidate = `${baseStem}-${i}${ext}`
    if (!taken.has(candidate)) return candidate
  }
  return ''
}
