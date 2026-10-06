import { html, nothing, unsafeCSS } from 'lit'
import { managedFetch } from '../../client/managed/request.js'
import { ManagedPage, loadingRows } from './page.js'
import commonStyles from './styles/common.css'
import aliasStyles from './styles/repository-aliases.css'
import '../view/repository-selector.js'

const path = '/api/admin/repositories/aliases'
async function request(suffix = '', options = {}) {
  const response = await managedFetch(`${path}${suffix}`, { credentials: 'same-origin', ...options })
  const body = await response.json()
  if (!response.ok) {
    const messages = {
      'alias-exists': 'An alias already exists for this old repository and path. Edit that row instead.',
      'bad-old-repo': 'Enter the old repository as owner/name or a GitHub URL.',
      'bad-directory': 'Enter repository directories without parent segments, backslashes, or surrounding whitespace.',
      'bad-repo': 'Choose a connected repository.',
      'no-alias': 'This alias was removed. Refresh the list and try again.',
    }
    throw new Error(messages[body?.error] ?? `HTTP ${response.status}`)
  }
  return body
}

class ManagedRepositoryAliases extends ManagedPage {
  static properties = { repositories: { attribute: false }, _data: { state: true }, _edit: { state: true }, _error: { state: true }, _busy: { state: true } }
  static styles = [unsafeCSS(commonStyles), unsafeCSS(aliasStyles)]
  constructor() { super(); this._data = null; this._edit = null; this._error = null; this._busy = false }
  connectedCallback() { super.connectedCallback(); void this._load() }
  updated(changed) {
    if (changed.has('repositories') && changed.get('repositories') !== undefined) {
      this.appState.invalidate(['repository-aliases'])
      void this._load()
    }
  }
  async _load() {
    this._error = null
    await this._loadCollection('repository-aliases', 'repository aliases', signal => request('', { signal }), data => { this._data = data })
  }
  _start(alias = null) {
    this._error = null
    this._edit = alias ? { ...alias } : { id: null, oldRepo: '', oldPath: '', repoId: null, newPath: '' }
  }
  async _mutate(method, id, body) {
    if (this._busy || !this._csrf || this._role !== 'admin') return
    this._busy = true; this._error = null
    try {
      await this.appState.mutate(() => request(id ? `/${encodeURIComponent(id)}` : '', {
        method, headers: { 'content-type': 'application/json', 'x-csrf-token': this._csrf },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }), ['repository-aliases', 'workspace-import'])
      this._edit = null
      await this._load()
    } catch (err) { this._error = String(err?.message ?? err) }
    finally { this._busy = false }
  }
  _save() {
    const { id, ...alias } = this._edit
    return this._mutate(id ? 'PATCH' : 'POST', id, alias)
  }
  _field(key, label, placeholder) {
    return html`<td><input type="text" aria-label=${label} placeholder=${placeholder} .value=${this._edit[key]} ?disabled=${this._busy}
      @input=${event => { this._edit = { ...this._edit, [key]: event.target.value } }}></td>`
  }
  _editor() {
    const options = (this._data?.repos ?? []).filter(repo => repo.active !== false).map(repo => ({ value: repo.repoId, label: repo.fullName }))
    return html`<tr>${this._field('oldRepo', 'Old repository', 'owner/repository')}${this._field('oldPath', 'Old path', 'Repository root')}
      <td><repository-selector label="New repository" placeholder="Choose repository…" .options=${options} .value=${this._edit.repoId} ?disabled=${this._busy}
        @repository-change=${event => { this._edit = { ...this._edit, repoId: event.detail.value } }}></repository-selector></td>
      ${this._field('newPath', 'New path', 'Repository root')}
      <td class="actions"><button type="button" class="btn" ?disabled=${this._busy || !this._edit.oldRepo.trim() || this._edit.repoId == null} @click=${() => void this._save()}>${this._busy ? 'Saving…' : 'Save'}</button>
        <button type="button" class="btn" ?disabled=${this._busy} @click=${() => { this._edit = null; this._error = null }}>Cancel</button></td></tr>`
  }
  render() {
    const aliases = this._data?.aliases ?? [], repos = this._data?.repos ?? []
    return html`<section aria-labelledby="aliases-heading"><div class="heading"><h2 id="aliases-heading">Aliases</h2>
      <button type="button" class="btn" ?disabled=${this._busy || this._edit != null || !this._data} @click=${() => this._start()}>Add alias</button></div>
      <p class="intro">Map repository locations when importing new reports and bundles.</p>
      ${this._error ? html`<p class="msg error" role="alert">${this._error}</p>` : nothing}
      <div aria-busy=${this._loading}>${this._data === null ? (this._error ? html`<button type="button" class="btn" @click=${() => void this._load()}>Try again</button>` : loadingRows('Loading repository aliases…')) : html`
        <div class="alias-table"><table><thead><tr><th>Old repository</th><th>Old path</th><th>New repository</th><th>New path</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
          ${aliases.map(alias => this._edit?.id === alias.id ? this._editor() : html`<tr><td>${alias.oldRepo}</td><td class="mono">${alias.oldPath || '/'}</td>
            <td>${repos.find(repo => repo.repoId === alias.repoId)?.fullName ?? 'Removed repository'}${repos.find(repo => repo.repoId === alias.repoId)?.active === false ? ' (inactive)' : ''}</td><td class="mono">${alias.newPath || '/'}</td><td class="actions">
              <button type="button" class="btn" ?disabled=${this._busy || this._edit != null} @click=${() => this._start(alias)}>Edit</button>
              <button type="button" class="btn" ?disabled=${this._busy || this._edit != null} @click=${() => void this._mutate('DELETE', alias.id)}>Delete</button></td></tr>`)}
          ${this._edit?.id === null ? this._editor() : nothing}
          ${aliases.length === 0 && !this._edit ? html`<tr><td colspan="5" class="empty">No repository aliases yet.</td></tr>` : nothing}
        </tbody></table></div>`}</div>
    </section>`
  }
}
customElements.define('managed-repository-aliases', ManagedRepositoryAliases)
