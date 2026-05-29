// `<persistence-degraded-dialog>` — informational popup shown when the
// sync layer flips `persistenceDegraded` on (see
// `client/sync/triage-session-store.ts`). Triage still works in-memory
// this session but can't be written back to this browser, so it won't
// survive a reload. The producer only `console.warn`s, so surface it
// explicitly. Pairs with the amber ring on the sidebar's
// `#sync-status` badge.
//
// Single-acknowledge dialog: extends `AppDialog` for the shared
// shadow-DOM <dialog> chrome (focus-trap + Esc-to-close). The open
// helper resolves `{ shown }` so the caller can retry if a
// `modal-conflict` kept it from displaying.
import { html } from 'lit'
import { AppDialog } from './app-dialog.js'

class PersistenceDegradedDialog extends AppDialog {
  // Focus the acknowledge button so Enter/Esc both just dismiss.
  focusInitial() {
    this.renderRoot.querySelector('button.primary')?.focus()
  }

  _onConfirm = () => this._finish(true)

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Changes might not be saved</h3>
      </header>
      <p class="nwd-intro">
        Triage works in this tab, but this browser <strong>can't save its sync
        state right now</strong> — so changes that haven't reached the server
        could be lost if you reload the page.
      </p>
      <p class="nwd-intro">
        This usually means the browser's storage is full, or another tab is
        running a newer version of the app (to avoid overwriting that newer
        version's data, this tab has paused saving).
      </p>
      <p class="nwd-note">
        Free up space if storage is full, and close or reload other tabs of
        this app to the same version. This notice clears on its own once
        saving works again.
      </p>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" class="primary" @click=${this._onConfirm}>Got it</button>
      </footer>
    </dialog>`
  }
}

customElements.define('persistence-degraded-dialog', PersistenceDegradedDialog)

// Own open helper rather than the shared `openAppDialog`, so we settle
// on `modal-conflict` too: if another modal is already open when
// persistence degrades, `AppDialog.firstUpdated`'s `showModal()` throws
// and dispatches `modal-conflict` instead of `resolve` — the shared
// helper only listens for `resolve`, so it would hang forever and leak
// the element. Resolve `{ shown }` and remove on BOTH paths so the
// promise always settles and cleans up; `shown: false` (conflict, never
// displayed) tells the caller to retry while still degraded so the
// one-shot notice isn't skipped for the whole episode.
export function openPersistenceDegradedDialog() {
  return new Promise((resolve) => {
    const el = document.createElement('persistence-degraded-dialog')
    const settle = (shown) => { el.remove(); resolve({ shown }) }
    el.addEventListener('resolve', () => settle(true))
    el.addEventListener('modal-conflict', () => settle(false))
    document.body.append(el)
  })
}
