// A connected repository, a revision of it (revision-select.js) and a
// directory at that revision, picked and browsed: what Create a bundle builds
// from (create-bundle.js), which extends RepositoryBrowser with what it does
// with the files it browses.
import { LitElement, html, nothing, unsafeCSS } from 'lit'
import { ifDefined } from 'lit/directives/if-defined.js'
import { managedFetch } from '../../client/managed/request.js'
import { sourceFolderIcon } from '../view/source-file-icon.js'
import { commitIcon } from '../view/revision-select.js'
import '../view/repository-selector.js'
import '../view/revision-select.js'
import commonStyles from './styles/common.css'
import styles from './styles/repository-browser.css'

const MAX_CACHED_DIRECTORIES = 100

export async function browseRepository(route, params, signal) {
  const response = await managedFetch(`/api/admin/repositories/${route}?${new URLSearchParams(params)}`, {
    credentials: 'same-origin', headers: { accept: 'application/json' }, signal,
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    if (data?.error === 'github-rate-limited') {
      const seconds = Number(response.headers.get('retry-after'))
      const minutes = Math.ceil(seconds / 60)
      const wait = Number.isFinite(seconds) && seconds > 0 ? ` Try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.` : ' Try again after the limit resets.'
      throw new Error(`GitHub’s API rate limit has been reached.${wait}`)
    }
    if (data?.error === 'github-status-403') throw new Error('GitHub denied this request. Check repository access and the GitHub App’s read permissions.')
    if (data?.error === 'github-unauthorized') throw new Error('GitHub authentication has expired or was revoked. Sign in again and check the repository App installation.')
    if (data?.error === 'github-unreachable') throw new Error('Could not connect to GitHub. Try again shortly.')
    if (response.status === 404) throw new Error('This repository, revision, or directory is unavailable.')
    if (response.status === 403) throw new Error('Repository access is required to browse files.')
    throw new Error('Could not load repository files from GitHub. Try again.')
  }
  return response.json()
}

export class RepositoryBrowser extends LitElement {
  static styles = [unsafeCSS(commonStyles), unsafeCSS(styles)]
  static properties = {
    installTooltips: { attribute: false },
    initialRepoId: { attribute: false }, _repos: { state: true }, _loadingRepos: { state: true }, _reposError: { state: true },
    _repoId: { state: true }, _refs: { state: true }, _refKind: { state: true }, _refName: { state: true },
    _path: { state: true }, _entries: { state: true }, _commit: { state: true },
    _loadingRefs: { state: true }, _loading: { state: true }, _error: { state: true }, _refsError: { state: true }, _limited: { state: true },
  }

  constructor() {
    super()
    this._repos = []
    this._loadingRepos = true
    this._reposError = ''
    this.initialRepoId = null
    this._repoId = null
    this._refs = { branches: [], tags: [] }
    this._refKind = 'branch'
    this._refName = ''
    this._path = ''
    this._entries = null
    this._commit = ''
    this._directories = new Map()
    this._loadingRefs = false
    this._loading = false
    this._error = ''
    this._refsError = ''
    this._limited = false
  }

  updated(changed) {
    if (changed.has('installTooltips')) this.installTooltips?.(this.renderRoot)
  }

  firstUpdated() {
    void this.loadRepositories()
  }

  async loadRepositories() {
    this._reposRequest?.abort()
    void this.selectRepository(null)
    this._repos = []
    this._reposError = ''
    this._loadingRepos = true
    const request = new AbortController()
    this._reposRequest = request
    try {
      const data = await browseRepository('browsable', {}, request.signal)
      if (request.signal.aborted) return
      this._repos = data.repos
      if (this._repos.some(repo => repo.repoId === this.initialRepoId)) void this.selectRepository(this.initialRepoId)
    } catch {
      if (!request.signal.aborted) this._reposError = 'Could not load repositories. Try again.'
    } finally {
      if (!request.signal.aborted) this._loadingRepos = false
    }
  }

  disconnectedCallback() {
    clearTimeout(this._browseTimer)
    this._reposRequest?.abort()
    this._refsRequest?.abort()
    this._request?.abort()
    this._directories.clear()
    super.disconnectedCallback()
  }

  // What a subclass shows of a directory beside its entries (`data`, as the
  // contents route answers), none while one loads (`data` null).
  showDirectory(_data) {}

  resetFiles() {
    clearTimeout(this._browseTimer)
    this._request?.abort()
    this._directories.clear()
    this._loading = false
    this._entries = null
    this._path = ''
    this._commit = ''
    this.showDirectory(null)
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
      const { defaultContents, ...refs } = await browseRepository('refs', { repoId, withDefault: 'true' }, request.signal)
      if (request.signal.aborted) return
      this._refs = refs
      this._refName = refs.defaultBranch || refs.branches[0] || ''
      if (defaultContents) this.useDirectory(defaultContents, '')
      else if (this._refName) void this.loadDirectory('')
    } catch (error) {
      if (!request.signal.aborted) this._refsError = error.message
    } finally {
      if (!request.signal.aborted) this._loadingRefs = false
    }
  }

  changeRevision(kind, name) {
    this._refsRequest?.abort()
    this._loadingRefs = false
    this.resetFiles()
    this._refKind = kind
    this._refName = name
  }

  selectRevisionType(kind) {
    if (this._refKind === kind) return
    this.changeRevision(kind, kind === 'branch' ? this._refs.defaultBranch || '' : '')
    if (this._refName) void this.loadDirectory('')
  }

  editRevision(name) {
    this.changeRevision(this._refKind, name)
    const ref = name.trim()
    if (!ref) return
    const choices = this._refKind === 'branch' ? this._refs.branches : this._refs.tags
    if (this._refKind !== 'commit' && (choices.includes(ref) || (this._refKind === 'branch' && ref === this._refs.defaultBranch))) {
      void this.loadDirectory('')
    } else {
      this._browseTimer = setTimeout(() => { void this.loadDirectory('') }, 350)
    }
  }

  // A revision picked (revision-select.js): a kind starts on the default
  // branch, or on none to type; a name typed or picked browses, at once where
  // it names a listed branch or tag, else after a pause; Enter browses it now.
  revisionChanged({ detail: { how, kind, name } }) {
    if (how === 'kind') this.selectRevisionType(kind)
    else if (how === 'submit') void this.loadDirectory('', true)
    else this.editRevision(name)
  }

  async loadDirectory(path, fresh = false) {
    clearTimeout(this._browseTimer)
    if (this._repoId == null || !this._refName.trim()) return
    if (fresh) this.resetFiles()
    this._request?.abort()
    const request = new AbortController()
    this._request = request
    this._path = path
    this._entries = null
    this._error = ''
    this._limited = false
    this.showDirectory(null)
    this._loading = false
    const name = this._refName.trim()
    if (this._refKind === 'commit' && !/^[a-f\d]{7,40}$/iu.test(name)) {
      this._error = 'Enter a commit SHA with 7 to 40 hexadecimal characters.'
      return
    }
    const ref = this._commit || (this._refKind === 'commit' ? name : `${this._refKind === 'branch' ? 'heads' : 'tags'}/${name}`)
    // Only a resolved commit is immutable. Never reuse branch/tag lookups, and
    // keep directory data local to this view's repository/revision selection.
    const key = JSON.stringify([this._repoId, this._commit, path])
    const cached = this._commit && this._directories.get(key)
    if (cached) {
      this._directories.delete(key)
      this._directories.set(key, cached)
      this._entries = cached.entries
      this._limited = cached.limited
      this.showDirectory(cached)
      return
    }
    this._loading = true
    try {
      const data = await browseRepository('contents', { repoId: this._repoId, ref, path }, request.signal)
      if (request.signal.aborted) return
      this.useDirectory(data, path)
    } catch (error) {
      if (!request.signal.aborted) {
        this._directories.clear()
        this._error = error.message
      }
    } finally {
      if (!request.signal.aborted) this._loading = false
    }
  }

  useDirectory(data, path) {
    this._path = path
    this._commit = data.commit
    this._entries = data.entries.toSorted((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name))
    this._limited = data.limited
    this.showDirectory(data)
    if (/^[a-f\d]{40}$/iu.test(data.commit)) {
      const cacheKey = JSON.stringify([this._repoId, data.commit, path])
      this._directories.set(cacheKey, { ...data, entries: this._entries })
      if (this._directories.size > MAX_CACHED_DIRECTORIES) this._directories.delete(this._directories.keys().next().value)
    }
  }

  // The repository picked, of those listed.
  repository() {
    return this._repos.find(item => item.repoId === this._repoId)
  }

  // The repository and revision fields, and why either failed to load.
  renderSource() {
    const repo = this.repository()
    return html`<div class="source-fields">
        <div class="field"><span>Repository</span><repository-selector label="Repository" ?disabled=${this._loadingRepos} .options=${this._repos.map(item => ({ value: item.repoId, label: item.fullName }))} .value=${this._repoId} @repository-change=${event => this.selectRepository(event.detail.value)}></repository-selector></div>
        <revision-select .refs=${this._refs} .kind=${this._refKind} .name=${this._refName} ?disabled=${!repo || this._loadingRefs}
          .installTooltips=${this.installTooltips} @revision-change=${this.revisionChanged}></revision-select>
      </div>
      ${this._reposError ? html`<p class="message" role="alert">${this._reposError} <button type="button" class="text-action" @click=${() => this.loadRepositories()}>Retry</button></p>` : nothing}
      ${this._refsError ? html`<p class="message" role="status">${this._refsError} <button type="button" class="text-action" @click=${() => this.selectRepository(this._repoId)}>Retry</button></p>` : nothing}`
  }

  // The directory browsed: its path to step back along, its commit's tree on
  // GitHub, and its entries, each directory opening it and each other entry
  // as `file` renders it.
  renderBrowser(file) {
    const repo = this.repository()
    const parts = this._path.split('/').filter(Boolean)
    const treeUrl = repo && this._commit ? `https://github.com/${[...repo.fullName.split('/'), 'tree', this._commit, ...parts].map(encodeURIComponent).join('/')}` : null
    return html`<section class="browser" aria-label="Repository files" aria-busy=${this._loadingRepos || this._loading || this._loadingRefs}>
        <div class="browser-head"><nav class="breadcrumbs" aria-label="Repository directory"><button type="button" ?disabled=${!this._commit} aria-current=${ifDefined(this._path ? undefined : 'location')} @click=${() => this.loadDirectory('')}>${repo?.fullName ?? 'Repository'}</button>${parts.map((part, i) => html`<span aria-hidden="true">/</span><button type="button" aria-current=${ifDefined(i === parts.length - 1 ? 'location' : undefined)} @click=${() => this.loadDirectory(parts.slice(0, i + 1).join('/'))}>${part}</button>`)}</nav>${treeUrl ? html`<a class="commit-link" href=${treeUrl} target="_blank" rel="noopener noreferrer" data-tooltip=${this._commit} data-tooltip-icon="commit" aria-label=${`View directory at commit ${this._commit.slice(0, 7)} on GitHub`}>${commitIcon}<code>${this._commit.slice(0, 7)}</code></a>` : nothing}</div>
        <div class="file-browser">
          ${this._loadingRepos || this._loading || this._loadingRefs ? html`<p class="empty" role="status">${this._loadingRepos ? 'Loading repositories…' : this._loadingRefs ? 'Loading revisions…' : 'Loading files…'}</p>`
            : this._error ? html`<p class="empty error" role="alert">${this._error} <button type="button" class="text-action" @click=${() => this.loadDirectory(this._path)}>Retry</button></p>`
              : this._entries == null ? html`<p class="empty">${repo ? 'Choose a revision to browse its files.' : this._repos.length > 0 ? 'Select a repository to browse its files.' : 'No accessible repositories available.'}</p>`
                : this._entries.length === 0 ? html`<p class="empty">This directory is empty.</p>`
                  : html`<div class="file-grid">${this._entries.map(entry => entry.type === 'dir'
                    ? html`<button type="button" class="file-tile directory" @click=${() => this.loadDirectory(entry.path)}>${sourceFolderIcon}<span data-tooltip-truncated data-tooltip=${entry.path}>${entry.name}</span><span class="arrow" aria-hidden="true">›</span></button>`
                    : file(entry))}</div>`}
        </div>
        ${this._limited ? html`<p class="message ui-hint">Showing GitHub’s first 1,000 entries in this directory.</p>` : nothing}
      </section>`
  }
}
