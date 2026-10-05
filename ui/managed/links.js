import { html, nothing, unsafeCSS } from 'lit'
import { managedFetch } from '../../client/managed/request.js'
import { ManagedPage, loadingRows } from './page.js'
import { adminNavigation } from './navigation.js'
import commonStyles from './styles/common.css'
import linksStyles from './styles/links.css'

async function fetchLinks(signal) {
  const response = await managedFetch('/api/admin/links', { signal, credentials: 'same-origin' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json()
  if (!Array.isArray(body?.shares)) throw new Error('No public links returned')
  return body
}

class ManagedAdminLinks extends ManagedPage {
  static properties = { _data: { state: true }, _error: { state: true } }
  static styles = [unsafeCSS(commonStyles), unsafeCSS(linksStyles)]
  constructor() { super(); this._data = null; this._error = null }
  connectedCallback() { super.connectedCallback(); void this._load() }
  async _load() {
    this._error = null
    await this._loadCollection('links', 'public links', fetchLinks, data => { this._data = data })
  }
  async _edit(link) {
    const { openManagedShareDialog } = await import('../view/dialogs/managed-share-dialog.js')
    await openManagedShareDialog({ id: link.teamId, name: link.teamName }, link.id, this.session)
    if (this.isConnected) await this._load()
  }
  _groups() {
    const groups = new Map()
    for (const link of this._data?.shares ?? []) {
      if (!groups.has(link.teamId)) groups.set(link.teamId, { name: link.teamName, links: [] })
      groups.get(link.teamId).links.push(link)
    }
    return [...groups.values()]
  }
  _body() {
    if (this._data == null) return this._error ? html`<p class="msg error">Couldn't load public links: ${this._error}</p>` : loadingRows('Loading public links…')
    if (this._data.shares.length === 0) return html`<p class="msg">No public links. Create one with the share button beside a workspace in the sidebar.</p>`
    return this._groups().map(group => html`<section class="link-team" aria-label=${group.name}>
      <h2>${group.name}</h2>
      <div class="link-table"><table>
        <thead><tr><th>Link</th><th>Created by</th><th>Created</th><th>Security</th><th>Dependencies</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${group.links.map(link => html`<tr>
          <td><span data-tooltip=${link.id}>${link.id.slice(0, 8)}</span></td>
          <td>${link.createdBy}</td><td>${new Date(link.createdAt).toLocaleString()}</td>
          <td>${link.permissions.security ? 'On' : 'Off'}</td><td>${link.permissions.dependencies ? 'On' : 'Off'}</td>
          <td><button class="btn" aria-label=${`Edit public link ${link.id.slice(0, 8)} for ${group.name}`} @click=${() => this._edit(link)}>Edit</button></td>
        </tr>`)}</tbody>
      </table></div>
    </section>`)
  }
  render() {
    return html`<div class="wrap">${adminNavigation('manage-links', this._role, this.allowShare)}
      <h1 class="sr-only">Public links</h1>
      <div class="page-intro"><p class="intro">Manage public links and the findings each link can show.</p><span class="result-count">${this._data?.shares.length ?? '…'} links</span></div>
      ${this._loading && this._data ? html`<span class="sr-only" role="status">Refreshing public links…</span>` : nothing}
      <div aria-busy=${this._loading}>${this._body()}</div>
    </div>`
  }
}
customElements.define('managed-admin-links', ManagedAdminLinks)
