// Shown when reconnects are redirected to an authentication proxy
// (client/sync/proxy-auth-detect.ts, `triageSync.proxyAuthRequired`), as an
// expired Cloudflare Access session does: only a reload re-runs its login.
// Triage is saved locally, so it only offers one; the reload is the caller's.
import { html } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'

class ProxyAuthDialog extends AppDialog {
  _onClose = () => this._finish({ shown: true, reload: false })
  _onReload = () => this._finish({ shown: true, reload: true })

  render() {
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Sign in to keep syncing</h3>
      </header>
      <p class="nwd-intro ui-hint">
        Triage can't reach the sync server — the connection is being redirected to an
        <strong>authentication proxy</strong> (for example Cloudflare Access). This
        usually means your access session has expired.
      </p>
      <p class="nwd-note ui-hint">
        Reload the page to sign in again. Your triage is saved on this device, so
        reloading won't lose anything — or keep working offline and reload later.
      </p>
      <footer class="nwd-actions">
        <span class="nwd-spacer"></span>
        <button type="button" @click=${this._onClose}>Not now</button>
        <button type="button" class="primary" @click=${this._onReload}>Reload page</button>
      </footer>
    </dialog>`
  }
}

customElements.define('proxy-auth-dialog', ProxyAuthDialog)

// Opens unprompted, so never over another modal: `{ shown: false }` then, for
// the caller to retry while still blocked.
export function openProxyAuthDialog() {
  return openAppDialog('proxy-auth-dialog', {}, { exclusive: true, conflict: () => ({ shown: false, reload: false }) })
}
