import { VIEW_MODE_KEY, deleteBundle, dropBundleFromHashIndex, getPackagesIndex, listBundles, removeSecureItem, saveRepoUrlFor, saveTriage, setBundleWorkspace, state, subscribeToBundleFindingIndex } from '#client/index.js'
import { report } from './dom.js'
import { commonPrefix } from './format.js'
import { activeTabFor, findGroupById, groupState, ignoredKey, tabKey } from './group.js'
import { resetFilters } from './filters.js'
import { refreshGraph2Sidebar, refreshGraph2TopPkgs, render, renderKeepFocus } from './render.js'
import { refreshBundleGraphSidebar, refreshBundleGraphTopPkgs } from './render-bundle.js'
import { openCommentDialog } from './comment-dialog.js'
import { openFixLinkDialog } from './fix-link-dialog.js'
import { downloadReportsAsMarkdown } from './markdown-export.js'

// Subscribe once to the bundle-finding index. Any time another
// OPFS report finishes parsing, re-render IF the user is currently
// looking at a bundle — the Issues tab and Graph view both pull
// from the index, so newly-indexed findings need to land in the
// view without waiting for a tab flip / re-open.
subscribeToBundleFindingIndex(() => {
  if (state.currentView === 'bundles' && state.selectedBundle) render()
  else if (state.currentView === 'packages') render()
  else if (state.currentView === 'repositories') render()
  else if (state.currentView === 'findings' || state.currentView === 'files') {
    // Sidebar's PACKAGES / REPOSITORIES entry captions depend on
    // the index too — refresh it when the count would change. The
    // main view stays put.
    renderSidebar().catch(() => {})
  }
})

// The findings-tab graph view and the bundles-tab graph view share
// the same renderGraph2Layout chrome but draw from different graph
// data. Click delegates below pick the right refresh helper based
// on which view is currently active so a node selection inside a
// bundle graph repaints the bundle's sidebar (and its top-pkgs
// block), not the findings tab's.
function refreshActiveGraphSidebar() {
  if (state.currentView === 'bundles' && state.bundleDetailsTab === 'graph') {
    refreshBundleGraphSidebar()
  } else {
    refreshGraph2Sidebar()
  }
}
function refreshActiveGraphTopPkgs() {
  if (state.currentView === 'bundles' && state.bundleDetailsTab === 'graph') {
    refreshBundleGraphTopPkgs()
  } else {
    refreshGraph2TopPkgs()
  }
}

// Re-render preserving the bundle source viewer's scroll position.
// Toggling the side panel (and any other state change while the
// viewer is open) goes through render() — Lit may detach + reattach
// .bundle-source-code-wrap when sibling structure changes, dropping
// scrollTop. Capture before, restore after on the freshly-rendered
// element. Tied specifically to the source viewer because nothing
// else in this view has user-driven scroll worth preserving.
function renderPreservingSourceScroll() {
  const before = document.querySelector('.bundle-source-code-wrap')
  const top = before?.scrollTop ?? 0
  const left = before?.scrollLeft ?? 0
  render()
  const after = document.querySelector('.bundle-source-code-wrap')
  if (after) {
    after.scrollTop = top
    after.scrollLeft = left
  }
}

// Re-render preserving scrollTop on a named container. Picking a
// row in any list-driven view (Code rail tree, Issues slide list,
// Code search results) triggers render() — Lit may rebuild the
// container's child nodes for the `.current` highlight or for a
// data shape change, and a rebuilt subtree resets scrollTop on
// the scrolling ancestor.
function renderPreservingScrollOf(selector) {
  const before = document.querySelector(selector)
  const top = before?.scrollTop ?? 0
  render()
  const after = document.querySelector(selector)
  if (after) after.scrollTop = top
}
import { openBundle } from './bundle-load.js'
import { renderSidebar } from './sidebar.js'
import { LAST_FILE_KEY, persistLastBundle, switchToFile } from './ingest.js'
import { treeAnchor } from './graph/utils.js'
import { graph2, cleanupGraph2 } from './graph2/state.js'

// composedPath-aware variant of Element.closest — needed for clicks
// that originate inside a shadow DOM (e.g. `<finding-table>`'s
// `.tab` / `.mark-dot` / `.mark-x` / `.mark-restore` buttons). Native
// click events bubble out composed:true, but `e.target` retargets to
// the shadow host on the way up, so a plain `e.target.closest('.tab')`
// from this delegate would miss the inner element. Walking
// composedPath sees the original target. Returns the deepest matching
// element, or null. Works equally for light-DOM clicks since the path
// starts at the same node.
function pathClosest(e, selector) {
  for (const el of e.composedPath()) {
    if (el?.matches?.(selector)) return el
  }
  return null
}

// All interactive elements inside #report are handled via event
// delegation here, no inline handlers. Order matters: closer-fitting
// selectors come first so a more specific match short-circuits before a
// generic one (e.g. tree-graph buttons before generic tab clicks).
report.addEventListener('click', (e) => {
  // Bundles list — per-row "Code →" shortcut. Selects the bundle
  // (kicking the same async parse the data-select-bundle path
  // does) and opens straight into the Code slide. Listed BEFORE
  // the row-select handler since both buttons live inside the
  // selectable row container; without the early return, the
  // generic row-select would fire too and we'd race the slide
  // setup against bundleDetails landing.
  // Finding card's `[Code]` shortcut — pops the bundle source
  // viewer modal as an overlay on top of the current view
  // (findings, packages, etc.) without navigating away. Same
  // pattern the graph-tab "View source" link uses inside the
  // bundles view, lifted to the global overlay slot
  // (`#bundle-source-overlay-slot` — render.js mounts the
  // modal there on every render). The button lives inside
  // `<finding-card>`'s shadow root, so we walk composedPath
  // rather than `e.target.closest`.
  const findingCode = pathClosest(e, '[data-finding-code-bundle]')
  if (findingCode) {
    const integrity = findingCode.dataset.findingCodeBundle
    const file = findingCode.dataset.findingCodeFile
    const lineAttr = findingCode.dataset.findingCodeLine
    const line = lineAttr ? parseInt(lineAttr, 10) : null
    state.bundleSourceFile = file || null
    state.bundleSourceFindingIdx = null
    // The modal suppresses itself when we're in the Code tab of
    // the bundles view (the slide renders the source inline);
    // flip the tab back to the default so the modal surfaces
    // even if the user happens to be parked on Code right now.
    if (state.bundleDetailsTab === 'code') state.bundleDetailsTab = 'packages'
    // After the modal lands in the DOM, scroll its line-row for
    // this finding into view at the top of the viewport. Same
    // shape the Code-search hits use.
    const scrollToFindingLine = () => {
      if (!Number.isFinite(line)) return
      queueMicrotask(() => {
        const row = document.querySelector(`.bundle-source-lineno-row[data-line="${line}"]`)
        // `instant` (not `smooth`) — the modal pops over the
        // current view, so a smooth scroll from the modal's
        // initial natural position would visibly drift the line
        // into place. Instant scroll lands the matching line at
        // the top of the viewport in the same frame the modal
        // appears.
        if (row) row.scrollIntoView({ block: 'start', behavior: 'instant' })
      })
    }
    if (state.selectedBundle === integrity && state.bundleDetails?.integrity === integrity) {
      // Already parsed — render to mount the modal, then scroll.
      render()
      scrollToFindingLine()
      return
    }
    state.selectedBundle = integrity
    state.bundleDetails = null
    render()
    // Wait for openBundle to finish parsing + render so the
    // line-row is actually in the DOM before we look it up.
    ;(async () => {
      await openBundle(integrity)
      scrollToFindingLine()
    })()
    return
  }
  const codeBundle = e.target.closest('[data-bundle-row-code]')
  if (codeBundle) {
    const integrity = codeBundle.dataset.bundleRowCode
    // Same state setup as data-select-bundle below; the only
    // difference is `bundleDetailsTab = 'code'` (drop the user
    // straight onto the code tab) and the cache short-circuit
    // when bundleDetails is already loaded for this integrity
    // (clicking Code → on the already-open bundle shouldn't
    // re-parse the snapshot).
    state.selectedBundle = integrity
    state.bundleSourceFile = null
    state.bundleSourceFindingIdx = null
    state.bundleCodeSearchQuery = ''
    state.bundleCodeSearchMode = 'files'
    state.bundleDetailsTab = 'code'
    graph2.showAll = true
    state.shownTriage = null
    persistLastBundle(integrity, 'code')
    if (state.bundleDetails?.integrity === integrity) {
      // Already parsed — just paint the new tab choice.
      render()
      renderSidebar()
      return
    }
    state.bundleDetails = null
    render()
    renderSidebar()
    openBundle(integrity)
    return
  }
  // Bundles list — per-row delete button (`data-delete-bundle=<integrity>`).
  // The dataset value is the SHA-512 integrity (the canonical id);
  // `state.bundles` carries the user-friendly name for the confirm
  // prompt. Drops the OPFS entry + meta record, refreshes
  // state.bundles, and re-renders both the main view (row goes) and
  // the sidebar (count drops, header hides at zero). Confirm because
  // OPFS removes are not recoverable from the in-app UI. Listed
  // BEFORE the row-select handler so a click on Delete doesn't
  // also open the details panel for the row about to disappear.
  const delBundle = e.target.closest('[data-delete-bundle]')
  if (delBundle) {
    const integrity = delBundle.dataset.deleteBundle
    const friendly = (state.bundles ?? []).find((b) => b.integrity === integrity)?.name ?? integrity
    if (!confirm(`Delete bundle "${friendly}"?`)) return
    ;(async () => {
      await deleteBundle(integrity)
      // Detach from any owning workspace's `bundles` list — mirrors
      // the `setReportWorkspace(name, null)` call in `deleteCurrent`.
      // Without this, the integrity stays in the workspace JSON until
      // a later setBundleWorkspace call rewrites the list. The sidebar
      // renders defensively against missing entries (as a muted
      // "missing bundle" row), but leaving a dangling pointer would
      // surface that row for a bundle the user explicitly deleted —
      // surprising and useless. The detach call cleans the JSON.
      await setBundleWorkspace(integrity, null)
      // Drop the open panel if it was pointing at the deleted row.
      // Also clear the persisted last-view pointer when it was
      // pinned to this bundle so a reload doesn't try to restore a
      // bundle we just dropped from OPFS. Mirrors deleteCurrent's
      // `removeSecureItem(LAST_FILE_KEY)` for files.
      if (state.selectedBundle === integrity) {
        state.selectedBundle = null
        state.bundleDetails = null
        state.bundleSourceFile = null
        state.bundleSourceFindingIdx = null
        removeSecureItem(LAST_FILE_KEY)
      }
      // Prune the cross-bundle hash index so the finding-card's
      // "Code →" lookup stops surfacing this bundle as a match.
      dropBundleFromHashIndex(integrity)
      state.bundles = await listBundles()
      render()
      await renderSidebar()
    })()
    return
  }
  // Bundles list — close-details button on the right panel. Same
  // shape as the findings table's data-table-deselect hook.
  if (e.target.closest('[data-deselect-bundle]')) {
    state.selectedBundle = null
    state.bundleDetails = null
    state.bundleSourceFile = null
    state.bundleSourceFindingIdx = null
    state.bundleCodeSearchQuery = ''
    state.bundleCodeSearchMode = 'files'
    render()
    // Drop the sidebar's per-row highlight now that no bundle is
    // selected — otherwise the deselected row would still read as
    // "current" until the next sidebar re-render.
    renderSidebar()
    return
  }
  // Packages list — row select. Mirrors the bundles select pattern;
  // selection is purely UI (no async load — the index is already in
  // memory), so a plain re-render paints the right-side panel.
  // [Issues →] button on a package / repository row — open the
  // full-width Issues slide directly, without forcing the user
  // to drill into the right-side details panel first. Same
  // shortcut shape bundles' [Code →] row button uses. Listed
  // BEFORE the row-select handlers below because the button
  // sits inside the `<li>`; closest() would otherwise bubble
  // the click up to the row's data-select-* attribute.
  const pkgRowIssues = e.target.closest('[data-package-row-issues]')
  if (pkgRowIssues) {
    const pkg = pkgRowIssues.dataset.packageRowIssues
    state.selectedPackage = pkg
    state.packageDetailsTab = 'issues'
    state.packageSlideTriage = null
    // Transient flag — slide-back clears `selectedPackage` too so
    // the user lands back on the plain list instead of the
    // row+details state. The row's [Issues →] is a drill-in
    // shortcut, not a row selection.
    state.packageSlideTransient = true
    render()
    return
  }
  const repoRowIssues = e.target.closest('[data-repository-row-issues]')
  if (repoRowIssues) {
    const repo = repoRowIssues.dataset.repositoryRowIssues
    state.selectedRepository = repo
    state.repositoryDetailsTab = 'issues'
    state.repositorySlideTriage = null
    state.repositorySlideTransient = true
    render()
    return
  }
  // Reset the details panel to the Overview tab so a new pick
  // doesn't carry the prior selection's tab choice.
  const selPackage = e.target.closest('[data-select-package]')
  if (selPackage) {
    const pkg = selPackage.dataset.selectPackage
    if (state.selectedPackage === pkg) return
    state.selectedPackage = pkg
    state.packageDetailsTab = 'overview'
    // Drop the slide's triage sub-view so a new pick lands in the
    // default `live` (untriaged + fixed) bucket — carrying a
    // prior package's `'invalid'` / `'deleted'` mode would
    // surprise the user.
    state.packageSlideTriage = null
    state.packageSlideTransient = false
    render()
    return
  }
  // Packages list — close-details button on the right panel.
  if (e.target.closest('[data-deselect-package]')) {
    state.selectedPackage = null
    render()
    return
  }
  // Packages details — tab switch. Overview keeps the regular
  // list + details layout; Issues opens the full-width slide
  // (state.packageDetailsTab='issues' triggers the slide branch
  // in renderPackagesView). Pure UI flip; the bucket is already
  // in memory so the re-render is paint-only.
  const pkgTab = e.target.closest('[data-package-tab]')
  if (pkgTab) {
    const tab = pkgTab.dataset.packageTab
    if ((tab === 'overview' || tab === 'issues') && state.packageDetailsTab !== tab) {
      state.packageDetailsTab = tab
      render()
    }
    return
  }
  // Packages slide back — drops out of the Issues slide back to
  // the regular list + details layout (Overview tab).
  if (e.target.closest('[data-action="package-slide-back"]')) {
    state.packageDetailsTab = 'overview'
    // Reset the slide's triage sub-view too — re-entering the
    // slide should land on the default `live` bucket.
    state.packageSlideTriage = null
    // Transient slides (opened via the row's [Issues →] shortcut)
    // also clear the selection on the way out — the row click
    // wasn't meant to leave the user on a selected-row+details
    // state when they back out of the slide.
    if (state.packageSlideTransient) {
      state.selectedPackage = null
      state.packageSlideTransient = false
    }
    render()
    return
  }
  // Package slide — Invalid / Deleted tabs in the header switch
  // the slide body to the matching triage bucket. Clicking the
  // currently-active tab again drops back to `live` (the
  // default + the same set the rest of the package surface
  // counts as "issues").
  const pkgSlideTriage = e.target.closest('[data-package-slide-triage]')
  if (pkgSlideTriage) {
    const next = pkgSlideTriage.dataset.packageSlideTriage
    state.packageSlideTriage = state.packageSlideTriage === next ? null : next
    render()
    return
  }
  // Packages details — click a report row to navigate to it.
  // Mirrors the bundle Issues report-chip handler (switchToFile
  // loads it into findings + flips currentView away from packages).
  const pkgReport = e.target.closest('[data-package-report]')
  if (pkgReport) {
    const name = pkgReport.dataset.packageReport
    if (name) switchToFile(name)
    return
  }
  // Repositories list — row select (mirrors data-select-package).
  // Resets the details panel to the Overview tab and drops the
  // slide's triage sub-view so a new pick lands on the default
  // `live` bucket.
  const selRepo = e.target.closest('[data-select-repository]')
  if (selRepo) {
    const repo = selRepo.dataset.selectRepository
    if (state.selectedRepository === repo) return
    state.selectedRepository = repo
    state.repositoryDetailsTab = 'overview'
    state.repositorySlideTriage = null
    state.repositorySlideTransient = false
    render()
    return
  }
  if (e.target.closest('[data-deselect-repository]')) {
    state.selectedRepository = null
    render()
    return
  }
  const repoTab = e.target.closest('[data-repository-tab]')
  if (repoTab) {
    const tab = repoTab.dataset.repositoryTab
    if ((tab === 'overview' || tab === 'issues') && state.repositoryDetailsTab !== tab) {
      state.repositoryDetailsTab = tab
      render()
    }
    return
  }
  if (e.target.closest('[data-action="repository-slide-back"]')) {
    state.repositoryDetailsTab = 'overview'
    state.repositorySlideTriage = null
    if (state.repositorySlideTransient) {
      state.selectedRepository = null
      state.repositorySlideTransient = false
    }
    render()
    return
  }
  const repoSlideTriage = e.target.closest('[data-repository-slide-triage]')
  if (repoSlideTriage) {
    const next = repoSlideTriage.dataset.repositorySlideTriage
    state.repositorySlideTriage = state.repositorySlideTriage === next ? null : next
    render()
    return
  }
  // Bundle details — tab switch. Packages / Files / Reports
  // render in the regular details panel next to the bundles list;
  // Terminal / Graph / Issues / Code open the full-width slide
  // layout (bundles list + details both step aside). State is
  // purely UI; the parsed bundleDetails stays cached so flipping
  // tabs is paint-only.
  const bundleTab = e.target.closest('[data-bundle-tab]')
  if (bundleTab) {
    const tab = bundleTab.dataset.bundleTab
    if (tab === 'packages' || tab === 'files' || tab === 'reports' || tab === 'graph' || tab === 'issues' || tab === 'code' || tab === 'terminal') {
      // Tear down the canvas when leaving Graph so its rAF /
      // observers stop. attachGraph2Interaction will re-wire on
      // re-entry.
      if (state.bundleDetailsTab === 'graph' && tab !== 'graph') cleanupGraph2()
      // Tab switch resets the source-viewer pointer so a stale
      // bundleSourceFile from a different tab (Code slide
      // selection, or modal opened from the Files tab) doesn't
      // re-render the wrong view in the new tab — the modal
      // renders over non-slide tabs whenever the pointer is set.
      state.bundleDetailsTab = tab
      state.bundleSourceFile = null
      state.bundleSourceFindingIdx = null
      if (state.selectedBundle) persistLastBundle(state.selectedBundle, tab)
      render()
    }
    return
  }
  // Slide back button — drops out of the Graph / Issues / Code
  // slide back to the bundles list + details. Defaults to the
  // Packages sub-tab so the panel paints meaningfully on the
  // way out. Same source-viewer reset as the tab switch above.
  if (e.target.closest('[data-action="bundle-slide-back"]')) {
    if (state.bundleDetailsTab === 'graph') cleanupGraph2()
    state.bundleDetailsTab = 'packages'
    state.bundleSourceFile = null
    state.bundleSourceFindingIdx = null
    state.bundleCodeSearchQuery = ''
    state.bundleCodeSearchMode = 'files'
    if (state.selectedBundle) persistLastBundle(state.selectedBundle)
    render()
    return
  }
  // Bundle Issues row — report chip click. Each chip carries the
  // OPFS report name in its dataset; navigate to that report
  // (switchToFile loads it into the findings tab and flips
  // currentView away from bundles, which is the desired UX since
  // the user is opting in to inspecting the report's findings).
  const issueReport = e.target.closest('[data-bundle-issue-report]')
  if (issueReport) {
    const name = issueReport.dataset.bundleIssueReport
    if (name) switchToFile(name)
    return
  }
  // Code slide search-mode tab — flips the rail between Files /
  // Code / Issues. Doesn't clear the query so the user can pivot
  // between modes against the same string. Renders via the
  // shared bundles render path.
  const codeSearchMode = e.target.closest('[data-bundle-search-mode]')
  if (codeSearchMode) {
    const mode = codeSearchMode.dataset.bundleSearchMode
    if (mode === 'files' || mode === 'code' || mode === 'issues') {
      state.bundleCodeSearchMode = mode
      render()
    }
    return
  }
  // [×] clear button next to the bundle code search input.
  // Drops the query and rerenders the rail; the input's `live`
  // value binding picks up the empty string and the panel falls
  // back to the unfiltered tree (Files mode) or the search-hint
  // placeholder (Code / Issues modes).
  if (e.target.closest('[data-bundle-search-clear]')) {
    if (state.bundleCodeSearchQuery !== '') {
      state.bundleCodeSearchQuery = ''
      render()
    }
    return
  }
  // Bundle source viewer — open / close. Close fires when the click
  // lands directly on the backdrop (NOT a descendant — clicks inside
  // the modal body shouldn't dismiss) or on any element carrying
  // data-action="bundle-source-close" (the × button). Open clicks
  // land on [data-bundle-view-source].
  // Order: close BEFORE open so a stray view-source target inside
  // the modal doesn't reopen it.
  if (e.target.classList?.contains('bundle-source-overlay')
      || e.target.closest('[data-action="bundle-source-close"]')) {
    if (state.bundleSourceFile) {
      state.bundleSourceFile = null
      state.bundleSourceFindingIdx = null
      render()
    }
    return
  }
  // Source viewer side panel close — clears the selected finding
  // but leaves the modal open.
  if (e.target.closest('[data-action="bundle-source-panel-close"]')) {
    if (state.bundleSourceFindingIdx != null) {
      state.bundleSourceFindingIdx = null
      renderPreservingSourceScroll()
    }
    return
  }
  // Source viewer gutter dot — selects a finding and opens the
  // side panel. The dot's dataset carries the index into the
  // file's findings array (built in render); the click toggles
  // selection so a second click on the same dot dismisses.
  const sourceFinding = e.target.closest('[data-bundle-source-finding]')
  if (sourceFinding) {
    const idx = parseInt(sourceFinding.dataset.bundleSourceFinding, 10)
    if (Number.isFinite(idx)) {
      state.bundleSourceFindingIdx = state.bundleSourceFindingIdx === idx ? null : idx
      renderPreservingSourceScroll()
    }
    return
  }
  const sourceOpen = e.target.closest('[data-bundle-view-source]')
  if (sourceOpen) {
    const path = sourceOpen.dataset.bundleViewSource
    if (!path) return
    // Optional finding pointer — set when an Issues-mode search
    // result is clicked; opens the side panel directly on that
    // finding and (after render) scrolls the source viewer to
    // its line. Plain Files-mode / Code-mode clicks omit the
    // attribute and keep the previous bundleSourceFindingIdx
    // (which the tab-switch reset already cleared).
    const findingIdxAttr = sourceOpen.dataset.bundleViewFindingIdx
    const findingIdx = findingIdxAttr === undefined ? null : parseInt(findingIdxAttr, 10)
    const lineAttr = sourceOpen.dataset.bundleViewLine
    const line = lineAttr ? parseInt(lineAttr, 10) : null
    state.bundleSourceFile = path
    if (Number.isFinite(findingIdx)) state.bundleSourceFindingIdx = findingIdx
    // Preserve the scroll position of whichever list-style
    // container the click came from. Code rail (tree / search
    // results), Issues slide (file-grouped list), and Code source
    // viewer panels each scroll inside their own element; the
    // outermost match wins. render() would otherwise reset
    // scrollTop on whichever subtree Lit rebuilds for the new
    // `.current` highlight.
    if (sourceOpen.closest('.bundle-code-rail')) {
      renderPreservingScrollOf('.bundle-code-rail-body')
    } else if (sourceOpen.closest('.bundles-slide-body')) {
      renderPreservingScrollOf('.bundles-slide-body')
    } else {
      render()
    }
    if (Number.isFinite(line)) {
      // Defer to the next microtask so the just-rendered source
      // viewer is in the DOM before we look up the line row.
      // `data-bundle-view-scroll-block` lets the click target pick
      // where the line should land in the viewport — code-search
      // hits use `'start'` (top of viewport, so the matching line
      // anchors the eye and the surrounding context flows below)
      // while Issues / per-line-dot clicks default to `'center'`
      // (the line IS the focus, so equal context above and below
      // reads better).
      const block = sourceOpen.dataset.bundleViewScrollBlock || 'center'
      queueMicrotask(() => {
        const row = document.querySelector(`.bundle-source-lineno-row[data-line="${line}"]`)
        if (row) row.scrollIntoView({ block, behavior: 'smooth' })
      })
    }
    return
  }
  // Bundles list — row select. Opens the right-side details panel,
  // then asynchronously reads + parses the bundle (.map gets
  // sourcemap fields surfaced; .stasis falls back to metadata-only).
  // The first render() shows a Loading… placeholder; once the
  // async load resolves, render() repaints with the parsed data.
  // Stale resolves (the user clicked another row in the meantime)
  // are dropped via the `state.selectedBundle === integrity` check.
  const selBundle = e.target.closest('[data-select-bundle]')
  if (selBundle) {
    const integrity = selBundle.dataset.selectBundle
    if (state.selectedBundle === integrity) return
    state.selectedBundle = integrity
    persistLastBundle(integrity)
    state.bundleDetails = null
    state.bundleSourceFile = null
    state.bundleSourceFindingIdx = null
    state.bundleCodeSearchQuery = ''
    state.bundleCodeSearchMode = 'files'
    // Reset to the Packages tab when a different bundle opens —
    // the user shouldn't carry the prior bundle's tab choice into
    // the new one (especially when one had >5 packages and the
    // other doesn't, so tabs aren't even rendered).
    state.bundleDetailsTab = 'packages'
    // Default "All files" to ON for the bundle graph: the user
    // expects to see the whole bundle inventory first, then
    // optionally narrow it down to issue-bearing files + their
    // deps via the toggle. The setting persists for the duration
    // of this bundle's session; opening a different bundle resets.
    graph2.showAll = true
    // Default the triage view to live (non-triaged) when opening
    // a bundle. The setting is shared with the findings tab, so
    // a user who left findings in Deleted view would otherwise
    // land here filtered to deletions only — confusing in a
    // bundle context where they expect to see active issues
    // first.
    state.shownTriage = null
    render()
    // Re-render the sidebar too so the bundles section's per-row
    // `.current` highlight follows the main-pane selection.
    renderSidebar()
    // Async open pipeline (read bytes, parse, set bundleDetails,
    // kick file hashes, kick the cross-report findings indexer)
    // lives in view/bundle-load.js — shared with the Code →
    // shortcut above and the bundle-only drop branch in
    // ingest.js. Stale resolves drop via state.selectedBundle
    // checks inside that helper.
    openBundle(integrity)
    return
  }
  // Files toggle (page header, right of the repo chip). On/off
  // shape — clicking flips state.currentView between 'files' and
  // 'findings', mirroring the Trash button's state.showDeleted.
  // The graph view-mode (when active) lives inside Findings now;
  // its rAF/observers tear down naturally when the body's innerHTML
  // resets at the top of render(), but cleanupGraph2 is called
  // explicitly so the canvas state can drop its viewport cache /
  // hover state cleanly across the view switch.
  const filesToggle = e.target.closest('[data-action="toggle-files"]')
  if (filesToggle) {
    if (state.currentView === 'files') {
      state.currentView = 'findings'
    } else {
      if (state.viewMode === 'graph') cleanupGraph2()
      state.currentView = 'files'
    }
    document.body.classList.remove('report-fullscreen')
    render()
    return
  }
  // Graph v2 — segmented controls (layout / edge mode), palette
  // swatches, severity rows, toggle rows, neighbor jumps, and the
  // jump-to-Findings / jump-to-Files buttons. All grouped here so
  // the more specific selectors hit before the generic tab/click
  // handlers below. The slider input event is wired separately
  // (input event listener at the bottom of this file).
  const g2Pkg = e.target.closest('[data-g2-pkg]')
  if (g2Pkg) {
    const pkg = g2Pkg.dataset.g2Pkg
    // Clicking a package row (Top packages list) toggles solo on
    // that package. Clicking the currently-soloed entry clears
    // solo. Used to also drive a swatch palette in the right
    // panel; that grid is gone now, so the only DOM surface to
    // update is the right-panel sections via refresh helpers.
    graph2.solo = graph2.solo === pkg ? null : pkg
    // Clear the file selection when the user solos a package —
    // selection card switches to package mode in that case (see
    // renderSelectionCard's priority chain). Without this, an
    // earlier file selection would keep displaying file info
    // even though the user just asked for package-level info.
    if (graph2.solo) graph2.selected = null
    refreshActiveGraphSidebar()
    refreshActiveGraphTopPkgs()
    graph2.graphState?.requestDraw?.()
    return
  }
  // (graph2 severity filter is now a `<severity-chips kind="graph">`
  // — the click dispatches a `severity-toggle` CustomEvent that the
  // dedicated listener at the bottom of this file handles, doing
  // the same canvas redraw + Top-packages refresh as the old
  // `[data-g2-sev]` click delegate did.)

  const g2Select = e.target.closest('[data-g2-select]')
  if (g2Select) {
    graph2.selected = g2Select.dataset.g2Select
    refreshActiveGraphSidebar()
    return
  }
  // Top-packages mini-tabs (Issues / Files). Pure right-panel
  // change — re-render just the block, leave the canvas alone.
  const g2TopPkgs = e.target.closest('[data-g2-top-pkgs]')
  if (g2TopPkgs) {
    graph2.topPkgsTab = g2TopPkgs.dataset.g2TopPkgs
    refreshActiveGraphTopPkgs()
    return
  }
  const g2JumpFindings = e.target.closest('[data-g2-jump-findings]')
  if (g2JumpFindings) {
    resetFilters()
    state.filterConfMin = 0
    state.filterInclude = g2JumpFindings.dataset.g2JumpFindings
    state.currentView = 'findings'
    // The jump targets the findings list, not the graph. If the
    // user was on the in-findings graph view, stay in findings
    // but switch to a list-style mode so the include filter
    // (which has no UI in the graph viewport) is actually visible.
    if (state.viewMode === 'graph') state.viewMode = 'table'
    cleanupGraph2()
    render()
    return
  }
  const g2JumpFile = e.target.closest('[data-g2-jump-file]')
  if (g2JumpFile) {
    const targetFile = g2JumpFile.dataset.g2JumpFile
    state.currentView = 'files'
    cleanupGraph2()
    render()
    requestAnimationFrame(() => {
      const target = document.querySelector(`#${treeAnchor(targetFile)}`)
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return
  }
  // Path/package filter clear button — wipe the input value
  // and redraw. The clear button itself is hidden via CSS
  // when the input shows its placeholder (i.e. empty), so no
  // re-render is needed; the button just disappears once the
  // input value is cleared.
  if (e.target.closest('#g2-path-filter-clear')) {
    graph2.pathFilter = ''
    const input = document.querySelector('#g2-path-filter')
    if (input) input.value = ''
    graph2.graphState?.requestDraw?.()
    return
  }
  // v2 fullscreen — same body-class flip as v1's #tree-fullscreen.
  // The CSS rule under body.report-fullscreen sizes both .tree-layout
  // and .graph2-layout to the viewport, and v2's ResizeObserver on
  // the stage element will fire when the size change lands so the
  // canvas refits without explicit wiring.
  if (e.target.closest('#g2-fullscreen')) {
    document.body.classList.toggle('report-fullscreen')
    return
  }
  // Show-all in the v2 topbar — flips the FILE SET, so the
  // graph rebuilds with different nodes / edges / layout. Tear
  // down the v2 canvas (rAF + observers + window listeners) so
  // render() can re-attach against the new set.
  const g2ShowAll = e.target.closest('[data-g2-show-all]')
  if (g2ShowAll) {
    graph2.showAll = !graph2.showAll
    graph2.layoutCache = null
    // Selection might have pointed at a file that's now filtered
    // out — clear it so the right panel doesn't render against a
    // missing node.
    graph2.selected = null
    cleanupGraph2()
    render()
    return
  }
  // Triage view selector in graph v2's topbar — flips
  // state.shownTriage to the picked bucket (or back to live when
  // re-clicking the active button). Same canvas teardown +
  // cache invalidation the prior trash toggle did so the graph
  // rebuilds against the new file set.
  const g2TriageBtn = e.target.closest('.graph2-triage-selector [data-triage-show]')
  if (g2TriageBtn) {
    const next = g2TriageBtn.dataset.triageShow
    state.shownTriage = state.shownTriage === next ? null : next
    graph2.layoutCache = null
    graph2.selected = null
    cleanupGraph2()
    render()
    return
  }
  // Package-graph drill-in (selection card → "Package graph →"):
  // narrows the canvas to a single package's intra-imports with
  // v1-style rendering. Selection is preserved when the file
  // belongs to the package being focused, so the right panel
  // keeps showing it; cleared otherwise.
  const g2FocusPkg = e.target.closest('[data-g2-focus-pkg]')
  if (g2FocusPkg) {
    graph2.focusedPkg = g2FocusPkg.dataset.g2FocusPkg
    graph2.layoutCache = null
    cleanupGraph2()
    render()
    return
  }
  // Back-to-full from the package-focus mode — restores the
  // spiral over the whole file set. Selection is kept (it's
  // valid in both modes since the file still exists in the
  // full graph).
  if (e.target.closest('#g2-back-to-full')) {
    graph2.focusedPkg = null
    graph2.layoutCache = null
    cleanupGraph2()
    render()
    return
  }
  // Tab click — switch the active tab within a group. Re-render because
  // tab highlight + tab body visibility + marks row color all update.
  // pathClosest (rather than e.target.closest) so the lookup works for
  // tabs rendered inside `<finding-table>`'s shadow DOM. Same applies
  // to the mark-dot / mark-x / mark-restore handlers below; the `[data-gid]`
  // ancestor is also resolved off the path because it's the
  // `.finding-row` inside the same shadow tree.
  const tabEl = pathClosest(e, '.tab')
  if (tabEl && pathClosest(e, '.tabs')) {
    const findingEl = pathClosest(e, '[data-gid]')
    const gid = findingEl.dataset.gid
    const tid = tabEl.dataset.tid
    state.activeTabByGroup.set(gid, tid)
    render()
    return
  }
  // Triage menu action — clicked option inside the native
  // `popover="auto"` menu. The popover is in the top layer (escapes
  // overflow-hidden ancestors), so the data-gid lookup walks UP
  // from the action button to the popover root rather than the
  // row's DOM tree. Conflict groups still scope to the active tab;
  // non-conflict groups apply to every tab. Setting any state for
  // a tab clears the others (the Map allows at most one value).
  // Manual hidePopover() after the click since the action button
  // doesn't carry a popovertarget attribute.
  const triageActionBtn = pathClosest(e, '[data-triage-action]')
  if (triageActionBtn) {
    const popover = triageActionBtn.closest('.triage-menu')
    const gid = popover?.dataset.gid
    if (!gid) return
    const group = findGroupById(gid)
    if (!group) return
    const action = triageActionBtn.dataset.triageAction
    if (!['fixed', 'invalid', 'deleted', 'ignored', 'restore'].includes(action)) return
    const groupSt = groupState(group)
    const targets = groupSt.hasConflict ? [activeTabFor(group)] : group
    for (const f of targets) {
      const key = tabKey(f)
      const iKey = ignoredKey(f)
      if (action === 'restore') {
        // Clear both buckets — Restore returns the tab to live.
        state.triageState.delete(key)
        state.ignoredIds.delete(iKey)
      } else if (action === 'ignored') {
        // Mutually exclusive with triage. Toggle on re-click.
        if (state.ignoredIds.has(iKey)) {
          state.ignoredIds.delete(iKey)
        } else {
          state.ignoredIds.add(iKey)
          state.triageState.delete(key)
        }
      } else {
        // Triage state — clear any ignore on the same tab. Toggle
        // on re-click of the active state.
        if (state.triageState.get(key) === action) {
          state.triageState.delete(key)
        } else {
          state.triageState.set(key, action)
          state.ignoredIds.delete(iKey)
        }
      }
    }
    try { popover.hidePopover() } catch {}
    saveTriage()
    render()
    return
  }
  // Comment button — open the multi-line <comment-dialog> with
  // the active tab's existing comment (empty when none).
  // Whitespace-trimmed input; empty strings clear the entry from
  // state.comments so saveTriage doesn't persist a "" placeholder.
  // The comment is per-active-tab (matching mark-color semantics —
  // a multi-tab group can hold distinct comments per member tab).
  // The dialog resolves to null when the user cancelled or saved
  // an unchanged value, so the early-return covers both.
  const commentBtn = pathClosest(e, '.mark-comment')
  if (commentBtn) {
    const findingEl = pathClosest(e, '[data-gid]')
    const gid = findingEl.dataset.gid
    const group = findGroupById(gid)
    if (!group) return
    const activeTab = activeTabFor(group)
    const activeKey = tabKey(activeTab)
    const current = state.comments.get(activeKey) ?? ''
    openCommentDialog({ initial: current, finding: activeTab }).then((next) => {
      if (next === null) return null
      if (next) state.comments.set(activeKey, next)
      else state.comments.delete(activeKey)
      saveTriage()
      render()
      return null
    }).catch(() => {})
    return
  }
  // Copy button — write the active tab's file / line /
  // description / confidence to the clipboard as a labeled
  // block. Per-active-tab so a multi-tab group copies the
  // member the user is currently looking at. Briefly toggles a
  // `.copied` class so the button's icon pulses to acknowledge
  // the click; the class is dropped after 1s so the next click
  // pulses again. Failure (no clipboard permission, no secure
  // context) silently no-ops — the button is a convenience, not
  // load-bearing.
  const copyBtn = pathClosest(e, '.mark-copy')
  if (copyBtn) {
    const findingEl = pathClosest(e, '[data-gid]')
    const gid = findingEl?.dataset?.gid
    const group = gid ? findGroupById(gid) : null
    if (!group) return
    const f = activeTabFor(group)
    // Repo header — surfaces upstream context above the file path.
    // Two paths:
    //   * The finding lives inside a package (`bucket.files.has(f.file)`
    //     in some package bucket): use that package's repo IF every
    //     analyzer agreed on a single value (`bucket.repos.size ===
    //     1`). Conflicting or absent → no header for this finding.
    //   * The finding is OWN-source (no package bucket contains its
    //     file): fall through to the per-finding `repo.github`,
    //     then the per-report `_repoFallback` stamped at ingest, then
    //     the global `state.repoUrl` typed via the page chip in
    //     single-file mode.
    let inPackage = false
    let repo = null
    for (const bucket of getPackagesIndex().values()) {
      if (bucket.files.has(f.file)) {
        inPackage = true
        if (bucket.repos && bucket.repos.size === 1) repo = [...bucket.repos][0]
        break
      }
    }
    if (!inPackage) {
      repo = f.repo?.github ?? f._repoFallback ?? state.repoUrl ?? null
      if (!repo) repo = null
    }
    const lines = []
    if (repo) lines.push(`Repo: ${repo}`)
    if (f.file) lines.push(`File: ${f.file}`)
    if (f.line !== undefined && f.line !== null && f.line !== '') lines.push(`Line: ${f.line}`)
    if (f.description) lines.push(`Description: ${f.description}`)
    if (f.confidence !== undefined && f.confidence !== null) lines.push(`Confidence: ${f.confidence}/10`)
    const text = lines.join('\n')
    try {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.classList.add('copied')
        setTimeout(() => copyBtn.classList.remove('copied'), 1000)
        return null
      }).catch(() => {})
    } catch {}
    return
  }
  // Fix-link button — mirrors the comment flow but stores into
  // state.fixes. Typically a PR URL (also accepts plain text).
  // Empty input clears the entry. Per-active-tab so a multi-tab
  // group can hold distinct fix references per member. The
  // dialog resolves to null on cancel / Esc / unchanged save.
  const fixBtn = pathClosest(e, '.mark-fix')
  if (fixBtn) {
    const findingEl = pathClosest(e, '[data-gid]')
    const gid = findingEl.dataset.gid
    const group = findGroupById(gid)
    if (!group) return
    const activeTab = activeTabFor(group)
    const activeKey = tabKey(activeTab)
    const current = state.fixes.get(activeKey) ?? ''
    openFixLinkDialog({ initial: current, finding: activeTab }).then((next) => {
      if (next === null) return null
      if (next) state.fixes.set(activeKey, next)
      else state.fixes.delete(activeKey)
      saveTriage()
      render()
      return null
    }).catch(() => {})
    return
  }
  // Toolbar triage view selector — flips state.shownTriage to the
  // picked bucket (or back to live when re-clicking the active
  // button). Filters (severity, confidence, text match) still apply,
  // just against the chosen bucket rather than the live set.
  const triageShowBtn = e.target.closest('[data-triage-show]')
  if (triageShowBtn && !triageShowBtn.closest('.graph2-triage-selector')) {
    const next = triageShowBtn.dataset.triageShow
    state.shownTriage = state.shownTriage === next ? null : next
    render()
    return
  }
  // Source filter chips — `data-source-toggle="own|modules"`.
  // Single-select with toggle-off:
  //   * click while nothing's active → switch to that chip
  //   * click on a different chip → switch (the other goes off)
  //   * click on the active chip again → clear (no filter, show all)
  // Set-based state (rather than a single string) keeps the filter
  // predicate in filters.js stable as `size === 1` checks.
  const srcChip = e.target.closest('[data-source-toggle]')
  if (srcChip) {
    const v = srcChip.dataset.sourceToggle
    const wasActive = state.filterSources.has(v)
    state.filterSources.clear()
    if (!wasActive) state.filterSources.add(v)
    render()
    return
  }
  // (severity-chips / triage-filter / view-mode-buttons clicks are
  // dispatched as `severity-toggle` / `color-toggle` /
  // `view-mode-change` custom events from their respective Lit
  // components — handled outside this click delegate by dedicated
  // listeners below.)
  // `severity-toggle` / `color-toggle` custom events from their
  // respective Lit components — handled outside this click delegate
  // by dedicated listeners below.)

  // Table-view details panel close button — clears selection and
  // re-renders so the list expands back to full width.
  if (e.target.closest('[data-table-deselect]')) {
    state.tableSelectedGid = null
    render()
    return
  }
  // Files-tab table view: row click toggles the file selection
  // (re-clicking the active row deselects, just like the findings
  // table). The details panel on the right follows
  // state.filesSelectedFile.
  const treeRow = e.target.closest('[data-tree-select]')
  if (treeRow) {
    const file = treeRow.dataset.treeSelect
    state.filesSelectedFile = state.filesSelectedFile === file ? null : file
    render()
    return
  }
  if (e.target.closest('[data-tree-deselect]')) {
    state.filesSelectedFile = null
    render()
  }
  // Table-view row click is no longer a delegate here; <finding-table>
  // owns row selection and dispatches a `row-select` CustomEvent
  // (handled below) on clicks that aren't on a button / link / label.
})

// Bundle source modal lives in `#bundle-source-overlay-slot`
// (sibling of `#main-content`, not inside `#report`), so its
// clicks don't reach the report listener above. The handlers
// here cover the modal-specific interactions: close button,
// backdrop click, side-panel close, and per-line gutter dots.
const bundleSourceOverlaySlot = document.querySelector('#bundle-source-overlay-slot')
if (bundleSourceOverlaySlot) {
  bundleSourceOverlaySlot.addEventListener('click', (e) => {
    // Backdrop click (`.bundle-source-overlay` itself, not a
    // descendant) or × button → close.
    if (e.target.classList?.contains('bundle-source-overlay')
        || e.target.closest('[data-action="bundle-source-close"]')) {
      if (state.bundleSourceFile) {
        state.bundleSourceFile = null
        state.bundleSourceFindingIdx = null
        render()
      }
      return
    }
    // Side panel close — clears the selected finding but leaves
    // the modal open.
    if (e.target.closest('[data-action="bundle-source-panel-close"]')) {
      if (state.bundleSourceFindingIdx != null) {
        state.bundleSourceFindingIdx = null
        renderPreservingSourceScroll()
      }
      return
    }
    // Gutter dot — selects a finding on this line and opens the
    // side panel. Re-clicking the same dot dismisses.
    const sourceFinding = e.target.closest('[data-bundle-source-finding]')
    if (sourceFinding) {
      const idx = parseInt(sourceFinding.dataset.bundleSourceFinding, 10)
      if (Number.isFinite(idx)) {
        state.bundleSourceFindingIdx = state.bundleSourceFindingIdx === idx ? null : idx
        renderPreservingSourceScroll()
      }
    }
  })
}

// row-select fires from inside `<finding-table>`'s shadow DOM with
// composed:true, so it bubbles up to the report element. Re-clicking
// the same row deselects (closes the side details panel).
report.addEventListener('row-select', (e) => {
  const gid = e.detail?.gid
  if (!gid) return
  state.tableSelectedGid = state.tableSelectedGid === gid ? null : gid
  render()
})

// Kanban drag-and-drop. A `<finding-row class="kanban-card">` is
// draggable; the `.kanban-column` elements advertise themselves as
// drop zones via `data-kanban-target=<active|fixed|invalid|deleted
// |ignored>`. On drop we mirror the existing `[data-triage-action]`
// menu's mutation rules (conflict groups apply to the active tab
// only, consistent groups apply to every tab), then `saveTriage()`
// + render() to repaint the board.
const KANBAN_DATA_TYPE = 'application/x-deepview-kanban-gid'

function setGroupTriage(group, target) {
  const groupSt = groupState(group)
  const targets = groupSt.hasConflict ? [activeTabFor(group)] : group
  for (const f of targets) {
    const key = tabKey(f)
    const iKey = ignoredKey(f)
    if (target === 'untriaged') {
      state.triageState.delete(key)
      state.ignoredIds.delete(iKey)
    } else if (target === 'ignored') {
      state.ignoredIds.add(iKey)
      state.triageState.delete(key)
    } else {
      state.triageState.set(key, target)
      state.ignoredIds.delete(iKey)
    }
  }
}

function clearKanbanDragChrome() {
  for (const el of report.querySelectorAll('.kanban-card.dragging')) {
    el.classList.remove('dragging')
  }
  for (const el of report.querySelectorAll('.kanban-column.drag-over')) {
    el.classList.remove('drag-over')
  }
}

report.addEventListener('dragstart', (e) => {
  const card = e.target.closest?.('.kanban-card[data-kanban-source]')
  if (!card || !e.dataTransfer) return
  const gid = card.dataset.gid
  if (!gid) return
  // Setting both a private type (for our drop predicate) and a
  // plain-text fallback (so dragging out of the app shows the gid
  // rather than nothing). `effectAllowed = 'move'` matches the
  // semantics — the card leaves its source column.
  e.dataTransfer.setData(KANBAN_DATA_TYPE, gid)
  e.dataTransfer.setData('text/plain', gid)
  e.dataTransfer.effectAllowed = 'move'
  card.classList.add('dragging')
})

report.addEventListener('dragend', () => {
  clearKanbanDragChrome()
})

report.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes(KANBAN_DATA_TYPE)) return
  const col = e.target.closest?.('.kanban-column[data-kanban-target]')
  if (!col) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  if (!col.classList.contains('drag-over')) {
    for (const other of report.querySelectorAll('.kanban-column.drag-over')) {
      if (other !== col) other.classList.remove('drag-over')
    }
    col.classList.add('drag-over')
  }
})

report.addEventListener('dragleave', (e) => {
  const col = e.target.closest?.('.kanban-column[data-kanban-target]')
  if (!col) return
  // `dragleave` also fires on entering child elements; only clear
  // the highlight when the pointer actually left the column box.
  if (col.contains(e.relatedTarget)) return
  col.classList.remove('drag-over')
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
  if (!group) return
  // No-op drops (same column) skip the persist + render churn —
  // groupState read is cheap relative to a full re-render.
  const currentTriage = groupState(group).commonTriage ?? 'untriaged'
  if (currentTriage === target) return
  setGroupTriage(group, target)
  // Paint first; persist after. saveTriage's synchronous portion
  // does a localStorage.setItem of the (potentially large)
  // pending-key JSON which can stall the next frame; doing it
  // after render() means the card visibly snaps to the new column
  // immediately and the persistence work happens off the critical
  // path. The async compress / seal already runs on its own
  // microtask chain after this point.
  render()
  queueMicrotask(saveTriage)
})

// Kanban detail popover — open / close via document.startViewTransition
// so the modal animates in / out via the CSS keyframes attached to
// `::view-transition-{new,old}(kanban-detail-modal)` in findings.css.
// We intentionally do NOT use a shared-element pairing (the card
// doesn't get the same view-transition-name): the morph between a
// 200×60 card and a 560×~400 modal causes visible drop-shadow
// flicker and, more importantly, leaves the view-transition state
// in a sometimes-stuck shape (next click takes no effect, the one
// after that does — the "every third click" report). Letting the
// modal animate in place against the unchanged kanban board is
// stable and still feels snappy.
// True between `startViewTransition` and the resolution of its
// `.finished` promise. Used to swallow rapid follow-up open / close
// clicks that would otherwise call `startViewTransition` against
// the still-active prior transition — the browser would
// `skipTransition()` the prior one, forcing its update callback to
// run synchronously against the just-updated state, which left
// the page in an inconsistent shape (the "rapid-double-click then
// nothing ever opens again" report). Card-to-card switches still
// go through (they don't start a transition).
let kanbanTransitioning = false

function kanbanCardEl(gid) {
  if (!gid) return null
  return report.querySelector(`.kanban-card[data-gid="${CSS.escape(gid)}"]`)
}

// Measure a representative kanban card and stamp its dimensions as
// CSS custom properties on the document root. The clip-path
// keyframes (kanban-clip-hide / kanban-clip-reveal in findings.css)
// use these to set the floor of the modal pseudo's clip animation
// — the modal never shrinks past card-sized, so its "small" frame
// exactly overlaps the source card instead of going to a zero-area
// inner rect that would expose the OLD modal snapshot's leftover
// edges (the "two rectangles overlapping" report). Falls back to the
// :root defaults if no card is mounted; uses the actual stamped
// source card when provided, else the first card in the board.
//
// The user note: "underestimating size is ok, overestimating might
// make the animation bad" — Math.floor of the measured rect plays
// it safe.
function updateKanbanClipVars(stampedCard) {
  const card = stampedCard ?? report.querySelector('.kanban-card')
  if (!card) return
  const rect = card.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  document.documentElement.style.setProperty(
    '--kanban-clip-card-w',
    `${Math.floor(rect.width)}px`,
  )
  document.documentElement.style.setProperty(
    '--kanban-clip-card-h',
    `${Math.floor(rect.height)}px`,
  )
}

function setKanbanPopoverGid(next) {
  const prev = state.kanbanPopoverGid
  if (prev === next) return
  const opening = prev === null && next !== null
  const closing = prev !== null && next === null

  // Plain render path: no API available, or card-to-card switch
  // (modal stays open, contents swap in place). Card switches stay
  // allowed during an in-flight transition because they don't
  // start a new one — only a render().
  if (!document.startViewTransition || (!opening && !closing)) {
    state.kanbanPopoverGid = next
    render()
    return
  }

  // Open / close are gated on the lock. Successive rapid clicks
  // are ignored until the in-flight animation completes — without
  // this the View Transitions API's `skipTransition()` race left
  // the page in a state where no further transition would render.
  if (kanbanTransitioning) return
  kanbanTransitioning = true

  // Direction class on <html> so the CSS can hide the card-side
  // pseudo for the duration of the transition. The card snapshot
  // sits at a different proportion than the modal snapshot (its
  // natural ~200×60 vs the modal's ~560×400), and during the
  // morph it's visible underneath the scaling modal as a
  // mis-proportioned stub. Hiding it leaves only the modal
  // pseudo's clip-path animation visible. CSS uses the direction
  // to pick the right pseudo: ::view-transition-old for opening
  // (OLD = card), ::view-transition-new for closing (NEW = card).
  const directionClass = opening ? 'kanban-opening' : 'kanban-closing'
  document.documentElement.classList.add(directionClass)

  // Shared-element pairing: the modal has `view-transition-name:
  // kanban-detail-modal` in CSS; we stamp the source card with
  // the same name via inline style. The browser pairs the
  // snapshots by name and the GROUP pseudo morphs position +
  // size between them, so the modal flies out of the card on
  // open and back into it on close. The inline-style bookkeeping
  // is safe because the lock above guarantees only one transition
  // is ever in flight at a time.
  //
  // Safety-net timeout: ViewTransition.finished is supposed to
  // settle (resolve or reject) when the transition ends, but
  // some browser builds get stuck and never settle if the
  // transition is interrupted oddly — that would leave the lock
  // held forever and "no clicks open the modal until reload".
  // 600ms is generous (animation runs in ~200ms); the setTimeout
  // is cleared on a clean settle.
  const unlock = (card) => {
    if (card) card.style.viewTransitionName = ''
    document.documentElement.classList.remove(directionClass)
    kanbanTransitioning = false
  }

  if (opening) {
    const card = kanbanCardEl(next)
    if (card) {
      // Set CSS clip-size vars from the actual source card, and
      // forcing layout via getBoundingClientRect inside that helper
      // doubles as a style-flush so the inline view-transition-name
      // is committed before the snapshot capture below.
      updateKanbanClipVars(card)
      card.style.viewTransitionName = 'kanban-detail-modal'
      // One more layout read to commit the just-set inline style
      // into the style tree the browser uses for the old snapshot.
      card.getBoundingClientRect()
    } else {
      updateKanbanClipVars()
    }
    state.kanbanPopoverGid = next
    const t = document.startViewTransition(() => {
      render()
      // Clear inline name inside the callback so the NEW snapshot
      // has exactly one element holding `kanban-detail-modal` —
      // the modal (via CSS). Two elements with the same name
      // would make the browser skip the pairing.
      if (card) card.style.viewTransitionName = ''
    })
    const safety = setTimeout(() => unlock(card), 600)
    ;(async () => {
      try { await t.finished } catch {}
      clearTimeout(safety)
      unlock(card)
    })()
    return
  }

  // closing — invert: stamp the destination (the formerly-focused
  // card) inside the callback after render() has removed the modal,
  // so the NEW snapshot holds the name and the browser morphs the
  // OLD modal back into the card.
  updateKanbanClipVars()
  state.kanbanPopoverGid = next
  let closeCard = null
  const t = document.startViewTransition(() => {
    render()
    closeCard = kanbanCardEl(prev)
    if (closeCard) {
      // Refresh the clip-size vars from the now-re-rendered target
      // card in case its size shifted (different content, different
      // column).
      updateKanbanClipVars(closeCard)
      closeCard.style.viewTransitionName = 'kanban-detail-modal'
    }
  })
  const safety = setTimeout(() => unlock(closeCard ?? kanbanCardEl(prev)), 600)
  ;(async () => {
    try { await t.finished } catch {}
    clearTimeout(safety)
    unlock(closeCard ?? kanbanCardEl(prev))
  })()
}

report.addEventListener('click', (e) => {
  // × button inside the modal — close. Listed first so the card
  // toggle below doesn't intercept clicks landing here when the
  // card and modal overlap z-wise (they don't, but cheap to
  // sequence).
  if (e.target.closest?.('.kanban-detail-close')) {
    setKanbanPopoverGid(null)
    return
  }
  // Kanban card — open / toggle / switch. Backdrop is
  // pointer-events: none in CSS so this branch can also fire for
  // clicks landing on a card that's visually behind the backdrop
  // — re-clicking the active card toggles the modal closed
  // without needing a separate trip through the backdrop.
  const card = e.target.closest?.('.kanban-card[data-kanban-source]')
  if (card) {
    // Skip when the user is grabbing text (selection clicks fire
    // a click after mouseup with a non-empty selection range).
    if (window.getSelection?.()?.toString()) return
    const gid = card.dataset.gid
    if (!gid) return
    setKanbanPopoverGid(state.kanbanPopoverGid === gid ? null : gid)
    return
  }
  // Click inside the modal panel — no-op (action buttons inside
  // run via their own delegates higher up in this file).
  if (e.target.closest?.('.kanban-detail-modal')) return
  // Click anywhere else while the modal is open → close. With the
  // backdrop set to pointer-events: none, these clicks bubble up
  // from whatever non-modal, non-card DOM was under the cursor
  // (a column header, empty column body, the kanban board gutter).
  if (state.kanbanPopoverGid) setKanbanPopoverGid(null)
})

// Esc dismisses the popover. Bound to document so it fires
// regardless of focus location — the modal isn't a `<dialog>`
// (we manage focus + light dismiss ourselves to keep view-transition
// in the driver's seat).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!state.kanbanPopoverGid) return
  setKanbanPopoverGid(null)
})

// mark-color fires from `<color-marker>` (composed:true) when one of
// its dots is clicked. Color applies to the ACTIVE tab only (per
// spec rule 4); clicking the currently-marked color toggles it off.
// This may change tab sort order (colored tabs come first), so a
// full re-render is necessary — we can't just flip classes in place.
report.addEventListener('mark-color', (e) => {
  const findingEl = pathClosest(e, '[data-gid]')
  if (!findingEl) return
  const gid = findingEl.dataset.gid
  const group = findGroupById(gid)
  if (!group) return
  const activeKey = tabKey(activeTabFor(group))
  const color = e.detail?.color
  if (!color) return
  const current = state.markers.get(activeKey)
  if (current === color) state.markers.delete(activeKey)
  else state.markers.set(activeKey, color)
  saveTriage()
  render()
})

// Print button — fixed top-right icon, lives OUTSIDE #report (see
// index.html / styles/theme.css), so the report-level click delegate
// can't see it. Attach directly. Two pieces of state get swapped
// for the duration of the print and restored after the dialog
// dismisses:
//
//   - document.title → filename (or longest common prefix across
//     loaded reports) so the OS print dialog and any saved PDF
//     default to a meaningful name. Set AFTER the viewMode swap
//     because `render()` ends by writing the document title.
//
//   - state.viewMode `table` → `list`. The table layout is
//     interaction-driven (compact rows, side details panel, hover
//     state) and prints as a stub of the row chrome with none of
//     the finding body the reader needs on paper. List mode paints
//     the full card per entry, which is what paper actually wants.
//     `tableSelectedGid` isn't bound to viewMode so the row
//     selection survives the round trip.
//
// The swap/restore lifecycle is owned by a beforeprint/afterprint
// pair so non-button entry points (Ctrl+P, browser menu, print
// extensions) get the same printable layout. The pair alone isn't
// enough, though: `<finding-card>` is a Lit element whose render is
// scheduled in a microtask, so going from beforeprint straight to
// the browser snapshot prints empty card shells — only the
// file/location headers, which land synchronously through
// innerHTML, show up. The button handler covers that by running
// the swap eagerly and awaiting every card's `updateComplete`
// BEFORE calling `window.print()`; beforeprint then no-ops because
// `prepareForPrint` is idempotent on the saved-state sentinel. The
// Ctrl+P / menu path can't insert that await between the event and
// the snapshot and is best-effort — the mode swap and title
// rewrite land, but finding bodies may print blank on the first
// shot (a second print after Lit has caught up renders fully).
// Microtasks drain through the await chain in user-gesture
// context, so `window.print()` still pops a dialog without the
// browser suppressing it as automation.
//
// Saved-state vars hold the values to restore on afterprint; a
// non-null `printSavedMode` doubles as the re-entrancy guard so
// the click handler doesn't race itself across the await and
// beforeprint doesn't clobber state the click handler captured.
let printSavedMode = null
let printSavedTitle = null

function prepareForPrint() {
  if (printSavedMode !== null) return
  if (state.reports.length === 0) return
  printSavedMode = state.viewMode
  printSavedTitle = document.title
  if (state.viewMode === 'table') {
    state.viewMode = 'list'
    render()
  }
  const fileNames = state.reports.map((r) => r.fileName)
  let target = ''
  if (fileNames.length === 1) target = fileNames[0]
  else if (fileNames.length > 1) target = commonPrefix(fileNames)
  // Strip the `.json` suffix so a "Save as PDF" doesn't end up
  // named `<report>.json.pdf`. Also handles a stripped trailing
  // `.` from a partial common prefix like `security-foo.j` —
  // only `.json` exactly at the end gets removed.
  target = target.replace(/\.json$/u, '')
  if (target) document.title = target
}

function restoreAfterPrint() {
  if (printSavedMode === null) return
  if (state.viewMode !== printSavedMode) {
    state.viewMode = printSavedMode
    render()
  }
  document.title = printSavedTitle
  printSavedMode = null
  printSavedTitle = null
}

window.addEventListener('beforeprint', prepareForPrint)
window.addEventListener('afterprint', restoreAfterPrint)

document.querySelector('#print-btn').addEventListener('click', async () => {
  if (state.reports.length === 0) return
  if (printSavedMode !== null) return
  prepareForPrint()
  try {
    // `updateComplete` resolves after the element's render() has
    // applied its template; doing this on every card is overkill
    // in steady-state but cheap enough relative to dialog-modal
    // time.
    await Promise.all(
      [...report.querySelectorAll('finding-card')].map((c) => c.updateComplete),
    )
    window.print()
  } catch (e) {
    // If window.print() never fires, afterprint won't either —
    // restore manually so the page isn't stranded in list mode.
    // Safe to call even if afterprint has already run; the
    // sentinel check no-ops it.
    restoreAfterPrint()
    throw e
  }
})

// Markdown download — pairs with the print button (same top-right
// stack). Pure data export: no view-mode swap needed since we
// serialize state.reports + per-finding triage / marker / comment
// state directly, without going through the DOM.
document.querySelector('#download-btn').addEventListener('click', () => {
  if (state.reports.length === 0) return
  downloadReportsAsMarkdown(state.reports)
})

report.addEventListener('change', (e) => {
  const id = e.target.id
  const val = e.target.value
  if (id === 'sort-select') { state.sortBy = val; render() }
  else if (id === 'analyzer-select') { state.filterAnalyzer = val; render() }
  else if (id === 'packages-sort-select') { state.packagesSortBy = val; render() }
  else if (id === 'repositories-sort-select') { state.repositoriesSortBy = val; render() }
})

// Confidence range slider. `range-change` fires on release and
// triggers the full render so every chrome piece (severity-chip
// badges, the search row's `X of Y`) catches up. The drag-time
// label mirror is owned by the <conf-range-mirror> element — it
// listens to `range-input` directly and updates its own text, so
// the toolbar doesn't have to re-render per tick.
report.addEventListener('range-change', (e) => {
  if (e.target.id !== 'conf-range') return
  state.filterConfMin = e.detail.low
  state.filterConfMax = e.detail.high
  render()
})

report.addEventListener('input', (e) => {
  const id = e.target.id
  const val = e.target.value
  if (id === 'filter-search') { state.filterInclude = val; renderKeepFocus(id) }
  else if (id === 'filter-files-search') { state.filesSearch = val; renderKeepFocus(id) }
  else if (id === 'g2-path-filter') {
    graph2.pathFilter = val
    graph2.graphState?.requestDraw?.()
  }
  else if (id === 'bundle-code-search-input') {
    state.bundleCodeSearchQuery = val
    renderKeepFocus(id)
  }
  else if (id === 'packages-search-input') {
    state.packagesSearchQuery = val
    renderKeepFocus(id)
  }
  else if (id === 'repositories-search-input') {
    state.repositoriesSearchQuery = val
    renderKeepFocus(id)
  }
})

// `<severity-chips>` / `<triage-filter>` events. Each component
// dispatches a `*-toggle` event with the value to flip; the host
// adds / removes it from the matching state Set and re-renders so
// the rest of the chrome (counts on the chips, the filtered row
// count) catches up.
report.addEventListener('severity-toggle', (e) => {
  const sev = e.detail.severity
  if (e.detail.kind === 'graph') {
    // Graph topbar usage — flip `graph2.selectedSeverities` (the
    // canvas highlight set, separate from the findings-tab filter)
    // and trigger a surgical canvas redraw + Top-packages refresh.
    // A full render() would tear down the canvas's rAF loop / hover
    // state, so we update the chip's `selected` property in place
    // instead of re-rendering through render.js.
    if (graph2.selectedSeverities.has(sev)) graph2.selectedSeverities.delete(sev)
    else graph2.selectedSeverities.add(sev)
    e.target.selected = [...graph2.selectedSeverities]
    graph2.graphState?.requestDraw?.()
    refreshActiveGraphTopPkgs()
    return
  }
  // Findings-tab usage (default) — flips `state.filterSeverities`
  // and full-renders so the toolbar count + visible row set catch up.
  if (state.filterSeverities.has(sev)) state.filterSeverities.delete(sev)
  else state.filterSeverities.add(sev)
  render()
})
report.addEventListener('color-toggle', (e) => {
  const col = e.detail.color
  if (e.detail.kind === 'graph') {
    // Graph topbar usage — flip `graph2.selectedColors` (the canvas
    // highlight set, separate from the findings-tab filter) and
    // trigger a surgical canvas redraw + Top-packages refresh.
    // Mirrors the severity-toggle 'graph' branch above; a full
    // render() would tear down the canvas's rAF loop / hover state.
    if (graph2.selectedColors.has(col)) graph2.selectedColors.delete(col)
    else graph2.selectedColors.add(col)
    e.target.selected = [...graph2.selectedColors]
    graph2.graphState?.requestDraw?.()
    refreshActiveGraphTopPkgs()
    return
  }
  if (state.filterColors.has(col)) state.filterColors.delete(col)
  else state.filterColors.add(col)
  render()
})
report.addEventListener('view-mode-change', (e) => {
  if (e.detail.kind === 'files') {
    // Files-tab toggle — flips state.filesViewMode (table | list).
    // Not persisted to localStorage; only the findings tab's mode
    // round-trips since that's what the user sees first on a
    // typical load. Re-render is enough for the Files tab.
    state.filesViewMode = e.detail.mode
    render()
    return
  }
  state.viewMode = e.detail.mode
  // Persist so the user's preferred view sticks across reloads —
  // state.js reads it back on boot.
  try { localStorage.setItem(VIEW_MODE_KEY, state.viewMode) } catch {}
  // Switching away from kanban drops the popover gid — the modal
  // only renders inside the kanban template, so a stale gid here
  // would leak across view-mode changes when the user returns.
  if (state.viewMode !== 'kanban') state.kanbanPopoverGid = null
  render()
})

// `<repo-chip>` events (see view/repo-chip.js). The component owns
// the editing UI and the focus management; we only need to mirror
// the events to `state` and trigger the re-render that catches up
// the rest of the chrome (`fileUrl()` / `commitUrl()` -driven row
// links, the `prettyRepoLabel` shown on the chip face).
report.addEventListener('repo-edit-start', () => {
  state.repoEditing = true
  render()
})
report.addEventListener('repo-input', (e) => {
  // Live-save: every keystroke updates `state.repoUrl` and persists
  // to localStorage per-report, so the value survives a reload even
  // if the user never explicitly commits via Enter / blur.
  state.repoUrl = e.detail.url
  saveRepoUrlFor(state.currentFile, state.repoUrl)
})
report.addEventListener('repo-commit', (e) => {
  state.repoUrl = e.detail.url
  saveRepoUrlFor(state.currentFile, state.repoUrl)
  state.repoEditing = false
  render()
})
report.addEventListener('repo-cancel', (e) => {
  // The component sends back the value the input was opened with;
  // restore it so the rolled-back URL drives the chip's display
  // and the per-report persistence both flip back in step.
  state.repoUrl = e.detail.url
  saveRepoUrlFor(state.currentFile, state.repoUrl)
  state.repoEditing = false
  render()
})

// Escape closes the bundle source viewer when it's open. Listen at
// the document level so the keypress lands regardless of which
// element holds focus (the modal isn't a focusable container, and
// we don't want to force-focus on open just to catch keys).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  // Escape closes the side panel first when one's open — pressing
  // Escape twice fully exits the viewer. Otherwise close the modal.
  if (state.bundleSourceFindingIdx != null) {
    state.bundleSourceFindingIdx = null
    renderPreservingSourceScroll()
    return
  }
  if (state.bundleSourceFile) {
    state.bundleSourceFile = null
    render()
  }
})

