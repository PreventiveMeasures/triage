import { splitMarkdownImport } from '../../common/markdown-import.js'
import { dependencyDirectory } from '../../client/dependency-paths.js'
import { BUNDLE_TABS } from '../../common/bundle-tabs.js'
import { managedBundleRoute, managedTabLocation, managedTeamBundleEntries } from './managed-bundle-navigation.js'
import { npmPackageRoute } from './npm-package.js'
import { repositoryCodeRoute } from './repository-code.js'
import { setManagedWorkspace } from '../../client/managed/workspace.js'
import { DEPENDENCY_TABS, managedRouteForIds } from '../../common/managed/routes.js'
import { LINKS_KIND, adoptRepoUrlFor, analyzeContent, computeLinkHint, deleteBundle, deleteFile, deleteWorkspace, dropBundleFromHashIndex, ensureTriageLoaded, getSecureItem, getWorkspaceAppMetadata, isManagedUiMode, listBundles, listFiles, listWorkspaces, loadRepoUrlFor, parseLinkedFindings, pruneOrphanTriage, readFile, readFileBytes, removeCount, removeSecureItem, saveBundle, saveFile, saveRepoUrlFor, setBundleWorkspace, setCount, setReportWorkspace, setSecureItem, state, workspaceAppCacheToken } from '#client/index.js'
import { closeWorkspace as closePresence, deleteBundleFromRemote, deleteFromRemote as deletePresence, holdLocalChangeChecks, isInRemoteOrCached, openWorkspace as openPresence, putFile, triageSync } from './client-sync.js'
import { openImportConflictDialog, openSyncDownloadDialog } from './lazy-dialogs.js'
// Up front, not in the dialogs' bundle (lazy-dialogs.js says why).
import { openPasskeyUnlockDialog } from './dialogs/passkey-unlock-dialog.js'
import { dropZone, report } from './dom.js'
import { clearMergedGroups, getRevalidationConflicts, getShownGroups } from './group.js'
import { configureDepsDir, stampUpstreamFindings } from './format.js'
import { hasRevalidateStamp } from '../../common/finding-filters.js'
import { reportCommit } from '../../common/repo-commit.js'
import { dropForeignRepo } from '../../common/finding-repo.js'
import { applyOpeningFilters, resetFilters } from './filters.js'
import { reportWorkspaceFor } from './finding-link.js'
import { readManagedReport } from '../../common/managed/report-content.ts'
import { encodeReportLocation } from '../../client/report-location.js'
import { configureReportRevalidation, render, renderEmptyWorkspace, renderTriageLoading } from './render.js'
import { ensureClientMode, navigateToAdminPage, renderSidebar } from './sidebar.js'
import { createManagedAnnotationRead, hydrateManagedReportTriage } from './managed-triage.js'
import { resetBundleTerminal } from './terminal-attach.js'
import { cleanupGraph2, graph2 } from './graph/state.js'
import { openBundle, prefetchBundleHashesAfterPaint, selectBundle } from './bundle-load.js'
import { backfillFindingIds, detectFormat, inheritReportMeta, isAppFinding, parseCodexCsvToScans, readReport, repoDirectory, reportEntries, reportRepoGithub, stampSecurityGroups } from '@preventive/report'
import { importWorkspaceFromGzip } from './workspace-import.js'
import { maybePromptFirstUse } from './first-import-prompt.js'
import { droppedLockfile, openDroppedLockfile as readAndShowLockfile } from './lockfile-drop.js'
import { clearReportSources, fetchTeamReports, loadManagedBundle, login as managedLogin } from './client-managed.js'
import { showToast } from './toast.js'
import { managedHistory } from './managed-history.js'
import { loadManagedReportComments } from './managed-comments.js'
import { preloadManagedTeam, startManagedTeamFeed } from './managed-feed.js'
import { awaitManagedDetails } from './managed-details.js'
import { setLoadedWorkspaceAppReports, updateWorkspaceAppMetadata } from './workspace-app-load.js'
import { beginViewNavigation, currentViewGeneration, currentViewSignal } from './view-navigation.js'
export { beginViewNavigation, currentViewGeneration } from './view-navigation.js'

// The last-viewed selection, restored on page load (local mode only;
// managed selections live in the URL): an OPFS report filename, or `r:` +
// JSON of its name and workspace parent; `ws:<id>` for a workspace,
// `wrs:`/`wbs:<id>` for its report / bundle lists; `b:<integrity>` for a
// bundle, optionally ` <tab>`. One selection at a time, last wins.
export const LAST_FILE_KEY = 'deepview.lastFile'
// The bundle view's tabs; 'overview' is the default and left off the
// LAST_FILE_KEY suffix, and an unknown one (a removed tab) restores to it.
export { BUNDLE_TABS } from '../../common/bundle-tabs.js'

// Persist a bundle selection: managed, as the route (`push` adds a history
// entry, else the current one is replaced); local, as `b:<integrity> <tab>`.
export function persistLastBundle(integrity, tab = 'overview', { push = false } = {}) {
  if (isManagedUiMode()) {
    const entry = state.bundles.find(bundle => bundle.integrity === integrity)
    const route = entry?.npm ? npmPackageRoute(entry, tab, managedTabLocation(state, tab))
      : entry?.repository ? repositoryCodeRoute(entry, tab, managedTabLocation(state, tab))
      : managedBundleRoute(state.managedTeams, entry, state.currentManagedTeam, tab, managedTabLocation(state, tab), state.bundles)
    if (push) managedHistory.pushRoute(route)
    else managedHistory.replaceRoute(route)
    return
  }
  const suffix = tab && tab !== 'overview' && BUNDLE_TABS.has(tab) ? ` ${tab}` : ''
  setSecureItem(LAST_FILE_KEY, `b:${integrity}${suffix}`).catch(() => {})
}

// Every async load path captures the navigation generation and bails once
// a newer navigation has bumped it, so two quick clicks can't interleave
// their reports. A `null` generation is the headless `window.__loadFile`
// path, unguarded so the print flow's repeated ingests accumulate.
const isStaleLoad = (captured) => captured !== currentViewGeneration()
const isStale = (gen) => gen !== null && isStaleLoad(gen)

// A report's entries are findings or groups of them.
const toGroup = (entry) => (Array.isArray(entry) ? entry : [entry])

// Renders wait for a frame, out of the ingest call stack: a workspace
// parses many reports, and a render per parse would block the next one.
// The timeout keeps headless callers without requestAnimationFrame moving.
function nextAnimationFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve)
    else setTimeout(resolve, 0)
  })
}

async function renderAfterAnimationFrame(gen) {
  await nextAnimationFrame()
  if (isStale(gen)) return false
  render()
  void prefetchBundleHashesAfterPaint(state.reports.flatMap((r) => r.bundleHashes ?? []),
    () => !isStale(gen)).catch(() => {})
  return true
}

// A new view must not open on the previous one's graph selection, hidden
// or soloed packages, or layout.
function resetGraph2() {
  graph2.selected = null
  graph2.focusedPkg = null
  graph2.layoutCache = null
  graph2.solo = null
  graph2.hidden.clear()
  graph2.pathFilter = ''
  cleanupGraph2()
}

// The header repo chip's URL (`url` for a single report, else none) and
// a fresh graph.
function resetRepoAndGraph(url = '') {
  state.repoUrl = url
  state.repoEditing = false
  resetGraph2()
}

function clearLoadedReports() {
  state.reports = []
  clearMergedGroups()
  state.workspaceMerges = []
  state.revalidateConflicts = new Map()
}

function clearManagedReport() {
  state.managedReport = null
  state.managedReports = []
  state.managedComments.clear()
  state.managedIssues.clear()
}

// Report navigation leaves non-report surfaces, but keeps the Files lens.
function openFindingsView() {
  if (state.currentView !== 'findings' && state.currentView !== 'files') state.currentView = 'findings'
}

function showReportPane() {
  report.classList.add('active')
  dropZone.classList.add('hidden')
}

// The local workspaces listing report `name` (membership is additive).
function workspacesWith(name) {
  return listWorkspaces().filter((w) => Array.isArray(w.reports) && w.reports.includes(name))
}

// Close the sync AND presence sessions of every open workspace not in
// `keepIds`, in lockstep: presence rides sync's `workspace-subscribe`, so
// a presence session must never outlive its sync one.
function closeSessionsExcept(keepIds) {
  for (const info of triageSync.openSessions) {
    if (info && !keepIds.has(info.workspaceId)) {
      triageSync.closeSession(info.workspaceId)
      closePresence(info.workspaceId)
    }
  }
}

// The welcome surface, selection untouched: for a load that ended with
// nothing to show. render.js owns #report's containers imperatively; they
// are removed so their Lit views disconnect.
function showEmptyMainPane() {
  report.classList.remove('active')
  report.replaceChildren()
  dropZone.classList.remove('hidden')
  document.title = 'DeepView'
}

// The two shapes an absent file takes: OPFS `NotFoundError`, or the
// localStorage fallback's `File not found:` (storage.js).
function isMissingFileError(err) {
  return (err instanceof DOMException && err.name === 'NotFoundError')
    || (typeof err?.message === 'string' && err.message.startsWith('File not found:'))
}

// A dropped bundle's kind by its filename, or null: a sourcemap (`.map`)
// or a stasis snapshot (`stasis.code.br` — not any `.br`). Bundles are
// archived as-is, unvalidated.
export function bundleKind(name) {
  const lower = stripDownloadDup(name.toLowerCase())
  if (lower.endsWith('.map')) return 'sourcemap'
  if (lower === 'stasis.code.br' || lower.endsWith('.stasis.code.br')) return 'stasis'
  return null
}

// Browsers name a re-downloaded duplicate `bar.stasis.code (1).br`: strip
// one ` (N)` right before the last extension (bare digits only, so
// `foo (final).enc` stays).
function stripDownloadDup(name) {
  return name.replace(/ \(\d+\)(?=\.[^.]*$)/u, '')
}

// Persist one dropped report, resolving a same-name collision:
//   - new name → save;
//   - byte-identical content → no write, no re-upload;
//   - different content → the conflict dialog: Replace overwrites, and
//     re-uploads to every workspace whose remote ALREADY holds the report
//     (one that never uploaded it would open a presence session and prompt
//     for a password for a report the user thinks local); Rename saves
//     under a name the dialog checked against `existingNames`; Cancel
//     returns null.
// Returns `{ name, content }` of what landed; `existingNames` is kept
// current so later files of the same drop see it.
async function importReportContent({ name, content, existingNames }) {
  const saveAs = async (as) => {
    await saveFile(as, content)
    existingNames.add(as)
    return { name: as, content }
  }
  if (!existingNames.has(name)) return saveAs(name)
  // Compared on the LOGICAL content (decrypted, decompressed). A file gone
  // since the snapshot (a sibling tab deleted it) is no collision; a locked
  // vault or any other read failure propagates — never overwrite what the
  // user can't currently see.
  let existing
  try { existing = await readFile(name) }
  catch (err) {
    if (!isMissingFileError(err)) throw err
    return saveAs(name)
  }
  if (existing === content) return { name, content }
  const uploadableWorkspaces = workspacesWith(name).filter((w) => isInRemoteOrCached(w.id, name))
  const decision = await openImportConflictDialog({
    name,
    workspaceNames: uploadableWorkspaces.map((w) => w.name),
    existingNames,
  })
  if (decision.action === 'cancel') return null
  if (decision.action === 'rename') return saveAs(decision.newName)
  // Replace: save first so the upload reads the new on-disk form. While the
  // save and uploads run, sync must not read the new bytes as an
  // un-uploaded change; the hold is released however they went. Both are
  // best-effort: the local replace stands.
  let release
  if (uploadableWorkspaces.length > 0) {
    try { release = await holdLocalChangeChecks(name) }
    catch (err) { console.warn(`Import: couldn't announce the replace of "${name}" to sync:`, err) }
  }
  try {
    await saveFile(name, content)
    if (uploadableWorkspaces.length > 0) {
      await uploadReportToWorkspaces(name, uploadableWorkspaces)
    }
  } finally {
    if (typeof release === 'function') release()
  }
  return { name, content }
}

// The repository the sender of a raw reports export named for a report
// (workspace-export.js `manualRepo`), keyed on the name it LANDED under and
// never over a URL this browser already holds — `adoptRepoUrlFor` decides
// that inside secure-storage's per-key lock, so a sibling tab can't race
// it. Best-effort: the report is already saved.
async function adoptImportedRepo(name, repo) {
  const url = typeof repo?.github === 'string' ? repo.github : ''
  if (!url) return
  try {
    await adoptRepoUrlFor(name, url)
  } catch (err) {
    console.warn(`Import: failed to adopt the repository "${url}" for "${name}":`, err)
  }
}

// Best-effort push of a replaced report to the workspaces whose remote
// already holds it (callers pre-filter with isInRemoteOrCached), opening
// each session on demand. `openPresence` MUST be awaited before `putFile`,
// which throws for a workspace whose session isn't open yet.
async function uploadReportToWorkspaces(name, workspaces) {
  let bytes
  try {
    bytes = await readFileBytes(name)
  } catch (err) {
    console.warn(`Import: failed to read freshly-saved "${name}" for cloud sync:`, err)
    return
  }
  for (const ws of workspaces) {
    try {
      await openPresence(ws.id)
      const result = await putFile(ws.id, name, bytes)
      if (result && result.ok === false) {
        console.warn(`Import: failed to upload "${name}" to workspace "${ws.name}" (${ws.id}): ${result.reason ?? 'unknown'}`)
      }
    } catch (err) {
      console.warn(`Import: failed to upload "${name}" to workspace "${ws.name}" (${ws.id}):`, err)
    }
  }
}

async function addFiles(files) {
  // A FileList is only readable during the drop (or until the picker is
  // reset): keep the File objects before waiting.
  files = [...files]
  if (files.length === 0) return
  // The landing can show while /api/config is pending; follow the mode it
  // settles on. Managed servers take uploads server-side only, so nothing
  // here writes to disk — the one choke point for drops and the picker.
  await ensureClientMode()
  if (isManagedUiMode()) return
  // A lockfile is shown, never saved (lockfile-drop.js), so it skips the
  // pipeline; dropped with files that are saved, it opens only if none is.
  const lockfile = droppedLockfile(files, file => stripDownloadDup(file.name))
  if (lockfile) files = files.filter(file => !lockfile.taken.has(file))
  if (files.length === 0) { await openDroppedLockfile(lockfile); return }
  // Ask about passkey encryption before the first write, so an accepted
  // enable seals it rather than migrating plaintext after.
  await maybePromptFirstUse()
  if (isManagedUiMode()) return
  let last = null
  let lastBundleIntegrity = null
  // Prefetched after the sidebar refreshes `state.bundles`, so existing
  // reports' "Code →" buttons find a just-dropped bundle.
  const newBundleIntegrities = new Set()
  // OPFS report names, kept current by importReportContent so files of one
  // drop see each other; re-listed after a workspace import, which saves
  // reports out of its reach.
  const existingNames = new Set(await listFiles())
  // Unrecognised reports of a raw export, named once at the end.
  const unreadable = []
  // One report through the collision prompt, counted for the sidebar; the
  // last one landed is navigated to.
  const land = async (name, content, { count, source }) => {
    const saved = await importReportContent({ name, content, existingNames })
    if (saved) {
      setCount(saved.name, count, source)
      last = saved
    }
    return saved
  }
  for (const file of files) {
    try {
      // Workspace exports (gzip, or encrypted) route before `file.text()`,
      // which would mangle their bytes.
      const lower = stripDownloadDup(file.name.toLowerCase())
      if (lower.endsWith('.gz') || lower.endsWith('.deepview-workspace.enc')) {
        const imported = await importWorkspaceFromGzip(file)
        // A raw reports export is a drop of the reports in it, each taking
        // a dragged-in report's path; one bad entry doesn't stop the rest.
        if (imported?.kind === 'reports') {
          for (const r of imported.reports) {
            if (typeof r?.name !== 'string' || !r.name || typeof r?.content !== 'string') continue
            const result = analyzeContent(r.content)
            if (!result.recognized) { unreadable.push(r.name); continue }
            const saved = await land(r.name, r.content, result)
            if (saved) await adoptImportedRepo(saved.name, r.repo)
          }
        }
        try {
          const refreshed = await listFiles()
          existingNames.clear()
          for (const n of refreshed) existingNames.add(n)
        } catch (err) {
          console.warn('Import: failed to refresh existingNames after workspace import:', err)
        }
        continue
      }
      // Sourcemap / stasis bundles are archived as dropped (binary, so read
      // as bytes), outside the report pipeline.
      const kind = bundleKind(file.name)
      if (kind) {
        const buf = new Uint8Array(await file.arrayBuffer())
        const { integrity } = await saveBundle(file.name, buf)
        lastBundleIntegrity = integrity
        newBundleIntegrities.add(integrity)
        continue
      }
      const content = await file.text()
      // Codex is named by the file, not its content (see @preventive/report).
      const products = splitMarkdownImport(content, file.name)
      if (products) {
        for (const product of products) await land(product.name, product.content, analyzeContent(product.content))
      } else if (detectFormat(content, lower) === 'codex') {
        for (const { displayName, data } of parseCodexCsvToScans(content)) {
          // OPFS names can't hold '/'; file-display.js maps '__' back.
          const json = JSON.stringify(data)
          await land(displayName.replaceAll('/', '__') + '.codex', json, analyzeContent(json))
        }
      } else {
        // Only what a parser here recognises is saved. A links file takes
        // the same path; its cached `source` tells it apart afterwards.
        const result = analyzeContent(content)
        if (!result.recognized) {
          throw new Error('not a recognized DeepView, DeepSec, Piolium, Claude Security, Codex, or Markdown (generic) report, and not a links file')
        }
        await land(file.name, content, result)
      }
    } catch (err) {
      alert(`Failed to load ${file.name}: ${err.message}`)
    }
  }
  if (unreadable.length > 0) {
    const n = unreadable.length
    alert(`Skipped ${n} report${n === 1 ? '' : 's'} no parser recognised: ${unreadable.join(', ')}`)
  }
  // Refreshes state.bundles for the bundle path below.
  await renderSidebar()
  if (last) {
    // A report wins over a bundle dropped beside it.
    await switchToFile(last.name, last.content)
  } else if (lastBundleIntegrity) {
    // Open the dropped bundle's panel, set up as a sidebar click would.
    selectBundle(lastBundleIntegrity)
    persistLastBundle(lastBundleIntegrity, state.bundleDetailsTab)
    render()
    await renderSidebar()
    openBundle(lastBundleIntegrity)
  } else if (lockfile) {
    await openDroppedLockfile(lockfile)
  }
  void prefetchBundleHashesAfterPaint(newBundleIntegrities).catch(() => {})
}

// A dropped lockfile alone in an editor of its own, in place of the view,
// as Home leaves it: nothing saved or reopened next visit. The drop
// navigates before its read, so a page left meanwhile keeps the screen.
function openDroppedLockfile(dropped) {
  return readAndShowLockfile(dropped, file => stripDownloadDup(file.name), (lockfile) => {
    closeSessionsExcept(new Set())
    clearActiveView()
    state.droppedLockfile = lockfile
    state.bundleSourceLockfile = true
    state.currentView = 'lockfile'
    render()
    return renderSidebar()
  }, err => alert(`Failed to load ${dropped.lockfile.name}: ${err.message}`))
}

// Replace the view with the named OPFS file (`content` when already read).
// Resolves true only when this load ended up on screen.
export async function switchToFile(name, content, { workspaceId } = {}) {
  if (isManagedUiMode()) return
  const gen = beginViewNavigation()
  state.currentManagedTeam = null
  state.currentManagedReport = null
  state.currentReportWorkspace = reportWorkspaceFor(name, workspaceId)
  // A report rides the chain of every workspace it sits in, so peer edits
  // arrive without opening the workspace. Other workspaces' sessions close;
  // these stay warm across switches (no re-paid key derivation).
  const desiredWorkspaceIds = new Set(workspacesWith(name).map((w) => w.id))
  closeSessionsExcept(desiredWorkspaceIds)
  clearLoadedReports()
  state.currentFile = name
  state.currentWorkspace = null
  state.currentLinks = null
  clearManagedReport()
  // A links file moves to 'links' once read; through 'findings' first, a
  // report never inherits the previous file's view.
  openFindingsView()
  // The URL last typed for THIS file (saveRepoUrlFor), set before ingest
  // so the previous file's doesn't drive the chip meanwhile.
  resetRepoAndGraph(loadRepoUrlFor(name))
  setSecureItem(LAST_FILE_KEY, encodeReportLocation(name, state.currentReportWorkspace)).catch(() => {})
  if (content === undefined) {
    // A failed read leaves no file selected (a newer switch owns the state).
    const unselect = async () => {
      if (isStaleLoad(gen)) return
      state.currentFile = null
      await renderSidebar()
    }
    try {
      content = await readFile(name)
    } catch (err) {
      if (isStaleLoad(gen)) return
      // A locked vault: prompt to unlock, and retry on success.
      if (err && err.message?.includes('vault locked')) {
        const ok = await openPasskeyUnlockDialog()
        if (ok && !isStaleLoad(gen)) await switchToFile(name)
        else await unselect()
        return
      }
      // A missing (or just quarantined) file isn't worth an alert. When a
      // workspace's remote still holds it — only one that already does, as
      // for Replace — offer the sync badge's re-download, and retry.
      if (isMissingFileError(err)) {
        const cloudWs = workspacesWith(name).find((w) => isInRemoteOrCached(w.id, name))
        if (cloudWs) {
          try {
            await openPresence(cloudWs.id)
            if (isStaleLoad(gen)) return
            const result = await openSyncDownloadDialog({
              workspaceId: cloudWs.id,
              items: [{ kind: 'report', identifier: name }],
            })
            if (isStaleLoad(gen)) return
            if (result?.downloaded?.some((d) => d.kind === 'report' && d.identifier === name)) {
              await switchToFile(name)
              return
            }
          } catch (redownloadErr) {
            // The sync badge's recovery flow still offers it.
            console.warn(`Re-download prompt for missing "${name}" failed:`, redownloadErr)
            if (isStaleLoad(gen)) return
          }
        }
        await unselect()
        return
      }
      alert(`Failed to read ${name}: ${err.message}`)
      state.currentFile = null
      await renderSidebar()
      return
    }
    if (isStaleLoad(gen)) return
  }
  // A links file carries no findings of its own (render-links.js points at
  // those in the reports that do), so it skips ingest.
  const linked = parseLinkedFindings(content)
  if (linked) {
    state.currentLinks = { name, ...linked }
    state.currentView = 'links'
    render()
  } else {
    await ingestReport(name, content, gen)
  }
  if (isStaleLoad(gen)) return
  // Sessions open AFTER ingest, which their id-sets are built from.
  // `refreshSession` updates an already-open one, whose ids are stale.
  for (const id of desiredWorkspaceIds) {
    triageSync.openSession(id)
    triageSync.refreshSession(id)
    openPresence(id)
  }
  await renderSidebar()
  return true
}

// A team is a server-backed workspace. Reuse the workspace grouping and
// filtering lens, but fetch on demand and never create a local workspace or
// persist report bytes. Individual reports share this navigation generation
// so a slow team load cannot overwrite a later report click (or Home).
export function switchToManagedDeduplication(id) {
  if (state.managedSession?.role !== 'admin') return false
  // Reuse report hydration and the Links viewer with an in-memory management
  // scope. No team or catalog entry is created for the link report.
  return switchToManagedTeam({ id: null, reports: [{ id }] }, id, { history: false, deduplication: true })
}

// A workspace's or team's list of its `kind`: its reports or bundles, or a
// team's repositories or dependencies, these on their sub-tab `tab`, else
// the one last picked.
export async function switchToWorkspaceContent(id, kind, { history = true, tab = state.teamDependenciesTab } = {}) {
  const managed = isManagedUiMode()
  if (!['reports', 'bundles', ...managed ? ['repositories', 'dependencies'] : []].includes(kind)) return false
  const view = `workspace-${kind}`
  const parent = managed ? state.managedTeams.find(team => team.id === id) : listWorkspaces().find(workspace => workspace.id === id)
  // A team's dependencies, only where its reader reviews them in it.
  if (!parent || kind === 'dependencies' && (parent.dependencyReview !== true || !DEPENDENCY_TABS.has(tab))) return false
  if (managed && history && managedHistory.active) {
    return managedHistory.navigate(managedRouteForIds({ view, teamId: id, ...kind === 'dependencies' ? { dependencyTab: tab } : {} }, state.managedTeams))
  }
  if (kind === 'dependencies') state.teamDependenciesTab = tab
  const workspaceId = managed ? `managed-team:${id}` : id
  const gen = beginViewNavigation()
  closeSessionsExcept(new Set())
  clearActiveView({ forgetLastView: false })
  state.currentWorkspace = workspaceId
  state.currentManagedTeam = managed ? id : null
  state.currentView = view
  if (managed) state.bundles = managedTeamBundleEntries(state.managedTeams)
  showReportPane()
  document.body.classList.remove('report-fullscreen')
  render({ animate: false })
  document.querySelector('#main-content')?.scrollTo({ top: 0 })
  if (!managed) setSecureItem(LAST_FILE_KEY, `${kind === 'reports' ? 'wrs' : 'wbs'}:${id}`).catch(() => {})
  await renderSidebar()
  if (isStaleLoad(gen)) return false
  render({ animate: false })
  return !isStaleLoad(gen)
}

export async function switchToManagedTeam(team, reportId = null, { history = true, deduplication = false } = {}) {
  if (!isManagedUiMode() || !team || !Array.isArray(team.reports)) return false
  if (history && managedHistory.active) return managedHistory.navigate(managedRouteForIds({ view: 'findings', teamId: team.id, reportId }, state.managedTeams))
  if (reportId !== null && !team.reports.some(r => r.id === reportId)) return false
  const gen = beginViewNavigation()
  const hiddenReport = team.reports.find(r => r.id === reportId && r.visible === false)
  const viewSignal = currentViewSignal()
  const opened = reportId === null ? null : team.reports.find(r => r.id === reportId)
  // The loading header replaces the previous view at once: no partially
  // hydrated finding may stay interactive during the awaits, and a failed
  // load goes Home rather than leave a partial view.
  closeSessionsExcept(new Set())
  clearReportSources()
  renderTriageLoading(reportId === null && !deduplication ? team.id : null)
  showReportPane()
  state.currentView = 'findings'
  clearLoadedReports()
  state.currentFile = opened?.filename ?? null
  // Namespaced, in-memory workspace identity: all existing workspace lens
  // rules apply, without registering a local workspace or sync subscription.
  state.currentWorkspace = reportId === null ? `managed-team:${team.id}` : null
  state.currentManagedTeam = team.id
  state.currentManagedReport = reportId
  // What will load, as the catalog names it, so a catalog that agrees finds
  // nothing changed (managed-report-catalog.js); a link report's are known
  // once they are in.
  state.managedReports = deduplication ? []
    : reportId === null ? team.reports.filter(r => r.visible !== false).map(r => ({ id: r.id, filename: r.filename }))
      : opened.analyzer === LINKS_KIND ? [] : [{ id: opened.id, filename: opened.filename }]
  state.managedComments.clear()
  state.managedIssues.clear()
  state.managedReport = null
  // The team's feed and annotations are asked for as its reports are. Its
  // board is drawn from them without their findings' detail, the whole
  // reports asked for beside them (managed-details.js).
  const preload = deduplication ? undefined : preloadManagedTeam(viewSignal)
  const details = deduplication ? null : fetchTeamReports(team.id, { reportId: hiddenReport?.id ?? null })
  void renderSidebar()
  let workspace
  try {
    workspace = deduplication ? await (await loadManagedBundle()).fetchManagedLinkWorkspace(reportId, { signal: viewSignal })
      : await fetchTeamReports(team.id, { reportId: hiddenReport?.id ?? null, lite: true })
  } catch (error) {
    if (!isStaleLoad(gen)) await failManagedTeamLoad(error.message || 'Could not load link report.')
    return false
  }
  if (isStaleLoad(gen)) return false
  if (workspace === null || reportId !== null && !workspace.some(r => r.id === reportId)) {
    await failManagedTeamLoad('Could not load all team reports. Please try again.')
    return false
  }
  const selectedLink = workspace.find(r => r.id === reportId && r.data.source === 'links' && Array.isArray(r.data.links))
  const selected = workspace.filter(r => reportId === null || selectedLink || r.id === reportId)
  const findings = selected.filter(r => r.data.source !== 'links' || !Array.isArray(r.data.links))
  state.currentFile = reportId === null ? null : workspace.find(r => r.id === reportId).filename
  setManagedWorkspace(team.id, workspace)
  state.managedReports = selected.map((entry) => ({ id: entry.id, filename: entry.filename }))
  state.managedReport = reportId === null ? null : state.managedReports[0] ?? null
  state.currentReportWorkspace = null
  state.currentLinks = null
  state.selectedBundle = null
  state.selectedBundleWorkspace = null
  state.scanSelection = null
  resetRepoAndGraph()
  for (const entry of findings) {
    await ingestReport(entry.filename, entry.data, gen, {
      renderView: false, managedReportId: entry.id, managedRepo: entry.repo, keepLens: Boolean(workspace.folded),
    })
    if (isStaleLoad(gen)) return false
  }
  // Every report is hydrated before the merged view becomes interactive:
  // later edits route by the per-report ids stamped above, to a report that
  // owns the finding. `readAnnotations` is the team feed's read
  // (managed-feed.js, which knows its revision), else one of its own; the
  // ids in `except` keep what they hold (replaceManagedReports).
  const hydrate = async (signal, readAnnotations = createManagedAnnotationRead(state.currentManagedTeam, signal), except = undefined) => {
    const results = await Promise.all(findings.flatMap(entry => [
      hydrateManagedReportTriage(entry.id, { renderView: false, signal, readAnnotations, except }),
      loadManagedReportComments(entry.id, { signal, readAnnotations, except }),
    ]))
    return results.every(Boolean) && !signal.aborted && !isStaleLoad(gen)
  }
  // A link report read as one of findings is read again for those it links.
  const annotations = selectedLink ? undefined : preload
  // The board's folded copy is replaced by the whole reports once the view
  // is shown (managed-details.js); details arriving sooner wait for that.
  const shown = Promise.withResolvers()
  let opening = null
  if (details) {
    awaitManagedDetails(team.id, details, () => { void shown.promise.then(() => render()) }, { folded: workspace.folded ?? false, lens: workspace.lens, shown: shown.promise, signal: viewSignal,
      replace: whole => replaceManagedReports(whole, findings, { gen, hydrate, annotations, opening }) })
  }
  if (findings.length > 0) {
    const hydrated = deduplication ? await hydrate(currentViewSignal()) : await startManagedTeamFeed({ hydrate, annotations })
    if (isStaleLoad(gen)) return false
    if (!hydrated) {
      await failManagedTeamLoad('Could not load report annotations. Open the team or report again to retry.')
      return false
    }
  }
  if (selectedLink) {
    state.currentView = 'links'
    state.currentLinks = { name: selectedLink.filename, groups: selectedLink.data.links, skipped: 0,
      ...(deduplication ? { managedId: reportId } : {}) }
    if (!(await renderAfterAnimationFrame(gen))) return false
  } else if (findings.length === 0) {
    renderEmptyWorkspace()
  } else {
    applyOpeningFilters(getShownGroups())
    if (!(await renderAfterAnimationFrame(gen))) return false
  }
  startManagedTeamFeed()
  await renderSidebar()
  opening = OPENING_FIELDS.map(key => state[key])
  shown.resolve(true)
  return true
}

// What a view opens on (filters.js applyOpeningFilters) and the lens it is
// read through: a later answer reopens it only while these are untouched.
const OPENING_FIELDS = ['showRevalidation', 'upstreamOnly', 'revalidationDetailed', 'filterConfMin', 'filterConfMax', 'filterRevalidate', 'filterPartial', 'sortBy', 'severityMode']

// The whole reports in place of a team board's copy, which left out rows App
// mode doesn't show (common/managed/finding-detail.js `fold`): re-ingested,
// the lens configured once all are in, the reader's filters kept — or, if
// the `opening` ones stayed untouched throughout, the whole reports' own.
// Findings the copy held keep their annotations (a reader's edits among
// them); those it left out are hydrated from the annotations read as the
// team opened, caught up since (managed-feed.js). The board is held inert
// meanwhile (render.js); a failure once begun goes Home, as a failed load.
async function replaceManagedReports(workspace, findings, { gen, hydrate, annotations, opening }) {
  const whole = new Map(workspace.map(entry => [entry.id, entry]))
  const entries = findings.map(entry => whole.get(entry.id))
  if (isStaleLoad(gen) || entries.some(entry => !entry)) return false
  const held = new Set(state.reports.flatMap(loaded => loaded.groups.flat().map(finding => finding.id)))
  const board = document.querySelector('#findings-body-slot')
  let settled = null, untouched = false
  board?.setAttribute('inert', '')
  try {
    state.reports = []
    clearMergedGroups()
    for (const entry of entries) {
      const ingested = await ingestReport(entry.filename, entry.data, gen, {
        renderView: false, managedReportId: entry.id, managedRepo: entry.repo, keepFilters: true, keepLens: true,
      })
      if (isStaleLoad(gen)) return false
      if (!ingested) { await failManagedTeamLoad('Could not load all team reports. Please try again.'); return false }
    }
    untouched = OPENING_FIELDS.every((key, index) => state[key] === opening[index])
    configureReportRevalidation()
    settled = OPENING_FIELDS.map(key => state[key])
    if (!await startManagedTeamFeed({ hydrate: (signal, readAnnotations) => hydrate(signal, readAnnotations, held), annotations }) || isStaleLoad(gen)) {
      if (!isStaleLoad(gen)) await failManagedTeamLoad('Could not load report annotations. Open the team or report again to retry.')
      return false
    }
  } finally {
    board?.removeAttribute('inert')
  }
  // Left alone throughout, but for what the lens took of the whole reports.
  if (untouched && OPENING_FIELDS.every((key, index) => state[key] === settled[index])) applyOpeningFilters(getShownGroups())
  return true
}

// A team or report that failed to load leaves Home in place of its loading
// view, telling why.
async function failManagedTeamLoad(message) {
  await goHome({ history: false })
  showToast(message)
}

// The App lens a workspace's metadata asks for (workspace-app-load.js).
function openAppLens() {
  state.showRevalidation = true
  state.upstreamOnly = false
  state.revalidationDetailed = false
  configureReportRevalidation()
}

// Replace the view with every report of a local workspace merged. Each
// report's repo URL rides its findings' `_repoFallback`, so there is no
// global `state.repoUrl` (nor editable chip); reports gone from OPFS are
// skipped.
export async function switchToWorkspace(workspaceId) {
  if (isManagedUiMode()) return
  state.currentManagedTeam = null
  state.currentManagedReport = null
  clearManagedReport()
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  if (!ws) return
  const gen = beginViewNavigation()
  // Keep the target's sessions open (no re-subscribe per click; the
  // trailing refreshSession updates their ids).
  closeSessionsExcept(new Set([workspaceId]))
  openFindingsView()
  // Primes the workspace half of a deep link's location hint.
  void computeLinkHint('workspace', workspaceId)
  clearLoadedReports()
  state.currentFile = null
  state.currentWorkspace = workspaceId
  state.currentReportWorkspace = null
  state.currentLinks = null
  resetRepoAndGraph()
  setSecureItem(LAST_FILE_KEY, `ws:${workspaceId}`).catch(() => {})
  // Clear the previous view while the empty workspace loads. Its header
  // below still offers navigation to bundles when there are no findings.
  if (ws.reports.length === 0) showEmptyMainPane()
  const appToken = await workspaceAppCacheToken(ws)
  if (isStaleLoad(gen)) return
  let complete = true
  // Every read starts at once and ingest walks them in workspace order, so
  // the first findings don't wait for the slowest read; a failed read is
  // null rather than a rejected batch.
  const reads = ws.reports.map((name) => readFile(name).catch(() => null))
  let ingested = 0
  for (let i = 0; i < ws.reports.length; i++) {
    const content = await reads[i]
    if (isStaleLoad(gen)) return
    if (content === null) { complete = false; continue }
    // A links file is a member with no findings to merge; its own row
    // still opens it.
    if (parseLinkedFindings(content)) continue
    // One paint for the whole workspace, not a graph/list pass per report.
    if (await ingestReport(ws.reports[i], content, gen, { renderView: false })) ingested++
    else complete = false
    if (isStaleLoad(gen)) return
  }
  // Nothing painted (every member a links file, or unreadable): don't
  // leave the previous view up.
  if (ingested === 0 && ws.reports.length > 0) showEmptyMainPane()
  if (complete && getWorkspaceAppMetadata(ws)?.appMode) openAppLens()
  const loadedReports = state.reports.slice()
  setLoadedWorkspaceAppReports(ws, loadedReports, appToken, {
    complete,
    isCurrent: () => !isStaleLoad(gen) && state.currentWorkspace === workspaceId
      && ['findings', 'files'].includes(state.currentView),
  })
  // Start the sidebar refresh with the completed snapshot, alongside the main
  // view's first paint, without waiting for unrelated files to finish indexing.
  const sidebarRender = renderSidebar().catch((err) => console.warn('workspace sidebar:', err))
  // What the WORKSPACE opens on, asked again now every member is in (each
  // ingest asked it only of the first): nothing has touched the filters
  // since that first member's reset.
  if (ingested > 0) {
    applyOpeningFilters(getShownGroups())
    if (!(await renderAfterAnimationFrame(gen))) return
  } else renderEmptyWorkspace()
  // Discover global links and derive metadata in the background. A cold
  // counts cache must never delay opening this workspace or a finding link.
  // Late promotion can update the opening defaults only while the user has
  // left them alone; metadata still updates if they choose a different lens.
  const opening = OPENING_FIELDS.map((key) => state[key])
  void updateWorkspaceAppMetadata(ws, loadedReports, appToken, {
    complete,
    isCurrent: () => !isStaleLoad(gen),
    onReady: async (metadata) => {
      if (!metadata.appMode || state.currentWorkspace !== workspaceId
          || !['findings', 'files'].includes(state.currentView)
          || OPENING_FIELDS.some((key, i) => state[key] !== opening[i])) return
      openAppLens()
      applyOpeningFilters(getShownGroups())
      await renderAfterAnimationFrame(gen)
    },
  }).catch((err) => console.warn('workspace App metadata:', err))
  // The sync session opens once every report is in (its id-set is built
  // from them); refreshSession updates one kept open from before.
  triageSync.openSession(workspaceId)
  triageSync.refreshSession(workspaceId)
  openPresence(workspaceId)
  await sidebarRender
}

// Remote deletes, each best-effort ('not-found' is fine: a peer already
// dropped it) and BEFORE the local one, so an auto-download can't re-pull
// through a remaining tag. False once a newer navigation took over.
async function deleteFromRemotes(workspaceIds, gen, what, remove) {
  for (const wsId of workspaceIds) {
    try {
      const result = await remove(wsId)
      if (isStaleLoad(gen)) return false
      if (result && result.ok === false && result.reason !== 'not-found') {
        console.warn(`Failed to delete ${what} from workspace ${wsId} remote: ${result.reason}`)
      }
    } catch (err) {
      console.warn(`Failed to delete ${what} from workspace ${wsId} remote:`, err)
    }
  }
  return true
}

// The 'wipe' choice: drop triage no remaining report reaches. A failure
// leaves the orphans for the next prune; the removal already landed.
async function pruneOrphans() {
  try { await pruneOrphanTriage() }
  catch (err) { console.warn('Skipped orphan-triage GC:', err) }
}

// Remove the current file from OPFS and every workspace listing it (so no
// export or other machine resurrects it), and close the view. `triage`
// 'wipe' also prunes orphaned triage ('keep' leaves it for a re-import);
// `deleteFromRemoteWorkspaceIds` are the workspaces whose remote holds the
// report (the sidebar's `isInRemoteOrCached`). Re-checks the generation
// after every await, so a switch landing meanwhile keeps its view.
export async function deleteCurrent({ triage = 'keep', deleteFromRemoteWorkspaceIds = [] } = {}) {
  if (!state.currentFile) return
  const gen = beginViewNavigation()
  const name = state.currentFile
  // Name-scoped and synchronous, so before any await: a stale bail must not
  // leave a repo URL that resurfaces on a same-name re-import.
  removeCount(name)
  saveRepoUrlFor(name, '')
  if (!await deleteFromRemotes(deleteFromRemoteWorkspaceIds, gen, `'${name}'`, (wsId) => deletePresence(wsId, name))) return
  await deleteFile(name)
  if (isStaleLoad(gen)) return
  await setReportWorkspace(name, null)
  if (triage === 'wipe' && !isStaleLoad(gen)) await pruneOrphans()
  if (isStaleLoad(gen)) return
  clearActiveView()
  await renderSidebar()
}

// Clear every in-memory view state and paint the empty welcome surface —
// for goHome, deleteCurrent and leaveWorkspace alike. Navigation and sync
// sessions are the callers' (each orders them with its own operations).
function clearActiveView({ forgetLastView = true } = {}) {
  resetBundleTerminal()
  state.currentManagedTeam = null
  state.currentManagedReport = null
  state.currentFile = null
  state.currentWorkspace = null
  state.currentReportWorkspace = null
  state.currentLinks = null
  clearManagedReport()
  state.selectedBundle = null
  state.selectedBundleWorkspace = null
  state.scanSelection = null
  state.bundleDetails = null
  state.bundleDetailsTab = 'overview'
  state.bundleSourceFile = null
  state.bundleSourceFindingIdx = null
  state.selectedPackage = null
  state.selectedPackageVersion = null
  state.packageDetailsTab = 'overview'
  state.packageSlideTriage = null
  state.packageSlideTransient = false
  state.expandedPackages.clear()
  state.selectedRepository = null
  state.repositoryDetailsTab = 'overview'
  state.repositorySlideTriage = null
  state.repositorySlideTransient = false
  state.filesSelectedFile = null
  state.tableSelectedGid = null
  state.kanbanPopoverGid = null
  state.kanbanExpandedColumn = null
  state.focusGid = null
  state.activeTabByGroup.clear()
  clearLoadedReports()
  state.repoUrl = ''
  state.repoEditing = false
  state.shownTriage = null
  state.droppedLockfile = null
  state.currentView = 'findings'
  resetGraph2()
  if (forgetLastView) removeSecureItem(LAST_FILE_KEY)
  showEmptyMainPane()
}

// Leave the current surface when the managed server's UI mode changes, as
// one operation: the generation bump stops in-flight loads from putting the
// old view back, closing sessions stops local triage updates during the
// landing paint, and the last-view pointer goes so local mode can't restore
// the managed report (cold-start detection passes forgetLastView: false).
export function resetForClientModeTransition(options) {
  beginViewNavigation()
  closeSessionsExcept(new Set())
  clearActiveView(options)
}

// Back to the welcome surface (the sidebar wordmark), stored data left as
// it is. Invalidates in-flight loads and closes the view's sync sessions,
// which would otherwise echo edits to a chain nothing shows.
export async function goHome({ history = true } = {}) {
  if (history && isManagedUiMode() && managedHistory.active) return managedHistory.navigate({ view: 'home' })
  beginViewNavigation()
  closeSessionsExcept(new Set())
  clearActiveView({ forgetLastView: !isManagedUiMode() })
  await renderSidebar()
  return true
}

// deleteCurrent for the selected bundle: its bytes, its workspace
// listings, its hash-index entries (the "Code →" lookups), the panel
// selection and a last-view pointer naming it.
export async function deleteCurrentBundle({ deleteFromRemoteWorkspaceIds = [] } = {}) {
  if (!state.selectedBundle) return
  const gen = beginViewNavigation()
  const integrity = state.selectedBundle
  if (!await deleteFromRemotes(deleteFromRemoteWorkspaceIds, gen, 'bundle', (wsId) => deleteBundleFromRemote(wsId, integrity))) return
  await deleteBundle(integrity)
  if (isStaleLoad(gen)) return
  await setBundleWorkspace(integrity, null)
  if (isStaleLoad(gen)) return
  state.selectedBundle = null
  state.selectedBundleWorkspace = null
  state.bundleDetails = null
  state.bundleSourceFile = null
  state.bundleSourceFindingIdx = null
  // Only a pointer to THIS bundle (`b:<integrity>[ <tab>]`): the slot is
  // shared with workspace and report pointers.
  const lastFile = getSecureItem(LAST_FILE_KEY)
  if (typeof lastFile === 'string'
      && (lastFile === `b:${integrity}` || lastFile.startsWith(`b:${integrity} `))) {
    removeSecureItem(LAST_FILE_KEY)
  }
  dropBundleFromHashIndex(integrity)
  state.bundles = await listBundles()
  if (isStaleLoad(gen)) return
  render()
  await renderSidebar()
}

// Leave a workspace from THIS browser: its entry and persisted triage base
// go (`onWorkspaceDeleted`); its reports stay ('detach', back to the
// unfiled bucket) or go with their counts and repo URLs ('delete', then
// `triage: 'wipe'` prunes orphaned triage). The server's chain is
// untouched. The view is cleared if it showed the workspace, or — deleting
// — one of its reports.
export async function leaveWorkspace(workspaceId, mode = 'detach', { triage = 'keep' } = {}) {
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  if (!ws) return
  beginViewNavigation()
  const reports = Array.isArray(ws.reports) ? [...ws.reports] : []
  // Before the entry goes, so the save loop can't emit a doomed save
  // against a chain about to vanish.
  triageSync.closeSession(workspaceId)
  closePresence(workspaceId)
  if (mode === 'delete') {
    // A copy another workspace lists loses its bytes too; that workspace
    // skips it until re-imported or re-downloaded.
    for (const name of reports) {
      try { await deleteFile(name) } catch {}
      removeCount(name)
      saveRepoUrlFor(name, '')
    }
    if (triage === 'wipe') await pruneOrphans()
  }
  const wasActiveWorkspace = state.currentWorkspace === workspaceId
  const wasActiveFile = mode === 'delete'
    && state.currentFile != null
    && reports.includes(state.currentFile)
  if (wasActiveWorkspace || wasActiveFile) clearActiveView()
  await deleteWorkspace(workspaceId)
  await renderSidebar()
}

// Parse + store one report, no OPFS: for switchToFile, the workspace and
// team loads, and the headless print flow (`window.__loadFile`), which
// calls it repeatedly to merge inputs. `gen` (see isStaleLoad) is
// re-checked after every await.
async function ingestReport(name, content, gen = null, { renderView = true, managedReportId = null, managedRepo = null, keepFilters = false, keepLens = false } = {}) {
  const stale = () => isStale(gen)
  try {
    // Finish both hints before rendering the Link button. Copy remains
    // synchronous inside its click handler, including on a cold load.
    await Promise.all([
      computeLinkHint('report', name),
      computeLinkHint('workspace', state.currentWorkspace || state.currentReportWorkspace),
    ])
    if (stale()) return
    // Stored triage is awaited before the first render shows marks.
    await ensureTriageLoaded()
    if (stale()) return
    // Managed responses are already parsed. Clone before stamping IDs so the
    // session's cached report remains independent of the active view.
    const { data, reason } = managedReportId === null
      ? isManagedUiMode() ? readManagedReport(content, name) : readReport(content)
      : { data: structuredClone(content), reason: null }
    if (!data) throw new Error(reason)
    // The first report of the view gates the filter reset below.
    const isFirst = state.reports.length === 0
    // `findings` or, for an already deduplicated report, `groups`
    // (reportEntries). Ids are derived for findings lacking one BEFORE
    // grouping, so imports dedupe and keep triage across reloads; in place.
    const rawEntries = reportEntries(data) ?? []
    const rawFindings = rawEntries.flatMap(toGroup)
    await backfillFindingIds(rawFindings)
    if (stale()) return
    // The producers whose own pass judged something in this document, per
    // producer (a re-imported export mixes a revalidated analysis with
    // imports no pass saw): an unstamped import rides `revalidation` in the
    // outcome filter only where its producer judged nothing
    // (filters.js filterRevalidateKind).
    const judgedSources = new Set(rawFindings
      .filter(hasRevalidateStamp)
      .map((f) => f.source ?? data.source ?? null))
    // The repo each finding's links resolve against (`state.repoUrl` can't
    // hold N reports'): a report-level `repo.github` declaration (slug
    // form), outranking the URL typed for it; a managed assignment, even an
    // unassigned one, overrides the embedded one. With it, the
    // `directory` its tree sits in (fileUrl's path prefix).
    const reportRepo = managedRepo ?? data?.repo
    const declaredRepo = reportRepoGithub({ repo: reportRepo })
    const repoFallback = declaredRepo ?? (managedReportId == null ? loadRepoUrlFor(name) : '')
    const repoDir = repoDirectory(reportRepo)
    // Report boundaries and every original copy are kept: workspace grouping
    // depends on the App lens.
    const depsDirectory = dependencyDirectory([{ groups: rawEntries.map(toGroup), tree: data.tree, treeDependencies: data.treeDependencies }])
    const groups = []
    for (const entry of rawEntries) {
      const members = toGroup(entry)
      if (members.length === 0) continue
      const stamped = []
      for (const f of members) {
        const filled = {
          ...dropForeignRepo(f, repoFallback),
          _id: state.nextFindingId++,
          _repoFallback: repoFallback,
          _repoDirectory: repoDir,
          _repoCommit: reportCommit(data, declaredRepo),
          _reportName: name,
          _depsDirectory: depsDirectory,
          _managedReportId: managedReportId,
          // The bundles the analyzer ran against, for "Code →" lookups.
          _bundleHashes: data.bundleHashes ?? [],
        }
        inheritReportMeta(filled, data)
        // The PRODUCER (a `source` marker, or null for DeepView's own dump):
        // the finding's own marker first (a re-imported export stamps them
        // per finding), else its report's — as the markdown writer's
        // `sourceReader` reads it.
        filled._source = filled.source ?? data.source ?? null
        // The LAYER, settled once from the producer; a field the finding
        // arrived with is kept.
        if (!('isApp' in filled)) filled.isApp = isAppFinding(filled, filled._source)
        filled._sourcePass = judgedSources.has(filled._source)
        // The analyzer filter's value: the producer, else a native dump's
        // `type`, else null (the "no analyzer" bucket).
        filled._analyzer = filled._source ?? (filled.type ?? null)
        stamped.push(filled)
      }
      groups.push(stamped)
    }
    stampSecurityGroups(groups)
    state.reports.push({
      type: data.type || 'analysis',
      // Set by the markdown parsers; render.js titles an all-MD view by it.
      source: data.source ?? null,
      fileName: name,
      _managedReportId: managedReportId,
      groups,
      // The report-level repo slug, or null; the header prefers it.
      repo: declaredRepo,
      // Per-file imports / exports / hashes (the "Tree" tab).
      tree: data.tree ?? null,
      // A team's report tells in its place how many files it holds and the
      // dependency directory it names; the tree is asked for once its graph
      // or Files shows (managed-trees.js).
      treeFiles: data.treeFiles ?? null,
      treeDependencies: data.treeDependencies ?? null,
      bundleHashes: data.bundleHashes ?? [],
    })
    configureDepsDir(state.reports)
    if (stampUpstreamFindings(state.reports)) clearMergedGroups()
    state.revalidateConflicts = getRevalidationConflicts()
    // The lens is restored / disabled before the opening filters are derived
    // (leaving a conflicted workspace for one of its reports included) —
    // except under `keepLens`: a team board's folded copy, whose left-out
    // rows might say otherwise (render.js), and the whole reports replacing
    // it, configured once all are in.
    configureReportRevalidation({ held: keepLens })
    // A view's reports ingested again, whole, keep the filters its reader
    // set. Otherwise the set opens on an auto-tuned floor, or Confirmed,
    // over the rows the view SHOWS; a workspace asks again once all its
    // members are in.
    if (isFirst && !keepFilters) {
      resetFilters()
      applyOpeningFilters(getShownGroups())
    }
    if (renderView) await renderAfterAnimationFrame(gen)
    return true
  } catch (err) {
    alert(`Failed to parse ${name}: ${err.message}`)
  }
}

// Headless entry point (the `print` command, src/print.js): parse and
// render a report in-process, resolving once it has rendered. Repeated
// calls accumulate.
window.__loadFile = (name, content) => ingestReport(name, content)

// Headless filter override, applied by `print` after every report loads:
// `severities` an array (empty clears; null/undefined leaves it).
window.__setFilters = ({ severities, confMin } = {}) => {
  if (severities !== undefined && severities !== null) state.filterSeverities = new Set(severities)
  if (confMin !== undefined) state.filterConfMin = confMin
  render()
}

// Esc leaves fullscreen, as the toolbar's button does.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('report-fullscreen')) {
    document.body.classList.remove('report-fullscreen')
  }
})

// Drops anywhere route through addFiles; the drop zone's own handler adds
// its hover affordance.
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  if (e.target.closest('#drop-zone')) return
  addFiles(e.dataTransfer.files)
})

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault()
  if (!isManagedUiMode()) dropZone.classList.add('hover')
})
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('hover'))
dropZone.addEventListener('drop', (e) => {
  e.preventDefault()
  dropZone.classList.remove('hover')
  addFiles(e.dataTransfer.files)
})

// Only the `.drop-prompt-action` button opens the picker: the empty
// surface around it is a window drag handle in WCO mode. The hidden input
// is made on first use; its value is reset after each change so the same
// file can be picked again.
let filePickerInput = null
function openFilePicker() {
  if (isManagedUiMode()) return
  if (!filePickerInput) {
    filePickerInput = document.createElement('input')
    filePickerInput.type = 'file'
    filePickerInput.multiple = true
    filePickerInput.hidden = true
    filePickerInput.addEventListener('change', () => {
      // Copied BEFORE the reset: `input.files` is live, `.value = ''`
      // empties it, and async addFiles reaches its loop only after.
      const files = [...filePickerInput.files]
      if (files.length > 0) addFiles(files)
      filePickerInput.value = ''
    })
    document.body.append(filePickerInput)
  }
  filePickerInput.click()
}
// Delegated on the drop zone, so it survives the prompt's re-renders.
dropZone.addEventListener('click', (e) => {
  const managedPage = e.target.closest('[data-managed-page]')
  if (managedPage) { void navigateToAdminPage(managedPage.dataset.managedPage); return }
  if (e.target.closest('[data-managed-login]')) { void managedLogin(state.managed?.loginPath); return }
  const team = e.target.closest('[data-managed-team]')
  if (team) {
    const selected = state.managedTeams.find((candidate) => candidate.id === team.dataset.managedTeam)
    if (selected) void switchToManagedTeam(selected)
    return
  }
  const workspace = e.target.closest('[data-landing-workspace]')
  if (workspace) {
    void switchToWorkspace(workspace.dataset.landingWorkspace)
    return
  }
  if (e.target.closest('.drop-prompt-action')) openFilePicker()
})
