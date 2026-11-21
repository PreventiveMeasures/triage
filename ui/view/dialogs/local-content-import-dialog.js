import { html, nothing, unsafeCSS } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog } from './confirmation-dialog.js'
import contentImportCSS from './dialog-content-import.css'

const selectable = (item) => !item.present && !item.error

class LocalContentImportDialog extends ConfirmationDialog {
  static styles = [...ConfirmationDialog.styles, unsafeCSS(contentImportCSS)]
  static properties = { selected: { state: true } }

  constructor() {
    super()
    this.plan = { kind: 'report', items: [], groups: [] }
    this.selected = new Set()
  }

  // Cloud-synced files start selected.
  beforeOpen() {
    this.selected = new Set(this.plan.items.filter((item) => item.synced && selectable(item)).map((item) => item.value))
  }

  toggle(item, checked) {
    if (!selectable(item)) return
    const selected = new Set(this.selected)
    if (checked) selected.add(item.value)
    else selected.delete(item.value)
    this.selected = selected
  }

  confirmationResult(confirmed) {
    const selected = this.plan.items.filter((item) => this.selected.has(item.value) && selectable(item)).map((item) => item.value)
    const accepted = confirmed && selected.length > 0 && !this.signal?.aborted
    return { confirmed: accepted, selected: accepted ? selected : [] }
  }

  render() {
    const kind = this.plan.kind === 'bundle' ? 'bundles' : 'reports'
    return this.prompt({
      title: `Import ${kind}`, titleId: 'content-import-title',
      body: 'Choose files to upload. Cloud-synced files are selected by default.',
      notes: html`<p class="lwd-note">Workspaces are shown for organization only. Teams and triage are not imported.
        Repository locations follow each file’s embedded metadata; files without it stay unattached.</p>
      <div class="content-import-groups">
        ${this.plan.groups.map((group) => html`<fieldset><legend>${group.name}</legend>
          ${group.items.map(({ item, synced, cached }) => html`<label class=${`content-import-item${selectable(item) ? '' : ' unavailable'}`}>
            <input type="checkbox" .checked=${this.selected.has(item.value)} ?disabled=${item.present || !!item.error}
              @change=${(event) => this.toggle(item, event.target.checked)}>
            <span class="content-import-label"><strong>${item.name}</strong>
              <span class="content-import-status">${synced ? 'Cloud synced' : 'Not synced'}${cached ? ' · last known status' : ''}
                ${item.present ? html`<span class="content-import-present">Already present</span>` : nothing}</span>
              ${item.error ? html`<span>${item.error}</span>` : nothing}
            </span>
          </label>`)}
        </fieldset>`)}
        ${this.plan.items.length === 0 ? html`<p class="lwd-empty">No local ${kind} available.</p>` : nothing}
      </div>`,
      status: html`<span class="lwd-empty" role="status">${this.selected.size} selected</span>`,
      action: `Import ${kind}`, kind: 'primary', disabled: this.selected.size === 0,
    })
  }
}

customElements.define('local-content-import-dialog', LocalContentImportDialog)

export function openLocalContentImportDialog(props) {
  return openAppDialog('local-content-import-dialog', props)
}
