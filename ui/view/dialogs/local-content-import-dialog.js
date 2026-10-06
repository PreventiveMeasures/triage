import { html, nothing, unsafeCSS } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog } from './confirmation-dialog.js'
import contentImportCSS from './dialog-content-import.css'

class LocalContentImportDialog extends ConfirmationDialog {
  static styles = [...ConfirmationDialog.styles, unsafeCSS(contentImportCSS)]
  static properties = { plan: { attribute: false }, selected: { state: true } }

  constructor() {
    super()
    this.plan = { kind: 'report', items: [], groups: [] }
    this.selected = new Set()
  }

  beforeOpen() {
    this.selected = new Set(this.plan.items.filter(item => item.synced && !item.present && !item.error).map(item => item.value))
  }

  firstUpdated() {
    if (this.signal?.aborted) { this._onCancel(); return }
    this.signal?.addEventListener('abort', this._onCancel, { once: true })
    super.firstUpdated()
  }

  disconnectedCallback() {
    this.signal?.removeEventListener('abort', this._onCancel)
    super.disconnectedCallback()
  }

  toggle(item, checked) {
    if (item.present || item.error) return
    const selected = new Set(this.selected)
    if (checked) selected.add(item.value)
    else selected.delete(item.value)
    this.selected = selected
  }

  confirmationResult(confirmed) {
    const selected = this.plan.items.filter(item => this.selected.has(item.value) && !item.present && !item.error).map(item => item.value)
    const accepted = confirmed && selected.length > 0 && !this.signal?.aborted
    return { confirmed: accepted, selected: accepted ? selected : [] }
  }

  render() {
    const kind = this.plan.kind === 'bundle' ? 'bundles' : 'reports'
    return html`<dialog aria-labelledby="content-import-title" @close=${this._onClose}>
      <header><h3 id="content-import-title">Import ${kind}</h3></header>
      <p class="lwd-body">Choose files to upload. Cloud-synced files are selected by default.</p>
      <p class="lwd-note">Workspaces are shown for organization only. Teams and triage are not imported.
        Repository locations follow each file’s embedded metadata; files without it stay unattached.</p>
      <div class="content-import-groups">
        ${this.plan.groups.map(group => html`<fieldset><legend>${group.name}</legend>
          ${group.items.map(({ item, synced, cached }) => html`<label class=${`content-import-item${item.present || item.error ? ' unavailable' : ''}`}>
            <input type="checkbox" .checked=${this.selected.has(item.value)} ?disabled=${item.present || !!item.error}
              @change=${event => this.toggle(item, event.target.checked)}>
            <span class="content-import-label"><strong>${item.name}</strong>
              <span class="content-import-status">${synced ? 'Cloud synced' : 'Not synced'}${cached ? ' · last known status' : ''}
                ${item.present ? html`<span class="content-import-present">Already present</span>` : nothing}</span>
              ${item.error ? html`<span>${item.error}</span>` : nothing}
            </span>
          </label>`)}
        </fieldset>`)}
        ${this.plan.items.length === 0 ? html`<p class="lwd-empty">No local ${kind} available.</p>` : nothing}
      </div>
      <footer class="nwd-actions">
        <span class="lwd-empty" role="status">${this.selected.size} selected</span><span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel}>Cancel</button>
        <button type="button" class="primary" ?disabled=${this.selected.size === 0} @click=${this._onConfirm}>Import ${kind}</button>
      </footer>
    </dialog>`
  }
}

customElements.define('local-content-import-dialog', LocalContentImportDialog)

export function openLocalContentImportDialog(props) {
  return openAppDialog('local-content-import-dialog', props)
}
