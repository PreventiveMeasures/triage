// `<proxy-auth-dialog>` — cancellable popup shown when the sync layer
// detects that reconnects are being redirected to an authentication
// proxy (see `client/sync/proxy-auth-detect.ts`, surfaced via
// `triageSync.proxyAuthRequired`). The canonical case is an expired
// Cloudflare Access session: the relay can't be reached until the user
// re-runs the proxy login, which a full page reload does. Triage is
// saved locally, so reloading loses nothing — hence the dialog only
// *offers* a reload and is freely dismissable ("Not now").
//
// Single-choice dialog: extends `AppDialog` for the shared shadow-DOM
// <dialog> chrome (focus-trap + Esc-to-close). The reload itself is the
// caller's job — the dialog just resolves which action was picked, so
// it stays pure/testable and the `location.reload()` decision lives at
// the app layer (sidebar wiring). The open helper resolves
// `{ shown, reload }` so the caller can retry if a `modal-conflict`
// kept it from displaying.
import { html } from 'lit'
import { AppDialog } from './app-dialog.js'

class ProxyAuthDialog extends AppDialog {
  // Focus the (non-destructive) reload button so Enter reloads; Esc
  // still cancels via the native <dialog> close.
  focusInitial() {
    this.renderRoot.querySelector('button.primary')?.focus()
  }

  _onReload = () => this._finish('reload')
  _onDismiss = () => this._finish(null)
  // Esc / backdrop dismissal is a cancel, same as "Not now".
  _onClose = () => this._finish(null)

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Sign in to keep syncing</h3>
      </header>
      <p class="nwd-intro">
        Triage can't reach the sync server — the connection is being redirected to an
        <strong>authentication proxy</strong> (for example Cloudflare Access). This
        usually means your access session has expired.
      </p>
      <p class="nwd-note">
        Reload the page to sign in again. Your triage is saved on this device, so
        reloading won't lose anything — or keep working offline and reload later.
      </p>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onDismiss}>Not now</button>
        <button type="button" class="primary" @click=${this._onReload}>Reload page</button>
      </footer>
    </dialog>`
  }
}

customElements.define('proxy-auth-dialog', ProxyAuthDialog)

// Own open helper (not the shared `openAppDialog`) so we settle on
// `modal-conflict` too: if another modal is already open when the proxy
// redirect is detected, `AppDialog.firstUpdated`'s `showModal()` throws
// and dispatches `modal-conflict` instead of `resolve`. Resolve
// `{ shown, reload }` and remove on BOTH paths so the promise always
// settles and cleans up; `shown: false` (conflict, never displayed)
// tells the caller to retry while still blocked. Mirrors
// `openPersistenceDegradedDialog`.
export function openProxyAuthDialog() {
  return new Promise((resolve) => {
    const el = document.createElement('proxy-auth-dialog')
    const settle = (shown, reload) => { el.remove(); resolve({ shown, reload }) }
    el.addEventListener('resolve', (e) => settle(true, e.detail === 'reload'))
    el.addEventListener('modal-conflict', () => settle(false, false))
    document.body.append(el)
  })
}
