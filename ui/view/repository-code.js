// The managed code viewer. A directory of a connected repository at a commit
// opens in the bundle view, as a bundle whose files are the directory's, with
// the Code, Search and Treemap tabs, as an npm version opens (npm-package.js);
// `/manage/code` picks one (ui/managed/repository-code.js). The server reads
// it with the reader's own GitHub access, within their grants of it
// (GET /api/admin/repositories/code). What it answered is kept in memory only
// while it is shown.
import { isManagedUiMode, state } from '#client/index.js'
import { REPOSITORY_CODE_TABS } from '../../common/managed/routes.js'
import { fetchRepositoryCode } from './client-managed.js'
import { selectBundle } from './bundle-load.js'
import { fileRowDetails } from './bundle-sources.js'
import { cleanupGraph2 } from './graph/state.js'
import { managedTabLocation } from './managed-bundle-navigation.js'
import { managedHistory } from './managed-history.js'
import { render } from './render.js'
import { currentViewSignal } from './view-navigation.js'

// A directory as a route or an entry names it: its repository's id, the
// commit and its path, `''` the root.
const sameDirectory = (a, b) => a.repoId === b.repoId && a.commit === b.commit && (a.path ?? '') === (b.path ?? '')

// The directory's name: its repository's, and its path in it.
export const repositoryCodeName = ({ repo, path }) => path ? `${repo}/${path}` : repo

// The bundle view's entry for a directory at a commit. It has no managed id,
// so nothing reads it through the bundle routes; `repository` names it.
export function repositoryCodeEntry(data) {
  const { repoId, repo, commit, path } = data
  const files = Array.isArray(data.files) ? data.files : []
  return {
    integrity: `repository:${repoId}:${commit}:${path}`, kind: 'sourcemap', name: `${repositoryCodeName({ repo, path })}@${commit.slice(0, 7)}`,
    size: files.reduce((sum, [, size]) => sum + size, 0), repository: { repoId, repo, commit, path },
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

// Opens a directory on `bundleTab` (Code by default), `file` a path in it
// for Code to open on, `repo` its repository's name for its header to
// show while it opens.
export function navigateToRepositoryCode({ repoId, commit, path = '', repo = null, file = null, bundleTab = 'code' }) {
  if (!isManagedUiMode() || !managedHistory?.active) return
  void managedHistory.navigate({ view: 'repository-code', repoId, commit, path, bundleTab,
    ...repo ? { repo } : {}, ...file ? { filePath: file } : {} })
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

// Open a `repository-code` route: the directory, which replaces whatever
// bundle was shown, its header showing while it opens. Answers the route the
// page ends on, or false. A directory that fails to open says why where it
// would have shown, at its route, for a reload to read it again.
export async function openRepositoryCodeRoute(route, isCurrent, renderSidebar) {
  const { repoId, commit, path = '' } = route
  const tab = REPOSITORY_CODE_TABS.has(route.bundleTab) ? route.bundleTab : 'code'
  const shown = state.currentView === 'bundles' ? state.bundles?.[0] : null
  // Another tab of the directory shown, as Back gives, keeps it.
  let entry = shown?.repository && sameDirectory(shown.repository, route) && state.bundleDetails?.integrity === shown.integrity ? shown : null
  let details = entry ? state.bundleDetails : null
  if (!entry) {
    const opening = { repoId, commit, path, tab, repo: route.repo ?? null, error: null }
    showOpening(opening)
    renderSidebar()
    let data
    try {
      data = await fetchRepositoryCode(repoId, commit, path, { signal: currentViewSignal() })
      if (data?.repoId !== repoId || data.commit !== commit || data.path !== path) throw new Error('The server answered with another directory.')
    } catch (err) {
      if (err?.name === 'AbortError' || !isCurrent()) return false
      showOpening({ ...opening, error: err.message })
      return { view: 'repository-code', repoId, commit, path, bundleTab: tab }
    }
    if (!isCurrent() || !isManagedUiMode()) return false
    entry = repositoryCodeEntry(data)
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
