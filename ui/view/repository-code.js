// The managed code viewer. A directory of a connected repository at a commit
// opens in the bundle view, as a bundle whose files are the directory's, with
// the Code, Search and Treemap tabs, as an npm version opens (npm-package.js).
// Its header picks the repository and the revision (RepositoryCodeSource);
// `/manage/code/<repo id>` opens the default branch's head. The server reads
// it with the reader's own GitHub access, within their grants of it
// (GET /api/admin/repositories/code). What it answered is kept in memory only
// while it is shown.
import { LitElement, html, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { isManagedUiMode, state } from '#client/index.js'
import { REPOSITORY_CODE_TABS } from '../../common/managed/routes.js'
import { fetchBrowsableRepositories, fetchRepositoryCode, fetchRepositoryContents, fetchRepositoryRefs } from './client-managed.js'
import { selectBundle } from './bundle-load.js'
import { fileRowDetails } from './bundle-sources.js'
import { cleanupGraph2 } from './graph/state.js'
import { COMMIT_ICON_SVG } from './icons.js'
import { managedTabLocation } from './managed-bundle-navigation.js'
import { managedHistory } from './managed-history.js'
import { render } from './render.js'
import { sourceFolderIcon } from './source-file-icon.js'
import { installShadowTooltipListener } from './tooltip.js'
import { currentViewGeneration, currentViewSignal } from './view-navigation.js'
import './repository-selector.js'
import './revision-select.js'

const COMMIT = /^[a-f\d]{40}$/iu

// A directory as a route or an entry names it: its repository's id, the
// commit and its path, `''` the root.
const sameDirectory = (a, b) => a.repoId === b.repoId && a.commit === b.commit && (a.path ?? '') === (b.path ?? '')

// The directory's name: its repository's, and its path in it.
export const repositoryCodeName = ({ repo, path }) => path ? `${repo}/${path}` : repo

// What the header reads, for the session and role that read it: the
// repositories the reader may browse, each repository's branches and tags,
// read again as its code opens anew, and the revision each commit was opened
// by, to name it so again (`{ kind, name }`, `name` null for the default
// branch), by repository and commit.
const headerData = new Map()
const revisionNames = new Map()
const DATA_RETRY_MS = 30_000
let keptFor = null

function sessionData() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== keptFor) {
    headerData.clear()
    revisionNames.clear()
    keptFor = session
  }
  return headerData
}

// `{ status }`: 'loading', then 'ready' with its `value`, or 'error' until a
// read after its retry is due; each a new object, so the header repaints.
function headerRead(key, ask) {
  const data = sessionData()
  const held = data.get(key)
  if (held && !(held.status === 'error' && Date.now() >= held.retryAt)) return held
  const loading = { status: 'loading' }
  data.set(key, loading)
  ask().then(value => ({ status: 'ready', value }), err => err?.name === 'AbortError' ? null : { status: 'error', retryAt: Date.now() + DATA_RETRY_MS })
    .then(answer => {
      if (data.get(key) !== loading) return null
      if (answer) data.set(key, answer)
      else data.delete(key)
      render()
      return null
    })
    .catch(() => {})
  return loading
}

export const browsableRepositories = () => headerRead('repositories', () => fetchBrowsableRepositories())
export const repositoryRefs = repoId => headerRead(`refs\0${repoId}`, () => fetchRepositoryRefs(repoId))

// The bundle view's entry for a directory at a commit. It has no managed id,
// so nothing reads it through the bundle routes; `repository` names it, and
// the revision it was opened by, where that was a name.
export function repositoryCodeEntry(data, revision = null) {
  const { repoId, repo, commit, path } = data
  const files = Array.isArray(data.files) ? data.files : []
  return {
    integrity: `repository:${repoId}:${commit}:${path}`, kind: 'sourcemap', name: `${repositoryCodeName({ repo, path })}@${commit.slice(0, 7)}`,
    size: files.reduce((sum, [, size]) => sum + size, 0), repository: { repoId, repo, commit, path, revision },
  }
}

// The file Code opens on: the directory's readme, where it has one.
const README = /^readme(?:\.[^/]*)?$/iu
export function repositoryCodeEntries(paths) {
  const readmes = paths.filter(path => README.test(path))
  return readmes.toSorted((a, b) => Number(!/\.md$/iu.test(a)) - Number(!/\.md$/iu.test(b)) || a.localeCompare(b)).slice(0, 1)
}

// Its files, as the server read them, in the shape an npm version's take
// (bundle-sources.js fileRowDetails).
export function repositoryCodeDetails(entry, data) {
  const details = fileRowDetails(entry, data.files)
  return { ...details, repository: entry.repository, npmEntries: repositoryCodeEntries(details.json.sources) }
}

// The route of the directory an entry names, on `tab`, at `location`.
export function repositoryCodeRoute(entry, tab = 'code', location = null) {
  if (!entry?.repository) return null
  const { repoId, commit, path } = entry.repository
  return { view: 'repository-code', repoId, commit, path, bundleTab: REPOSITORY_CODE_TABS.has(tab) ? tab : 'code', ...location }
}

// Opens a repository's directory on `bundleTab` (Code by default): at
// `commit`, else at `ref` (`heads/<branch>`, `tags/<tag>`, a commit, or
// the default branch's head without one), `revision` naming it so in the
// header, `file` a path in it for Code to open on, `repo` its repository's
// name for its header while it opens.
export function navigateToRepositoryCode({ repoId, commit = null, ref = null, revision = undefined, path = '', repo = null, file = null, bundleTab = 'code' }) {
  if (!isManagedUiMode() || !managedHistory?.active) return
  void managedHistory.navigate({ view: 'repository-code', repoId, commit, path, bundleTab,
    ...ref == null ? {} : { ref }, ...revision === undefined ? {} : { revision }, ...repo ? { repo } : {}, ...file ? { filePath: file } : {} })
}

// The revision a route asks for: its commit, else what it names, else the
// default branch's head.
const routeRef = route => route.commit ?? route.ref ?? ''

// The ref a revision (`{ kind, name }`) names, '' the default branch's head.
const revisionRef = revision => revision?.name
  ? revision.kind === 'commit' ? revision.name.toLowerCase() : `${revision.kind === 'branch' ? 'heads' : 'tags'}/${revision.name}` : ''

// The same directory at another revision, on `tab`: a full commit by its
// own route, a name or a short commit resolved as it opens.
function openRevision({ repoId, repo, path }, revision, tab) {
  const commit = revision.kind === 'commit' && COMMIT.test(revision.name) ? revision.name.toLowerCase() : null
  navigateToRepositoryCode({ repoId, repo, path, commit, bundleTab: tab, ...commit ? {} : { ref: revisionRef(revision), revision } })
}

// Another directory of the repository at the revision shown, on `tab`.
function openDirectory({ repoId, repo, commit, revision }, path, tab) {
  navigateToRepositoryCode({ repoId, repo, path, commit, bundleTab: tab, ...commit ? {} : { ref: revisionRef(revision), revision } })
}

// A directory opening, or failing to (`opening`, render-bundle.js
// renderRepositoryCodeOpening).
function showOpening(opening) {
  state.currentView = 'repository-code'
  state.repositoryCodeOpening = opening
  state.currentManagedTeam = null
  state.currentManagedReport = null
  document.body.classList.remove('report-fullscreen')
  render({ animate: false })
}

// The directory opening in place of `entry`, the one shown, while it loads
// (openRepositoryCodeRoute): for its header to name it, and its body to show
// the one shown as it waits. Null once it opens or fails, or a navigation
// since has left both.
export function repositoryCodePending(entry) {
  const pending = state.repositoryCodePending
  return pending?.integrity === entry?.integrity && pending.generation === currentViewGeneration() ? pending.repository : null
}

// Failures a directory's own entries get past: one too large to read whole,
// or none to read, as an ancestor of a manager's grants is, which lists those
// alone.
const LISTED_FAILURES = new Set(['directory-too-large', 'no-directory'])

// A directory that failed to open lists its directories to open instead,
// where it has any, at the commit its listing read.
async function listDirectories(opening, err) {
  if (!LISTED_FAILURES.has(err?.code)) return
  try {
    const data = await fetchRepositoryContents(opening.repoId, routeRef(opening), opening.path, { signal: currentViewSignal() })
    const directories = (data.entries ?? []).filter(entry => entry.type === 'dir').toSorted((a, b) => a.name.localeCompare(b.name))
    if (state.repositoryCodeOpening?.error && sameDirectory(state.repositoryCodeOpening, opening) && directories.length > 0 && COMMIT.test(data.commit)) {
      state.repositoryCodeOpening = { ...state.repositoryCodeOpening, listing: { commit: data.commit.toLowerCase(), directories } }
      render()
    }
  } catch {}
}

// Opens the directory a failed opening names on another tab, as its tabs
// do, those of a directory too large to open its History alone can show.
export function openRepositoryCodeTab({ repoId, repo, commit, ref, path, revision }, bundleTab) {
  navigateToRepositoryCode({ repoId, repo, path, commit, bundleTab, ...commit ? {} : { ref: ref ?? '', revision } })
}

// Open a `repository-code` route: the directory, which replaces whatever
// bundle was shown, its header showing while it opens, or the directory shown
// until it does. Answers the route the page ends on, at the commit it opened,
// or false. A directory that fails to open says why where it would have
// shown, at its route, for a reload to read it again.
export async function openRepositoryCodeRoute(route, isCurrent, renderSidebar) {
  const { repoId, commit = null, path = '' } = route
  const tab = REPOSITORY_CODE_TABS.has(route.bundleTab) ? route.bundleTab : 'code'
  sessionData()
  const shown = state.currentView === 'bundles' && state.bundles?.[0]?.repository && state.bundleDetails?.integrity === state.bundles[0].integrity ? state.bundles[0] : null
  // Another tab of the directory shown, as Back gives, keeps it.
  let entry = commit && shown && sameDirectory(shown.repository, { repoId, commit, path }) ? shown : null
  let details = entry ? state.bundleDetails : null
  // Another tab of a directory too large to open fails as it did, its
  // History showing all the same.
  const failed = state.currentView === 'repository-code' ? state.repositoryCodeOpening : null
  if (!entry && commit && failed?.code === 'directory-too-large' && sameDirectory(failed, { repoId, commit, path })) {
    showOpening({ ...failed, tab })
    return { view: 'repository-code', repoId, commit, path, bundleTab: tab }
  }
  if (!entry) {
    const revision = route.revision === undefined ? commit ? revisionNames.get(`${repoId}\0${commit}`) ?? null : route.ref ? null : { kind: 'branch', name: null } : route.revision
    const known = browsableRepositories().value?.find(item => item.repoId === repoId)?.fullName
    const opening = { repoId, commit, ref: route.ref ?? null, path, tab, repo: route.repo ?? known ?? null, revision, error: null }
    // Its branches and tags as they are now, for its header.
    headerData.delete(`refs\0${repoId}`)
    // Another directory, or revision, keeps the one shown, dimmed, until it
    // opens, its header naming it meanwhile (repositoryCodePending).
    const pending = shown ? { integrity: shown.integrity, generation: currentViewGeneration(), repository: { repoId, repo: opening.repo, commit, path, revision } } : null
    if (pending) {
      state.repositoryCodePending = pending
      render({ animate: false })
    } else {
      showOpening(opening)
      renderSidebar()
    }
    let data
    try {
      data = await fetchRepositoryCode(repoId, routeRef(route), path, { signal: currentViewSignal() })
      if (data?.repoId !== repoId || (commit && data.commit !== commit) || data.path !== path || !COMMIT.test(data.commit ?? '')) throw new Error('The server answered with another directory.')
    } catch (err) {
      if (err?.name === 'AbortError' || !isCurrent()) return false
      // One too large names the commit it was read at, its route then naming
      // it, as History reads it.
      const failedAt = !commit && err?.code === 'directory-too-large' && COMMIT.test(err.commit ?? '') ? err.commit.toLowerCase() : commit
      const failure = { ...opening, commit: failedAt, error: err.message, code: err?.code ?? null }
      showOpening(failure)
      void listDirectories(failure, err)
      return { view: 'repository-code', repoId, commit: failedAt, path, bundleTab: tab }
    } finally {
      // Given up, superseded or failed, the one shown is itself again.
      if (pending && state.repositoryCodePending === pending) {
        state.repositoryCodePending = null
        if (state.currentView === 'bundles' && state.selectedBundle === pending.integrity) render({ animate: false })
      }
    }
    if (!isCurrent() || !isManagedUiMode()) return false
    if (revision) revisionNames.set(`${repoId}\0${data.commit}`, revision)
    entry = repositoryCodeEntry(data, revision)
    details = repositoryCodeDetails(entry, data)
  }
  cleanupGraph2()
  state.bundles = [entry]
  selectBundle(entry.integrity, tab)
  if (tab === 'code' && route.file != null) {
    state.bundleCodeFileRequest = { bundle: entry.integrity, file: route.file,
      ...(route.line == null ? {} : { line: route.line }), ...(route.endLine == null ? {} : { endLine: route.endLine }) }
  } else if (tab === 'code' && typeof route.filePath === 'string') {
    state.bundleCodeFileRequest = { bundle: entry.integrity, path: route.filePath }
  }
  state.bundleDetails = details
  state.repositoryCodeOpening = null
  state.currentManagedTeam = null
  state.currentManagedReport = null
  state.reports = []
  document.body.classList.remove('report-fullscreen')
  render({ animate: false })
  renderSidebar()
  document.querySelector('#main-content')?.scrollTo({ top: 0 })
  return repositoryCodeRoute(entry, state.bundleDetailsTab, managedTabLocation(state))
}

// The revision a directory shows, as it was opened: by its name, the default
// branch's once the repository's branches arrive, else by its commit.
export function shownRevision({ revision, commit }, refs) {
  if (revision?.name) return revision
  if (revision) return { kind: 'branch', name: refs?.status === 'ready' ? refs.value.defaultBranch ?? '' : '' }
  return { kind: 'commit', name: commit ?? '' }
}

// The header of a repository's directory, or of one opening
// (render-bundle.js bundleSlideView): the repository, among those the reader
// may browse (`repos`, browsableRepositories); the directory's path in it,
// each part opening that directory; the revision as it was opened, among the
// repository's branches and tags (`refs`, repositoryRefs), as Create a bundle
// picks one; and the commit, linking its tree on GitHub. Picking another
// repository opens its default branch's head, on the same tab; picking another
// revision, or entering one, opens the same directory there.
class RepositoryCodeSource extends LitElement {
  static properties = {
    repository: { attribute: false }, tab: { type: String }, repos: { attribute: false }, refs: { attribute: false },
    _edit: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repository = null
    this.tab = 'code'
    this.repos = null
    this.refs = null
    // The revision being picked, until it opens; null shows the one opened.
    this._edit = null
    this._shownKey = null
  }

  willUpdate() {
    const { repoId, commit, path, revision } = this.repository ?? {}
    const key = JSON.stringify([repoId, commit, path, revision])
    if (key !== this._shownKey) {
      this._shownKey = key
      this._edit = null
    }
  }

  revisionChanged({ detail: { how, kind, name } }) {
    const typed = name.trim()
    if (how === 'kind' || how === 'input' || !typed || (kind === 'commit' && !/^[a-f\d]{7,40}$/iu.test(typed))) {
      this._edit = { kind, name }
      return
    }
    this._edit = { kind, name: typed }
    openRevision(this.repository, { kind, name: typed }, this.tab)
  }

  render() {
    if (!this.repository) return nothing
    const { repoId, repo, commit, path } = this.repository
    const repos = this.repos?.status === 'ready' ? this.repos.value : []
    const options = repos.map(item => ({ value: item.repoId, label: item.fullName }))
    if (!repos.some(item => item.repoId === repoId)) options.unshift({ value: repoId, label: repo ?? `Repository ${repoId}` })
    const revision = this._edit ?? shownRevision(this.repository, this.refs)
    const parts = path ? path.split('/') : []
    const name = repo ?? repos.find(item => item.repoId === repoId)?.fullName
    const tree = name && commit ? `https://github.com/${[...name.split('/'), 'tree', commit, ...parts].map(encodeURIComponent).join('/')}` : null
    return html`<repository-selector class="repository-code-repo" label="Repository" .options=${options} .value=${repoId}
        @repository-change=${event => { if (event.detail.value !== repoId) navigateToRepositoryCode({ repoId: event.detail.value, repo: options.find(option => option.value === event.detail.value)?.label, bundleTab: this.tab }) }}></repository-selector>
      ${parts.length > 0 ? html`<nav class="repository-code-path" aria-label="Directory">
        <button type="button" aria-label="Open the repository's root" @click=${() => openDirectory(this.repository, '', this.tab)}>/</button>
        ${parts.map((part, index) => index === parts.length - 1
          ? html`<span aria-current="location">${part}</span>`
          : html`<button type="button" @click=${() => openDirectory(this.repository, parts.slice(0, index + 1).join('/'), this.tab)}>${part}</button><span aria-hidden="true">/</span>`)}
      </nav>` : nothing}
      <revision-select class="repository-code-revision" .refs=${this.refs?.status === 'ready' ? this.refs.value : null} .kind=${revision.kind} .name=${revision.name}
        .installTooltips=${root => installShadowTooltipListener(root)} @revision-change=${this.revisionChanged}></revision-select>
      ${tree ? html`<a class="bundles-slide-commit" href=${tree} data-tooltip=${commit} data-tooltip-icon="commit" target="_blank" rel="noopener noreferrer"
        aria-label=${`View this directory at commit ${commit.slice(0, 7)} on GitHub`}>${unsafeHTML(COMMIT_ICON_SVG)}<span>${commit.slice(0, 7)}</span></a>` : nothing}`
  }
}
if (!customElements.get('repository-code-source')) customElements.define('repository-code-source', RepositoryCodeSource)

// What a directory that failed to open lists to open instead (listDirectories).
export function repositoryCodeListing(opening) {
  const { listing } = opening
  if (!listing) return nothing
  return html`<div class="repository-code-listing">
    <p>Open one of its directories:</p>
    <ul>${listing.directories.map(entry => html`<li><button type="button" class="repository-code-directory"
      @click=${() => openDirectory({ ...opening, commit: listing.commit }, entry.path, opening.tab)}>${sourceFolderIcon}<span>${entry.name}</span></button></li>`)}</ul>
  </div>`
}
