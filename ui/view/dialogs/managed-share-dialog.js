import { html, nothing, unsafeCSS } from 'lit'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { changeWorkspaceShare, listWorkspaceShares } from '../../../client/managed/session.js'
import { managedAppState } from '../../managed/state.js'
import shareStyles from './managed-share-dialog.css'

class ManagedShareDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(shareStyles)]
  static properties = { team: { attribute: false }, session: { attribute: false }, initialId: { attribute: false }, selectedId: { state: true },
    links: { state: true }, dependencies: { state: true }, security: { state: true }, busy: { state: true }, message: { state: true } }
  constructor() {
    super(); this.team = null; this.initialId = ''; this.selectedId = ''; this.links = []
    this.dependencies = false; this.security = false; this.busy = true; this.message = ''; this.urls = new Map()
  }
  beforeOpen() { void this.load(this.initialId) }
  select(id) {
    const link = this.links.find(item => item.id === id)
    this.selectedId = link?.id ?? ''
    this.dependencies = link?.permissions.dependencies === true
    this.security = link?.permissions.security === true
    this.message = ''
  }
  async load(id = this.selectedId) {
    this.busy = true
    try {
      const links = await listWorkspaceShares(this.team.id)
      if (this._settled) return
      this.links = links
      this.select(id)
      return true
    } catch (error) { this.message = error.message; return false }
    finally { this.busy = false }
  }
  async change(revoke = false, all = false) {
    if (this.busy) return
    this.busy = true
    this.message = ''
    try {
      const result = await changeWorkspaceShare(this.team.id, this.session?.csrfToken, {
        id: all ? undefined : this.selectedId || undefined, revoke, dependencies: this.dependencies, security: this.security,
      })
      managedAppState.invalidate(['links', 'history'])
      if (this._settled) return
      if (result.path) {
        this.urls.set(result.id, new URL(result.path, location.origin).href)
        this.links = [{ id: result.id, createdAt: Date.now(), createdBy: this.session?.login ?? '',
          permissions: { dependencies: this.dependencies, security: this.security } }, ...this.links]
        this.selectedId = result.id
      }
      if (revoke) { if (all) this.urls.clear(); else this.urls.delete(this.selectedId) }
      if (await this.load(revoke ? '' : result.id ?? this.selectedId)) {
        this.message = revoke ? all ? 'All public links revoked.' : 'Link revoked.' : result.path ? 'Link created.' : 'Permissions saved. The link URL is unchanged.'
      }
    } catch (error) { this.message = error.message }
    finally { this.busy = false }
  }
  async copy() {
    try { await navigator.clipboard.writeText(this.urls.get(this.selectedId)); this.message = 'Link copied.' }
    catch { this.message = 'Select the link and copy it.' }
  }
  render() {
    const url = this.urls.get(this.selectedId)
    return html`<dialog @close=${this._onClose}>
      <header><h3>Share ${this.team?.name}</h3></header>
      <p class="nwd-intro">Anyone with this link can read this workspace’s published reports, comments, triage, and available source files without signing in.<br>New published reports will also be included.</p>
      <label class="share-field">Public links
        <select class="nwd-input" ?disabled=${this.busy} @change=${event => this.select(event.target.value)}>
          <option value="" ?selected=${!this.selectedId}>Create a new link</option>
          ${this.links.map(link => html`<option value=${link.id} ?selected=${this.selectedId === link.id}>${new Date(link.createdAt).toLocaleString()} · ${link.createdBy} · ${link.id.slice(0, 8)}</option>`)}
        </select>
      </label>
      <fieldset ?disabled=${this.busy}>
        <legend>Include in this link</legend>
        <label><input type="checkbox" .checked=${this.security} @change=${event => { this.security = event.target.checked }}> Security findings and advisories</label>
        <label><input type="checkbox" .checked=${this.dependencies} @change=${event => { this.dependencies = event.target.checked }}> Findings in dependencies</label>
      </fieldset>
      <p class="nwd-note">Both options are off for new links.<br>Existing links keep their URL when permissions change.</p>
      ${url ? html`<label class="share-field">Public link<input class="nwd-input" readonly .value=${url} @focus=${event => event.target.select()}></label>` : nothing}
      ${this.message ? html`<p class="nwd-note" role="status">${this.message}</p>` : nothing}
      <footer class="nwd-actions">
        ${this.selectedId ? html`<button class="danger" ?disabled=${this.busy} @click=${() => this.change(true)}>Revoke link</button>` : nothing}
        <span class="nwd-spacer"></span>
        ${url ? html`<button @click=${() => this.copy()}>Copy link</button>` : nothing}
        <button class="primary" ?disabled=${this.busy} @click=${() => this.change()}>${this.selectedId ? 'Save changes' : 'Create public link'}</button>
        <button @click=${() => this._finish(null)}>Close</button>
      </footer>
      ${this.links.length > 0 ? html`<button class="revoke-all" ?disabled=${this.busy} @click=${() => this.change(true, true)}>Revoke all links for this workspace</button>` : nothing}
    </dialog>`
  }
}
customElements.define('managed-share-dialog', ManagedShareDialog)
export function openManagedShareDialog(team, initialId = '', session = null) { return openAppDialog('managed-share-dialog', { team, initialId, session }) }
