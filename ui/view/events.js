import { managedBundleRoute, managedCodeLocation, prepareNpmReviewTab } from './managed-bundle-navigation.js'
import { npmRisk } from './npm-risk.js'
import { setFindingTriage } from '../../client/ignored-triage.js'
import { REPOSITORY_FILELESS_TABS, compareModeField, compareModeOf, managedRouteForIds, parseManagedRoute } from '../../common/managed/routes.js'
import { getPublicShare } from '../../client/managed/public-share.js'
import { managedHistory } from './managed-history.js'
import { openFindingHistoryDialog, openManagedIssueDialog } from './client-managed.js'
import { canViewFindingHistory } from './finding-history.js'
import { issueDraftOptions, renderHighlighted } from './render-finding.js'
import { BUNDLE_SOURCE_WRAP_KEY, KANBAN_DETAIL_FULLSCREEN_KEY, SEVERITY_MODE_KEY, bundleFindingsWalk, isEncryptionEnabled, isManagedUiMode, patchEntry, readBundle, saveRepoUrlFor, saveTriage, state, subscribeToBundleFindingIndex, subscribeToBundleHashIndex, subscribeToLinkedFindings } from '#client/index.js'
import { downloadBlob, report } from './dom.js'
import { commonPrefix, configureRevalidation, depsDirName, handoffBlock, isModule, lineRange } from './format.js'
import { activeTabFor, canApplyFixToGroup, canEditTriage, canTriageFinding, findGroupById, findingRepo, fixApplies, getShownGroups, groupState, groupWithPassRows, syncGroupTriage, tabKey, triageActionPlan, triageEntry, triageScope } from './group.js'
import { applyOpeningFilters, clearFilterOverride, defaultConfidenceFloor, defaultRevalidateFilter, resetFilters, setFilterOverride } from './filters.js'
import { bundleDependencyRepo, focusCodeHistory, focusCodeLinkPosition, loadBundleDependencyRepos, revealFocusCodeLines } from './focus-code.js'
import { pushed, stepped } from './focus-code-history.js'
import { bundleFileHistory, stepBundleFile, visitBundleFile } from './bundle-code-history.js'
import { refreshGraph2Sidebar, refreshGraph2TopPkgs, render } from './render.js'
import { startViewTransition } from './render-transition.js'
import { bundleSourceModalShown, refreshBundleGraphSidebar, refreshBundleGraphTopPkgs, revealBundleCodeCurrent, revealBundleSourceLine } from './render-bundle.js'
import { keepSourceLine, topSourceLine } from './source-wrap.js'
import { togglePrettySource } from './pretty-source.js'
import { toggleLockfileView } from './lockfile-view.js'
import { grantAdvisoriesProxyConsent, retryBundleAdvisories } from './render-bundle-advisories.js'
import { openCommentDialog, openDownloadBundleDialog, openExportConfirmDialog, openExportViewDialog, openFindingSourceDialog, openFixLinkDialog, openManagedCommentsDialog, openRevalidationConflictsDialog } from './lazy-dialogs.js'
import { findingLinkFor } from './finding-link.js'
import { revealFindingInReport } from './finding-link-nav.js'
import { closeLinksPreview, getLinksPreview, openLinksPreview } from './links-preview.js'
import { findingsEscapeLayer, focusNavBlocked, nativeLayerOpen } from './key-layers.js'
import { FOCUS_SPLIT_STEP, nudgeFocusSplit, resetFocusSplit, startFocusSplitDrag } from './focus-splitter.js'
import { keyClickTarget } from './key-click.js'
import { downloadReportsAsMarkdown, reportsToMarkdown } from './markdown-export.js'
import { bundleToCycloneDx, bundleToSpdx, sbomBaseName } from './sbom.js'
import { bundleSourceLines, bundleSourcesAsMap } from '../../common/bundle-sources.js'
import { ensureBundleSources, handOffBundles, openBundle, prefetchBundleHashes, releaseHandoff, selectBundleTab } from './bundle-load.js'
import { renderSidebar, showStoredBundle } from './sidebar.js'
import { BUNDLE_TABS, goHome, persistLastBundle, switchToFile, switchToManagedTeam, switchToWorkspace, switchToWorkspaceContent } from './ingest.js'
import { treeAnchor } from './file-counts.js'
import { cleanupGraph2, graph2 } from './graph/state.js'
import { hideToast, showToast } from './toast.js'
import { managedDetailsReady } from './managed-details.js'

// All interactive elements inside #report are handled by delegation here,
// no inline handlers. Click delegates are tables of [matcher, handler]: the
// first row whose matcher finds an element runs, unless its handler returns
// `false` to pass the click on down the table — so more specific selectors
// come first.
//
// `deep` matches along the composed path: a click inside a shadow root
// (`<finding-card>`, `<finding-table>`, `<graph-layout>`) reaches #report
// retargeted to the host, where `e.target.closest()` (`near`) can't see the
// element actually clicked.
function pathClosest(e, selector) {
  for (const el of e.composedPath()) {
    if (el?.matches?.(selector)) return el
  }
  return null
}
const deep = selector => e => pathClosest(e, selector)
const near = selector => e => e.target.closest?.(selector)

function runClicks(table, e) {
  for (const [match, handle] of table) {
    const el = match(e)
    if (el && handle(el, e) !== false) return true
  }
  return false
}

// A click ending a text selection isn't a pick. A keyboard click (Enter or
// Space, key-click.js; `detail` 0) ends none, whatever is selected elsewhere.
const endsSelection = (e) => e.detail !== 0 && Boolean(window.getSelection?.()?.toString())

const toggleIn = (set, value) => { if (!set.delete(value)) set.add(value) }
const onFindingsView = () => state.currentView === 'findings' || state.currentView === 'files'
const currentManagedTeam = () => state.managedTeams.find(team => team.id === state.currentManagedTeam)

function navigateManagedReportView(view) {
  if (!isManagedUiMode() || !managedHistory.active || !state.currentManagedTeam) return null
  return managedHistory.navigate(managedRouteForIds({ view, teamId: state.currentManagedTeam, reportId: state.currentManagedReport }, state.managedTeams))
}

// Another OPFS report finished parsing into the finding index, which every
// cross-report view reads. Repaint once both a frame and 350ms have passed,
// so report loading and painting progress before a graph rebuild starts.
let findingIndexRenderQueued = false
subscribeToBundleFindingIndex(() => {
  if (findingIndexRenderQueued) return
  findingIndexRenderQueued = true
  let waitsRemaining = 2
  const ready = () => { if (--waitsRemaining === 0) refreshFindingIndexView() }
  requestAnimationFrame(ready)
  setTimeout(ready, 350)
})

// The findings surface waits out a walk still filling the index: a tick
// there rebuilds every merged row and card, so it draws once with what the
// walk found rather than once per report.
let findingIndexWalkAwaited = false
function refreshFindingIndexView() {
  findingIndexRenderQueued = false
  const walk = bundleFindingsWalk()
  if (walk && onFindingsView()) {
    if (!findingIndexWalkAwaited) {
      findingIndexWalkAwaited = true
      void walk.catch(() => {}).finally(() => {
        findingIndexWalkAwaited = false
        refreshFindingIndexView()
      })
    }
    return
  }
  // Rows with the same finding id contribute security evidence even without
  // a links file: invalidate the cached lens in every view.
  state.findingIndexTick++
  const view = state.currentView
  // The sidebar's PACKAGES / REPOSITORIES captions read the index too.
  if (onFindingsView()) renderSidebar().catch(() => {})
  if (onFindingsView() || ['packages', 'repositories', 'links'].includes(view) || view === 'bundles' && state.selectedBundle) render()
}

// A bundle's per-file hashes landed (or a deleted bundle's were dropped).
// Every join of a finding to bundle source goes through that index — the
// focus view's Code panel, a card's "Code →", the Files tab's link, a Links
// preview — and reads it during a render that usually came first: the
// prefetch at ingest is fire-and-forget, and a reload paints before the
// index fills. The bundle views hold their own `details.fileHashes`.
// Coalesced, as a report's bundles finish hashing in a burst.
let hashIndexRenderQueued = false
const readsHashIndex = () => onFindingsView() || getLinksPreview()
subscribeToBundleHashIndex(() => {
  if (!readsHashIndex() || hashIndexRenderQueued) return
  hashIndexRenderQueued = true
  queueMicrotask(() => {
    hashIndexRenderQueued = false
    if (!readsHashIndex()) return
    // `<finding-card>` paints from its own autorun, which an unchanged
    // binding doesn't re-run; the tick is the state change it reads.
    state.bundleHashTick++
    render()
  })
})

// A links file entered or left the links index, which cards read for their
// "Duplicates:" row from their own autorun (see `linksTick` in state.ts).
// Not coalesced: the index notifies per batch, not per file it reads.
subscribeToLinkedFindings(() => {
  state.linksTick++
  render()
})

// The findings and bundle graph views share the chrome, not the data.
const inBundleGraph = () => state.currentView === 'bundles' && state.bundleDetailsTab === 'graph'
function refreshActiveGraphSidebar() {
  if (inBundleGraph()) refreshBundleGraphSidebar()
  else refreshGraph2Sidebar()
}
function refreshActiveGraphTopPkgs() {
  if (inBundleGraph()) refreshBundleGraphTopPkgs()
  else refreshGraph2TopPkgs()
}

// The node set or layout changed: drop the cached layout and the fields
// named, then remount the canvas.
function rebuildGraph(...reset) {
  graph2.layoutCache = null
  for (const field of reset) graph2[field] = null
  cleanupGraph2()
  render()
}

// Re-render keeping a scroller's position. Lit rebuilds a list's children
// when a row's `.current` highlight or a sibling's structure changes, and a
// rebuilt subtree resets the scroll of its scrolling ancestor.
function renderPreservingScrollOf(selector, keepLeft = false) {
  const before = document.querySelector(selector)
  const top = before?.scrollTop ?? 0
  const left = before?.scrollLeft ?? 0
  render()
  const after = document.querySelector(selector)
  if (!after) return
  after.scrollTop = top
  if (keepLeft) after.scrollLeft = left
}
const renderPreservingSourceScroll = () => renderPreservingScrollOf('.bundle-source-code-wrap', true)

// Table renders diff in place (the persistent `<finding-table>`, render.js);
// this guards the renders that do rebuild the scroller (cross-view re-entry).
function renderPreservingTableScroll() {
  if (state.viewMode === 'table') renderPreservingScrollOf('.findings-table-list')
  else render()
}

// A search field's re-renders, one per frame. The findings search re-filters
// and re-sorts the whole loaded set, and the bundle searches scan sources
// inside render(), so per keystroke they would tie typing latency to that
// cost. The query is written synchronously; a pending frame draws the newest.
let searchRaf = 0
function renderSearchNextFrame() {
  if (searchRaf) return
  searchRaf = requestAnimationFrame(() => {
    searchRaf = 0
    render()
  })
}

// After the render that mounts (or re-targets) the source viewer.
function scrollSourceLineIntoView(line, options) {
  queueMicrotask(() => {
    document.querySelector(`.bundle-source-lineno-row[data-line="${line}"]`)?.scrollIntoView(options)
  })
}

function pulseCopied(el) {
  el.classList.add('copied')
  setTimeout(() => el.classList.remove('copied'), 1000)
}

// A convenience: no clipboard permission or secure context is a silent no-op.
function copyWithPulse(el, text) {
  try {
    navigator.clipboard.writeText(text).then(() => {
      pulseCopied(el)
      return null
    }).catch(() => {})
  } catch {}
}

function selectBundleSourceFile(path) {
  const history = bundleFileHistory(state.bundleCodeHistory, state.bundleDetails?.integrity ?? null, state.bundleSourceFile)
  state.bundleCodeHistory = visitBundleFile(history, path)
  state.bundleSourceFile = path
}

function resetBundleSourceScroll(focus = false) {
  queueMicrotask(() => {
    const source = document.querySelector('.bundle-source-code-wrap')
    if (source) { source.scrollTop = 0; source.scrollLeft = 0 }
    if (focus) source?.querySelector('.bundle-source-code')?.focus({ preventScroll: true })
  })
}

// A file opened in the source viewer from its history or a link in it.
function showSourceFile(clearSearch, focus) {
  state.bundleSourceFindingIdx = null
  if (clearSearch) {
    state.bundleCodeSearchMode = 'files'
    state.bundleCodeSearchQuery = ''
  }
  renderPreservingScrollOf('.bundle-code-rail-body')
  revealBundleCodeCurrent()
  resetBundleSourceScroll(focus)
}

function goBundleTab(tab, options) {
  selectBundleTab(tab, options)
  if (state.selectedBundle) persistLastBundle(state.selectedBundle, tab, { push: true })
}

// Another tab of the open bundle, from its tab strip, or a source popup's
// Code button, which keeps its file (`preserveSource`).
function switchBundleTab(tab, options) {
  // Leaving Graph stops its canvas' rAF / observers.
  if (state.bundleDetailsTab === 'graph' && tab !== 'graph') {
    cleanupGraph2()
    document.body.classList.remove('report-fullscreen')
  }
  // Switching tabs resets the source-viewer pointer (selectBundleTab): the
  // modal renders over non-slide tabs whenever it's set.
  prepareNpmReviewTab(state, tab, npm => npmRisk(npm)?.oldVersion ?? null)
  goBundleTab(tab, options)
  render()
  // Code opens a default file on entry, perhaps deep in a subtree the rail
  // opens scrolled past.
  if (tab === 'code') {
    ensureBundleSources().then(() => {
      if (state.bundleDetailsTab === 'code') revealBundleCodeCurrent()
      return null
    })
  }
}

// A line link pasted or typed over the open managed file changes only the
// fragment; managed-history keeps the page. Mark the lines it names, within
// the file, and bring them into view.
window.addEventListener('hashchange', () => {
  if (!isManagedUiMode() || getPublicShare() || state.currentView !== 'bundles' || state.bundleDetailsTab !== 'code') return
  const route = parseManagedRoute(new URL(location.href))
  if (route?.bundleTab !== 'code' || route.file == null || route.file !== managedCodeLocation(state)?.file) return
  const path = state.bundleSourceFile
  const end = route.endLine ?? route.line
  state.bundleSourceTargetLine = route.line && end <= bundleSourceLines(bundleSourcesAsMap(state.bundleDetails).get(path) ?? '')
    ? { bundle: state.bundleDetails?.integrity ?? null, path, line: route.line, ...(route.endLine ? { end: route.endLine } : {}) }
    : null
  render()
  if (state.bundleSourceTargetLine) scrollSourceLineIntoView(route.line, { block: 'center' })
})

// Source links, file history, close controls and gutter dots: shared by
// #report (Code and finding panels) and the separate source overlay slot.
const SOURCE_CLICKS = [
  // Managed Code's line numbers mark a line, and with Shift a range from the
  // line clicked first; clicking the one marked line clears it. The render
  // puts the marked lines in the URL.
  [near('[data-bundle-source-line]'), (el, e) => {
    const line = Number(el.dataset.bundleSourceLine)
    const bundle = state.bundleDetails?.integrity ?? null
    const path = state.bundleSourceFile
    const target = state.bundleSourceTargetLine
    const marked = target?.bundle === bundle && target.path === path ? target : null
    if (e.shiftKey && marked) {
      const anchor = marked.anchor ?? marked.line
      state.bundleSourceTargetLine = { bundle, path, line: Math.min(anchor, line), end: Math.max(anchor, line), anchor }
    } else if (marked?.line === line && !(marked.end > line)) state.bundleSourceTargetLine = null
    else state.bundleSourceTargetLine = { bundle, path, line }
    renderPreservingSourceScroll()
  }],
  // Rewrapping moves every line below the first that changes, so put back
  // the one at the top of the code once the gutter has followed.
  [near('[data-bundle-source-wrap]'), (el) => {
    const restore = keepSourceLine(el)
    state.bundleSourceWrap = !state.bundleSourceWrap
    try { localStorage.setItem(BUNDLE_SOURCE_WRAP_KEY, String(state.bundleSourceWrap)) } catch {}
    render()
    queueMicrotask(restore)
  }],
  // A pretty-printed copy's lines aren't the file's, so it opens at its top.
  [near('[data-bundle-source-pretty]'), (el) => {
    togglePrettySource(el.dataset.bundleSourcePretty === 'json')
    render()
    resetBundleSourceScroll()
  }],
  // A lockfile's packages, in the lockfile viewer, in place of its text.
  [near('[data-bundle-source-lockfile]'), () => {
    toggleLockfileView()
    render()
  }],
  // A dropped lockfile's editor (lockfile-drop.js) closes to the landing.
  [near('[data-dropped-lockfile-close]'), () => { void goHome() }],
  [near('[data-bundle-code-history]'), (el) => {
    const history = bundleFileHistory(state.bundleCodeHistory, state.bundleDetails?.integrity ?? null, state.bundleSourceFile)
    const next = stepBundleFile(history, el.dataset.bundleCodeHistory === 'back' ? -1 : 1)
    const path = next.files[next.at]
    if (next.at === history.at || !bundleSourcesAsMap(state.bundleDetails).has(path)) return
    state.bundleCodeHistory = next
    state.bundleSourceFile = path
    showSourceFile(true, false)
  }],
  [near('[data-bundle-source-link]'), (el, e) => {
    const path = el.dataset.bundleSourceLink
    const panel = el.closest('.focus-pane-code')
    if (panel) {
      const group = focusedGroupOf(e)
      const pos = focusCodeLinkPosition(group, panel.dataset.focusCodeIntegrity, panel.dataset.focusCodeFile, path)
      if (pos) {
        pushFocusCode(group, pos)
        queueMicrotask(() => panel.querySelector('.focus-code-source')?.focus({ preventScroll: true }))
      }
      return
    }
    if (!bundleSourcesAsMap(state.bundleDetails).has(path)) return
    // Search results can hide a target that doesn't contain the query, so
    // follow references on in Code, with its file tree.
    if (state.currentView === 'bundles' && state.bundleDetailsTab === 'search') goBundleTab('code', { preserveSource: true })
    selectBundleSourceFile(path)
    showSourceFile(state.bundleDetailsTab === 'code', true)
  }],
  // The popup's Code button: the file in its bundle's Code tab, with its
  // file tree, at the line the popup had at its top, its marked lines kept,
  // and over the bundle view its finding panel too. Over a finding's view,
  // its local bundle opens on the file (selectBundle's `file`).
  [near('[data-action="bundle-source-open-code"]'), (el) => {
    const path = state.bundleSourceFile
    const integrity = state.selectedBundle
    if (!path || !integrity) return
    const top = topSourceLine(el)
    const reveal = () => {
      if (state.bundleDetailsTab !== 'code' || state.bundleSourceFile !== path) return
      if (top > 1) revealBundleSourceLine(top, 'start')
      queueMicrotask(() => document.querySelector('.bundle-code-main .bundle-source-code')?.focus({ preventScroll: true }))
    }
    if (state.currentView === 'bundles') {
      switchBundleTab('code', { preserveSource: true })
      reveal()
      return
    }
    const target = state.bundleSourceTargetLine
    const marked = target?.bundle === integrity && target.path === path
      ? { line: target.line, ...(target.end > target.line ? { endLine: target.end } : {}) } : {}
    showStoredBundle(integrity, 'code', { file: { path, ...marked } }).then(() => {
      reveal()
      return null
    }).catch(() => {})
  }],
  // Backdrop or close button. Before the opening clicks further down, so a
  // stray view-source target inside the modal doesn't reopen it.
  [e => e.target.classList?.contains('bundle-source-overlay') ? e.target : e.target.closest('[data-action="bundle-source-close"]'), () => {
    if (!state.bundleSourceFile) return
    selectBundleTab(state.bundleDetailsTab)
    render()
  }],
  // The side panel's close clears the finding, leaving the modal open.
  [near('[data-action="bundle-source-panel-close"]'), () => {
    if (state.bundleSourceFindingIdx == null) return
    state.bundleSourceFindingIdx = null
    renderPreservingSourceScroll()
  }],
  // A gutter dot opens the side panel on the finding it indexes (into the
  // file's findings, built in render); the same dot again dismisses it.
  [near('[data-bundle-source-finding]'), (el) => {
    const idx = parseInt(el.dataset.bundleSourceFinding, 10)
    if (!Number.isFinite(idx)) return
    state.bundleSourceFindingIdx = state.bundleSourceFindingIdx === idx ? null : idx
    renderPreservingSourceScroll()
  }],
]

// The dedup group whose card or source panel a click landed in, read off the
// nearest data-gid on its path. Not `state.focusGid`: the focus view writes
// that only on an explicit pick, so a first click straight into the card
// would find it null.
function focusedGroupOf(e) {
  const gid = pathClosest(e, '[data-gid]')?.dataset?.gid
  return gid ? findGroupById(gid) : null
}
// The group's active tab, which per-tab actions (copy, link, comment, color) act on.
function focusedTabOf(e) {
  const group = focusedGroupOf(e)
  return group && activeTabFor(group)
}

// The labeled Repo / File / Line / Description / Confidence block the copy
// and Claude buttons hand off (the GitHub-issue link builds the same).
function findingHandoffText(e) {
  const f = focusedTabOf(e)
  return f ? handoffBlock(f, findingRepo(f)) : null
}

// An evidence reference in the focus view loads its file into the Code panel
// beside the card (render-finding.js evidencePanelRef).
function followCodeNav(el, e) {
  pushFocusCode(focusedGroupOf(e), {
    integrity: el.dataset.codeNavIntegrity,
    file: el.dataset.codeNavFile,
    range: lineRange(el.dataset.codeNavLine),
  })
}

async function revealOrAlert(id, name, managedReport) {
  const result = await revealFindingInReport(id, name, managedReport)
  if (!result.ok) alert(result.reason)
}

// The package and repository list + details views share one shape: a row
// selects, the [Issues →] shortcut opens the Issues slide `transient` (backing
// out of it drops the selection too), and a new pick starts on Overview and
// the slide's default `live` bucket.
const ENTITY = {
  package: { id: 'selectedPackage', version: 'selectedPackageVersion', tab: 'packageDetailsTab', triage: 'packageSlideTriage', transient: 'packageSlideTransient' },
  repository: { id: 'selectedRepository', tab: 'repositoryDetailsTab', triage: 'repositorySlideTriage', transient: 'repositorySlideTransient' },
}
function openEntity(kind, id, version, tab, transient) {
  const keys = ENTITY[kind]
  state[keys.id] = id
  if (keys.version) state[keys.version] = version
  state[keys.tab] = tab
  state[keys.triage] = null
  state[keys.transient] = transient
  render()
}
function closeEntity(kind) {
  const keys = ENTITY[kind]
  state[keys.id] = null
  if (keys.version) state[keys.version] = null
}
function setEntityTab(kind, tab) {
  const key = ENTITY[kind].tab
  if ((tab !== 'overview' && tab !== 'issues') || state[key] === tab) return
  state[key] = tab
  render()
}
function entitySlideBack(kind) {
  const keys = ENTITY[kind]
  state[keys.tab] = 'overview'
  state[keys.triage] = null
  if (state[keys.transient]) {
    closeEntity(kind)
    state[keys.transient] = false
  }
  render()
}

const REPORT_CLICKS = [
  [deep('[data-finding-history]'), (_, e) => {
    const finding = focusedTabOf(e)
    if (canViewFindingHistory(finding)) void openFindingHistoryDialog(finding)
  }],
  [deep('[data-code-nav-file]'), (el, e) => { followCodeNav(el, e) }],
  // Back / forward through the Code panel's history (render.js).
  [deep('[data-code-history]'), (el) => { stepFocusCode(el.dataset.codeHistory === 'forward' ? 1 : -1) }],
  // The `</>` beside a finding's code links toggles its inline preview. The
  // Set is replaced, not mutated, so the autorun reading it sees the change;
  // the loader's own settle render fills the snippet in.
  [deep('[data-code-preview]'), (el) => {
    const next = new Set(state.codePreviews)
    toggleIn(next, el.dataset.codePreview)
    state.codePreviews = next
    render()
  }],
  [deep('[data-finding-code-report]'), (el) => {
    if (!isManagedUiMode()) return false
    void openFindingSourceDialog({
      reportId: el.dataset.findingCodeReport,
      file: el.dataset.findingCodeFile,
      line: el.dataset.findingCodeLine,
    })
  }],
  // A card's `[Code]` pops the bundle source viewer over the current view
  // (the overlay slot render.js mounts) without navigating away.
  [deep('[data-finding-code-bundle]'), (el) => {
    const integrity = el.dataset.findingCodeBundle
    const file = el.dataset.findingCodeFile
    const line = el.dataset.findingCodeLine ? parseInt(el.dataset.findingCodeLine, 10) : null
    state.bundleSourceFile = file || null
    state.bundleCodeHistory = null
    state.bundleSourceFindingIdx = null
    // The modal suppresses itself in the Code and Search tabs, which show
    // the source inline.
    if (state.bundleDetailsTab === 'code' || state.bundleDetailsTab === 'search') state.bundleDetailsTab = 'overview'
    // `instant`: the modal pops over the view, and a smooth scroll would
    // visibly drift the line into place.
    const scrollToLine = () => {
      if (Number.isFinite(line)) scrollSourceLineIntoView(line, { block: 'start', behavior: 'instant' })
    }
    if (state.selectedBundle === integrity && state.bundleDetails?.integrity === integrity) {
      // An already-open metadata view may still need source bodies.
      render()
      ensureBundleSources().then(() => {
        if (state.selectedBundle === integrity && state.bundleSourceFile === file) scrollToLine()
        return null
      })
      return
    }
    state.selectedBundle = integrity
    state.selectedBundleWorkspace = null
    state.bundleDetails = null
    render()
    // Once openBundle has parsed and rendered, so the line row exists.
    void openBundle(integrity).then(scrollToLine)
  }],
  // Inside the row `<li>`: before the row's own handlers, or the click would
  // select the row as well.
  [near('[data-package-expand]'), (el) => {
    toggleIn(state.expandedPackages, el.dataset.packageExpand)
    render()
  }],
  [near('[data-package-row-issues]'), (el) => {
    openEntity('package', el.dataset.packageRowIssues, el.dataset.packageRowIssuesVersion || null, 'issues', true)
  }],
  [near('[data-repository-row-issues]'), (el) => { openEntity('repository', el.dataset.repositoryRowIssues, null, 'issues', true) }],
  // An empty version is the package aggregate / only version slot
  // (versionMatchesSelection in render-packages.js).
  [near('[data-select-package]'), (el) => {
    const pkg = el.dataset.selectPackage
    const ver = el.dataset.selectPackageVersion || null
    if (state.selectedPackage === pkg && state.selectedPackageVersion === ver) return
    openEntity('package', pkg, ver, 'overview', false)
  }],
  [near('[data-deselect-package]'), () => {
    closeEntity('package')
    render()
  }],
  [near('[data-package-tab]'), (el) => { setEntityTab('package', el.dataset.packageTab) }],
  [near('[data-action="package-slide-back"]'), () => { entitySlideBack('package') }],
  // Links view and workspace finding report chips open the finding in its
  // original report, keeping the row's grouping and annotations.
  [deep('[data-links-report][data-links-finding]'), (el, e) => {
    e.preventDefault()
    const { linksReport: name, linksFinding: id, managedReport } = el.dataset
    if (name && id) revealOrAlert(id, name, managedReport).catch((err) => console.warn('links: reveal in report failed:', err))
  }],
  // A report chip in the Packages and Repositories details opens that report.
  [near('[data-package-report]'), (el) => { if (el.dataset.packageReport) switchToFile(el.dataset.packageReport) }],
  [near('[data-select-repository]'), (el) => {
    const repo = el.dataset.selectRepository
    if (state.selectedRepository !== repo) openEntity('repository', repo, null, 'overview', false)
  }],
  [near('[data-deselect-repository]'), () => {
    closeEntity('repository')
    render()
  }],
  [near('[data-repository-tab]'), (el) => { setEntityTab('repository', el.dataset.repositoryTab) }],
  [near('[data-action="repository-slide-back"]'), () => { entitySlideBack('repository') }],
  // The bundle view's tab strip. Tabs are paint-only over the cached
  // bundleDetails (Graph and Terminal re-mount their slots in render.js).
  [near('[data-bundle-tab]'), (el) => {
    const tab = el.dataset.bundleTab
    if (!(BUNDLE_TABS.has(tab) || tab === 'review' && state.bundleDetails?.npm || REPOSITORY_FILELESS_TABS.has(tab) && state.bundleDetails?.repository)) return
    // Re-clicking the active tab navigates nowhere — and must not reset the
    // Code slide's open file — but still persists: the render-time coercions
    // (hidden advisories / compare → overview) change the tab without
    // persisting, and this is the one chance to repair that stale suffix.
    if (tab === state.bundleDetailsTab) {
      if (state.selectedBundle) persistLastBundle(state.selectedBundle, tab)
      return
    }
    switchBundleTab(tab)
  }],
  [near('[data-bundle-retry-sources]'), () => {
    if (state.bundleDetails) delete state.bundleDetails.sourceError
    render()
  }],
  // Overview's "Download bundle": the bytes leave the vault decrypted, with
  // every bundled source, so a confirmation fronts the write. The entry
  // lookup guards a stale integrity left after another tab deleted it.
  [near('[data-bundle-download]'), (el) => {
    const integrity = el.dataset.bundleDownload
    const entry = (state.bundles ?? []).find((b) => b.integrity === integrity)
    if (!entry) return
    void (async () => {
      const { confirmed } = await openDownloadBundleDialog({ name: entry.name, encrypted: isEncryptionEnabled() })
      if (!confirmed) return
      try {
        const bytes = await readBundle(integrity)
        downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), entry.name)
      } catch (err) {
        alert(`Failed to download bundle: ${err.message}`)
      }
    })()
  }],
  // SPDX / CycloneDX, serialized from the parsed inventory — if the open
  // details still match the selected bundle a cross-tab switch could swap.
  [near('[data-bundle-export-sbom]'), (el) => {
    const format = el.dataset.bundleExportSbom
    const details = state.bundleDetails
    const entry = (state.bundles ?? []).find((b) => b.integrity === state.selectedBundle)
    if (!entry || !details || details.integrity !== entry.integrity) return
    const cdx = format === 'cyclonedx'
    try {
      const text = cdx ? bundleToCycloneDx(details, entry) : bundleToSpdx(details, entry)
      downloadBlob(new Blob([text], { type: 'application/json' }), `${sbomBaseName(entry.name)}.${cdx ? 'cdx' : 'spdx'}.json`)
    } catch (err) {
      alert(`Failed to export ${cdx ? 'CycloneDX' : 'SPDX'}: ${err.message}`)
    }
  }],
  // Search's Context pill: matches with or without their surrounding lines.
  [deep('[data-bundle-search-context]'), () => {
    state.bundleSearchContext = !state.bundleSearchContext
    renderPreservingScrollOf('.bundle-search-results')
  }],
  // Advisories' first-visit consent; the next render's fetch sees it.
  [near('[data-advisories-consent]'), () => {
    grantAdvisoriesProxyConsent()
    render()
  }],
  // Retry drops the sticky error; the render paints the loading line.
  [near('[data-advisories-retry]'), () => {
    retryBundleAdvisories(state.bundleDetails, render).catch(() => {})
    render()
  }],
  [near('[data-bundle-issue-report]'), (el) => { if (el.dataset.bundleIssueReport) switchToFile(el.dataset.bundleIssueReport) }],
  ...SOURCE_CLICKS,
  // The Code slide's issue stepper (‹ ›) cycles the side panel through the
  // open file's findings in line order, wrapping; the (idx, line) pairs ride
  // on the stepper's container.
  [near('[data-bundle-code-issue-step]'), (el) => {
    let order = null
    try { order = JSON.parse(el.closest('[data-bundle-code-issue-order]')?.dataset.bundleCodeIssueOrder ?? 'null') } catch {}
    if (!Array.isArray(order) || order.length === 0) return
    const step = el.dataset.bundleCodeIssueStep === '-1' ? -1 : 1
    const pos = order.findIndex((o) => o.idx === state.bundleSourceFindingIdx)
    // With nothing selected, forward starts at the first and back at the last.
    const next = pos === -1
      ? (step > 0 ? order[0] : order.at(-1))
      : order[(pos + step + order.length) % order.length]
    state.bundleSourceFindingIdx = next.idx
    renderPreservingSourceScroll()
    if (next.line > 0) scrollSourceLineIntoView(next.line, { block: 'center', behavior: 'smooth' })
  }],
  [deep('[data-bundle-view-source]'), (el) => {
    const path = el.dataset.bundleViewSource
    if (!path) return
    // An Issues-mode result opens the side panel on its finding. The index is
    // into the previous file's findings, so it never carries to another file.
    const findingIdx = el.dataset.bundleViewFindingIdx === undefined ? null : parseInt(el.dataset.bundleViewFindingIdx, 10)
    const line = el.dataset.bundleViewLine ? parseInt(el.dataset.bundleViewLine, 10) : null
    const hasLine = Number.isFinite(line)
    // A line is the file's as published: not a pretty-printed copy's
    // (pretty-source.js), nor a lockfile's package list.
    if (hasLine) {
      state.bundleSourcePretty = false
      state.bundleSourceLockfile = false
    }
    const pathChanged = state.bundleSourceFile !== path
    selectBundleSourceFile(path)
    if (Number.isFinite(findingIdx)) state.bundleSourceFindingIdx = findingIdx
    else if (pathChanged) state.bundleSourceFindingIdx = null
    // Mark the line a result opened; a file opened without one clears it.
    state.bundleSourceTargetLine = hasLine ? { bundle: state.bundleDetails?.integrity ?? null, path, line } : null
    // Keep the scroll of the list the click came from.
    const list = [['.bundle-code-rail', '.bundle-code-rail-body'], ['.bundle-search-results'], ['.bundles-slide-body']].find(([within]) => el.closest(within))
    if (list) renderPreservingScrollOf(list.at(-1))
    else render()
    if (!hasLine) return
    // Code-search hits land at the top (`data-bundle-view-scroll-block`),
    // Issues and gutter dots centered.
    const block = el.dataset.bundleViewScrollBlock || 'center'
    ensureBundleSources().then(() => {
      if (state.bundleSourceFile === path) scrollSourceLineIntoView(line, { block, behavior: 'smooth' })
      return null
    })
  }],
  [near(['reports', 'bundles', 'repositories', 'dependencies'].map(kind => `[data-action="workspace-${kind}"]`).join(', ')), (el) => {
    const kind = el.dataset.action.slice('workspace-'.length)
    if (state.currentView !== `workspace-${kind}`) void switchToWorkspaceContent(state.currentManagedTeam ?? state.currentWorkspace, kind)
  }],
  [near('[data-action="workspace-findings"]'), () => {
    if (state.currentView === 'findings') return
    if (state.currentView === 'files') {
      if (navigateManagedReportView('findings')) return
      state.currentView = 'findings'
      state.filesSelectedFile = null
      document.body.classList.remove('report-fullscreen')
      render()
    } else if (isManagedUiMode()) void switchToManagedTeam(currentManagedTeam())
    else void switchToWorkspace(state.currentWorkspace)
  }],
  [near('[data-workspace-report]'), (el) => {
    if (isManagedUiMode()) void switchToManagedTeam(currentManagedTeam(), el.dataset.workspaceReport)
    else void switchToFile(el.dataset.workspaceReport, undefined, { workspaceId: state.currentWorkspace })
  }],
  // A team's repository, from its Repositories list: its code, at the path
  // the team links it by where it links one.
  [near('[data-workspace-repository]'), (el) => {
    const { workspaceRepository: repoId, repositoryName: repo, repositoryPath: path } = el.dataset
    document.dispatchEvent(new CustomEvent('managed-repository-code-open', { detail: { repoId: Number(repoId), repo, path } }))
  }],
  [near('[data-workspace-bundle]'), (el) => {
    const bundleId = el.dataset.workspaceBundle
    if (isManagedUiMode()) {
      void managedHistory.navigate(managedRouteForIds({ view: 'bundles', teamId: state.currentManagedTeam, bundleId, bundleTab: 'overview' }, state.managedTeams))
    } else void showStoredBundle(bundleId, 'overview', { workspaceId: state.currentWorkspace })
  }],
  // The page header's Files toggle. The in-findings graph tears its canvas
  // down explicitly, dropping its viewport cache and hover state cleanly.
  [near('[data-action="toggle-files"]'), () => {
    const files = state.currentView === 'files'
    if (navigateManagedReportView(files ? 'findings' : 'files')) return
    if (!files && state.viewMode === 'graph') cleanupGraph2()
    state.currentView = files ? 'findings' : 'files'
    document.body.classList.remove('report-fullscreen')
    render()
  }],
  // Graph controls, ahead of the generic tab handlers below. (Its severity
  // and color chips dispatch `severity-toggle` / `color-toggle`, and its path
  // filter an `input`, handled further down.)
  //
  // A Top packages row solos its package, again un-solos. Soloing drops the
  // file selection, so the selection card shows the package.
  [deep('[data-g2-pkg]'), (el) => {
    const pkg = el.dataset.g2Pkg
    graph2.solo = graph2.solo === pkg ? null : pkg
    if (graph2.solo) graph2.selected = null
    refreshActiveGraphSidebar()
    refreshActiveGraphTopPkgs()
    graph2.graphState?.requestDraw?.()
  }],
  // The canvas paints the selection ring, so redraw now rather than on the
  // next hover.
  [deep('[data-g2-select]'), (el) => {
    graph2.selected = el.dataset.g2Select
    refreshActiveGraphSidebar()
    graph2.graphState?.requestDraw?.()
  }],
  // Top packages' Issues / Files tabs: the right panel only.
  [deep('[data-g2-top-pkgs]'), (el) => {
    graph2.topPkgsTab = el.dataset.g2TopPkgs
    refreshActiveGraphTopPkgs()
  }],
  [deep('[data-g2-jump-findings]'), (el) => {
    // A bundle's file isn't in `state.reports`: its findings are the
    // bundle's Issues tab.
    if (state.currentView === 'bundles') {
      if (state.bundleDetailsTab === 'graph') cleanupGraph2()
      goBundleTab('issues')
      render()
      return
    }
    resetFilters()
    state.filterConfMin = 0
    state.filterInclude = el.dataset.g2JumpFindings
    state.currentView = 'findings'
    // The include filter has no UI in the graph, so land on a list.
    if (state.viewMode === 'graph') state.viewMode = 'table'
    cleanupGraph2()
    if (navigateManagedReportView('findings')) return
    render()
  }],
  [deep('[data-g2-jump-file]'), (el) => {
    const targetFile = el.dataset.g2JumpFile
    cleanupGraph2()
    const revealFile = () => requestAnimationFrame(() => {
      document.querySelector(`#${treeAnchor(targetFile)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    const navigation = navigateManagedReportView('files')
    if (navigation) { void navigation.then(ok => ok ? revealFile() : undefined); return }
    state.currentView = 'files'
    render()
    revealFile()
  }],
  // CSS hides the clear button once the input is empty, so no render.
  [deep('#g2-path-filter-clear'), () => {
    graph2.pathFilter = ''
    const input = document.querySelector('graph-layout')?.shadowRoot?.querySelector('#g2-path-filter')
    if (input) input.value = ''
    graph2.graphState?.requestDraw?.()
  }],
  // body.report-fullscreen sizes the layout to the viewport; the stage's
  // ResizeObserver refits the canvas.
  [deep('#g2-fullscreen'), () => { document.body.classList.toggle('report-fullscreen') }],
  // Show all changes the file set; the selection may be filtered out.
  [deep('[data-g2-show-all]'), () => {
    graph2.showAll = !graph2.showAll
    rebuildGraph('selected')
  }],
  // One node per file or per package. A file selection means nothing on a
  // package canvas, and package focus goes with it; a solo'd package stays.
  [deep('[data-g2-packages-view]'), () => {
    if (graph2.bundleLayout === 'flow') graph2.flowPackagesView = !graph2.flowPackagesView
    else if (graph2.bundleLayout === 'dependencies') {
      graph2.dependencyPackagesView = !graph2.dependencyPackagesView
      graph2.solo = null
    } else graph2.packagesView = !graph2.packagesView
    rebuildGraph('selected', 'focusedPkg')
  }],
  // Findings reach the bundle graph only while Issues is on. Layouts don't
  // depend on them, so the nodes, selection and viewport all stay.
  [deep('[data-g2-bundle-issues]'), () => {
    graph2.bundleIssues = !graph2.bundleIssues
    cleanupGraph2({ keepViewport: true })
    render()
  }],
  [deep('[data-g2-layout]'), (el) => {
    const next = el.dataset.g2Layout
    if (!['graph', 'layers', 'matrix', 'dependencies', 'flow', 'package-flow'].includes(next)) return
    if (graph2.bundleLayout === next && !graph2.focusedPkg) return
    graph2.bundleLayout = next
    if (next === 'dependencies') graph2.dependencyPackagesView = false
    rebuildGraph('selected', 'solo', 'focusedPkg')
  }],
  // The topbar's triage selector rebuilds the graph over the new file set.
  [deep('.graph2-triage-selector [data-triage-show]'), (el) => {
    const next = el.dataset.triageShow
    state.shownTriage = state.shownTriage === next ? null : next
    rebuildGraph('selected')
  }],
  // "Package graph →": one package's intra-imports.
  [deep('[data-g2-focus-pkg]'), (el) => {
    graph2.focusedPkg = el.dataset.g2FocusPkg
    rebuildGraph()
  }],
  // Back from package focus keeps the selection, except landing on the
  // packages view (which focus suspended): a file picked inside the drill-in
  // has no node there. A stale `packagesView` on a graph whose gate is off
  // over-clears, which beats under-clearing at package altitude.
  [deep('#g2-back-to-full'), () => {
    graph2.focusedPkg = null
    if (graph2.packagesView || graph2.bundleLayout === 'layers') graph2.selected = null
    rebuildGraph()
  }],
  // A finding's tab strip, possibly inside `<finding-table>`'s shadow DOM.
  [deep('.tab'), (el, e) => {
    if (!pathClosest(e, '.tabs')) return false
    state.activeTabByGroup.set(pathClosest(e, '[data-gid]').dataset.gid, el.dataset.tid)
    renderPreservingTableScroll()
  }],
  // An option in the triage menu: a top-layer `popover="auto"`, so the gid
  // is on the popover root, and the button (no popovertarget) closes it.
  // Set-or-clear is `triageActionPlan`'s call, made once for the whole scope:
  // a re-click must switch the group off, not flip each tab. Clearing (also
  // Restore) writes the same 'untriaged' the kanban's untriaged column does.
  [deep('[data-triage-action]'), (el) => {
    const popover = el.closest('.triage-menu')
    const gid = popover?.dataset.gid
    const group = gid ? findGroupById(gid) : null
    const action = el.dataset.triageAction
    if (!group || !['inprogress', 'fixed', 'invalid', 'deleted', 'ignored', 'restore'].includes(action)) return
    const { targets, clearing } = triageActionPlan(group, action)
    if (targets.length === 0) return
    applyTriage(targets, clearing ? 'untriaged' : action)
    try { popover.hidePopover() } catch {}
    saveTriage()
    renderPreservingTableScroll()
  }],
  // The active tab's comment; an empty one clears the entry rather than
  // saving "". The dialog resolves null on cancel or an unchanged save.
  [deep('.mark-comment'), (_, e) => {
    const activeTab = focusedTabOf(e)
    if (!activeTab || !canTriageFinding(activeTab)) return
    if (isManagedUiMode()) {
      openManagedCommentsDialog(activeTab, renderPreservingTableScroll)
        .catch(() => showToast('Could not open comments. Please retry.'))
      return
    }
    const key = tabKey(activeTab)
    openCommentDialog({ initial: triageEntry(activeTab)?.comment ?? '', finding: activeTab }).then((next) => {
      if (next === null || !canEditTriage(activeTab)) return null
      patchEntry(state.triage, key, { comment: next || undefined })
      saveTriage()
      renderPreservingTableScroll()
      return null
    }).catch(() => {})
  }],
  [deep('.mark-copy'), (el, e) => {
    const text = findingHandoffText(e)
    if (text !== null) copyWithPulse(el, text)
  }],
  // A `#finding=<id>` URL reopening the app on this finding
  // (finding-link-nav.js). Null only for a session-local id, whose button
  // render-finding.js withholds.
  [deep('.mark-link'), (el, e) => {
    const finding = focusedTabOf(e)
    const url = finding && findingLinkFor(finding)
    if (url) copyWithPulse(el, url)
  }],
  // The page header's report name(s), and the Code slide's full file path.
  [deep('[data-copy-report]'), (el) => { copyWithPulse(el, el.dataset.copyReport) }],
  [deep('[data-copy-path]'), (el) => { copyWithPulse(el, el.dataset.copyPath) }],
  // A team member's issue opens the managed dialog; otherwise the button is
  // the GitHub link it is.
  [deep('.mark-issue'), (el, e) => {
    if (!isManagedUiMode() || !state.managedSession || state.managedSession.publicShare || !state.currentManagedTeam) return false
    const finding = focusedTabOf(e)
    if (!finding?._managedReportId || !finding.id) return false
    e.preventDefault()
    const url = new URL(el.dataset.issueForm)
    const draftOptions = () => ({ ...issueDraftOptions(finding), findingLink: findingLinkFor(finding) })
    void openManagedIssueDialog({ teamId: state.currentManagedTeam, session: { ...state.managedSession },
      context: { reportId: finding._managedReportId, findingId: finding.id, repository: url.pathname.split('/').slice(1, 3).join('/') },
      formUrl: url.href, title: url.searchParams.get('title') ?? '',
      finding, draftOptions: draftOptions(),
      // The draft again once the bundle says where the evidence in
      // dependencies is (focus-code.js), which a card need not have read.
      draftOptionsReady: loadBundleDependencyRepos(finding).then(draftOptions),
      renderBody: renderHighlighted, render,
    }).catch(() => showToast('Could not open issue creation. Please retry.'))
  }],
  // Hands the finding block to Claude Code through its URL scheme.
  [deep('.mark-claude'), (el, e) => {
    const text = findingHandoffText(e)
    if (text === null) return
    // Built outside the try: a malformed text's URIError surfaces, as before.
    const url = `claude://code/new?q=${encodeURIComponent(`Confirm and fix:\n\n${text}`)}`
    try {
      window.location.href = url
      pulseCopied(el)
    } catch {}
  }],
  // The fix link (typically a PR URL), per active tab; an empty one clears
  // it. The dialog offers to widen the edit to the whole group where the
  // group agrees (canApplyFixToGroup) — the group as the data has it, with
  // the revalidation rows the App lens drops from the rendered one
  // (`groupWithPassRows`): the PR fixing the base finding fixes its
  // re-rating too. The active tab and its pin stay on the rendered group.
  [deep('.mark-fix'), (_, e) => {
    const gid = pathClosest(e, '[data-gid]')?.dataset.gid
    const group = gid ? findGroupById(gid) : null
    if (!group) return
    const activeTab = activeTabFor(group)
    if (!canEditTriage(activeTab)) return
    const whole = groupWithPassRows(group)
    const current = triageEntry(activeTab)?.fix ?? ''
    openFixLinkDialog({
      initial: current,
      finding: activeTab,
      canApplyToGroup: canApplyFixToGroup(whole, current),
    }).then((next) => {
      if (next === null || !canEditTriage(activeTab)) return null
      // The offer was granted before the dialog opened; `fixApplies` asks
      // again per tab, lest a link a sync peer or another tab landed on a
      // sibling meanwhile be overwritten.
      const targets = next.scope === 'group'
        ? whole.filter((f) => canEditTriage(f) && (f === activeTab || fixApplies(f, current)))
        : [activeTab]
      let changed = false
      for (const f of targets) {
        if (patchEntry(state.triage, tabKey(f), { fix: next.value || undefined })) changed = true
      }
      if (!changed) return null
      // A fix link is a mark `activeTabFor` picks the default tab by, so
      // writing every sibling would swap the card under the reader: pin it.
      if (targets.length > 1) state.activeTabByGroup.set(gid, tabKey(activeTab))
      renderPreservingTableScroll()
      // Paint first, persist after (see the kanban drop below).
      queueMicrotask(saveTriage)
      return null
    }).catch(() => {})
  }],
  // The attention flag, per exact tab key. Un-flagging writes `false`, never
  // undefined, so the removal is a syncable change that overrides a peer's
  // stale `true` (TriageEntry.flagged).
  [deep('[data-flag-toggle]'), (el, e) => {
    const key = el.dataset.flagToggle
    const finding = focusedGroupOf(e)?.find((f) => tabKey(f) === key)
    if (!finding || !canEditTriage(finding)) return
    patchEntry(state.triage, key, { flagged: triageEntry(finding)?.flagged !== true })
    saveTriage()
    renderPreservingTableScroll()
  }],
  // The toolbar's triage selector: filters still apply, against that bucket.
  [near('[data-triage-show]'), (el) => {
    if (el.closest('.graph2-triage-selector')) return false
    const next = el.dataset.triageShow
    state.shownTriage = state.shownTriage === next ? null : next
    render()
  }],
  [near('[data-table-deselect]'), () => {
    state.tableSelectedGid = null
    renderPreservingTableScroll()
  }],
  // The Files tab's rows toggle the details panel's file.
  [near('[data-tree-select]'), (el) => {
    const file = el.dataset.treeSelect
    state.filesSelectedFile = state.filesSelectedFile === file ? null : file
    render()
  }],
  [near('[data-tree-deselect]'), () => {
    state.filesSelectedFile = null
    render()
  }],
]
report.addEventListener('click', (e) => { runClicks(REPORT_CLICKS, e) })

// The bundle source modal's slot is outside #report.
document.querySelector('#bundle-source-overlay-slot')?.addEventListener('click', (e) => runClicks(SOURCE_CLICKS, e))

// Opening a finding's details (table aside, kanban modal, focus card) is
// where a partially-triaged group gets levelled (syncGroupTriage in
// group.js); the caller's render picks up what changed. Persisted after that
// render, like the kanban drop: these sit on click and arrow-key paths.
function syncOpenedGroupTriage(gid) {
  const group = gid ? findGroupById(gid) : null
  if (group && syncGroupTriage(group)) queueMicrotask(saveTriage)
}

// `<finding-table>` dispatches this (composed) for a row click; the same
// row again closes the details panel.
report.addEventListener('row-select', (e) => {
  const gid = e.detail?.gid
  if (!gid) return
  const opening = state.tableSelectedGid !== gid
  state.tableSelectedGid = opening ? gid : null
  if (opening) syncOpenedGroupTriage(gid)
  renderPreservingTableScroll()
})

// Kanban drag-and-drop: a `.kanban-card` drags onto a `.kanban-column`
// whose `data-kanban-target` names a triage state.
const KANBAN_DATA_TYPE = 'application/x-deepview-kanban-gid'

// Write one triage target onto every tab in `targets`. Callers decide
// set-vs-clear for the whole scope first (`triageActionPlan`), so every tab
// of a group lands on the same answer.
function applyTriage(targets, target) {
  for (const f of targets) {
    if (!canEditTriage(f)) continue
    setFindingTriage(state.triage, f, target, depsDirName())
  }
}

function clearKanbanDragChrome() {
  for (const el of report.querySelectorAll('.kanban-card.dragging')) el.classList.remove('dragging')
  for (const el of report.querySelectorAll('.kanban-column.drag-over')) el.classList.remove('drag-over')
}

report.addEventListener('dragstart', (e) => {
  const card = e.target.closest?.('.kanban-card[data-kanban-source]')
  if (!card || !e.dataTransfer) return
  const gid = card.dataset.gid
  if (!gid) return
  const group = findGroupById(gid)
  if (!group || triageScope(group).length === 0) { e.preventDefault(); return }
  // The private type is what the drop checks; text/plain shows the gid when
  // dragged out of the app.
  e.dataTransfer.setData(KANBAN_DATA_TYPE, gid)
  e.dataTransfer.setData('text/plain', gid)
  e.dataTransfer.effectAllowed = 'move'
  card.classList.add('dragging')
})

report.addEventListener('dragend', clearKanbanDragChrome)

report.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes(KANBAN_DATA_TYPE)) return
  const col = e.target.closest?.('.kanban-column[data-kanban-target]')
  if (!col) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  if (col.classList.contains('drag-over')) return
  for (const other of report.querySelectorAll('.kanban-column.drag-over')) {
    if (other !== col) other.classList.remove('drag-over')
  }
  col.classList.add('drag-over')
})

report.addEventListener('dragleave', (e) => {
  const col = e.target.closest?.('.kanban-column[data-kanban-target]')
  // `dragleave` fires on entering a child too; only leaving the column counts.
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over')
})

report.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.types.includes(KANBAN_DATA_TYPE)) return
  const col = e.target.closest?.('.kanban-column[data-kanban-target]')
  if (!col) {
    clearKanbanDragChrome()
    return
  }
  e.preventDefault()
  const gid = e.dataTransfer.getData(KANBAN_DATA_TYPE)
  const target = col.dataset.kanbanTarget
  clearKanbanDragChrome()
  if (!gid || !target) return
  const group = findGroupById(gid)
  // A drop on its own column changes nothing.
  if (!group || (groupState(group).commonTriage ?? 'untriaged') === target) return
  // The column names the state outright, so only the scope is a question.
  const targets = triageScope(group)
  if (targets.length === 0) return
  applyTriage(targets, target)
  // Paint first, persist after: saveTriage's synchronous head serializes the
  // whole triage map into localStorage, which would stall the frame the card
  // snaps to its column in.
  render()
  queueMicrotask(saveTriage)
})

// The kanban detail modal opens and closes through a view transition: the
// card and modal share the transition name, and findings.css animates
// `::view-transition-{new,old}(kanban-detail-modal)`; on close, CSS keeps the
// card image's text size while its background follows the morph.
//
// Starting a transition against a still-active one makes the browser skip
// it, running its callback synchronously against just-updated state and
// leaving no transition able to render again, so `kanbanTransitioning`
// swallows open / close clicks until the in-flight one settles.
let kanbanTransitioning = false

// W95 and Paper open and close the dialog in place, as a window and a
// printed page would: no flight out of the card, no fade.
const STILL_THEMES = ['theme-w95', 'theme-paper']
function kanbanAnimates() {
  return Boolean(document.startViewTransition)
    && !STILL_THEMES.some(theme => document.body.classList.contains(theme))
}

function kanbanCardEl(gid) {
  if (!gid) return null
  return report.querySelector(`.kanban-card[data-gid="${CSS.escape(gid)}"]`)
}

// Stamp a card's size on the root as the floor of the modal's clip animation
// (findings.css kanban-clip-*), so its "small" frame overlaps the card rather
// than collapsing to a zero-area rect that exposes the old snapshot's edges.
// Floored: underestimating is harmless, overestimating spoils the animation.
function updateKanbanClipVars(stampedCard) {
  const card = stampedCard ?? report.querySelector('.kanban-card')
  if (!card) return
  const rect = card.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const root = document.documentElement.style
  root.setProperty('--kanban-clip-card-w', `${Math.floor(rect.width)}px`)
  root.setProperty('--kanban-clip-card-h', `${Math.floor(rect.height)}px`)
  root.setProperty('--kanban-return-card-bg', getComputedStyle(card).backgroundColor)
}

// A trail of followed Code references belongs to the finding that was on
// screen, as in the focus view: a new finding starts the panel afresh.
function resetFocusCode() {
  state.focusCodeStack = []
  state.focusCodeAt = 0
}

// Every change of the dialog's finding, the close included, comes through
// here. Once rendered, a fullscreen dialog's Code panel moves to the lines the
// finding cites (revealFocusCodeLines): Lit reuses `.focus-code-body`, whose
// scroll would otherwise survive the swap.
function setKanbanPopoverGid(next) {
  const prev = state.kanbanPopoverGid
  if (prev === next) return
  const opening = prev === null && next !== null
  const closing = prev !== null && next === null
  // Card-to-card switches swap the modal's contents in place, with no
  // transition, so they go through even while one is in flight.
  if (!kanbanAnimates() || (!opening && !closing)) {
    syncOpenedGroupTriage(next)
    state.kanbanPopoverGid = next
    resetFocusCode()
    render()
    revealFocusCodeLines()
    return
  }
  if (kanbanTransitioning) return
  // Levelled past the lock only, which would swallow the click.
  syncOpenedGroupTriage(next)
  kanbanTransitioning = true
  // Opening hides the old card snapshot; closing keeps the new card visible
  // and stops its text scaling with the animated box.
  const directionClass = opening ? 'kanban-opening' : 'kanban-closing'
  document.documentElement.classList.add(directionClass)
  // The modal has `view-transition-name: kanban-detail-modal` in CSS; the
  // card it flies out of (or back into) gets the same name inline, so the
  // browser pairs the two. `finished` can fail to ever settle on an odd
  // interruption, so a timeout (the animation is ~200ms) releases the lock.
  const settle = (transition, card) => {
    const unlock = () => {
      const el = card()
      if (el) el.style.viewTransitionName = ''
      document.documentElement.classList.remove(directionClass)
      kanbanTransitioning = false
    }
    const safety = setTimeout(unlock, 600)
    void (async () => {
      try { await transition.finished } catch {}
      clearTimeout(safety)
      unlock()
    })()
  }
  if (opening) {
    const card = kanbanCardEl(next)
    if (card) {
      // Measuring flushes styles; the second read commits the inline name to
      // the style tree the old snapshot is taken from.
      updateKanbanClipVars(card)
      card.style.viewTransitionName = 'kanban-detail-modal'
      card.getBoundingClientRect()
    } else updateKanbanClipVars()
    state.kanbanPopoverGid = next
    resetFocusCode()
    settle(startViewTransition(() => {
      render()
      // Inside the callback, so the new snapshot captures the panel already
      // moved (the rail brings the open card into view a microtask later,
      // still before the capture).
      revealFocusCodeLines()
      // Two elements with the name would make the browser skip the pairing.
      if (card) card.style.viewTransitionName = ''
    }), () => card)
    return
  }
  updateKanbanClipVars()
  state.kanbanPopoverGid = next
  resetFocusCode()
  let closeCard = null
  settle(startViewTransition(() => {
    render()
    closeCard = kanbanCardEl(prev)
    if (!closeCard) return
    // Re-measured: the rendered card may have changed size.
    updateKanbanClipVars(closeCard)
    closeCard.style.viewTransitionName = 'kanban-detail-modal'
  }), () => closeCard ?? kanbanCardEl(prev))
}

// Step the open modal through its column's cards, clamped at the ends, so
// the arrows walk findings that share a triage state.
function navigateKanban(direction) {
  const current = kanbanCardEl(state.kanbanPopoverGid)
  const column = current?.closest('.kanban-column')
  if (!column) return
  const cards = [...column.querySelectorAll('.kanban-card[data-kanban-source]')]
  const idx = cards.indexOf(current)
  if (idx < 0) return
  const nextIdx = Math.min(Math.max(idx + direction, 0), cards.length - 1)
  if (nextIdx === idx) return
  const nextGid = cards[nextIdx].dataset.gid
  if (!nextGid) return
  setKanbanPopoverGid(nextGid)
  // The open card's ring is the state-driven `.active`; moving focus too
  // keeps its `:focus-visible` ring off the originally clicked card. The
  // modal covers the board, so the scroll is unseen until the close morph.
  const card = kanbanCardEl(nextGid)
  if (card) {
    card.focus({ preventScroll: true })
    card.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }
}

let linksPreviewTrigger = null

function dismissLinksPreview() {
  closeLinksPreview()
  resetFocusCode()
  render()
  if (linksPreviewTrigger?.isConnected) linksPreviewTrigger.focus({ preventScroll: true })
  linksPreviewTrigger = null
}

const KANBAN_CLICKS = [
  [deep('[data-links-preview]'), (el, e) => {
    e.preventDefault()
    linksPreviewTrigger = el
    const rowIndex = el.dataset.previewRow
    const loading = openLinksPreview(el.dataset.linksPreview, el.dataset.previewReport,
      rowIndex === undefined ? undefined : Number(rowIndex), el.dataset.previewManagedReport)
    render()
    report.querySelector('.kanban-detail-close')?.focus({ preventScroll: true })
    void loading.then(() => {
      render()
      revealFocusCodeLines()
      // Only the saved hash index, as report navigation reads; unopened
      // bundle bodies stay unloaded.
      const hashes = getLinksPreview()?.group?.[0]._bundleHashes
      if (Array.isArray(hashes)) {
        for (const integrity of hashes) prefetchBundleHashes(integrity).catch(() => {})
      }
      return null
    })
  }],
  [near('.kanban-detail-close'), () => {
    if (getLinksPreview()) dismissLinksPreview()
    else setKanbanPopoverGid(null)
  }],
  // The dialog's fullscreen toggle, persisted for the next dialog. A plain
  // render, not a view transition: the morph's clip floor is the source
  // card's size, which would collapse the dialog and grow it back.
  [near('[data-kanban-detail-fullscreen]'), () => {
    state.kanbanDetailFullscreen = !state.kanbanDetailFullscreen
    try {
      localStorage.setItem(KANBAN_DETAIL_FULLSCREEN_KEY, String(state.kanbanDetailFullscreen))
    } catch {}
    render()
    // Fullscreen mounts the code panel, at the top of the file.
    revealFocusCodeLines()
  }],
  // A column header's fullscreen toggle. Expanding a different column than
  // the open card's unmounts that card, leaving the modal nothing to close
  // back into, so it closes.
  [near('[data-kanban-expand]'), (el) => {
    const key = el.dataset.kanbanExpand
    const next = state.kanbanExpandedColumn === key ? null : key
    state.kanbanExpandedColumn = next
    if (next && state.kanbanPopoverGid) {
      const openColumn = kanbanCardEl(state.kanbanPopoverGid)?.closest('.kanban-column')
      if (openColumn?.dataset.kanbanTarget !== next) state.kanbanPopoverGid = null
    }
    render()
  }],
  // The rail header's prev / next: the ← / → column walk, for the mouse.
  [near('[data-kanban-nav]'), (el) => { navigateKanban(el.dataset.kanbanNav === 'next' ? 1 : -1) }],
  // A card in the dialog's rail. Re-clicking the open one keeps it: in the
  // rail the active card marks position, it isn't what the dialog came from.
  [near('[data-kanban-select]'), (el, e) => {
    if (endsSelection(e)) return
    if (el.dataset.gid) setKanbanPopoverGid(el.dataset.gid)
  }],
  // A compact card's action buttons run their own delegates; a read-only fix
  // note opens the card like the rest of it.
  [near('.kanban-action:not(.kanban-fix-note)'), () => {}],
  // A board card opens, switches or (the open one) closes the modal. The
  // backdrop is pointer-events: none, so this also fires for a card behind it.
  [near('.kanban-card[data-kanban-source]'), (el, e) => {
    if (endsSelection(e)) return
    const gid = el.dataset.gid
    if (gid) setKanbanPopoverGid(state.kanbanPopoverGid === gid ? null : gid)
  }],
  // Inside the modal or the rail's chrome isn't outside the dialog. The path
  // still says so when an earlier listener's navigation replaced the markup.
  [deep('.kanban-detail-modal, .kanban-detail-side'), () => {}],
]
report.addEventListener('click', (e) => {
  if (runClicks(KANBAN_CLICKS, e)) return
  // Anywhere else light-dismisses.
  if (getLinksPreview()) dismissLinksPreview()
  else if (state.kanbanPopoverGid) setKanbanPopoverGid(null)
})

// The rail header's column picker lands on the bucket's first finding, whose
// gid rides on the option.
report.addEventListener('change', (e) => {
  const select = e.target.closest?.('[data-kanban-column]')
  if (!select) return
  const gid = select.selectedOptions[0]?.dataset.gid
  if (gid) setKanbanPopoverGid(gid)
})

// Esc unwinds one layer per press, the topmost (key-layers.js): a dialog or
// popover over it all closes itself, the source viewer has its own listener,
// then the links preview or the kanban modal (not `<dialog>`s, so view
// transitions stay in charge), then a fullscreen column.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  const layer = findingsEscapeLayer(e, {
    sourceViewer: bundleSourceModalShown(),
    linksPreview: !!getLinksPreview(),
    kanbanModal: !!state.kanbanPopoverGid,
    // The expansion outlives a trip to another view, where Esc belongs to
    // whatever is on screen.
    kanbanColumn: state.viewMode === 'kanban' && state.kanbanExpandedColumn !== null,
  })
  if (layer === 'links-preview') dismissLinksPreview()
  else if (layer === 'kanban-modal') setKanbanPopoverGid(null)
  else if (layer === 'kanban-column') {
    state.kanbanExpandedColumn = null
    render()
  }
})

// Move the focus view's Code panel to `pos`, from a link followed in
// `group`'s card (stack rules in focus-code-history.js). A null `pushed`
// means the panel already shows exactly this: no entry, no repaint, just
// back onto those lines.
function pushFocusCode(group, pos) {
  if (!pos.integrity || !pos.file) return
  const history = focusCodeHistory(group)
  if (!history) return
  const next = pushed(history, pos)
  if (next) {
    state.focusCodeStack = next.stack
    state.focusCodeAt = next.at
    render()
  }
  if (!pos.range) resetFocusCodeScroll()
  revealFocusCodeLines()
}

function resetFocusCodeScroll() {
  for (const body of report.querySelectorAll('.focus-code-body')) {
    body.scrollTop = 0
    body.scrollLeft = 0
  }
}

// The panel's references are `role="link"` spans (render-finding.js says
// why), so their keyboard activation is ours: Enter, and Space, which would
// otherwise scroll the pane away from the lines asked for.
report.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const codeNav = pathClosest(e, '[data-code-nav-file]')
  if (!codeNav) return
  e.preventDefault()
  followCodeNav(codeNav, e)
})

// Back (-1) / forward (+1) through the panel's history; the buttons are
// disabled at the ends, so a no-op there only catches a stale render.
function stepFocusCode(direction) {
  const next = stepped(state.focusCodeStack, state.focusCodeAt, direction)
  if (next === state.focusCodeAt) return
  state.focusCodeAt = next
  render()
  if (!state.focusCodeStack[next]?.range) resetFocusCodeScroll()
  revealFocusCodeLines()
}

function setFocusGid(gid) {
  if (!gid || state.focusGid === gid) return
  syncOpenedGroupTriage(gid)
  state.focusGid = gid
  resetFocusCode()
  render()
  // Bring the active card into view in the queue without animation, which
  // would lag an arrow-key run-through; only the sidebar scrolls.
  report.querySelector('.focus-side-card.active')?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  // And put the finding's whole cited block in view in the Code panel, when
  // it is mounted (focus-code.js).
  revealFocusCodeLines()
}

// Step the focus through the rendered "up next" queue, clamped at the ends:
// a wrap would surprise mid-triage. Shared by the top bar and the arrows.
function navigateFocus(direction) {
  const cards = [...report.querySelectorAll('.focus-side-card[data-focus-select]')]
  if (cards.length === 0) return
  const idx = cards.findIndex((c) => c.classList.contains('active'))
  const nextIdx = idx < 0
    ? (direction > 0 ? 0 : cards.length - 1)
    : Math.min(Math.max(idx + direction, 0), cards.length - 1)
  if (nextIdx === idx) return
  const nextGid = cards[nextIdx].dataset.gid
  if (nextGid) setFocusGid(nextGid)
}

const FOCUS_CLICKS = [
  [near('[data-focus-nav]'), (el) => { navigateFocus(el.dataset.focusNav === 'next' ? 1 : -1) }],
  // A queue card swaps the centered finding (not on a text-selecting click).
  [near('.focus-side-card[data-focus-select]'), (el, e) => {
    if (endsSelection(e)) return
    if (el.dataset.gid) setFocusGid(el.dataset.gid)
  }],
]
report.addEventListener('click', (e) => { runClicks(FOCUS_CLICKS, e) })

// The compact cards, table rows and Files rows are focusable but wired for
// clicks (the tables above, `<finding-row>`'s `row-select`, REPORT_CLICKS's
// `data-tree-select`), so Enter and Space click them (key-click.js says
// when). Space would scroll the page; a held key clicks once.
report.addEventListener('keydown', (e) => {
  const el = keyClickTarget(e)
  if (!el) return
  e.preventDefault()
  if (!e.repeat) el.click()
})

// The focus view's pane divider (focus-splitter.js): a primary-button drag
// resizes the split, a double-click restores 1:1.
report.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  const handle = e.target.closest?.('[data-focus-splitter]')
  if (handle) startFocusSplitDrag(handle, e)
})
report.addEventListener('dblclick', (e) => {
  const handle = e.target.closest?.('[data-focus-splitter]')
  if (handle) resetFocusSplit(handle)
})

// ← / → step between findings, from anywhere: in the focus view through the
// queue, in the kanban with its modal open through the open card's column.
// Up / down stay the reader's, to scroll a tall card.
document.addEventListener('keydown', (e) => {
  if (state.currentView !== 'findings') return
  const inFocus = state.viewMode === 'focus'
  const inKanban = state.viewMode === 'kanban' && state.kanbanPopoverGid !== null
  if (!inFocus && !inKanban) return
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
  if (focusNavBlocked(e)) return
  let direction = 0
  if (e.key === 'ArrowRight') direction = 1
  else if (e.key === 'ArrowLeft') direction = -1
  else return
  e.preventDefault()
  // The pane divider is an ARIA separator: focused, it takes the arrows.
  const splitter = e.target?.closest?.('[data-focus-splitter]')
  if (splitter) {
    nudgeFocusSplit(splitter, direction * FOCUS_SPLIT_STEP)
    return
  }
  if (inFocus) navigateFocus(direction)
  else navigateKanban(direction)
})

// `<color-marker>`'s dots color the active tab; the marked color again
// clears it. A full render, as colored tabs sort first.
report.addEventListener('mark-color', (e) => {
  const activeTab = focusedTabOf(e)
  if (!activeTab || !canEditTriage(activeTab)) return
  const color = e.detail?.color
  if (!color) return
  patchEntry(state.triage, tabKey(activeTab), { color: triageEntry(activeTab)?.color === color ? undefined : color })
  saveTriage()
  renderPreservingTableScroll()
})

// Printing swaps two things and restores them after:
//   - state.viewMode `table` → `list`: the table prints as row stubs, list
//     paints every card in full (the row selection survives);
//   - document.title → the report's name (or the loaded reports' common
//     prefix), the saved PDF's default — after the swap's render, which
//     writes the title.
// beforeprint / afterprint own it, so Ctrl+P and the browser menu get the
// same layout. `<finding-card>` renders in a microtask, which the snapshot
// after beforeprint doesn't wait for: so prepareForPrint builds every card's
// body synchronously, and the export dialog's print path also awaits each
// card before window.print() (microtasks keep the user gesture). A non-null
// `printSavedMode` is the re-entrancy guard for both.
let printSavedMode = null
let printSavedTitle = null
// The relaxed filter selection the export dialog handed back, when the user
// dropped a filter. Print serializes the DOM, so the override holds from the
// re-render here through the browser's print dialog to `afterprint`. Null
// for a native Ctrl+P, which prints what is on screen.
let printFilterFields = null
let printOneSamplePerGroup = false

function prepareForPrint() {
  if (printSavedMode !== null) return
  if (state.reports.length === 0) {
    // The one exit without a matching restore, so the one place a pending
    // selection could go stale.
    printFilterFields = null
    printOneSamplePerGroup = false
    return
  }
  printSavedMode = state.viewMode
  printSavedTitle = document.title
  const rerender = state.viewMode === 'table' || Boolean(printFilterFields)
  if (state.viewMode === 'table') state.viewMode = 'list'
  if (printFilterFields) setFilterOverride(printFilterFields)
  if (rerender) render()
  // Every card goes on paper, so every card needs its body, which the list
  // surfaces build only near the viewport (finding-card.js).
  for (const card of report.querySelectorAll('finding-card')) {
    card.toggleAttribute('print-one-sample', printOneSamplePerGroup)
    card.ensureRendered({ sync: true })
  }
  const fileNames = state.reports.map((r) => r.fileName)
  // Without `.json`, so "Save as PDF" isn't `<report>.json.pdf`.
  const target = (fileNames.length === 1 ? fileNames[0] : commonPrefix(fileNames)).replace(/\.json$/u, '')
  if (target) document.title = target
}

function restoreAfterPrint() {
  if (printSavedMode === null) return
  for (const card of report.querySelectorAll('finding-card')) card.removeAttribute('print-one-sample')
  printOneSamplePerGroup = false
  let rerender = false
  if (state.viewMode !== printSavedMode) {
    state.viewMode = printSavedMode
    rerender = true
  }
  if (printFilterFields) {
    clearFilterOverride()
    printFilterFields = null
    rerender = true
  }
  if (rerender) render()
  document.title = printSavedTitle
  printSavedMode = null
  printSavedTitle = null
}

window.addEventListener('beforeprint', prepareForPrint)
window.addEventListener('afterprint', restoreAfterPrint)

// Print under the selection the export dialog handed back; its confirm
// click is the user gesture that authorises window.print().
async function runPrint(fields, { oneSamplePerGroup = false } = {}) {
  // Again: a print started during the dialog could otherwise race past.
  if (printSavedMode !== null) return
  printFilterFields = fields
  printOneSamplePerGroup = oneSamplePerGroup
  try {
    prepareForPrint()
    await Promise.all(
      [...report.querySelectorAll('finding-card')].map((c) => c.ensureRendered()),
    )
    window.print()
  } catch (e) {
    // No print, no afterprint: restore here (a no-op if it already ran).
    restoreAfterPrint()
    throw e
  }
}

// A markdown export under the dialog's selection: `fields` is a relaxed
// clone of the toolbar's, never its own state, scoped to the synchronous
// serialization.
function withExportFilters(fields, fn) {
  if (!fields) return fn()
  setFilterOverride(fields)
  try {
    return fn()
  } finally {
    clearFilterOverride()
  }
}

// The toolbar's export button (download-button.js). The dialog states the
// filtered selection; its tabs are the ways out (`mode`): Download writes
// the markdown — from state, not the DOM — and Print sends the page to
// paper. View shows the file read-only instead, ending the flow.
document.addEventListener('download-requested', async () => {
  if (state.reports.length === 0) return
  const { confirmed, view, fields, mode, oneSamplePerGroup } = await openExportConfirmDialog('download')
  // A team's findings are written with their detail, which may still be on
  // its way; one whose detail never came is not written without it.
  if (!(await managedDetailsReady())) {
    showToast('Could not load finding details to export. Open the team again to retry.')
    return
  }
  if (view) {
    await openExportViewDialog(withExportFilters(fields, () => reportsToMarkdown({ oneSamplePerGroup, shipped: bundleDependencyRepo })))
    return
  }
  if (!confirmed) return
  if (mode === 'print') {
    await runPrint(fields, { oneSamplePerGroup })
    return
  }
  withExportFilters(fields, () => downloadReportsAsMarkdown({ oneSamplePerGroup, shipped: bundleDependencyRepo }))
})

// `<analyzer-select>` hands back every dimension, the clicked one updated.
report.addEventListener('analyzer-change', (e) => {
  state.filterAnalyzer = e.detail.analyzer
  state.filterModel = e.detail.model
  state.filterValidationModel = e.detail.validationModel
  render()
})
// Toolbar controls handing back a value for their state slot: `<repo-filter>`,
// `<revalidate-filter>`, and the partial chip in its Confirmed row.
for (const [type, key] of [['repo-change', 'filterRepo'], ['revalidate-change', 'filterRevalidate'], ['partial-change', 'filterPartial']]) {
  report.addEventListener(type, (e) => {
    state[key] = e.detail.value
    render()
  })
}
// …and toggles flipping one: `<bundle-search>`'s `.*` (regular expressions)
// and `Aa` (case-sensitive) modifiers, and the findings search's negation.
for (const [type, key] of [['bundle-search-regex-toggle', 'bundleSearchRegex'], ['bundle-search-case-toggle', 'bundleSearchCase'], ['search-negate-toggle', 'filterIncludeNegate']]) {
  report.addEventListener(type, () => {
    state[key] = !state[key]
    render()
  })
}
// `<revalidation-switch>`'s App toggle changes which rows exist (group.js
// drops the pass's own), which filters the toolbar offers, and what every
// card draws. The confidence block is re-derived as a load of the new set
// would put it (filters.js applyOpeningFilters): carried over it could hold
// an outcome nothing reaches, or a floor tuned to the old group count.
// configureRevalidation first: getShownGroups reads `revalidate` through
// format.js's gate, still set to the previous render's mode.
report.addEventListener('revalidation-change', (e) => {
  state.showRevalidation = e.detail.on
  const hasDependencyIssues = !e.detail.on && state.reports.some((r) =>
    (r.groups ?? []).some((g) => g.some((f) => !f.isApp && (f.isUpstream || isModule(f.file)))))
  if (hasDependencyIssues) {
    showToast('App mode off is not recommended; it can conflate triage for issues in dependencies.', { kind: 'warning' })
  } else if (e.detail.on) hideToast()
  configureRevalidation(state.showRevalidation, state.upstreamOnly)
  applyOpeningFilters(getShownGroups(), { resetSort: false })
  render()
})
report.addEventListener('revalidation-conflicts-open', () => {
  void (async () => {
    const selected = await openRevalidationConflictsDialog(state.revalidateConflicts)
    if (selected) await revealOrAlert(selected.id, selected.reportName)
  })().catch((err) => console.warn('revalidation: open conflicting finding failed:', err))
})
// The pill's detail icon: whether a group the pass re-examined shows the
// rows it re-rated or the pass's row alone (group.js drawnTabs), and whether
// `+ Partial` is offered. It changes what groups show, not which findings
// exist, so the confidence block stays (render.js clears the partial mode
// once its chip stops being offered).
report.addEventListener('revalidation-detail-change', (e) => {
  state.revalidationDetailed = e.detail.on === true
  render()
})
// The upstream lens changes which groups exist and which members they hold
// (workspace-groups.js mergeReportGroups).
report.addEventListener('upstream-only-change', (e) => {
  state.upstreamOnly = e.detail.on === true
  configureRevalidation(state.showRevalidation, state.upstreamOnly)
  if (!state.upstreamOnly) {
    const groups = getShownGroups()
    if (defaultRevalidateFilter(groups, defaultConfidenceFloor(groups)) === 'confirmed') {
      state.filterRevalidate = 'confirmed'
      state.filterPartial = ''
    }
  }
  render()
})
// The Code rail's Files / Code / Issues / Largest tabs. Back on Files the
// tree rebuilds at its remembered scroll-top, perhaps far from the open file;
// Largest starts at its top, where the largest files are.
report.addEventListener('bundle-search-mode-change', (e) => {
  const mode = e.detail?.mode
  if (!['files', 'code', 'issues', 'largest'].includes(mode)) return
  state.bundleCodeSearchMode = mode
  render()
  if (mode === 'files') revealBundleCodeCurrent()
  else if (mode === 'largest') {
    const body = document.querySelector('.bundle-code-rail-body')
    if (body) body.scrollTop = 0
  }
})
// Native select changes don't cross shadow roots; graph-layout emits this
// composed event so the main and lazy graph bundles share one selection.
report.addEventListener('bundle-graph-reason-change', (e) => {
  const reason = e.detail?.reason
  if (reason !== null && typeof reason !== 'string') return
  graph2.bundleReason = reason
  rebuildGraph('selected', 'solo', 'focusedPkg')
})
// `<bundle-compare>`'s swap, or a pick on its own side: switch to
// `integrity` on the Compare tab, compared with `target` (which the
// component has stashed; for a swap the old base).
report.addEventListener('bundle-swap', (e) => {
  const integrity = e.detail?.integrity
  const entry = integrity ? (state.bundles ?? []).find(b => b.integrity === integrity) : null
  if (!entry) return
  // Both sides arrive parsed: the navigation opens one and compares against
  // the other without reading either again, and lets go of what is left
  // once it settles (a task later, after the views it painted updated).
  const held = handOffBundles(e.detail.bundles ?? [])
  const release = () => { setTimeout(() => releaseHandoff(held)) }
  if (entry.managedId) {
    // The link names the bundle compared with, the old base for a swap, in
    // the mode Compare was in.
    const target = e.detail.target === undefined ? state.selectedBundle : e.detail.target
    const compared = state.bundles.find(b => b.integrity === target)
    const compare = compared?.managedId ? { compareId: compared.managedId, ...compareModeField(e.detail.mode) } : null
    void managedHistory.navigate(managedBundleRoute(state.managedTeams, entry, state.currentManagedTeam, 'compare', compare, state.bundles)).finally(release)
    return
  }
  void showStoredBundle(integrity, 'compare').finally(release)
})
// `<bundle-compare>` picked a bundle, cleared it, or switched mode: a
// managed bundle's URL names the bundle compared with and the mode (see
// managedCompareLocation), replaced in place as Code's open file is.
report.addEventListener('bundle-compare-change', (e) => {
  const { base, target, mode } = e.detail ?? {}
  if (!isManagedUiMode() || !base || base !== state.selectedBundle || state.bundleDetailsTab !== 'compare') return
  state.bundleCompare = target ? { bundle: base, target, mode: compareModeOf(mode) } : null
  persistLastBundle(base, 'compare')
})
// `<findings-sort>` and `<entity-sort>`.
const SORT_KEYS = { findings: 'sortBy', packages: 'packagesSortBy', repositories: 'repositoriesSortBy' }
report.addEventListener('sort-change', (e) => {
  const { kind, value } = e.detail
  if (!Object.hasOwn(SORT_KEYS, kind)) return
  state[SORT_KEYS[kind]] = value
  render()
})

// The confidence slider commits on release; `<conf-range-mirror>` follows
// the drag itself, so the toolbar doesn't re-render per tick.
report.addEventListener('range-change', (e) => {
  if (e.target.id !== 'conf-range') return
  state.filterConfMin = e.detail.low
  state.filterConfMax = e.detail.high
  render()
})

// The graph's path filter, from inside `<graph-layout>`'s shadow root:
// composedPath()[0] is the real input.
report.addEventListener('input', (e) => {
  const src = e.composedPath()[0]
  if (src?.id !== 'g2-path-filter') return
  graph2.pathFilter = src.value
  graph2.graphState?.requestDraw?.()
})

// `<toolbar-search>`, `<entity-search>`, `<bundle-code-search>` and
// `<bundle-search>` (whose × clear sends an empty value): kind → [state
// slot, render per frame]. Per frame where a keystroke's render is heavy —
// re-filtering the findings, a Files row per matching file, scanning every
// source. Lit reuses each `<input>` and `live()` makes the matching write a
// no-op, so focus and caret survive the render.
const SEARCH_KEYS = {
  'findings': ['filterInclude', true],
  'files': ['filesSearch', true],
  'packages': ['packagesSearchQuery', false],
  'repositories': ['repositoriesSearchQuery', false],
  'bundle-code': ['bundleCodeSearchQuery', true],
  'bundle-search': ['bundleSearchQuery', true],
}
report.addEventListener('search-input', (e) => {
  if (!e.detail || !Object.hasOwn(SEARCH_KEYS, e.detail.kind)) return
  const { kind, value } = e.detail
  const [key, perFrame] = SEARCH_KEYS[kind]
  state[key] = value
  // Clearing the findings search ends it: drop negation, whose toggle hides
  // while the field is empty.
  if (kind === 'findings' && !value) state.filterIncludeNegate = false
  if (perFrame) renderSearchNextFrame()
  else render()
})

// A severity / color chip. The graph topbar's (kind "graph") highlight the
// canvas, surgically: a full render would tear down its rAF loop and hover
// state. Its chip element is composedPath()[0], inside the graph's shadow
// root, where `e.target` is retargeted to `<graph-layout>`.
function chipToggle(e, value, graphSet, filterSet) {
  if (e.detail.kind !== 'graph') {
    toggleIn(filterSet, value)
    render()
    return
  }
  toggleIn(graphSet, value)
  e.composedPath()[0].selected = [...graphSet]
  graph2.graphState?.requestDraw?.()
  refreshActiveGraphTopPkgs()
}
report.addEventListener('severity-toggle', (e) => { chipToggle(e, e.detail.severity, graph2.selectedSeverities, state.filterSeverities) })
report.addEventListener('color-toggle', (e) => { chipToggle(e, e.detail.color, graph2.selectedColors, state.filterColors) })
// `<source-filter>`: single-select, the active chip again clears it.
report.addEventListener('source-toggle', (e) => {
  const v = e.detail.source
  const wasActive = state.filterSources.has(v)
  state.filterSources.clear()
  if (!wasActive) state.filterSources.add(v)
  render()
})
// Annotation chips, each an independent AND filter (matchesFilters) cycling
// '' → 'with' → 'without'. Duplicates is a single report's filter.
const ANNOTATION_FILTERS = { 'comment': 'filterComment', 'issue': 'filterIssue', 'fix': 'filterFix', 'flag': 'filterFlagged', 'duplicates': 'filterDuplicates', 'cross-context': 'filterCrossContext', 'app-stacked': 'filterAppStacked', 'security': 'filterSecurity' }
report.addEventListener('annotation-filter-toggle', (e) => {
  const key = e.detail?.key
  if (!Object.hasOwn(ANNOTATION_FILTERS, key) || (key === 'duplicates' && state.currentWorkspace)) return
  const slot = ANNOTATION_FILTERS[key]
  const v = state[slot]
  state[slot] = v === '' ? 'with' : v === 'with' ? 'without' : ''
  render()
})
// `<slide-triage-tabs>`' Invalid / Deleted tabs; the active one again clears.
report.addEventListener('slide-triage-toggle', (e) => {
  const { kind, value } = e.detail
  if (!Object.hasOwn(ENTITY, kind)) return
  const key = ENTITY[kind].triage
  state[key] = state[key] === value ? null : value
  render()
})
report.addEventListener('view-mode-change', (e) => {
  if (e.detail.kind === 'files') {
    state.filesViewMode = e.detail.mode
    render()
    return
  }
  state.viewMode = e.detail.mode
  // The kanban modal only renders in the kanban, and a stale focus gid would
  // re-anchor the queue on what was read last, long after filters moved on.
  if (state.viewMode !== 'kanban') state.kanbanPopoverGid = null
  if (state.viewMode !== 'focus') state.focusGid = null
  render()
})

// `<severity-mode-switch>`: the global Corrected / Original lens, persisted
// (state.ts reads it on boot).
report.addEventListener('severity-mode-change', (e) => {
  const mode = e.detail?.mode
  if (mode !== 'corrected' && mode !== 'original') return
  state.severityMode = mode
  try { localStorage.setItem(SEVERITY_MODE_KEY, mode) } catch {}
  render()
})

// `<repo-chip>` (view/repo-chip.js) owns the editing UI. Every keystroke
// saves the URL per report, so it survives a reload uncommitted; commit and
// cancel (which hands back the URL the edit opened with) also end editing.
report.addEventListener('repo-edit-start', () => {
  if (isManagedUiMode()) return
  state.repoEditing = true
  render()
})
function setRepoUrl(e, done) {
  if (isManagedUiMode()) return
  state.repoUrl = e.detail.url
  saveRepoUrlFor(state.currentFile, state.repoUrl)
  if (!done) return
  state.repoEditing = false
  render()
}
report.addEventListener('repo-input', (e) => { setRepoUrl(e, false) })
report.addEventListener('repo-commit', (e) => { setRepoUrl(e, true) })
report.addEventListener('repo-cancel', (e) => { setRepoUrl(e, true) })

// Escape closes the bundle source viewer's side panel, then the viewer —
// except in the Code slide, where the open file is the tree's selection (no
// overlay, no close affordance), and deselecting it would strand the reader
// on the "pick a file" placeholder. A dialog or popover over them closes
// first, on its own (key-layers.js).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  const panel = state.bundleSourceFindingIdx != null
  if (!panel && (!state.bundleSourceFile || (state.currentView === 'bundles' && state.bundleDetailsTab === 'code'))) return
  if (nativeLayerOpen()) return
  if (panel) {
    state.bundleSourceFindingIdx = null
    renderPreservingSourceScroll()
    return
  }
  selectBundleTab(state.bundleDetailsTab)
  render()
})
