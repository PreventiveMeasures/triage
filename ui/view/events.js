import { VIEW_MODE_KEY, saveRepoUrlFor, state } from '../../client/state.js'
import { report } from './dom.js'
import { commonPrefix } from './format.js'
import { activeTabFor, findGroupById, groupState, ignoredKey, tabKey } from './group.js'
import { resetFilters } from './filters.js'
import { saveTriage } from '../../client/triage.js'
import { computeBundleFileHashes, refreshBundleGraphSidebar, refreshBundleGraphTopPkgs, refreshGraph2Sidebar, refreshGraph2TopPkgs, render, renderKeepFocus } from './render.js'
import { ensureBundleFindingsIndexed, subscribeToBundleFindingIndex } from '../../client/bundle-finding-index.js'

// Subscribe once to the bundle-finding index. Any time another
// OPFS report finishes parsing, re-render IF the user is currently
// looking at a bundle — the Issues tab and Graph view both pull
// from the index, so newly-indexed findings need to land in the
// view without waiting for a tab flip / re-open.
subscribeToBundleFindingIndex(() => {
  if (state.currentView === 'bundles' && state.selectedBundle) render()
  else if (state.currentView === 'packages') render()
  else if (state.currentView === 'findings' || state.currentView === 'files') {
    // Sidebar's PACKAGES entry caption depends on the index too —
    // refresh it when the count would change. The main view stays
    // put.
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
import { deleteBundle, listBundles, readBundle } from '../../client/storage.js'
import { brotliDecompress } from './brotli-decompress.js'
import { renderSidebar } from './sidebar.js'
import { switchToFile } from './ingest.js'
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
  const codeBundle = e.target.closest('[data-bundle-row-code]')
  if (codeBundle) {
    const integrity = codeBundle.dataset.bundleRowCode
    state.selectedBundle = integrity
    state.bundleDetails = state.selectedBundle === integrity ? state.bundleDetails : null
    state.bundleSourceFile = null
    state.bundleSourceFindingIdx = null
    state.bundleCodeSearchQuery = ''
    state.bundleCodeSearchMode = 'files'
    state.bundleDetailsTab = 'code'
    graph2.showAll = true
    state.shownTriage = null
    render()
    // Async parse path — mirrors the data-select-bundle handler
    // below. Skipping when bundleDetails is already cached for
    // this integrity (clicking Code → on the already-open bundle
    // shouldn't re-parse).
    const entry = (state.bundles ?? []).find((b) => b.integrity === integrity)
    if (!entry) return
    if (state.bundleDetails && state.bundleDetails.integrity === integrity) return
    state.bundleDetails = null
    ;(async () => {
      let details
      try {
        const bytes = await readBundle(integrity)
        const isMap = entry.name.toLowerCase().endsWith('.map')
        if (isMap) {
          try {
            const json = JSON.parse(new TextDecoder().decode(bytes))
            details = { integrity, kind: 'sourcemap', size: bytes.byteLength, json }
          } catch (err) {
            details = { integrity, kind: 'sourcemap', size: bytes.byteLength, error: err.message }
          }
        } else {
          try {
            const out = await brotliDecompress(bytes)
            const json = JSON.parse(new TextDecoder().decode(out))
            details = { integrity, kind: 'stasis', size: bytes.byteLength, json }
          } catch (err) {
            details = { integrity, kind: 'stasis', size: bytes.byteLength, error: err.message }
          }
        }
      } catch (err) {
        details = { integrity, error: err.message, size: 0 }
      }
      if (state.selectedBundle !== integrity) return
      state.bundleDetails = details
      render()
      if (details.json) {
        ;(async () => {
          try {
            const fileHashes = await computeBundleFileHashes(details)
            if (state.selectedBundle !== integrity) return
            details.fileHashes = fileHashes
            render()
          } catch {}
        })()
      }
      ensureBundleFindingsIndexed().catch(() => {})
    })()
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
      // Drop the open panel if it was pointing at the deleted row.
      if (state.selectedBundle === integrity) {
        state.selectedBundle = null
        state.bundleDetails = null
        state.bundleSourceFile = null
        state.bundleSourceFindingIdx = null
      }
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
    return
  }
  // Packages list — row select. Mirrors the bundles select pattern;
  // selection is purely UI (no async load — the index is already in
  // memory), so a plain re-render paints the right-side panel.
  // Reset the details panel to the Overview tab so a new pick
  // doesn't carry the prior selection's tab choice.
  const selPackage = e.target.closest('[data-select-package]')
  if (selPackage) {
    const pkg = selPackage.dataset.selectPackage
    if (state.selectedPackage === pkg) return
    state.selectedPackage = pkg
    state.packageDetailsTab = 'overview'
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
  // Bundle details — tab switch (Packages / Files / Graph /
  // Issues). Packages/Files render in the regular details panel;
  // Graph and Issues open the full-width slide layout (bundles
  // list + details both step aside). State is purely UI; the
  // parsed bundleDetails stays cached so flipping tabs is
  // paint-only.
  const bundleTab = e.target.closest('[data-bundle-tab]')
  if (bundleTab) {
    const tab = bundleTab.dataset.bundleTab
    if (tab === 'packages' || tab === 'files' || tab === 'reports' || tab === 'graph' || tab === 'issues' || tab === 'code') {
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
      // Scroll by line — the per-line dot is keyed to the first
      // finding on the line (multiple findings collapse to one
      // dot), so a finding-idx-based lookup wouldn't find the
      // dot for a non-first finding.
      queueMicrotask(() => {
        const row = document.querySelector(`.bundle-source-lineno-row[data-line="${line}"]`)
        if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' })
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
    const entry = (state.bundles ?? []).find((b) => b.integrity === integrity)
    if (!entry) return
    ;(async () => {
      let details
      try {
        const bytes = await readBundle(integrity)
        const isMap = entry.name.toLowerCase().endsWith('.map')
        if (isMap) {
          try {
            const json = JSON.parse(new TextDecoder().decode(bytes))
            details = { integrity, kind: 'sourcemap', size: bytes.byteLength, json }
          } catch (err) {
            details = { integrity, kind: 'sourcemap', size: bytes.byteLength, error: err.message }
          }
        } else {
          // Stasis — brotli-decompress, then parse JSON. brotliDecompress
          // dispatches to native DecompressionStream when available and
          // falls through to the SW echo trick when it's not (see
          // view/brotli-decompress.js); a thrown error surfaces in the
          // panel's "Failed to parse" path.
          try {
            const out = await brotliDecompress(bytes)
            const json = JSON.parse(new TextDecoder().decode(out))
            details = { integrity, kind: 'stasis', size: bytes.byteLength, json }
          } catch (err) {
            details = { integrity, kind: 'stasis', size: bytes.byteLength, error: err.message }
          }
        }
      } catch (err) {
        details = { integrity, error: err.message, size: 0 }
      }
      // Drop the result if the user moved on while we loaded.
      if (state.selectedBundle !== integrity) return
      state.bundleDetails = details
      render()
      // Kick off SHA-512 hashing of every source so the bundle
      // graph's nodes + Issues tab can match findings by fileHash.
      // The digest is async (large bundles take a moment); the
      // panel renders immediately with no findings, then a re-
      // render once the hashes land paints any matches.
      if (details.json) {
        ;(async () => {
          try {
            const fileHashes = await computeBundleFileHashes(details)
            if (state.selectedBundle !== integrity) return
            details.fileHashes = fileHashes
            render()
          } catch {}
        })()
      }
      // Index every OPFS report's findings (background) so the
      // bundle's hash-match join sees findings from reports the
      // user hasn't currently loaded too. Idempotent — subsequent
      // bundle opens just walk the listFiles delta. Subscribe (at
      // module load above) keeps re-rendering the bundle view as
      // new entries land in the index.
      ensureBundleFindingsIndexed().catch(() => {})
    })()
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
      const target = document.getElementById(treeAnchor(targetFile))
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
    const input = document.getElementById('g2-path-filter')
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
  // Comment button — open a prompt with the active tab's existing
  // comment (empty when none). Whitespace-trimmed input; empty
  // strings clear the entry from state.comments so saveTriage
  // doesn't persist a "" placeholder. The comment is per-active-tab
  // (matching mark-color semantics — a multi-tab group can hold
  // distinct comments per member tab).
  const commentBtn = pathClosest(e, '.mark-comment')
  if (commentBtn) {
    const findingEl = pathClosest(e, '[data-gid]')
    const gid = findingEl.dataset.gid
    const group = findGroupById(gid)
    if (!group) return
    const activeKey = tabKey(activeTabFor(group))
    const current = state.comments.get(activeKey) ?? ''
    const next = window.prompt('Comment for this finding (leave blank to clear):', current)
    if (next === null) return
    const trimmed = next.trim()
    if (trimmed === current) return
    if (trimmed) state.comments.set(activeKey, trimmed)
    else state.comments.delete(activeKey)
    saveTriage()
    render()
    return
  }
  // Fix-link button — mirrors the comment flow but stores into
  // state.fixes. Typically a PR URL (also accepts plain text).
  // Empty input clears the entry. Per-active-tab so a multi-tab
  // group can hold distinct fix references per member.
  const fixBtn = pathClosest(e, '.mark-fix')
  if (fixBtn) {
    const findingEl = pathClosest(e, '[data-gid]')
    const gid = findingEl.dataset.gid
    const group = findGroupById(gid)
    if (!group) return
    const activeKey = tabKey(activeTabFor(group))
    const current = state.fixes.get(activeKey) ?? ''
    const next = window.prompt('Fix link for this finding (PR URL, leave blank to clear):', current)
    if (next === null) return
    const trimmed = next.trim()
    if (trimmed === current) return
    if (trimmed) state.fixes.set(activeKey, trimmed)
    else state.fixes.delete(activeKey)
    saveTriage()
    render()
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

// row-select fires from inside `<finding-table>`'s shadow DOM with
// composed:true, so it bubbles up to the report element. Re-clicking
// the same row deselects (closes the side details panel).
report.addEventListener('row-select', (e) => {
  const gid = e.detail?.gid
  if (!gid) return
  state.tableSelectedGid = state.tableSelectedGid === gid ? null : gid
  render()
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
// view.html / styles/theme.css), so the report-level click delegate
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
// Critical timing detail: `<finding-card>` is a Lit element whose
// render is scheduled in a microtask, so a naive
// `render(); window.print()` snapshots empty card shells (Lit
// hasn't painted yet — only the file / location headers, which
// land synchronously through innerHTML, show up). Awaiting every
// card's `updateComplete` promise after the swap is what makes
// the swap actually visible in the printed output. Microtasks
// drain through the await chain in user-gesture context, so
// `window.print()` still pops a dialog without the browser
// suppressing it as automation.
//
// Tried earlier and didn't help: a beforeprint/afterprint hook
// pair, on the theory that the browser drains microtasks between
// event-handler return and snapshot. It didn't, at least not
// reliably; the explicit await is the deterministic fix.
// Re-entrancy guard for the print flow. The handler is async (it
// awaits per-card updateComplete before opening the print dialog),
// so a second click during that await would capture a fresh
// `oldMode` from the already-swapped state — when both runs settle
// they'd restore the wrong mode and strand the user in 'list'.
let printing = false
document.getElementById('print-btn').addEventListener('click', async () => {
  if (state.reports.length === 0) return
  if (printing) return
  printing = true
  try {
    const oldMode = state.viewMode
    if (oldMode === 'table') {
      state.viewMode = 'list'
      render()
      // Wait for Lit's batched per-card update to land before
      // letting the browser snapshot. `updateComplete` resolves
      // after the element's render() has applied its template;
      // doing this on every card is overkill in steady-state but
      // cheap enough relative to dialog-modal time.
      await Promise.all(
        [...report.querySelectorAll('finding-card')].map((c) => c.updateComplete),
      )
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
    const oldTitle = document.title
    if (target) document.title = target
    window.print()
    document.title = oldTitle
    if (state.viewMode !== oldMode) {
      state.viewMode = oldMode
      render()
    }
  } finally {
    printing = false
  }
})

report.addEventListener('change', (e) => {
  const id = e.target.id
  const val = e.target.value
  if (id === 'sort-select') { state.sortBy = val; render() }
  else if (id === 'packages-sort-select') { state.packagesSortBy = val; render() }
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

