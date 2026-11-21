// What the sync badge's upload and download prompts share: naming the items,
// moving them one after another, and listing what failed once done.
import { html, nothing, unsafeCSS } from 'lit'
import { isLinksFile } from '../file-display.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import listCSS from './dialog-list.css'

// The explicit label, a short hash for a bundle, else the report's filename.
const itemLabel = (item) => item.kind === 'bundle'
  ? item.label ?? `bundle-${item.identifier.slice('sha512-'.length, 'sha512-'.length + 12)}…`
  : item.identifier

// Three kinds, not the wire's two: a links file travels as a report, but a
// prompt about what leaves this device names it for what it is. Read from the
// local counts cache, so a name never analyzed here reads as a report.
const displayKind = (item) => item.kind === 'bundle' ? 'bundle' : isLinksFile(item.identifier) ? 'links file' : 'report'

// Subclasses give `copy` ({ verb, heading, one(label), many(count, kinds),
// note, key }) and `transfer(item)`, which resolves a failure's reason or
// undefined, and may follow up on what moved in `transferred(moved)`.
export class TransferDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(listCSS)]

  static properties = { _running: { state: true }, _errors: { state: true }, _done: { state: true } }

  constructor() {
    super()
    this._running = false
    this._errors = []
    this._done = false
  }

  get copy() { return this.constructor.copy }

  focusInitial() {
    this.renderRoot.querySelector(`button[data-role="${this.copy.verb.toLowerCase()}"]`)?.focus()
  }

  _onClose = () => this._finish({ [this.copy.key]: [], failed: [] })

  transferred() {}

  _onRun = async () => {
    if (this._running) return
    this._running = true
    this._errors = []
    const moved = []
    const failed = []
    for (const item of this.items) {
      const { kind, identifier } = item
      let reason
      try {
        reason = await this.transfer(item)
      } catch (err) {
        reason = err?.message ?? String(err)
      }
      if (reason === undefined) {
        moved.push({ kind, identifier })
        continue
      }
      failed.push({ kind, identifier, reason })
      this._errors = [...this._errors, { label: itemLabel(item), reason }]
    }
    this._running = false
    this._done = true
    await this.transferred(moved)
    if (failed.length === 0) this._finish({ [this.copy.key]: moved, failed })
  }

  render() {
    const { verb, heading, one, many, note = nothing } = this.copy
    const count = this.items.length
    const single = count === 1
    // A list of one kind names it ("reports", "links files"), a mixed one "items".
    const kinds = new Set(this.items.map(displayKind))
    const kindLabel = kinds.size === 1 ? `${[...kinds][0]}${single ? '' : 's'}` : 'items'
    const failedOut = this._done && this._errors.length > 0
    const action = this._running
      ? (single ? `${verb}ing…` : `${verb}ing ${count} ${kindLabel}…`)
      : (single ? verb : `${verb} ${count}`)
    return html`<dialog @close=${this._onClose}>
      <header><h3>${heading}</h3></header>
      <p class="lwd-body">${single ? one(itemLabel(this.items[0])) : many(count, kindLabel)}</p>
      ${single ? nothing : html`<ul class="lwd-list">
        ${this.items.map((item) => {
          // Anything but a plain report says per row what it is.
          const kind = displayKind(item)
          return html`<li>${itemLabel(item)}${kind === 'report' ? nothing : html` <span class="lwd-kind-tag">${kind}</span>`}</li>`
        })}
      </ul>`}
      ${note}
      ${this._errors.length === 0 ? nothing : html`<ul class="lwd-list" role="alert">
        ${this._errors.map((e) => html`<li><strong>${e.label}</strong> — ${e.reason}</li>`)}
      </ul>`}
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="cancel" @click=${this._onCancel} ?disabled=${this._running}>
          ${failedOut ? 'Close' : 'Cancel'}
        </button>
        ${failedOut ? nothing : html`<button
          type="button"
          data-role=${verb.toLowerCase()}
          @click=${this._onRun}
          ?disabled=${this._running || count === 0}
        >${action}</button>`}
      </footer>
    </dialog>`
  }
}

export function openTransferDialog(tagName, { workspaceId, items } = {}) {
  return openAppDialog(tagName, { workspaceId: workspaceId ?? '', items: Array.isArray(items) ? [...items] : [] })
}
