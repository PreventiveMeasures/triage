import { LitElement, html, nothing, unsafeCSS } from 'lit'
import { ifDefined } from 'lit/directives/if-defined.js'
import { managedFetch } from '../../client/managed/request.js'
import { sourceFileIcon, sourceFolderIcon } from '../view/source-file-icon.js'
import '../view/repository-selector.js'
import commonStyles from './styles/common.css'
import styles from './styles/create-bundle.css'
import { packageEntryPointSuggestions, solidityEntryPointSuggestions } from './package-entry-points.js'
import { defaultBundleConditions } from './bundle-conditions.js'

const commitIcon = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M1 8h4m6 0h4"/></svg>`
const MAX_CACHED_DIRECTORIES = 100

const REVISION_TYPES = [
  { kind: 'branch', label: 'Branch', icon: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="3" r="1.5"/><path d="M4 4.5v7m0-3h3a5 5 0 0 0 5-4"/></svg>` },
  { kind: 'tag', label: 'Tag', icon: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M2 2h5.5l6.5 6.5-5.5 5.5L2 7.5Z"/><circle cx="5" cy="5" r="1"/></svg>` },
  { kind: 'commit', label: 'Commit SHA', icon: commitIcon },
]

async function browseRepository(route, params, signal) {
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

export class ManagedCreateBundle extends LitElement {
  static styles = [unsafeCSS(commonStyles), unsafeCSS(styles)]
  static properties = {
    installTooltips: { attribute: false },
    createBundle: { attribute: false }, _building: { state: true }, _opening: { state: true }, _buildError: { state: true },
    initialRepoId: { attribute: false }, _repos: { state: true }, _loadingRepos: { state: true }, _reposError: { state: true },
    _repoId: { state: true }, _refs: { state: true }, _refKind: { state: true }, _refName: { state: true },
    _path: { state: true }, _entries: { state: true }, _selected: { state: true }, _commit: { state: true },
    _packageEntryPoints: { state: true },
    _solidityEntryPoints: { state: true }, _soliditySuggestionsLimited: { state: true },
    _loadingRefs: { state: true }, _loading: { state: true }, _error: { state: true }, _refsError: { state: true }, _limited: { state: true },
    _revisionOpen: { state: true }, _revisionQuery: { state: true }, _activeRevision: { state: true },
  }

  constructor() {
    super()
    this._repos = []
    this._loadingRepos = true
    this._reposError = ''
    this.initialRepoId = null
    this._building = false
    this._opening = false
    this._buildError = ''
    this._repoId = null
    this._refs = { branches: [], tags: [] }
    this._refKind = 'branch'
    this._refName = ''
    this._path = ''
    this._entries = null
    this._selected = new Set()
    this._dismissedSuggestions = new Set()
    this._bundleConditions = defaultBundleConditions()
    this._packageEntryPoints = []
    this._solidityEntryPoints = []
    this._soliditySuggestionsLimited = false
    this._commit = ''
    this._directories = new Map()
    this._loadingRefs = false
    this._loading = false
    this._error = ''
    this._refsError = ''
    this._limited = false
    this._revisionOpen = false
    this._revisionQuery = ''
    this._activeRevision = -1
    this._onViewport = () => this.positionRevisionSuggestions()
  }

  connectedCallback() {
    super.connectedCallback()
    globalThis.addEventListener('resize', this._onViewport)
    globalThis.addEventListener('scroll', this._onViewport, true)
  }

  updated(changed) {
    if (changed.has('installTooltips')) this.installTooltips?.(this.renderRoot)
    this.positionRevisionSuggestions()
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
    this._buildRequest?.abort()
    this._opening = false
    globalThis.removeEventListener('resize', this._onViewport)
    globalThis.removeEventListener('scroll', this._onViewport, true)
    clearTimeout(this._browseTimer)
    this._reposRequest?.abort()
    this._refsRequest?.abort()
    this._request?.abort()
    this._directories.clear()
    this._dismissedSuggestions.clear()
    this._packageEntryPoints = []
    this._solidityEntryPoints = []
    this._soliditySuggestionsLimited = false
    super.disconnectedCallback()
  }

  resetFiles() {
    this._buildError = ''
    clearTimeout(this._browseTimer)
    this._request?.abort()
    this._directories.clear()
    this._loading = false
    this._entries = null
    this._path = ''
    this._commit = ''
    this._selected = new Set()
    this._dismissedSuggestions.clear()
    this._packageEntryPoints = []
    this._solidityEntryPoints = []
    this._soliditySuggestionsLimited = false
    this._error = ''
    this._limited = false
  }

  async selectRepository(repoId) {
    this.closeRevisionSuggestions()
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
    this.closeRevisionSuggestions()
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

  revisionSuggestions() {
    const choices = this._refKind === 'branch' ? this._refs.branches : this._refKind === 'tag' ? this._refs.tags : []
    const ordered = this._refKind === 'branch' && this._refs.defaultBranch
      ? [this._refs.defaultBranch, ...choices.filter(name => name !== this._refs.defaultBranch)] : choices
    const query = this._revisionQuery.trim().toLowerCase()
    return ordered.filter(name => name.toLowerCase().includes(query))
  }

  showRevisionSuggestions(all = true) {
    if (this._refKind === 'commit' || this._repoId == null || this._loadingRefs) return
    this._revisionQuery = all ? '' : this._refName
    this._activeRevision = -1
    this.renderRoot.querySelector('.revision-menu').showPopover()
  }

  closeRevisionSuggestions() {
    this.renderRoot?.querySelector('.revision-menu')?.hidePopover()
    this._revisionOpen = false
    this._activeRevision = -1
  }

  pickRevision(name) {
    this.editRevision(name)
    this.renderRoot.querySelector('.revision-name').focus({ preventScroll: true })
    this.closeRevisionSuggestions()
  }

  positionRevisionSuggestions() {
    if (!this._revisionOpen) return
    const menu = this.renderRoot.querySelector('.revision-menu')
    const rect = this.renderRoot.querySelector('.revision-name').getBoundingClientRect()
    const margin = 8
    const gap = 6
    const fontSize = parseFloat(getComputedStyle(this).fontSize)
    const columnWidth = 15 * fontSize
    const columns = Math.max(1, Math.min(3, Math.ceil(this.revisionSuggestions().length / 8), Math.floor((window.innerWidth - 2 * margin) / columnWidth)))
    const width = Math.min(Math.max(rect.width, columns * columnWidth), window.innerWidth - 2 * margin)
    menu.style.width = `${width}px`
    menu.style.setProperty('--revision-columns', columns)
    menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`
    const below = window.innerHeight - rect.bottom - gap - margin
    const above = rect.top - gap - margin
    const upward = below < Math.min(menu.scrollHeight, 320) && above > below
    menu.style.maxHeight = `${Math.max(0, Math.min(320, upward ? above : below))}px`
    menu.style.top = `${Math.max(margin, upward ? rect.top - menu.offsetHeight - gap : rect.bottom + gap)}px`
    menu.dataset.positioned = ''
  }

  async revisionKeyDown(event) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape' && this._revisionOpen) { event.preventDefault(); event.stopPropagation() }
      this.closeRevisionSuggestions()
      return
    }
    if (event.key === 'Enter') {
      const name = this.revisionSuggestions()[this._activeRevision]
      if (this._revisionOpen && name != null) { event.preventDefault(); this.pickRevision(name) }
      else this.closeRevisionSuggestions()
      return
    }
    if (this._refKind === 'commit' || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    if (!this._revisionOpen) this.showRevisionSuggestions()
    const count = this.revisionSuggestions().length
    this._activeRevision = count === 0 ? -1 : event.key === 'ArrowDown'
      ? Math.min(this._activeRevision + 1, count - 1) : this._activeRevision <= 0 ? count - 1 : this._activeRevision - 1
    await this.updateComplete
    this.renderRoot.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
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
    this._packageEntryPoints = []
    this._solidityEntryPoints = []
    this._soliditySuggestionsLimited = false
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
      this._packageEntryPoints = cached.packageEntryPoints
      this._solidityEntryPoints = cached.solidityEntryPoints
      this._soliditySuggestionsLimited = cached.soliditySuggestionsLimited
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
    this._packageEntryPoints = data.packageEntryPoints ?? []
    this._solidityEntryPoints = data.solidityEntryPoints ?? []
    this._soliditySuggestionsLimited = data.soliditySuggestionsLimited ?? false
    const suggestions = [...this._packageEntryPoints, ...this._solidityEntryPoints]
      .filter(entry => !this._dismissedSuggestions.has(entry))
    this._selected = new Set([...this._selected, ...suggestions])
    if (/^[a-f\d]{40}$/iu.test(data.commit)) {
      const cacheKey = JSON.stringify([this._repoId, data.commit, path])
      this._directories.set(cacheKey, { entries: this._entries, limited: this._limited, packageEntryPoints: this._packageEntryPoints,
        solidityEntryPoints: this._solidityEntryPoints, soliditySuggestionsLimited: this._soliditySuggestionsLimited })
      if (this._directories.size > MAX_CACHED_DIRECTORIES) this._directories.delete(this._directories.keys().next().value)
    }
  }

  toggleFile(path) {
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
  }

  hasScriptEntryPoints() {
    return [...this._selected].some(path => /\.[cm]?[tj]sx?$/iu.test(path))
  }

  async buildBundle() {
    if (this._building || this._opening || !this.createBundle || !this._commit || this._selected.size === 0) return
    const request = new AbortController()
    this._buildRequest = request
    this._building = true
    this._buildError = ''
    try {
      const bundle = await this.createBundle({ repoId: this._repoId, commit: this._commit,
        entries: [...this._selected], conditions: this._bundleConditions }, request.signal)
      if (!request.signal.aborted) {
        // Navigation loads bundle metadata before replacing this form.
        this._opening = true
        this.dispatchEvent(new CustomEvent('bundle-created', { detail: bundle, bubbles: true, composed: true }))
      }
    } catch (error) {
      if (!request.signal.aborted) this._buildError = error.message
    } finally { this._building = false }
  }

  render() {
    const busy = this._building || this._opening
    const repo = this._repos.find(item => item.repoId === this._repoId)
    const parts = this._path.split('/').filter(Boolean)
    const treeUrl = repo && this._commit ? `https://github.com/${[...repo.fullName.split('/'), 'tree', this._commit, ...parts].map(encodeURIComponent).join('/')}` : null
    const choices = this.revisionSuggestions()
    const revisionLabel = this._refKind === 'commit' ? 'Commit SHA' : this._refKind === 'tag' ? 'Tag' : 'Branch'
    return html`<p class="intro ui-hint">Choose a repository and revision, then select files to use as entry points.</p>
      <div ?inert=${busy}>
      <div class="source-fields">
        <div class="field"><span>Repository</span><repository-selector label="Repository" ?disabled=${this._loadingRepos} .options=${this._repos.map(item => ({ value: item.repoId, label: item.fullName }))} .value=${this._repoId} @repository-change=${event => this.selectRepository(event.detail.value)}></repository-selector></div>
        <form class="revision" @focusout=${event => { if (!event.currentTarget.contains(event.relatedTarget)) this.closeRevisionSuggestions() }} @submit=${event => { event.preventDefault(); void this.loadDirectory('', true) }}>
          <div class="revision-switch" role="group" aria-label="Revision type">${REVISION_TYPES.map(({ kind, label, icon }) => html`<button type="button" aria-label=${label} data-tooltip=${label} aria-pressed=${this._refKind === kind} ?disabled=${!repo || this._loadingRefs} @click=${() => { this.selectRevisionType(kind); this.renderRoot.querySelector('.revision-name').focus(); this.showRevisionSuggestions() }}>${icon}</button>`)}</div>
          <input class="revision-name" type="text" aria-label=${revisionLabel} role=${ifDefined(this._refKind === 'commit' ? undefined : 'combobox')} aria-autocomplete=${ifDefined(this._refKind === 'commit' ? undefined : 'list')} aria-expanded=${ifDefined(this._refKind === 'commit' ? undefined : String(this._revisionOpen))} aria-controls=${ifDefined(this._refKind === 'commit' ? undefined : 'bundle-revisions')} aria-activedescendant=${ifDefined(this._revisionOpen && this._activeRevision >= 0 ? `revision-${this._activeRevision}` : undefined)} autocomplete="off" placeholder=${this._refKind === 'commit' ? 'Commit SHA…' : `Choose or enter a ${this._refKind}…`} .value=${this._refName} ?disabled=${!repo || this._loadingRefs} @focus=${() => this.showRevisionSuggestions()} @click=${() => this.showRevisionSuggestions()} @keydown=${this.revisionKeyDown} @input=${event => { this.editRevision(event.target.value); this.showRevisionSuggestions(false) }}>
          ${this._refKind === 'commit' ? nothing : html`<button type="button" class="revision-expand" aria-label=${`Show ${this._refKind} suggestions`} aria-expanded=${this._revisionOpen} ?disabled=${!repo || this._loadingRefs} @mousedown=${event => event.preventDefault()} @click=${() => { if (this._revisionOpen) this.closeRevisionSuggestions(); else { this.renderRoot.querySelector('.revision-name').focus(); this.showRevisionSuggestions() } }}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>`}
          <div class="revision-menu" id="bundle-revisions" popover="auto" role="listbox" aria-label=${`${revisionLabel} suggestions`} @beforetoggle=${event => { this._revisionOpen = event.newState === 'open'; delete event.target.dataset.positioned; if (!this._revisionOpen) this._activeRevision = -1 }}>
            <div class="revision-options">${choices.map((name, index) => html`<button type="button" role="option" id=${`revision-${index}`} aria-selected=${name === this._refName} ?data-active=${index === this._activeRevision} tabindex="-1" @mousedown=${event => event.preventDefault()} @click=${() => this.pickRevision(name)}><span data-tooltip-truncated data-tooltip=${name}>${name}</span></button>`)}</div>
            ${choices.length > 0 ? nothing : html`<p class="revision-empty">${this._revisionQuery ? 'No matching suggestions. Enter a revision name to browse.' : `No ${this._refKind} suggestions available.`}</p>`}
          </div>
        </form>
      </div>
      ${this._reposError ? html`<p class="message" role="alert">${this._reposError} <button type="button" class="text-action" @click=${() => this.loadRepositories()}>Retry</button></p>` : nothing}
      ${this._refsError ? html`<p class="message" role="status">${this._refsError} <button type="button" class="text-action" @click=${() => this.selectRepository(this._repoId)}>Retry</button></p>` : nothing}
      <section class="browser" aria-label="Repository files" aria-busy=${this._loadingRepos || this._loading || this._loadingRefs}>
        <div class="browser-head"><nav class="breadcrumbs" aria-label="Repository directory"><button type="button" ?disabled=${!this._commit} aria-current=${ifDefined(this._path ? undefined : 'location')} @click=${() => this.loadDirectory('')}>${repo?.fullName ?? 'Repository'}</button>${parts.map((part, i) => html`<span aria-hidden="true">/</span><button type="button" aria-current=${ifDefined(i === parts.length - 1 ? 'location' : undefined)} @click=${() => this.loadDirectory(parts.slice(0, i + 1).join('/'))}>${part}</button>`)}</nav>${treeUrl ? html`<a class="commit-link" href=${treeUrl} target="_blank" rel="noopener noreferrer" data-tooltip=${this._commit} aria-label=${`View directory at commit ${this._commit.slice(0, 7)} on GitHub`}>${commitIcon}<code>${this._commit.slice(0, 7)}</code></a>` : nothing}</div>
        <div class="file-browser">
          ${this._loadingRepos || this._loading || this._loadingRefs ? html`<p class="empty" role="status">${this._loadingRepos ? 'Loading repositories…' : this._loadingRefs ? 'Loading revisions…' : 'Loading files…'}</p>`
            : this._error ? html`<p class="empty error" role="alert">${this._error} <button type="button" class="text-action" @click=${() => this.loadDirectory(this._path)}>Retry</button></p>`
              : this._entries == null ? html`<p class="empty">${repo ? 'Choose a revision to browse its files.' : this._repos.length > 0 ? 'Select a repository to browse its files.' : 'No accessible repositories available.'}</p>`
                : this._entries.length === 0 ? html`<p class="empty">This directory is empty.</p>`
                  : html`<div class="file-grid">${this._entries.map(entry => entry.type === 'dir'
                    ? html`<button type="button" class="file-tile directory" @click=${() => this.loadDirectory(entry.path)}>${sourceFolderIcon}<span data-tooltip-truncated data-tooltip=${entry.path}>${entry.name}</span><span class="arrow" aria-hidden="true">›</span></button>`
                    : html`<label class=${`file-tile ${this._selected.has(entry.path) ? 'selected' : ''} ${entry.type === 'file' ? '' : 'unsupported'}`} data-tooltip=${entry.type === 'file' ? nothing : `${entry.path} (${entry.type})`}><input type="checkbox" aria-label=${`Select ${entry.path} as an entry point`} .checked=${this._selected.has(entry.path)} ?disabled=${entry.type !== 'file'} @change=${() => this.toggleFile(entry.path)}>${sourceFileIcon(entry.name)}<span data-tooltip-truncated data-tooltip=${entry.type === 'file' ? entry.path : nothing}>${entry.name}</span></label>`)}</div>`}
        </div>
        ${this._limited ? html`<p class="message">Showing GitHub’s first 1,000 entries in this directory.</p>` : nothing}
      </section>
      ${packageEntryPointSuggestions(this._packageEntryPoints, this._selected, paths => { this._selected = new Set([...this._selected, ...paths]) })}
      ${solidityEntryPointSuggestions(this._solidityEntryPoints, this._selected, paths => { this._selected = new Set([...this._selected, ...paths]) }, this._soliditySuggestionsLimited)}
      <section class="entry-points" aria-label="Selected entry points"><div class="selection"><div class="selection-head"><h2>Entry points <span aria-live="polite">${this._selected.size}</span></h2>${this._selected.size > 0 ? html`<button type="button" class="btn clear-selection" @click=${this.clearFiles}>Clear all</button>` : nothing}</div>
        ${this._selected.size > 0 ? html`<ul>${[...this._selected].map(path => html`<li>${sourceFileIcon(path)}<span data-tooltip-truncated data-tooltip=${path}>${path}</span><button type="button" aria-label=${`Remove ${path}`} @click=${() => this.toggleFile(path)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></li>`)}</ul>` : html`<p class="note">Select files above. You can choose entry points from multiple directories.</p>`}
        </div>
      </section>
      <bundle-conditions .showConditions=${this.hasScriptEntryPoints()} @conditions-change=${event => { this._bundleConditions = event.detail }}><button type="button" slot="actions" class="btn primary" ?disabled=${busy || !this.createBundle || !this._commit || this._selected.size === 0 || this._loading || this._loadingRefs} @click=${this.buildBundle}>${this._opening ? 'Opening…' : this._building ? 'Creating…' : 'Create a bundle'}</button></bundle-conditions>
      </div>
      ${busy ? html`<p class="message" role="status">${this._opening ? 'Opening bundle…' : 'Building the selected entry points with Stasis…'}</p>` : nothing}
      ${this._buildError ? html`<p class="message error" role="alert">${this._buildError}</p>` : nothing}
    `
  }
}

customElements.define('managed-create-bundle', ManagedCreateBundle)
