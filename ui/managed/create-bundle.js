// Create a bundle: a connected repository, a revision of it (revision-select.js)
// and its directories at that revision, browsed for files to pick as entry
// points, built with Stasis.
import { LitElement, html, nothing, unsafeCSS } from 'lit'
import { ifDefined } from 'lit/directives/if-defined.js'
import { managedFetch } from '../../client/managed/request.js'
import { sourceFileIcon, sourceFolderIcon } from '../view/source-file-icon.js'
import { commitIcon } from '../view/revision-select.js'
import { defaultBundleConditions } from './bundle-conditions.js'
import '../view/repository-selector.js'
import '../view/revision-select.js'
import commonStyles from './styles/common.css'
import browserStyles from './styles/repository-browser.css'
import styles from './styles/create-bundle.css'

const MAX_CACHED_DIRECTORIES = 100

const BROWSE_ERRORS = {
  'github-status-403': 'GitHub denied this request. Check repository access and the GitHub App’s read permissions.',
  'github-unauthorized': 'GitHub authentication has expired or was revoked. Sign in again and check the repository App installation.',
  'github-unreachable': 'Could not connect to GitHub. Try again shortly.',
}

async function browseRepository(route, params, signal) {
  const response = await managedFetch(`/api/admin/repositories/${route}?${new URLSearchParams(params)}`, {
    credentials: 'same-origin', headers: { accept: 'application/json' }, signal,
  })
  if (response.ok) return response.json()
  const data = await response.json().catch(() => null)
  if (data?.error === 'github-rate-limited') {
    const seconds = Number(response.headers.get('retry-after'))
    const minutes = Math.ceil(seconds / 60)
    const wait = Number.isFinite(seconds) && seconds > 0 ? ` Try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.` : ' Try again after the limit resets.'
    throw new Error(`GitHub’s API rate limit has been reached.${wait}`)
  }
  throw new Error(BROWSE_ERRORS[data?.error] ?? (response.status === 404 ? 'This repository, revision, or directory is unavailable.'
    : response.status === 403 ? 'Repository access is required to browse files.' : 'Could not load repository files from GitHub. Try again.'))
}

// A directory's suggested entry points not yet selected, to select at once.
function entryPointSuggestions(paths, selected, apply, label, name, limited = false) {
  const pending = paths.filter(path => !selected.has(path))
  if (pending.length === 0 && !limited) return nothing
  return html`<aside class="package-suggestions" aria-label=${name}>
    <div><p>${label}</p>
      ${pending.length > 0 ? html`<ul>${pending.map(path => html`<li><code data-tooltip-truncated data-tooltip=${path}>${path}</code></li>`)}</ul>` : nothing}
      ${limited ? html`<p class="suggestions-note ui-hint">Suggestions are limited. Browse the source directories to select more files.</p>` : nothing}
    </div>${pending.length > 0 ? html`<button type="button" class="btn" @click=${() => apply(pending)}>Use suggestions</button>` : nothing}
  </aside>`
}

export class ManagedCreateBundle extends LitElement {
  static styles = [unsafeCSS(commonStyles), unsafeCSS(browserStyles), unsafeCSS(styles)]
  static properties = {
    installTooltips: { attribute: false }, initialRepoId: { attribute: false }, createBundle: { attribute: false },
    _repos: { state: true }, _loadingRepos: { state: true }, _reposError: { state: true },
    _repoId: { state: true }, _refs: { state: true }, _refKind: { state: true }, _refName: { state: true },
    _path: { state: true }, _entries: { state: true }, _commit: { state: true },
    _loadingRefs: { state: true }, _loading: { state: true }, _error: { state: true }, _refsError: { state: true }, _limited: { state: true },
    _building: { state: true }, _opening: { state: true }, _buildError: { state: true }, _selected: { state: true },
    _configEntryPoints: { state: true }, _packageEntryPoints: { state: true },
    _solidityEntryPoints: { state: true }, _soliditySuggestionsLimited: { state: true },
  }

  constructor() {
    super()
    Object.assign(this, { _repos: [], _loadingRepos: true, _reposError: '', initialRepoId: null, _repoId: null, _refs: { branches: [], tags: [] },
      _refKind: 'branch', _refName: '', _path: '', _entries: null, _commit: '', _loadingRefs: false, _loading: false, _error: '', _refsError: '',
      _limited: false, _building: false, _opening: false, _buildError: '', _selected: new Set() })
    // Resolved commits' directories, by repository, commit and path.
    this._directories = new Map()
    this._dismissedSuggestions = new Set()
    // The selected entries a directory read selected, which the user has not touched.
    this._suggested = new Set()
    this._bundleConditions = defaultBundleConditions()
    // Each entry a stasis.config.json lists -> its directory: the nearest
    // one's, at or above it, that lists it, as the build takes it.
    this._configs = new Map()
    this.showDirectory(null)
  }

  updated(changed) {
    if (changed.has('installTooltips')) this.installTooltips?.(this.renderRoot)
  }

  firstUpdated() {
    void this.loadRepositories()
  }

  disconnectedCallback() {
    this._buildRequest?.abort()
    this._opening = false
    this._dismissedSuggestions.clear()
    this._suggested.clear()
    this.showDirectory(null)
    clearTimeout(this._browseTimer)
    this._reposRequest?.abort()
    this._refsRequest?.abort()
    this._request?.abort()
    this._directories.clear()
    super.disconnectedCallback()
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

  // A directory's entry point suggestions, none while one loads (`data`
  // null): those its stasis.config.json lists, else the ones guessed.
  showDirectory(data) {
    this._configEntryPoints = data?.configEntryPoints ?? []
    this._packageEntryPoints = data?.packageEntryPoints ?? []
    this._solidityEntryPoints = data?.solidityEntryPoints ?? []
    this._soliditySuggestionsLimited = data?.soliditySuggestionsLimited ?? false
  }

  resetFiles() {
    this._buildError = ''
    clearTimeout(this._browseTimer)
    this._request?.abort()
    this._directories.clear()
    Object.assign(this, { _loading: false, _entries: null, _path: '', _commit: '', _error: '', _limited: false })
    this.showDirectory(null)
    this._selected = new Set()
    this._dismissedSuggestions.clear()
    this._suggested.clear()
    this._configs.clear()
  }

  async selectRepository(repoId) {
    this._refsRequest?.abort()
    this.resetFiles()
    Object.assign(this, { _repoId: repoId, _refs: { branches: [], tags: [] }, _refsError: '', _refKind: 'branch', _refName: '' })
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

  // A kind starts on the default branch, or on none to type.
  selectRevisionType(kind) {
    if (this._refKind === kind) return
    this.changeRevision(kind, kind === 'branch' ? this._refs.defaultBranch || '' : '')
    if (this._refName) void this.loadDirectory('')
  }

  // A name typed or picked browses at once where it names a listed branch or
  // tag, else after a pause.
  editRevision(name) {
    this.changeRevision(this._refKind, name)
    const ref = name.trim()
    if (!ref) return
    const choices = this._refKind === 'branch' ? this._refs.branches : this._refs.tags
    if (this._refKind !== 'commit' && (choices.includes(ref) || (this._refKind === 'branch' && ref === this._refs.defaultBranch))) void this.loadDirectory('')
    else this._browseTimer = setTimeout(() => { void this.loadDirectory('') }, 350)
  }

  // A revision picked (revision-select.js); Enter browses it now.
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
    Object.assign(this, { _path: path, _entries: null, _error: '', _limited: false })
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

  // A directory read selects the entry points it suggests, but those dismissed,
  // where they can be built with the ones selected. Those its stasis.config.json
  // lists come first: they take the place of entries selected for the user, but
  // never of ones the user picked.
  useDirectory(data, path) {
    this._path = path
    this._commit = data.commit
    this._entries = data.entries.toSorted((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name))
    this._limited = data.limited
    this.showDirectory(data)
    if (/^[a-f\d]{40}$/iu.test(data.commit)) {
      this._directories.set(JSON.stringify([this._repoId, data.commit, path]), { ...data, entries: this._entries })
      if (this._directories.size > MAX_CACHED_DIRECTORIES) this._directories.delete(this._directories.keys().next().value)
    }
    for (const entry of this._configEntryPoints) {
      const known = this._configs.get(entry)
      if (known === undefined || known.length < path.length) this._configs.set(entry, path)
    }
    const suggestions = [...this._configEntryPoints, ...this._packageEntryPoints, ...this._solidityEntryPoints]
      .filter(entry => !this._dismissedSuggestions.has(entry))
    const replace = this._configEntryPoints.length > 0 && this.configOf([...this._selected, ...suggestions]) === undefined
    const selected = new Set([...[...this._selected].filter(entry => !replace || !this._suggested.has(entry)), ...suggestions])
    if (this.configOf(selected) === undefined) return
    for (const entry of this._suggested) if (!selected.has(entry)) this._suggested.delete(entry)
    for (const entry of suggestions) if (!this._selected.has(entry)) this._suggested.add(entry)
    this._selected = selected
  }

  repository() {
    return this._repos.find(item => item.repoId === this._repoId)
  }

  // The directory of the stasis.config.json listing each of `paths`, null
  // where it lists none of them, undefined where it lists some, or they are
  // another's: those it lists are built with their options there, alone.
  configOf(paths = this._selected) {
    const directories = new Set([...paths].map(path => this._configs.get(path) ?? null))
    return directories.size > 1 ? undefined : directories.size === 0 ? null : [...directories][0]
  }

  toggleFile(path) {
    this._suggested.delete(path)
    const next = new Set(this._selected)
    if (next.has(path)) {
      next.delete(path)
      this._dismissedSuggestions.add(path)
    } else {
      next.add(path)
      this._dismissedSuggestions.delete(path)
    }
    this._selected = next
  }

  clearFiles() {
    for (const path of this._selected) this._dismissedSuggestions.add(path)
    this._selected = new Set()
    this._suggested.clear()
  }

  hasScriptEntryPoints() {
    return [...this._selected].some(path => /\.[cm]?[tj]sx?$/iu.test(path))
  }

  async buildBundle() {
    const config = this.configOf()
    if (this._building || this._opening || !this.createBundle || !this._commit || this._selected.size === 0 || config === undefined) return
    const request = new AbortController()
    this._buildRequest = request
    this._building = true
    this._buildError = ''
    try {
      // Entries stasis.config.json lists take its options, and no conditions.
      // A commit picked by its branch names it, which Stasis asks first of
      // whether the commit is the repository's own.
      const branch = this._refKind === 'branch' ? this._refName.trim() : ''
      const bundle = await this.createBundle({ repoId: this._repoId, commit: this._commit, ...(branch && { branch }),
        entries: [...this._selected], ...(config === null && { conditions: this._bundleConditions }) }, request.signal)
      if (!request.signal.aborted) {
        // Navigation replaces this form with the bundle as it opens it.
        this._opening = true
        this.dispatchEvent(new CustomEvent('bundle-created', { detail: bundle, bubbles: true, composed: true }))
      }
    } catch (error) {
      if (!request.signal.aborted) this._buildError = error.message
    } finally { this._building = false }
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
  // GitHub, and its entries, each directory opening it and each file a
  // checkbox selecting it.
  renderBrowser() {
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
                    : this._fileTile(entry))}</div>`}
        </div>
        ${this._limited ? html`<p class="message ui-hint">Showing GitHub’s first 1,000 entries in this directory.</p>` : nothing}
      </section>`
  }

  _fileTile(entry) {
    return html`<label class=${`file-tile ${this._selected.has(entry.path) ? 'selected' : ''} ${entry.type === 'file' ? '' : 'unsupported'}`} data-tooltip=${entry.type === 'file' ? nothing : `${entry.path} (${entry.type})`}><input type="checkbox" aria-label=${`Select ${entry.path} as an entry point`} .checked=${this._selected.has(entry.path)} ?disabled=${entry.type !== 'file'} @change=${() => this.toggleFile(entry.path)}>${sourceFileIcon(entry.name)}<span data-tooltip-truncated data-tooltip=${entry.type === 'file' ? entry.path : nothing}>${entry.name}</span></label>`
  }

  render() {
    const busy = this._building || this._opening
    const config = this.configOf()
    const select = paths => { this._selected = new Set([...this._selected, ...paths]) }
    return html`<p class="intro ui-hint">Choose a repository and revision, then select files to use as entry points.</p>
      <div ?inert=${busy}>
      ${this.renderSource()}
      ${this.renderBrowser()}
      ${entryPointSuggestions(this._configEntryPoints, this._selected, select, html`Entry points listed in <code>stasis.config.json</code>`, 'Configured entry points')}
      ${entryPointSuggestions(this._packageEntryPoints, this._selected, select, html`Entry points declared in <code>package.json</code>`, 'Suggested entry points')}
      ${entryPointSuggestions(this._solidityEntryPoints, this._selected, select, 'Suggested Solidity sources', 'Suggested Solidity sources', this._soliditySuggestionsLimited)}
      <section class="entry-points" aria-label="Selected entry points"><div class="selection"><div class="selection-head"><h2>Entry points <span aria-live="polite">${this._selected.size}</span></h2>${this._selected.size > 0 ? html`<button type="button" class="btn clear-selection" @click=${this.clearFiles}>Clear all</button>` : nothing}</div>
        ${this._selected.size > 0 ? html`<ul>${[...this._selected].map(path => html`<li>${sourceFileIcon(path)}<span data-tooltip-truncated data-tooltip=${path}>${path}</span><button type="button" aria-label=${`Remove ${path}`} @click=${() => this.toggleFile(path)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></li>`)}</ul>` : html`<p class="note ui-hint">Select files above. You can choose entry points from multiple directories.</p>`}
        ${config === undefined ? html`<p class="note error" role="alert">Entry points listed in a <code>stasis.config.json</code> are built with its options, alone. Select only those it lists, or only other files.</p>` : nothing}
        </div>
      </section>
      <bundle-conditions .showConditions=${this.hasScriptEntryPoints() && typeof config !== 'string'} @conditions-change=${event => { this._bundleConditions = event.detail }}><button type="button" slot="actions" class="btn primary" ?disabled=${busy || !this.createBundle || !this._commit || this._selected.size === 0 || config === undefined || this._loading || this._loadingRefs} @click=${this.buildBundle}>${this._opening ? 'Opening…' : this._building ? 'Creating…' : 'Create a bundle'}</button></bundle-conditions>
      </div>
      ${busy ? html`<p class="message" role="status">${this._opening ? 'Opening bundle…' : 'Building the selected entry points with Stasis…'}</p>` : nothing}
      ${this._buildError ? html`<p class="message error" role="alert">${this._buildError}</p>` : nothing}
    `
  }
}

customElements.define('managed-create-bundle', ManagedCreateBundle)
