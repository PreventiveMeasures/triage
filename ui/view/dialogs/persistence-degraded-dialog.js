// `<persistence-degraded-dialog>` — informational popup shown when the
// sync layer flips `persistenceDegraded` on (see
// `client/sync/triage-session-store.ts`). The triage state still works
// in-memory this session, but it can't be written back to this browser
// — so it won't survive a reload. The user has no other signal (the
// producer only `console.warn`s), so surface it explicitly. Pairs with
// the amber ring on the sidebar's `#sync-status` badge.
//
// Single-acknowledge dialog: extends `AppDialog` for the shared
// shadow-DOM <dialog> chrome (focus-trap + Esc-to-close). The resolve
// value is unused — callers fire-and-forget via
// `openPersistenceDegradedDialog()`.
import { html } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'

class PersistenceDegradedDialog extends AppDialog {
  // Focus the acknowledge button so Enter/Esc both just dismiss.
  focusInitial() {
    this.renderRoot.querySelector('button.primary')?.focus()
  }

  _onConfirm = () => this._finish(true)

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Your changes aren't being saved</h3>
      </header>
      <p class="nwd-intro">
        Triage still works in this tab, but it <strong>can't be saved in this
        browser right now</strong> — anything you change won't survive a page
        reload.
      </p>
      <p class="nwd-intro">
        This usually means another tab is running a different version of the
        app, or the browser's storage is full. To avoid overwriting data a
        newer version may have saved, this tab has paused writing.
      </p>
      <p class="nwd-note">
        Copy anything important elsewhere, then close other tabs of this app
        (or reload them all to the same version) and free up storage if it's
        full. This notice clears on its own once saving works again.
      </p>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" class="primary" @click=${this._onConfirm}>Got it</button>
      </footer>
    </dialog>`
  }
}

customElements.define('persistence-degraded-dialog', PersistenceDegradedDialog)

// Fire-and-forget. Resolves (to `true` on the button, `null` on
// Esc/close) when dismissed; callers don't act on the value.
export function openPersistenceDegradedDialog() {
  return openAppDialog('persistence-degraded-dialog')
}
