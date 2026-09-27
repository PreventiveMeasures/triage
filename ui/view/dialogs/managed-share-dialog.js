import { html, nothing } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { loadManagedBundle } from '../client-managed.js'
import { state } from '#client/index.js'

class ManagedShareDialog extends AppDialog {
  static properties = { team: { attribute: false }, url: { state: true }, busy: { state: true }, message: { state: true } }
  constructor() { super(); this.team = null; this.url = ''; this.busy = false; this.message = '' }
  async change(revoke) {
    this.busy = true
    this.message = ''
    try {
      const api = await loadManagedBundle()
      const result = await api.changeWorkspaceShare(this.team.id, state.managedSession?.csrfToken, revoke)
      this.url = result.path ? new URL(result.path, location.origin).href : ''
      this.message = revoke ? 'All public links for this workspace have been revoked.' : ''
    } catch (error) { this.message = error.message }
    finally { this.busy = false }
  }
  async copy() {
    try { await navigator.clipboard.writeText(this.url); this.message = 'Link copied.' }
    catch { this.message = 'Select the link and copy it.' }
  }
  render() {
    return html`<dialog @close=${this._onClose}>
      <header><h3>Share ${this.team?.name}</h3></header>
      <p class="nwd-intro">Anyone with this link can read this workspace’s published reports, comments, triage, and available source files without signing in. New published reports will also be included.</p>
      ${this.url ? html`<label>Public link<input class="nwd-input" readonly .value=${this.url} @focus=${event => event.target.select()}></label>` : nothing}
      ${this.message ? html`<p class="nwd-note" role="status">${this.message}</p>` : nothing}
      <footer class="nwd-actions">
        <button class="danger" ?disabled=${this.busy} @click=${() => this.change(true)}>Revoke links</button>
        <span class="nwd-spacer"></span>
        ${this.url ? html`<button @click=${() => this.copy()}>Copy link</button>` : html`<button class="primary" ?disabled=${this.busy} @click=${() => this.change(false)}>Create link</button>`}
        <button @click=${() => this._finish(null)}>Close</button>
      </footer>
    </dialog>`
  }
}
customElements.define('managed-share-dialog', ManagedShareDialog)
export function openManagedShareDialog(team) { return openAppDialog('managed-share-dialog', { team }) }
