import { VIEW_MODE_KEY, isReportIgnored, patchEntry, saveRepoUrlFor, saveTriage, setReportIgnored, state, subscribeToBundleFindingIndex } from '#client/index.js'
import { report } from './dom.js'
import { commonPrefix, handoffBlock } from './format.js'
import { activeTabFor, findGroupById, findingRepo, findingReport, groupState, tabKey } from './group.js'
import { resetFilters } from './filters.js'
import { refreshGraph2Sidebar, refreshGraph2TopPkgs, render } from './render.js'
import { refreshBundleGraphSidebar, refreshBundleGraphTopPkgs, revealBundleCodeCurrent } from './render-bundle.js'
import { grantAdvisoriesProxyConsent, retryBundleAdvisories } from './render-bundle-advisories.js'
import { openCommentDialog } from './dialogs/comment-dialog.js'
import { openExportConfirmDialog } from './dialogs/export-confirm-dialog.js'
import { openFixLinkDialog } from './dialogs/fix-link-dialog.js'
import { downloadReportsAsMarkdown } from './markdown-export.js'

// When another OPFS report finishes parsing, re-render if the user is
// viewing a bundle — Issues tab and Graph view both pull from the
// index, so newly-indexed findings must land without a tab flip / re-open.
subscribeToBundleFindingIndex(() => {
  if (state.currentView === 'bundles' && state.selectedBundle) render()
  else if (state.currentView === 'packages') render()
  else if (state.currentView === 'repositories') render()
  else if (state.currentView === 'findings' || state.currentView === 'files') {
    // Sidebar's PACKAGES / REPOSITORIES captions depend on the index
    // too; refresh it (main view stays put).
    renderSidebar().catch(() => {})
  }
})

// Findings-tab and bundles-tab graph views share renderGraph2Layout
// chrome but draw from different graph data. Pick the refresh helper
// by active view so a node selection inside a bundle graph repaints
// the bundle's sidebar / top-pkgs block, not the findings tab's.
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
// Lit may detach + reattach .bundle-source-code-wrap when sibling
// structure changes (e.g. side-panel toggle), dropping scrollTop;
// capture before, restore after. Source-viewer-specific because
// nothing else here has user-driven scroll worth preserving.
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

// Re-render preserving scrollTop on a named container. Picking a row
// in a list-driven view (Code rail tree, Issues slide, Code search)
// makes Lit rebuild the container's children for the `.current`
// highlight / data-shape change, and a rebuilt subtree resets
// scrollTop on the scrolling ancestor.
function renderPreservingScrollOf(selector) {
  const before = document.querySelector(selector)
  const top = before?.scrollTop ?? 0
  render()
  const after = document.querySelector(selector)
  if (after) after.scrollTop = top
}

// Row-internal interactions (tab switch, triage popover, mark-color,
// comment / fix save, details-panel close) re-render after mutating
// per-tab state. Steady-state table renders now diff in place (the
// persistent `<finding-table>` stays connected across them — see
// render.js), so a bare render() no longer resets scrollTop on
// `.findings-table-list`; this wrapper stays as a safeguard for the
// renders that DO rebuild the scroller (cross-view / cross-shape
// re-entry recreating the body slots).
function renderPreservingTableScroll() {
  if (state.viewMode === 'table') renderPreservingScrollOf('.findings-table-list')
  else render()
}
// Coalesce Search-tab re-renders to one per animation frame. The
// full-bundle scan (renderBundleSearchResults) runs inside render(),
// so rendering synchronously on every keystroke would tie typing
// latency to the scan cost; deferring to the next frame keeps the
// input responsive and collapses bursts (held key / paste / IME) into
// a single scan. The query state is written synchronously, so a frame
// already pending just picks up the newest value when it fires.
// (The scan itself also refines forward-typed queries from the
// previous keystroke's result — see bundle-search-scan.js — so the
// per-frame cost usually drops to re-checking prior hit lines.)
let _bundleSearchRaf = 0
function renderBundleSearchDebounced() {
  if (_bundleSearchRaf) return
  _bundleSearchRaf = requestAnimationFrame(() => {
    _bundleSearchRaf = 0
    render()
  })
}
import { openBundle } from './bundle-load.js'
import { renderSidebar } from './sidebar.js'
import { BUNDLE_TABS, persistLastBundle, switchToFile } from './ingest.js'
import { treeAnchor } from './file-counts.js'
import { graph2, cleanupGraph2 } from './graph/state.js'

// composedPath-aware Element.closest — needed for clicks originating
// inside a shadow DOM (e.g. `<finding-table>`'s `.tab` / `.mark-*`
// buttons): clicks bubble out composed:true but `e.target` retargets
// to the shadow host, so a plain `e.target.closest()` would miss the
// inner element; composedPath sees the original target. Works for
// light-DOM clicks too since the path starts at the same node.
function pathClosest(e, selector) {
  for (const el of e.composedPath()) {
    if (el?.matches?.(selector)) return el
  }
  return null
}

// Labeled `Repo / File / Line / Description / Confidence` block for
// the active tab under the clicked button. Shared by the copy and
// Claude buttons (and, built the same way from `findingRepo` +
// `handoffBlock`, the GitHub-issue link in render-finding.js). Repo
// lookup walks the package index first (matching the per-package repo
// header in the file picker), falling back to the per-finding /
// per-report / global repo URL for OWN-source findings.
function findingHandoffText(e) {
  const findingEl = pathClosest(e, '[data-gid]')
  const gid = findingEl?.dataset?.gid
  const group = gid ? findGroupById(gid) : null
  if (!group) return null
  const f = activeTabFor(group)
  return handoffBlock(f, findingRepo(f))
}

// All interactive elements inside #report are handled via event
// delegation here, no inline handlers. Order matters: more specific
// selectors come first so they short-circuit before a generic match
// (e.g. tree-graph buttons before generic tab clicks).
report.addEventListener('click', (e) => {
  // Finding card's `[Code]` shortcut — pops the bundle source viewer
  // modal as an overlay on the current view (findings, packages, etc.)
  // without navigating away, via the global overlay slot
  // (`#bundle-source-overlay-slot`, mounted by render.js each render).
  // Button lives in `<finding-card>`'s shadow root, hence composedPath.
  const findingCode = pathClosest(e, '[data-finding-code-bundle]')
  if (findingCode) {
    const integrity = findingCode.dataset.findingCodeBundle
    const file = findingCode.dataset.findingCodeFile
    const lineAttr = findingCode.dataset.findingCodeLine
    const line = lineAttr ? parseInt(lineAttr, 10) : null
    state.bundleSourceFile = file || null
    state.bundleSourceFindingIdx = null
    // The modal suppresses itself in the Code + Search tabs (those
    // slides render the source inline); flip back to default so it
    // surfaces even if the user is parked on one of them.
    if (state.bundleDetailsTab === 'code' || state.bundleDetailsTab === 'search') {
      state.bundleDetailsTab = 'overview'
    }
    // After the modal mounts, scroll its line-row to the top of the
    // viewport (same shape Code-search hits use).
    const scrollToFindingLine = () => {
      if (!Number.isFinite(line)) return
      queueMicrotask(() => {
        const row = document.querySelector(`.bundle-source-lineno-row[data-line="${line}"]`)
        // `instant`, not `smooth`: the modal pops over the current
        // view, so a smooth scroll from its initial natural position
        // would visibly drift the line into place. Instant lands the
        // line at the top in the same frame the modal appears.
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
  // Packages list — expand chevron on multi-version row headlines.
  // Flips `state.expandedPackages` so older-version sub-rows surface /
  // hide next render. Listed before the row-issues / row-select
  // handlers: the chevron lives inside the `<li>`, so bubbling up
  // would otherwise select the latest-version row alongside the expand.
  const pkgExpand = e.target.closest('[data-package-expand]')
  if (pkgExpand) {
    const pkg = pkgExpand.dataset.packageExpand
    if (state.expandedPackages.has(pkg)) state.expandedPackages.delete(pkg)
    else state.expandedPackages.add(pkg)
    render()
    return
  }
  // Before the row-select handler below: the [Issues →] button sits
  // inside the selectable `<li>`, so closest() would otherwise select
  // the row too.
  const pkgRowIssues = e.target.closest('[data-package-row-issues]')
  if (pkgRowIssues) {
    const pkg = pkgRowIssues.dataset.packageRowIssues
    const ver = pkgRowIssues.dataset.packageRowIssuesVersion
    state.selectedPackage = pkg
    state.selectedPackageVersion = ver ? ver : null
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
  // doesn't carry the prior selection's tab choice. The version
  // pin reads off the `data-select-package-version` attribute
  // (empty string → null, meaning "use the package aggregate" /
  // "the only version slot" — see versionMatchesSelection in
  // render-packages.js).
  const selPackage = e.target.closest('[data-select-package]')
  if (selPackage) {
    const pkg = selPackage.dataset.selectPackage
    const verRaw = selPackage.dataset.selectPackageVersion ?? ''
    const ver = verRaw === '' ? null : verRaw
    if (state.selectedPackage === pkg && state.selectedPackageVersion === ver) return
    state.selectedPackage = pkg
    state.selectedPackageVersion = ver
    state.packageDetailsTab = 'overview'
    // Drop the slide's triage sub-view so a new pick lands in the
    // default `live` (untriaged + in-progress + fixed) bucket — carrying a
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
    state.selectedPackageVersion = null
    render()
    return
  }
  // Packages details — tab switch. Overview keeps the regular
  // list + details layout; Issues opens the full-width slide
  // (state.packageDetailsTab='issues' triggers the slide branch
  // in renderPackagesView). Bucket's already in memory, so the
  // re-render is paint-only.
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
      state.selectedPackageVersion = null
      state.packageSlideTransient = false
    }
    render()
    return
  }
  // Package / repository slide Invalid / Deleted tabs dispatch
  // `slide-triage-toggle` CustomEvents from `<slide-triage-tabs>` —
  // handled by the listener below (search "slide-triage-toggle"), no
  // data-attribute branch here.
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
  // Repository slide Invalid / Deleted tabs — handled by the
  // `slide-triage-toggle` listener registered below. See the matching
  // comment in the package-slide branch above.
  // Bundle view — top tab switch. The strip carries Issues,
  // Terminal, Treemap, Graph, Code, Overview. State is purely UI;
  // the parsed bundleDetails stays cached so flipping tabs is
  // paint-only (except Graph / Terminal which re-mount their
  // canvas / terminal slot in render.js).
  const bundleTab = e.target.closest('[data-bundle-tab]')
  if (bundleTab) {
    const tab = bundleTab.dataset.bundleTab
    if (BUNDLE_TABS.has(tab)) {
      // Re-clicking the active tab is a UI no-op. Without this, the
      // reset below wiped the Code slide's open file (and the
      // Search sidebar) on a click that navigates nowhere. The
      // overlay modal can't coexist with a tab click (it covers
      // the strip), so nothing else distinguishes the same-tab
      // case. Still persist: the render-time coercions (hidden
      // advisories / compare → 'overview') mutate the tab without
      // persisting, and the same-tab click is the one chance to
      // repair that stale suffix.
      if (tab === state.bundleDetailsTab) {
        if (state.selectedBundle) persistLastBundle(state.selectedBundle, tab)
        return
      }
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
      // The Code slide auto-opens a default file on entry (see
      // pickDefaultBundleCodeFile); bring its tree row into view —
      // the worst-issue file can live deep in a long node_modules
      // subtree the rail opens scrolled past.
      if (tab === 'code') revealBundleCodeCurrent()
    }
    return
  }
  // Search tab — Context show/hide pill in the header. Flips whether
  // matches render with surrounding lines or just the match lines;
  // preserve the results scroll so the toggle doesn't jump the view.
  const searchContext = pathClosest(e, '[data-bundle-search-context]')
  if (searchContext) {
    state.bundleSearchContext = !state.bundleSearchContext
    renderPreservingScrollOf('.bundle-search-results')
    return
  }
  // Advisories tab — first-visit consent confirm. Writes the
  // localStorage flag + re-renders; the Advisories body's
  // ensureBundleAdvisories call then sees hasConsent() = true on
  // the next pass and kicks the fetch.
  if (e.target.closest('[data-advisories-consent]')) {
    grantAdvisoriesProxyConsent()
    render()
    return
  }
  // Advisories tab — Retry after a failed fetch. Drops the sticky
  // error entry and re-issues the lookup; the immediate render()
  // paints the loading line while the new request is in flight.
  if (e.target.closest('[data-advisories-retry]')) {
    retryBundleAdvisories(state.bundleDetails, render).catch(() => {})
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
  // Bundle code-rail search-mode tabs (Files / Code / Issues)
  // dispatch `bundle-search-mode-change` from `<bundle-code-search>`
  // — handled by the listener below. Clicking a tab doesn't clear the
  // query so the user can pivot between modes against the same string.
  // The [×] clear button inside `<bundle-code-search>` dispatches the
  // same `search-input` CustomEvent as typed input with `value: ""`,
  // so the search-input listener below handles both flows uniformly.
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
  // Code slide — issue stepper (‹ ›) in the main bar. Cycles
  // bundleSourceFindingIdx through the open file's findings in line
  // order (wrapping), opening the side panel on each, and scrolls
  // the finding's line into view. The line-ordered (idx, line)
  // pairs ride in a JSON attribute on the stepper container so the
  // handler doesn't re-derive the per-file findings.
  const issueStep = e.target.closest('[data-bundle-code-issue-step]')
  if (issueStep) {
    const holder = issueStep.closest('[data-bundle-code-issue-order]')
    let order = null
    try { order = JSON.parse(holder?.dataset.bundleCodeIssueOrder ?? 'null') } catch {}
    if (Array.isArray(order) && order.length > 0) {
      const step = issueStep.dataset.bundleCodeIssueStep === '-1' ? -1 : 1
      const pos = order.findIndex((o) => o.idx === state.bundleSourceFindingIdx)
      // No selection yet: forward starts at the first finding,
      // backward at the last — both feel like "begin from my end".
      const next = pos === -1
        ? (step > 0 ? order[0] : order.at(-1))
        : order[(pos + step + order.length) % order.length]
      state.bundleSourceFindingIdx = next.idx
      renderPreservingSourceScroll()
      if (next.line > 0) {
        queueMicrotask(() => {
          const row = document.querySelector(`.bundle-source-lineno-row[data-line="${next.line}"]`)
          if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' })
        })
      }
    }
    return
  }
  const sourceOpen = pathClosest(e, '[data-bundle-view-source]')
  if (sourceOpen) {
    const path = sourceOpen.dataset.bundleViewSource
    if (!path) return
    // Optional finding pointer — set when an Issues-mode search
    // result is clicked; opens the side panel directly on that
    // finding and (after render) scrolls the source viewer to
    // its line. Plain Files-mode / Code-mode clicks omit the
    // attribute: a re-click on the open file keeps the pointer,
    // but a different file drops it — the index is a position in
    // the PREVIOUS file's findings array, so carrying it over
    // opened the side panel on an arbitrary finding of the new
    // file (or pointed past its end).
    const findingIdxAttr = sourceOpen.dataset.bundleViewFindingIdx
    const findingIdx = findingIdxAttr === undefined ? null : parseInt(findingIdxAttr, 10)
    const lineAttr = sourceOpen.dataset.bundleViewLine
    const line = lineAttr ? parseInt(lineAttr, 10) : null
    const pathChanged = state.bundleSourceFile !== path
    state.bundleSourceFile = path
    if (Number.isFinite(findingIdx)) state.bundleSourceFindingIdx = findingIdx
    else if (pathChanged) state.bundleSourceFindingIdx = null
    // Preserve the scroll position of whichever list-style
    // container the click came from. Code rail (tree / search
    // results), Issues slide (file-grouped list), and Code source
    // viewer panels each scroll inside their own element; the
    // outermost match wins. render() would otherwise reset
    // scrollTop on whichever subtree Lit rebuilds for the new
    // `.current` highlight.
    if (sourceOpen.closest('.bundle-code-rail')) {
      renderPreservingScrollOf('.bundle-code-rail-body')
    } else if (sourceOpen.closest('.bundle-search-results')) {
      renderPreservingScrollOf('.bundle-search-results')
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
  // Files toggle (page header, right of the repo chip). Flips
  // state.currentView between 'files' and 'findings', mirroring the
  // Trash button's state.showDeleted. The graph view-mode lives
  // inside Findings; its rAF/observers tear down when render() resets
  // the body innerHTML, but cleanupGraph2 is called explicitly so the
  // canvas drops its viewport cache / hover state cleanly across the
  // switch.
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
  const g2Pkg = pathClosest(e, '[data-g2-pkg]')
  if (g2Pkg) {
    const pkg = g2Pkg.dataset.g2Pkg
    // Clicking a package row (Top packages list) toggles solo on
    // that package; re-clicking the soloed entry clears solo.
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
  // (graph2 severity filter is a `<severity-chips kind="graph">`; its
  // click dispatches `severity-toggle`, handled by the listener at the
  // bottom of this file — canvas redraw + Top-packages refresh.)

  const g2Select = pathClosest(e, '[data-g2-select]')
  if (g2Select) {
    graph2.selected = g2Select.dataset.g2Select
    refreshActiveGraphSidebar()
    // The canvas paints the selection ring from graph2.selected, so
    // redraw now — otherwise the highlight lags until the next hover
    // happens to dirty the frame.
    graph2.graphState?.requestDraw?.()
    return
  }
  // Top-packages mini-tabs (Issues / Files). Pure right-panel
  // change — re-render just the block, leave the canvas alone.
  const g2TopPkgs = pathClosest(e, '[data-g2-top-pkgs]')
  if (g2TopPkgs) {
    graph2.topPkgsTab = g2TopPkgs.dataset.g2TopPkgs
    refreshActiveGraphTopPkgs()
    return
  }
  const g2JumpFindings = pathClosest(e, '[data-g2-jump-findings]')
  if (g2JumpFindings) {
    // Bundle context — the canvas-selected file lives inside a
    // bundle, not in `state.reports`, so flipping
    // `state.currentView = 'findings'` would navigate out of the
    // bundle entirely. Switch to the bundle's Issues tab instead so
    // the click stays bundle-local — the closest analog to "show me
    // this file's findings" inside a bundle.
    if (state.currentView === 'bundles') {
      if (state.bundleDetailsTab === 'graph') cleanupGraph2()
      state.bundleDetailsTab = 'issues'
      state.bundleSourceFile = null
      state.bundleSourceFindingIdx = null
      if (state.selectedBundle) persistLastBundle(state.selectedBundle, 'issues')
      render()
      return
    }
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
  const g2JumpFile = pathClosest(e, '[data-g2-jump-file]')
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
  if (pathClosest(e, '#g2-path-filter-clear')) {
    graph2.pathFilter = ''
    const input = document.querySelector('graph-layout')?.shadowRoot?.querySelector('#g2-path-filter')
    if (input) input.value = ''
    graph2.graphState?.requestDraw?.()
    return
  }
  // v2 fullscreen — same body-class flip as v1's #tree-fullscreen.
  // The CSS rule under body.report-fullscreen sizes both .tree-layout
  // and .graph2-layout to the viewport, and v2's ResizeObserver on
  // the stage element will fire when the size change lands so the
  // canvas refits without explicit wiring.
  if (pathClosest(e, '#g2-fullscreen')) {
    document.body.classList.toggle('report-fullscreen')
    return
  }
  // Show-all in the v2 topbar — flips the FILE SET, so the
  // graph rebuilds with different nodes / edges / layout. Tear
  // down the v2 canvas (rAF + observers + window listeners) so
  // render() can re-attach against the new set.
  const g2ShowAll = pathClosest(e, '[data-g2-show-all]')
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
  // Split-dirs toggle (bundle Graph tab) — reclassifies own source
  // (one `__own__` group ⇄ a group per top-level dir), which changes
  // the package set, the colors, and the spiral clustering, so the
  // graph rebuilds. A solo'd / focused package name may no longer
  // exist after the flip (e.g. `src` → `__own__`), so clear both;
  // the file set is unchanged, so `selected` stays valid at file
  // altitude — but when the flip lands back on the packages view
  // (focus was just cleared), a surviving file selection would put
  // a file card over a package canvas, so it clears there.
  const g2SplitOwn = pathClosest(e, '[data-g2-split-own]')
  if (g2SplitOwn) {
    graph2.splitOwnDirs = !graph2.splitOwnDirs
    graph2.layoutCache = null
    graph2.solo = null
    graph2.focusedPkg = null
    if (graph2.packagesView) graph2.selected = null
    cleanupGraph2()
    render()
    return
  }
  // Packages-view toggle (bundle Graph tab) — flips the canvas
  // between one-node-per-file and one-node-per-package. The node
  // set, layout, and hit-testing all change, so tear down + rebuild
  // like the other graph-reshaping toggles. File selection is a
  // file-level concept — clear it so the sidebar doesn't show a
  // file card over a package canvas; a solo'd package stays (it's
  // the packages view's selection) and so does the focus drill-in
  // wiring through it. Exits package-focus mode for the same
  // reason the selection clears: the user asked for a different
  // altitude, not a different slice.
  const g2PackagesView = pathClosest(e, '[data-g2-packages-view]')
  if (g2PackagesView) {
    graph2.packagesView = !graph2.packagesView
    graph2.layoutCache = null
    graph2.selected = null
    graph2.focusedPkg = null
    cleanupGraph2()
    render()
    return
  }
  // Triage view selector in graph v2's topbar — flips
  // state.shownTriage to the picked bucket (or back to live when
  // re-clicking the active button). Canvas teardown + cache
  // invalidation so the graph rebuilds against the new file set.
  const g2TriageBtn = pathClosest(e, '.graph2-triage-selector [data-triage-show]')
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
  const g2FocusPkg = pathClosest(e, '[data-g2-focus-pkg]')
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
  // full graph) — EXCEPT when the back lands on the packages
  // view (focus suspended it; clearing focus resumes it): a
  // file picked inside the drill-in has no node on the package
  // canvas, and the sidebar would show its file card desynced
  // from the solo ring. Same file-card-over-package-canvas rule
  // the Packages toggle handler applies. graph2.packagesView may
  // be a stale `true` on a graph whose gate is off (< 3
  // packages, file altitude resumes) — over-clearing there costs
  // a selection, which beats under-clearing at package altitude.
  if (pathClosest(e, '#g2-back-to-full')) {
    graph2.focusedPkg = null
    graph2.layoutCache = null
    if (graph2.packagesView) graph2.selected = null
    cleanupGraph2()
    render()
    return
  }
  // Tab click — switch the active tab within a group. Re-render because
  // tab highlight + tab body visibility + marks row color all update.
  // pathClosest (not e.target.closest) so the lookup works for tabs
  // rendered inside `<finding-table>`'s shadow DOM — same for the
  // mark-* handlers below, and the `[data-gid]` ancestor is resolved
  // off the path too (it's the `.finding-row` in the same shadow tree).
  const tabEl = pathClosest(e, '.tab')
  if (tabEl && pathClosest(e, '.tabs')) {
    const findingEl = pathClosest(e, '[data-gid]')
    const gid = findingEl.dataset.gid
    const tid = tabEl.dataset.tid
    state.activeTabByGroup.set(gid, tid)
    renderPreservingTableScroll()
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
    if (!['inprogress', 'fixed', 'invalid', 'deleted', 'ignored', 'restore'].includes(action)) return
    const groupSt = groupState(group)
    const targets = groupSt.hasConflict ? [activeTabFor(group)] : group
    for (const f of targets) {
      const key = tabKey(f)
      const reportName = findingReport(f)
      if (action === 'restore') {
        // Clear both buckets — Restore returns the tab to live.
        patchEntry(state.triage, key, { triage: undefined })
        setReportIgnored(state.triage, key, reportName, false)
      } else if (action === 'ignored') {
        // Mutually exclusive with triage. Toggle on re-click.
        if (isReportIgnored(state.triage, key, reportName)) {
          setReportIgnored(state.triage, key, reportName, false)
        } else {
          patchEntry(state.triage, key, { triage: undefined })
          setReportIgnored(state.triage, key, reportName, true)
        }
      } else {
        // Triage state — clear any ignore on the same tab. Toggle
        // on re-click of the active state.
        if (state.triage.get(key)?.triage === action) {
          patchEntry(state.triage, key, { triage: undefined })
        } else {
          patchEntry(state.triage, key, { triage: action })
          setReportIgnored(state.triage, key, reportName, false)
        }
      }
    }
    try { popover.hidePopover() } catch {}
    saveTriage()
    renderPreservingTableScroll()
    return
  }
  // Comment button — open the multi-line <comment-dialog> with the
  // active tab's existing comment. Empty input clears the entry so
  // saveTriage doesn't persist a "" placeholder. Per-active-tab
  // (matching mark-color semantics — a multi-tab group holds distinct
  // comments per member). Dialog resolves to null on cancel or an
  // unchanged save, so the early-return covers both.
  const commentBtn = pathClosest(e, '.mark-comment')
  if (commentBtn) {
    const findingEl = pathClosest(e, '[data-gid]')
    const gid = findingEl.dataset.gid
    const group = findGroupById(gid)
    if (!group) return
    const activeTab = activeTabFor(group)
    const activeKey = tabKey(activeTab)
    const current = state.triage.get(activeKey)?.comment ?? ''
    openCommentDialog({ initial: current, finding: activeTab }).then((next) => {
      if (next === null) return null
      patchEntry(state.triage, activeKey, { comment: next || undefined })
      saveTriage()
      renderPreservingTableScroll()
      return null
    }).catch(() => {})
    return
  }
  // Copy button — write the active tab's file / line / description /
  // confidence to the clipboard as a labeled block (per-active-tab,
  // so a multi-tab group copies the member in view). Toggles `.copied`
  // for 1s so the icon pulses per click. Failure (no clipboard
  // permission, no secure context) silently no-ops — a convenience,
  // not load-bearing.
  const copyBtn = pathClosest(e, '.mark-copy')
  if (copyBtn) {
    const text = findingHandoffText(e)
    if (text === null) return
    try {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.classList.add('copied')
        setTimeout(() => copyBtn.classList.remove('copied'), 1000)
        return null
      }).catch(() => {})
    } catch {}
    return
  }
  // Page-header file chip — click copies the report name(s) to the
  // clipboard (a convenience, like the finding copy button above:
  // silent no-op without clipboard access, brief "Copied" overlay on
  // success). No pointer cursor — the `title` signals it, matching the
  // page-head chrome.
  const copyReport = pathClosest(e, '[data-copy-report]')
  if (copyReport) {
    const text = copyReport.dataset.copyReport
    try {
      navigator.clipboard.writeText(text).then(() => {
        copyReport.classList.add('copied')
        setTimeout(() => copyReport.classList.remove('copied'), 1000)
        return null
      }).catch(() => {})
    } catch {}
    return
  }
  // Code slide — copy the open file's full (un-stripped) path. Same
  // convenience semantics as the report-name copy above: silent
  // no-op without clipboard access, brief color pulse on success.
  const copyPath = pathClosest(e, '[data-copy-path]')
  if (copyPath) {
    const text = copyPath.dataset.copyPath
    try {
      navigator.clipboard.writeText(text).then(() => {
        copyPath.classList.add('copied')
        setTimeout(() => copyPath.classList.remove('copied'), 1000)
        return null
      }).catch(() => {})
    } catch {}
    return
  }
  // Claude button — hand the same finding block to Claude Code via
  // the `claude://code/new?q=…` URL scheme, prefixed with a
  // `Confirm and fix:` instruction so the receiving session knows
  // what to do with it.
  const claudeBtn = pathClosest(e, '.mark-claude')
  if (claudeBtn) {
    const text = findingHandoffText(e)
    if (text === null) return
    const url = `claude://code/new?q=${encodeURIComponent(`Confirm and fix:\n\n${text}`)}`
    try {
      window.location.href = url
      claudeBtn.classList.add('copied')
      setTimeout(() => claudeBtn.classList.remove('copied'), 1000)
    } catch {}
    return
  }
  // Fix-link button — mirrors the comment flow but stores into
  // state.fixes. Typically a PR URL (also accepts plain text). Empty
  // input clears the entry. Per-active-tab so a multi-tab group holds
  // distinct fix references per member. Dialog resolves to null on
  // cancel / Esc / unchanged save.
  const fixBtn = pathClosest(e, '.mark-fix')
  if (fixBtn) {
    const findingEl = pathClosest(e, '[data-gid]')
    const gid = findingEl.dataset.gid
    const group = findGroupById(gid)
    if (!group) return
    const activeTab = activeTabFor(group)
    const activeKey = tabKey(activeTab)
    const current = state.triage.get(activeKey)?.fix ?? ''
    openFixLinkDialog({ initial: current, finding: activeTab }).then((next) => {
      if (next === null) return null
      patchEntry(state.triage, activeKey, { fix: next || undefined })
      saveTriage()
      renderPreservingTableScroll()
      return null
    }).catch(() => {})
    return
  }
  // Attention-flag toggle (top-right of the card / row). Tri-state:
  // unset/false → true, true → false. We write the explicit `false`
  // on un-flag (never undefined) so the removal is a real, syncable
  // change that overrides a peer's stale `true` (see TriageEntry.flagged).
  // `data-flag-toggle` carries the exact tab key, so a multi-tab group
  // flags per member rather than the active tab only.
  const flagBtn = pathClosest(e, '[data-flag-toggle]')
  if (flagBtn) {
    const key = flagBtn.dataset.flagToggle
    // Toggle: true → false (explicit tombstone), false/unset → true.
    const cur = state.triage.get(key)?.flagged
    patchEntry(state.triage, key, { flagged: cur !== true })
    saveTriage()
    renderPreservingTableScroll()
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
  // severity-chips / triage-filter / source-filter / view-mode-buttons
  // clicks dispatch `severity-toggle` / `color-toggle` / `source-toggle`
  // / `view-mode-change` custom events — handled outside this click
  // delegate by dedicated listeners below.

  // Table-view details panel close button — clears selection and
  // re-renders so the list expands back to full width.
  if (e.target.closest('[data-table-deselect]')) {
    state.tableSelectedGid = null
    renderPreservingTableScroll()
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
  renderPreservingTableScroll()
})

// Kanban drag-and-drop. A `<finding-row class="kanban-card">` is
// draggable; the `.kanban-column` elements advertise themselves as
// drop zones via `data-kanban-target=<active|inprogress|fixed|invalid
// |deleted|ignored>`. On drop we mirror the existing `[data-triage-action]`
// menu's mutation rules (conflict groups apply to the active tab
// only, consistent groups apply to every tab), then `saveTriage()`
// + render() to repaint the board.
const KANBAN_DATA_TYPE = 'application/x-deepview-kanban-gid'

function setGroupTriage(group, target) {
  const groupSt = groupState(group)
  const targets = groupSt.hasConflict ? [activeTabFor(group)] : group
  for (const f of targets) {
    const key = tabKey(f)
    const reportName = findingReport(f)
    if (target === 'untriaged') {
      patchEntry(state.triage, key, { triage: undefined })
      setReportIgnored(state.triage, key, reportName, false)
    } else if (target === 'ignored') {
      patchEntry(state.triage, key, { triage: undefined })
      setReportIgnored(state.triage, key, reportName, true)
    } else {
      patchEntry(state.triage, key, { triage: target })
      setReportIgnored(state.triage, key, reportName, false)
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
// so the modal animates via the CSS keyframes on
// `::view-transition-{new,old}(kanban-detail-modal)` in findings.css.
// Intentionally NOT a shared-element pairing (card doesn't get the
// same view-transition-name): morphing a 200×60 card into a 560×~400
// modal flickers the drop-shadow and leaves the transition in a
// sometimes-stuck shape (next click no-ops, the one after works — the
// "every third click" report). Animating the modal in place against
// the unchanged board is stable and still snappy.
//
// kanbanTransitioning is true between `startViewTransition` and its
// `.finished` settling. It swallows rapid follow-up open / close
// clicks that would otherwise call `startViewTransition` against the
// still-active prior one — the browser would `skipTransition()` it,
// running its callback synchronously against just-updated state and
// leaving the page inconsistent (the "rapid-double-click then nothing
// ever opens again" report). Card-to-card switches still go through
// (they don't start a transition).
let kanbanTransitioning = false

function kanbanCardEl(gid) {
  if (!gid) return null
  return report.querySelector(`.kanban-card[data-gid="${CSS.escape(gid)}"]`)
}

// Measure a representative kanban card and stamp its dimensions as
// CSS custom properties on the document root. The clip-path keyframes
// (kanban-clip-hide / kanban-clip-reveal in findings.css) use these
// as the floor of the modal pseudo's clip animation — the modal never
// shrinks past card-sized, so its "small" frame overlaps the source
// card instead of collapsing to a zero-area rect that would expose
// the OLD modal snapshot's leftover edges (the "two rectangles
// overlapping" report). Uses the stamped source card when provided,
// else the first board card; falls back to :root defaults if none.
//
// Per the user note ("underestimating size is ok, overestimating
// might make the animation bad"), Math.floor plays it safe.
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
  // pseudo for the transition's duration. The card snapshot is a
  // different proportion than the modal (~200×60 vs ~560×400), so
  // during the morph it shows under the scaling modal as a
  // mis-proportioned stub; hiding it leaves only the modal pseudo's
  // clip-path animation visible. CSS picks the pseudo by direction:
  // ::view-transition-old for opening (OLD = card),
  // ::view-transition-new for closing (NEW = card).
  const directionClass = opening ? 'kanban-opening' : 'kanban-closing'
  document.documentElement.classList.add(directionClass)

  // Shared-element pairing: the modal has `view-transition-name:
  // kanban-detail-modal` in CSS; we stamp the source card with the
  // same name via inline style. The browser pairs snapshots by name
  // and the GROUP pseudo morphs position + size, so the modal flies
  // out of the card on open and back on close. The inline-style
  // bookkeeping is safe because the lock above guarantees one
  // transition in flight at a time.
  //
  // Safety-net timeout: ViewTransition.finished should settle when
  // the transition ends, but some browser builds get stuck and never
  // settle on an odd interruption — leaving the lock held forever
  // ("no clicks open the modal until reload"). 600ms is generous
  // (animation ~200ms); cleared on a clean settle.
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

// Move the open kanban popover by `direction` (+1 = next, -1 =
// previous) through the cards of the SAME column as the currently-
// shown finding, so the arrow keys step between findings sharing a
// triage state without crossing into another column. Clamps at the
// column ends (no wrap). Mirrors navigateFocus but scopes the walk
// to one `.kanban-column` rather than the flat focus queue. The
// card-to-card hop swaps the modal contents in place (no view
// transition — see setKanbanPopoverGid's plain-render branch).
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
  // The accent ring that marks the open card is the state-driven
  // `.active` class (render.js / findings.css), so the indicator itself
  // tracks the popover regardless of DOM focus. Still move focus to the
  // now-open card: it keeps keyboard focus coherent with what's shown,
  // and parks the card's own `:focus-visible` ring on the SAME card as
  // `.active` instead of leaving it stuck on the originally-clicked card
  // once the keyboard is in use (which showed a second, wrong outline).
  // `preventScroll` defers positioning to the scrollIntoView below;
  // `nearest` minimises movement, and the modal covers the board so the
  // scroll is invisible until the close transition morphs back.
  const card = kanbanCardEl(nextGid)
  if (card) {
    card.focus({ preventScroll: true })
    card.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }
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

// Focus-view selection. The right-hand "up next" queue renders each
// upcoming finding as a `<div class="kanban-card focus-side-card"
// data-focus-select>`; clicking one swaps the centered finding-card
// to that gid. The handler also scrolls the now-active card into
// view inside the sidebar so chaining clicks keeps the queue
// oriented around the cursor.
function setFocusGid(gid) {
  if (!gid || state.focusGid === gid) return
  state.focusGid = gid
  render()
  // Post-render: bring the new active card into view in the
  // sidebar. `block: 'nearest'` minimises movement (a no-op when
  // the card is already visible); `behavior: 'instant'` skips the
  // smooth-scroll animation, which would noticeably lag an arrow-
  // key run-through. The sidebar is the closest scrollable
  // ancestor, so only it scrolls — the page stays put.
  const card = report.querySelector('.focus-side-card.active')
  if (card) card.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  // Same nearest-scroll trick for the inline Code panel: align the
  // gutter row carrying the finding's line so the user sees the
  // relevant source on entry. Falls through silently when the
  // panel isn't mounted (no bundle code for this finding) or the
  // line isn't a number.
  const codeLine = report.querySelector('.focus-code-line-active')
  if (codeLine) codeLine.scrollIntoView({ block: 'center', behavior: 'instant' })
}

// Move the focus by `direction` (+1 = next, -1 = previous), walked
// off the rendered queue. Shared by the forward/back buttons in
// the main-pane top bar and the arrow-key keyboard handler.
// Both paths land here so the no-op guard (already at the end)
// and the gid lookup behave identically.
function navigateFocus(direction) {
  const cards = report.querySelectorAll('.focus-side-card[data-focus-select]')
  if (cards.length === 0) return
  let idx = -1
  for (let i = 0; i < cards.length; i++) {
    if (cards[i].classList.contains('active')) { idx = i; break }
  }
  // Clamp at the ends — wrapping would surprise the user mid-
  // triage (you don't expect Down to teleport you back to the top).
  const nextIdx = idx < 0
    ? (direction > 0 ? 0 : cards.length - 1)
    : Math.min(Math.max(idx + direction, 0), cards.length - 1)
  if (nextIdx === idx) return
  const nextGid = cards[nextIdx].dataset.gid
  if (nextGid) setFocusGid(nextGid)
}

report.addEventListener('click', (e) => {
  // Forward / back buttons in the main-pane top bar — same
  // navigation path as the keyboard handler below.
  const navBtn = e.target.closest?.('[data-focus-nav]')
  if (navBtn) {
    navigateFocus(navBtn.dataset.focusNav === 'next' ? 1 : -1)
    return
  }
  const card = e.target.closest?.('.focus-side-card[data-focus-select]')
  if (!card) return
  // Skip when the user is text-selecting (click fires after mouseup
  // with a non-empty selection range, same gotcha the kanban card
  // handler dodges).
  if (window.getSelection?.()?.toString()) return
  const gid = card.dataset.gid
  if (gid) setFocusGid(gid)
})

// Arrow-key navigation between findings. Bound to document so the key
// fires from anywhere, guarded to act only on an arrow-navigable
// surface, when the user isn't typing in a text field (Search, Repo,
// etc.), and no modal dialog is open. Two surfaces share the handler:
//
//   - Focus view — walks the right-hand "up next" queue.
//   - Kanban view with the detail popover open — walks the cards in
//     the open card's own column, stepping the popover through the
//     findings that share its triage state. With no popover up there's
//     nothing anchored to step from, so the arrows stay inert.
//
// Bound keys (all clamp at the ends, no wrap):
//   ← / ArrowLeft   → previous finding
//   → / ArrowRight  → next finding
//
// ArrowUp / ArrowDown intentionally don't navigate — the focused
// finding-card's description can be tall enough to scroll, and
// hijacking up/down would steal the user's way of reading past the
// fold.
//
// The "is the user typing" check walks `composedPath()` rather than
// `e.target.tagName`: inputs inside a custom element's shadow root
// (search bars, repo chip) retarget `e.target` to the shadow host, so
// a tagName check would hijack arrow-key caret movement inside them.
// The path walk sees the actual focused node.
function focusNavBlocked(e) {
  if (document.querySelector('dialog[open]')) return true
  for (const el of e.composedPath()) {
    if (!el || el.nodeType !== 1) continue
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    // App dialogs (comment / fix-link / …) render their <dialog> inside
    // a Lit shadow root, so the light-DOM querySelector above can't see
    // them. showModal() traps focus inside, so the open <dialog> is
    // always on a keydown's composed path while it's up — catch it here
    // regardless of which control holds focus (the INPUT/TEXTAREA check
    // alone misses a focused button, e.g. fix-link's Save/Cancel).
    if (tag === 'DIALOG' && el.open) return true
    if (el.isContentEditable) return true
  }
  return false
}

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
  if (inFocus) navigateFocus(direction)
  else navigateKanban(direction)
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
  const current = state.triage.get(activeKey)?.color
  if (current === color) patchEntry(state.triage, activeKey, { color: undefined })
  else patchEntry(state.triage, activeKey, { color })
  saveTriage()
  renderPreservingTableScroll()
})

// Print button — fixed top-right icon, lives OUTSIDE #report (see
// index.html / styles/theme.css), so the report-level click delegate
// can't see it; attach directly. Two pieces of state swap for the
// print and restore after the dialog dismisses:
//
//   - document.title → filename (or longest common prefix across
//     loaded reports) so the OS print dialog / saved PDF default to a
//     meaningful name. Set AFTER the viewMode swap because `render()`
//     ends by writing the document title.
//
//   - state.viewMode `table` → `list`. The table layout is
//     interaction-driven (compact rows, side panel, hover) and prints
//     as row-chrome stubs with none of the finding body; list mode
//     paints the full card per entry, which is what paper wants.
//     `tableSelectedGid` isn't bound to viewMode, so the row selection
//     survives the round trip.
//
// The swap/restore lifecycle is owned by a beforeprint/afterprint
// pair so non-button entry points (Ctrl+P, browser menu, print
// extensions) get the same layout. The pair alone isn't enough:
// `<finding-card>` is Lit, rendering in a microtask, so going
// straight from beforeprint to the browser snapshot prints empty
// shells — only the file/location headers (synchronous via innerHTML)
// show. The button handler fixes that by swapping eagerly and
// awaiting every card's `updateComplete` BEFORE `window.print()`;
// beforeprint then no-ops since `prepareForPrint` is idempotent on
// the saved-state sentinel. The Ctrl+P / menu path can't insert that
// await and is best-effort — mode swap + title land, but finding
// bodies may print blank on the first shot (a second print after Lit
// catches up renders fully). Microtasks drain through the await chain
// in user-gesture context, so `window.print()` still pops a dialog
// without the browser flagging it as automation.
//
// A non-null `printSavedMode` also doubles as the re-entrancy guard,
// so the click handler doesn't race itself across the await and
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

document.addEventListener('print-requested', async () => {
  if (state.reports.length === 0) return
  if (printSavedMode !== null) return
  // Confirm what's leaving first — the dialog restates the active
  // filters + included/excluded counts. The confirm click is itself a
  // user gesture, so the subsequent window.print() stays
  // user-activated (same microtask-drain reasoning as the
  // updateComplete await below). Cancel / Esc abort with no print.
  const { confirmed } = await openExportConfirmDialog('print')
  if (!confirmed) return
  // Re-check the re-entrancy guard: the top-of-handler check ran before
  // the await, and `printSavedMode` isn't set until prepareForPrint
  // below — so a print started during the dialog (a stray beforeprint,
  // or a second print-requested) could otherwise race past it.
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
// state directly, without going through the DOM. Like print, it
// fronts the export with the confirm dialog so the user sees the
// filtered selection (and counts) before the file is written.
document.addEventListener('download-requested', async () => {
  if (state.reports.length === 0) return
  const { confirmed } = await openExportConfirmDialog('download')
  if (!confirmed) return
  downloadReportsAsMarkdown(state.reports)
})

// `<analyzer-select>` dispatches this when a row in its analyzer /
// model popover is picked. detail always carries BOTH dimensions
// (the clicked one updated, the other passed through unchanged), so
// one listener writes the pair without knowing which column was
// clicked. The component owns its popover, so there's no id-keyed
// branch in a generic change listener.
report.addEventListener('analyzer-change', (e) => {
  state.filterAnalyzer = e.detail.analyzer
  state.filterModel = e.detail.model
  render()
})
// `<repo-filter>` dispatches this on native change. Mirrors
// the analyzer-change branch above — flip state and render the
// filtered body. Only the toolbar listens for it (the component
// is workspace-view-only); a stray event from anywhere else is
// harmless since the predicate gates on `state.filterRepo`.
report.addEventListener('repo-change', (e) => {
  state.filterRepo = e.detail.value
  render()
})
// `<bundle-code-search>` dispatches this when a Files / Code /
// Issues mode tab is clicked in the bundle code rail's search row.
// Switching back to Files rebuilds the tree at its remembered
// scroll-top, which may be far from the open file — reveal it.
report.addEventListener('bundle-search-mode-change', (e) => {
  const mode = e.detail?.mode
  if (mode !== 'files' && mode !== 'code' && mode !== 'issues') return
  state.bundleCodeSearchMode = mode
  render()
  if (mode === 'files') revealBundleCodeCurrent()
})
// `<bundle-search>` (the Search tab's github-style bar) dispatches
// this when the trailing `.*` modifier is clicked — flip between
// plain-substring and regular-expression matching.
report.addEventListener('bundle-search-regex-toggle', () => {
  state.bundleSearchRegex = !state.bundleSearchRegex
  render()
})
// …and this when the `Aa` modifier is clicked — flip matching
// between case-insensitive (default) and case-sensitive.
report.addEventListener('bundle-search-case-toggle', () => {
  state.bundleSearchCase = !state.bundleSearchCase
  render()
})
// `<bundle-compare>` swap button — switch the active bundle to the
// comparison target while staying on the Compare tab (so A and B trade
// places). The component has already stashed the post-swap target (the
// old base); this performs the same full bundle switch the sidebar row
// click does, just landing on 'compare' instead of 'overview'.
report.addEventListener('bundle-swap', (e) => {
  const integrity = e.detail?.integrity
  if (!integrity || !(state.bundles ?? []).some((b) => b.integrity === integrity)) return
  state.currentView = 'bundles'
  state.selectedBundle = integrity
  state.bundleDetails = null
  state.bundleSourceFile = null
  state.bundleSourceFindingIdx = null
  state.bundleCodeSearchQuery = ''
  state.bundleCodeSearchMode = 'files'
  state.bundleSearchQuery = ''
  state.bundleSearchRegex = false
  state.bundleSearchCase = false
  state.bundleSearchContext = true
  state.bundleDetailsTab = 'compare'
  graph2.showAll = true
  state.shownTriage = null
  persistLastBundle(integrity, 'compare')
  render()
  renderSidebar()
  openBundle(integrity)
})
// `<findings-sort>` (kind="findings") and `<entity-sort>` (kind=
// "packages"|"repositories") both dispatch this on native change.
// Routes to the matching state slot.
report.addEventListener('sort-change', (e) => {
  const { kind, value } = e.detail
  if (kind === 'findings') {
    state.sortBy = value
  } else if (kind === 'packages') {
    state.packagesSortBy = value
  } else if (kind === 'repositories') {
    state.repositoriesSortBy = value
  } else {
    return
  }
  render()
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
  // composedPath()[0] is the real input — `e.target` retargets to
  // the shadow host (`<graph-layout>`) for events crossing the
  // graph's shadow boundary, so reading `e.target.id` would miss
  // the `#g2-path-filter` branch below. Light-DOM inputs still
  // give themselves as path[0], so the other branches are
  // unaffected.
  const src = e.composedPath()[0]
  const id = src?.id
  const val = src?.value
  if (id === 'g2-path-filter') {
    graph2.pathFilter = val
    graph2.graphState?.requestDraw?.()
  }
})
// `<toolbar-search>` dispatches this on native input from the findings
// toolbar / Files tab search field. Routes to `state.filterInclude` or
// `state.filesSearch` based on `kind`. Plain render() suffices for
// focus / cursor preservation: Lit reuses the same `<input>` element
// across re-renders (parent diff + component autorun both diff against
// the same template position) and the user's caret survives the
// no-op DOM write `live()` performs once the typed value already
// matches state.
report.addEventListener('search-input', (e) => {
  if (!e.detail) return
  const { kind, value } = e.detail
  if (kind === 'findings') {
    state.filterInclude = value
    // Clearing the field ends the search; drop negation so a fresh
    // query starts matching (the toggle is hidden while empty, so a
    // persisted mode would resurface unseen).
    if (!value) state.filterIncludeNegate = false
  } else if (kind === 'files') {
    state.filesSearch = value
  } else if (kind === 'packages') {
    state.packagesSearchQuery = value
  } else if (kind === 'repositories') {
    state.repositoriesSearchQuery = value
  } else if (kind === 'bundle-code') {
    state.bundleCodeSearchQuery = value
  } else if (kind === 'bundle-search') {
    // Heaviest of the search fields (scans every source) — debounce
    // its render to one per frame instead of the synchronous render
    // below. The `<bundle-search>` component still updates its own
    // input via its autorun, so the field stays responsive.
    state.bundleSearchQuery = value
    renderBundleSearchDebounced()
    return
  } else {
    return
  }
  render()
})

// The findings search's negate toggle (`<toolbar-search kind="findings">`)
// flips the include/exclude mode; re-filter so the list follows.
// matchesFilters reads `state.filterIncludeNegate`.
report.addEventListener('search-negate-toggle', () => {
  state.filterIncludeNegate = !state.filterIncludeNegate
  render()
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
    // composedPath()[0] is the actual `<severity-chips>` element
    // when this fires from inside the graph's shadow DOM; `e.target`
    // would be retargeted to `<graph-layout>` and setting
    // `.selected` on the host would do nothing.
    e.composedPath()[0].selected = [...graph2.selectedSeverities]
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
    // composedPath()[0] is the actual `<triage-filter>` element
    // when this fires from inside the graph's shadow DOM; see the
    // sibling severity-toggle comment for the retargeting rationale.
    e.composedPath()[0].selected = [...graph2.selectedColors]
    graph2.graphState?.requestDraw?.()
    refreshActiveGraphTopPkgs()
    return
  }
  if (state.filterColors.has(col)) state.filterColors.delete(col)
  else state.filterColors.add(col)
  render()
})
// `<source-filter>` — Sources / Dependencies single-select with
// toggle-off. Clear the Set first so picking a chip switches off
// whatever else was active (and re-clicking the active chip leaves
// the Set empty = no filter).
report.addEventListener('source-toggle', (e) => {
  const v = e.detail.source
  const wasActive = state.filterSources.has(v)
  state.filterSources.clear()
  if (!wasActive) state.filterSources.add(v)
  render()
})
// Annotation filter chips (comment | fix | flag) — cycle the matching
// tri-state ('' → 'with' → 'without' → '') and re-render. Each is an
// independent AND filter (matchesFilters).
report.addEventListener('annotation-filter-toggle', (e) => {
  const key = e.detail?.key
  const next = (v) => (v === '' ? 'with' : v === 'with' ? 'without' : '')
  if (key === 'comment') state.filterComment = next(state.filterComment)
  else if (key === 'fix') state.filterFix = next(state.filterFix)
  else if (key === 'flag') state.filterFlagged = next(state.filterFlagged)
  else return
  render()
})
// Package / repository detail slide — `<slide-triage-tabs>` dispatches
// this when an Invalid / Deleted tab is clicked. Routes the toggle
// to the matching state slice based on `kind`; clicking the active
// bucket clears it (back to `live`).
report.addEventListener('slide-triage-toggle', (e) => {
  const { kind, value } = e.detail
  if (kind === 'package') {
    state.packageSlideTriage = state.packageSlideTriage === value ? null : value
  } else if (kind === 'repository') {
    state.repositorySlideTriage = state.repositorySlideTriage === value ? null : value
  } else {
    return
  }
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
  // Same idea for focus view: a stale focusGid would re-anchor the
  // queue on whatever the user was looking at last time, even after
  // filters / sort / loaded report have moved on. Letting it default
  // back to the first-filtered item is the friendlier behaviour.
  if (state.viewMode !== 'focus') state.focusGid = null
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
    // The Code slide is the one place `bundleSourceFile` is plain
    // navigation state (the tree's selected file) rather than an
    // overlay — the modal there is suppressed and the pane has no
    // close affordance. Escape deselecting it dumped the user on
    // the "pick a file" placeholder mid-read. The Search sidebar
    // stays Esc-closable: its × button advertises the key.
    if (state.currentView === 'bundles' && state.bundleDetailsTab === 'code') return
    state.bundleSourceFile = null
    render()
  }
})

