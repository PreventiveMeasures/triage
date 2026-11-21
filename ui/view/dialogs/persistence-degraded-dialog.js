// Shown when sync turns `persistenceDegraded` on (client/sync/
// triage-session-store.ts): triage works in memory but can't be written to
// this browser, so it won't survive a reload, and the producer only warns in
// the console. Pairs with the amber ring on the sidebar's `#sync-status`.
import { html } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'

class PersistenceDegradedDialog extends AppDialog {
  _onClose = () => this._finish({ shown: true })

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
      <p class="nwd-note ui-hint">
        Free up space if storage is full, and close or reload other tabs of
        this app to the same version. This notice clears on its own once
        saving works again.
      </p>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" class="primary" @click=${this._onClose}>Got it</button>
      </footer>
    </dialog>`
  }
}

customElements.define('persistence-degraded-dialog', PersistenceDegradedDialog)

// Opens unprompted, so never over another modal: `{ shown: false }` then, for
// the caller to retry while still degraded.
export function openPersistenceDegradedDialog() {
  return openAppDialog('persistence-degraded-dialog', {}, { exclusive: true, conflict: () => ({ shown: false }) })
}
