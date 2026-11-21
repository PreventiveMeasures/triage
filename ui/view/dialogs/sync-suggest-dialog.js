// Opens on its own when reports of the workspace on screen differ from their
// cloud copies in a way sync can't settle (a change that never uploaded, or two
// copies with nothing showing which is newer: `differingReports` in
// client/sync/objstore-presence.js), so the badge's quiet "N differ" isn't
// missed. "Sync" hands over to the re-check dialog. When and how often is
// view/sync-suggest.js's business.
import { html, nothing, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import detailActionCSS from '../../styles/detail-action.css'
import listCSS from './dialog-list.css'
import suggestCSS from './dialog-sync-suggest.css'

// Past this many names the list says how many more.
const MAX_LISTED = 10

class SyncSuggestDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(detailActionCSS), unsafeCSS(listCSS), unsafeCSS(suggestCSS)]

  _onClose = () => this._finish({ shown: true, sync: false })
  _onSync = () => this._finish({ shown: true, sync: true })

  _list() {
    if (this.names.length < 2) return nothing
    const listed = this.names.slice(0, MAX_LISTED)
    const more = this.names.length - listed.length
    return html`<ul class="lwd-list">
      ${listed.map((name) => html`<li><strong>${name}</strong></li>`)}
      ${more > 0 ? html`<li>and ${more} more</li>` : nothing}
    </ul>`
  }

  render() {
    const one = this.names.length === 1
    const intro = one
      ? html`Your copy of <strong>"${this.names[0]}"</strong> no longer matches its cloud copy, so other members may be seeing a different version.`
      : html`<strong>${this.names.length}</strong> reports no longer match their cloud copies, so other members may be seeing different versions.`
    return html`<dialog @close=${this._onClose}>
      <button type="button" class="detail-action ssd-close" data-role="close" aria-label="Close" @click=${this._onClose}>×</button>
      <header><h3>Reports out of sync</h3></header>
      <p class="lwd-body">${intro}</p>
      ${this._list()}
      <p class="nwd-note ui-hint">Sync compares ${one ? 'it' : 'each one'} with the cloud. Where it's clear which copy is newer, the other is updated; otherwise you choose which to keep.</p>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="dismiss" @click=${this._onClose}>Not now</button>
        <button type="button" class="primary" data-role="sync" @click=${this._onSync}>Sync</button>
      </footer>
    </dialog>`
  }
}

customElements.define('sync-suggest-dialog', SyncSuggestDialog)

// Resolves `{ shown, sync }`. Never over another modal (the suggester checks
// too): `shown: false` then, for the caller to retry.
export function openSyncSuggestDialog({ names } = {}) {
  return openAppDialog('sync-suggest-dialog', { names: Array.isArray(names) ? [...names] : [] }, {
    exclusive: true, conflict: () => ({ shown: false, sync: false }),
  })
}
