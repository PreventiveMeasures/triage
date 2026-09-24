// `<sync-suggest-dialog>` — opens on its own when reports of the
// workspace on screen differ from their cloud copies in a way sync
// can't settle by itself (a local change that never uploaded, or two
// copies with nothing showing which is newer — `differingReports` in
// `client/sync/objstore-presence.js`). The badge's "N differ" chunk
// says the same thing quietly; this makes sure it isn't missed. "Sync"
// hands over to the re-check dialog, which compares each report and
// brings them in line (or asks which copy to keep).
//
// When it opens and how often is `view/sync-suggest.js`'s business.
//
// Public API:
//   openSyncSuggestDialog({ names })
//     → Promise<{ shown: boolean, sync: boolean }>
//     `shown: false` — another modal was open, so it never displayed
//     (the caller retries); `sync` — the user chose "Sync".

import { html, nothing, unsafeCSS } from 'lit'
import { AppDialog } from './app-dialog.js'
import detailActionCSS from '../../styles/detail-action.css'
import listCSS from './dialog-list.css'
import suggestCSS from './dialog-sync-suggest.css'

// Past this many names the list stops and says how many more.
const MAX_LISTED = 5

class SyncSuggestDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(detailActionCSS), unsafeCSS(listCSS), unsafeCSS(suggestCSS)]

  static properties = {
    names: { type: Array },
  }

  constructor() {
    super()
    this.names = []
  }

  focusInitial() {
    this.renderRoot.querySelector('button[data-role="sync"]')?.focus()
  }

  _onSync = () => this._finish(true)
  _onDismiss = () => this._finish(false)
  _onClose = () => this._finish(false)

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
      <button type="button" class="detail-action ssd-close" data-role="close" aria-label="Close" @click=${this._onDismiss}>×</button>
      <header><h3>Reports out of sync</h3></header>
      <p class="lwd-body">${intro}</p>
      ${this._list()}
      <p class="nwd-note">Sync compares ${one ? 'it' : 'each one'} with the cloud. Where it's clear which copy is newer, the other is updated; otherwise you choose which to keep.</p>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" data-role="dismiss" @click=${this._onDismiss}>Not now</button>
        <button type="button" class="primary" data-role="sync" @click=${this._onSync}>Sync</button>
      </footer>
    </dialog>`
  }
}

customElements.define('sync-suggest-dialog', SyncSuggestDialog)

// Own open helper (like `openPersistenceDegradedDialog`) so it settles on
// `modal-conflict` too — this dialog opens unprompted, so another modal
// being up is expected, not an error.
export function openSyncSuggestDialog({ names } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('sync-suggest-dialog')
    el.names = Array.isArray(names) ? [...names] : []
    const settle = (shown, sync) => { el.remove(); resolve({ shown, sync }) }
    el.addEventListener('resolve', (e) => settle(true, e.detail === true))
    el.addEventListener('modal-conflict', () => settle(false, false))
    document.body.append(el)
  })
}
