import { LitElement, html, nothing, unsafeCSS } from 'lit'
import { ifDefined } from 'lit/directives/if-defined.js'
import { managedFetch } from '../../client/managed/request.js'
import { sourceFileIcon, sourceFolderIcon } from '../view/source-file-icon.js'
import '../view/repository-selector.js'
import commonStyles from './styles/common.css'
import styles from './styles/create-bundle.css'

async function browseRepository(route, params, signal) {
  const response = await managedFetch(`/api/admin/repositories/${route}?${new URLSearchParams(params)}`, {
    credentials: 'same-origin', headers: { accept: 'application/json' }, signal,
  })
  if (!response.ok) {
    if (response.status === 404) throw new Error('This repository, revision, or directory is unavailable.')
    if (response.status === 403) throw new Error('Repository access is required to browse files.')
    throw new Error('Could not load repository files from GitHub. Try again.')
  }
  return response.json()
}

export class ManagedCreateBundle extends LitElement {
  static styles = [unsafeCSS(commonStyles), unsafeCSS(styles)]
  static properties = {
    repos: { attribute: false }, initialRepoId: { attribute: false },
    _repoId: { state: true }, _refs: { state: true }, _refKind: { state: true }, _refName: { state: true },
    _path: { state: true }, _entries: { state: true }, _selected: { state: true }, _commit: { state: true },
    _loadingRefs: { state: true }, _loading: { state: true }, _error: { state: true }, _refsError: { state: true }, _limited: { state: true },
  }

  constructor() {
    super()
    this.repos = []
    this.initialRepoId = null
    this._repoId = null
    this._refs = { branches: [], tags: [] }
    this._refKind = 'branch'
    this._refName = ''
    this._path = ''
    this._entries = null
    this._selected = new Set()
    this._commit = ''
    this._loadingRefs = false
    this._loading = false
    this._error = ''
    this._refsError = ''
    this._limited = false
  }

  firstUpdated() {
    this.renderRoot.querySelector('repository-selector')?.shadowRoot?.querySelector('button')?.focus()
    if (this.repos.some(repo => repo.repoId === this.initialRepoId)) void this.selectRepository(this.initialRepoId)
  }

  disconnectedCallback() {
    this._refsRequest?.abort()
    this._request?.abort()
    super.disconnectedCallback()
  }

  resetFiles() {
    this._request?.abort()
    this._loading = false
    this._entries = null
    this._path = ''
    this._commit = ''
    this._selected = new Set()
    this._error = ''
    this._limited = false
  }

  async selectRepository(repoId) {
    this._refsRequest?.abort()
    this.resetFiles()
    this._repoId = repoId
    this._refs = { branches: [], tags: [] }
    this._refsError = ''
    this._refKind = 'branch'
    this._refName = ''
    if (repoId == null) { this._loadingRefs = false; return }
    const request = new AbortController()
    this._refsRequest = request
    this._loadingRefs = true
    try {
      const refs = await browseRepository('refs', { repoId }, request.signal)
      if (request.signal.aborted) return
      this._refs = refs
      this._refName = refs.defaultBranch || refs.branches[0] || ''
      if (this._refName) void this.loadDirectory('')
    } catch {
      if (!request.signal.aborted) this._refsError = 'Could not load branch and tag suggestions. Enter a revision to browse, or retry.'
    } finally {
      if (!request.signal.aborted) this._loadingRefs = false
    }
  }

  changeRevision(kind, name) {
    this.resetFiles()
    this._refKind = kind
    this._refName = name
  }

  async loadDirectory(path, fresh = false) {
    if (this._repoId == null || !this._refName.trim()) return
    if (fresh) this.resetFiles()
    this._request?.abort()
    const request = new AbortController()
    this._request = request
    this._path = path
    this._entries = null
    this._error = ''
    this._limited = false
    const name = this._refName.trim()
    if (this._refKind === 'commit' && !/^[a-f\d]{7,40}$/iu.test(name)) {
      this._error = 'Enter a commit SHA with 7 to 40 hexadecimal characters.'
      return
    }
    const ref = this._commit || (this._refKind === 'commit' ? name : `${this._refKind === 'branch' ? 'heads' : 'tags'}/${name}`)
    this._loading = true
    try {
      const data = await browseRepository('contents', { repoId: this._repoId, ref, path }, request.signal)
      if (request.signal.aborted) return
      this._commit = data.commit
      this._entries = data.entries.toSorted((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name))
      this._limited = data.limited
    } catch (error) {
      if (!request.signal.aborted) this._error = error.message
    } finally {
      if (!request.signal.aborted) this._loading = false
    }
  }

  toggleFile(path) {
    const next = new Set(this._selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    this._selected = next
  }

  render() {
    const repo = this.repos.find(item => item.repoId === this._repoId)
    const parts = this._path.split('/').filter(Boolean)
    const choices = this._refKind === 'branch' ? this._refs.branches : this._refs.tags
    const revisionLabel = this._refKind === 'commit' ? 'Commit SHA' : this._refKind === 'tag' ? 'Tag' : 'Branch'
    return html`<p class="intro">Choose a repository and revision, then select files to use as entry points.</p>
      <div class="source-fields">
        <div class="field"><span>Repository</span><repository-selector label="Repository" .options=${this.repos.map(item => ({ value: item.repoId, label: item.fullName }))} .value=${this._repoId} @repository-change=${event => this.selectRepository(event.detail.value)}></repository-selector></div>
        <form class="revision" @submit=${event => { event.preventDefault(); void this.loadDirectory('', true) }}>
          <label class="field"><span>Revision</span><select ?disabled=${!repo || this._loadingRefs} .value=${this._refKind} @change=${event => this.changeRevision(event.target.value, event.target.value === 'branch' ? this._refs.defaultBranch || '' : '')}><option value="branch">Branch</option><option value="tag">Tag</option><option value="commit">Commit</option></select></label>
          <label class="field revision-name"><span>${revisionLabel}</span><input type="text" aria-label=${revisionLabel} list=${ifDefined(this._refKind === 'commit' ? undefined : 'bundle-revisions')} placeholder=${this._refKind === 'commit' ? 'Commit SHA…' : `Choose or enter a ${this._refKind}…`} .value=${this._refName} ?disabled=${!repo || this._loadingRefs} @input=${event => this.changeRevision(this._refKind, event.target.value)}></label>
          <datalist id="bundle-revisions">${(choices ?? []).map(name => html`<option value=${name}></option>`)}</datalist>
          <button type="submit" class="browse" ?disabled=${!repo || this._loadingRefs || this._loading || !this._refName.trim()}>Browse</button>
        </form>
      </div>
      ${this._refsError ? html`<p class="message" role="status">${this._refsError} <button type="button" class="text-action" @click=${() => this.selectRepository(this._repoId)}>Retry</button></p>` : nothing}
      <section class="browser" aria-label="Repository files" aria-busy=${this._loading || this._loadingRefs}>
        <div class="browser-head"><nav class="breadcrumbs" aria-label="Repository directory"><button type="button" ?disabled=${!this._commit} aria-current=${ifDefined(this._path ? undefined : 'location')} @click=${() => this.loadDirectory('')}>${repo?.fullName ?? 'Repository'}</button>${parts.map((part, i) => html`<span aria-hidden="true">/</span><button type="button" aria-current=${ifDefined(i === parts.length - 1 ? 'location' : undefined)} @click=${() => this.loadDirectory(parts.slice(0, i + 1).join('/'))}>${part}</button>`)}</nav>${this._commit ? html`<code title=${this._commit}>${this._commit.slice(0, 7)}</code>` : nothing}</div>
        <div class="file-browser">
          ${this._loading || this._loadingRefs ? html`<p class="empty" role="status">${this._loadingRefs ? 'Loading revisions…' : 'Loading files…'}</p>`
            : this._error ? html`<p class="empty error" role="alert">${this._error} <button type="button" class="text-action" @click=${() => this.loadDirectory(this._path)}>Retry</button></p>`
              : this._entries == null ? html`<p class="empty">${repo ? 'Choose a revision and click Browse.' : this.repos.length > 0 ? 'Select a repository to browse its files.' : 'No connected repositories available.'}</p>`
                : this._entries.length === 0 ? html`<p class="empty">This directory is empty.</p>`
                  : html`<div class="file-grid">${this._entries.map(entry => entry.type === 'dir'
                    ? html`<button type="button" class="file-tile directory" title=${entry.path} @click=${() => this.loadDirectory(entry.path)}>${sourceFolderIcon}<span>${entry.name}</span><span class="arrow" aria-hidden="true">›</span></button>`
                    : html`<label class=${`file-tile ${this._selected.has(entry.path) ? 'selected' : ''} ${entry.type === 'file' ? '' : 'unsupported'}`} title=${entry.type === 'file' ? entry.path : `${entry.path} (${entry.type})`}><input type="checkbox" aria-label=${`Select ${entry.path} as an entry point`} .checked=${this._selected.has(entry.path)} ?disabled=${entry.type !== 'file'} @change=${() => this.toggleFile(entry.path)}>${sourceFileIcon(entry.name)}<span>${entry.name}</span></label>`)}</div>`}
        </div>
        ${this._limited ? html`<p class="message">Showing GitHub’s first 1,000 entries in this directory.</p>` : nothing}
      </section>
      <section class="entry-points" aria-label="Selected entry points"><div class="selection-head"><h2>Entry points <span aria-live="polite">${this._selected.size}</span></h2>${this._selected.size > 0 ? html`<button type="button" class="text-action" @click=${() => { this._selected = new Set() }}>Clear all</button>` : nothing}</div>
        ${this._selected.size > 0 ? html`<ul>${[...this._selected].map(path => html`<li>${sourceFileIcon(path)}<span title=${path}>${path}</span><button type="button" aria-label=${`Remove ${path}`} @click=${() => this.toggleFile(path)}>×</button></li>`)}</ul>` : html`<p class="note">Select files above. You can choose entry points from multiple directories.</p>`}
      </section>
      <footer class="create-actions"><span class="note">Bundle creation is not available yet.</span><span class="spacer"></span><button type="button" class="btn" @click=${() => this.dispatchEvent(new CustomEvent('cancel'))}>Cancel</button><button type="button" class="btn primary" disabled>Create a bundle</button></footer>
    `
  }
}

customElements.define('managed-create-bundle', ManagedCreateBundle)
