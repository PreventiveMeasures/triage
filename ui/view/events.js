import { state, VIEW_MODE_KEY } from './state.js'
import { report } from './dom.js'
import { commonPrefix } from './format.js'
import { tabKey, activeTabFor, groupState, findGroupById } from './group.js'
import { resetFilters } from './filters.js'
import { saveTriage } from './triage.js'
import { render, renderKeepFocus, refreshTreeSidebar, refreshGraph2Sidebar, refreshGraph2TopPkgs } from './render.js'
import { tree, cleanupGraphInteraction } from './graph/state.js'
import { treeAnchor } from './graph/utils.js'
import { graph2, cleanupGraph2 } from './graph2/state.js'

// All interactive elements inside #report are handled via event
// delegation here, no inline handlers. Order matters: closer-fitting
// selectors come first so a more specific match short-circuits before a
// generic one (e.g. tree-graph buttons before generic tab clicks).
report.addEventListener('click', (e) => {
  // Top-level view switcher (Findings / Tree / Files). Switching tabs
  // also drops fullscreen — the mode is bound to the graph canvas (it
  // hides the sidebar + header so the canvas can fill the viewport),
  // and persisting it across to Findings or Files leaves the page in
  // a chrome-less half-state with no canvas to justify it.
  const viewTab = e.target.closest('.report-tab')
  if (viewTab && viewTab.dataset.view) {
    // Tear down the previous tab's canvas teardown before switching
    // so its rAF / observers / window listeners stop firing once
    // we replace #report's innerHTML in render(). cleanupGraph2 is a
    // no-op when graph2 wasn't active.
    if (state.currentView === 'graph2' && viewTab.dataset.view !== 'graph2') cleanupGraph2()
    state.currentView = viewTab.dataset.view
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
    // Clicking a swatch toggles solo on that package. Clicking the
    // currently-soloed swatch clears solo. Hidden state is left
    // alone — there's a separate UI affordance (the search box) for
    // narrowing without committing to a single-package view.
    graph2.solo = graph2.solo === pkg ? null : pkg
    const palette = g2Pkg.parentElement
    palette.querySelectorAll('.g2-swatch').forEach((s) => {
      const p = s.dataset.g2Pkg
      s.classList.toggle('solo', graph2.solo === p)
      s.classList.toggle('dim', graph2.solo && graph2.solo !== p)
    })
    return
  }
  if (e.target.closest('#g2-palette-clear')) {
    graph2.solo = null
    graph2.hidden.clear()
    graph2.paletteSearch = ''
    const search = document.getElementById('g2-palette-search')
    if (search) search.value = ''
    document.querySelectorAll('#g2-palette .g2-swatch').forEach((s) => {
      s.classList.remove('solo', 'dim', 'muted', 'hidden-pkg')
    })
    return
  }
  const g2Sev = e.target.closest('[data-g2-sev]')
  if (g2Sev) {
    const sev = g2Sev.dataset.g2Sev
    graph2.showIssues[sev] = !graph2.showIssues[sev]
    g2Sev.classList.toggle('on', graph2.showIssues[sev])
    return
  }
  const g2Toggle = e.target.closest('[data-g2-toggle]')
  if (g2Toggle) {
    const key = g2Toggle.dataset.g2Toggle
    // Map UI-key → state field. The two non-matching ones (`hubs` →
    // `highlightHubs`, `labels` → `showLabels`, `halos` → `showHalos`)
    // exist because the data attributes read better in the DOM as
    // short tokens; renaming the state fields would lose context in
    // canvas.js.
    const map = { halos: 'showHalos', hubs: 'highlightHubs', labels: 'showLabels', issuesOnly: 'issuesOnly' }
    const field = map[key]
    if (field) {
      graph2[field] = !graph2[field]
      g2Toggle.classList.toggle('on', graph2[field])
    }
    return
  }
  const g2Select = e.target.closest('[data-g2-select]')
  if (g2Select) {
    graph2.selected = g2Select.dataset.g2Select
    refreshGraph2Sidebar()
    return
  }
  // Top-packages mini-tabs (Issues / Files). Pure right-panel
  // change — re-render just the block, leave the canvas alone.
  const g2TopPkgs = e.target.closest('[data-g2-top-pkgs]')
  if (g2TopPkgs) {
    graph2.topPkgsTab = g2TopPkgs.dataset.g2TopPkgs
    refreshGraph2TopPkgs()
    return
  }
  const g2JumpFindings = e.target.closest('[data-g2-jump-findings]')
  if (g2JumpFindings) {
    resetFilters()
    state.filterConfMin = ''
    state.filterInclude = g2JumpFindings.dataset.g2JumpFindings
    state.currentView = 'findings'
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
  // v2 fullscreen — same body-class flip as v1's #tree-fullscreen.
  // The CSS rule under body.report-fullscreen sizes both .tree-layout
  // and .graph2-layout to the viewport, and v2's ResizeObserver on
  // the stage element will fire when the size change lands so the
  // canvas refits without explicit wiring.
  if (e.target.closest('#g2-fullscreen')) {
    document.body.classList.toggle('report-fullscreen')
    return
  }
  // Show-all in the v2 topbar — flips the FILE SET (same data-level
  // filter graph v1's checkbox drives, sharing tree.showAll). Both
  // graph v1's and graph v2's layout caches are now stale; tear down
  // the v2 canvas (rAF + observers + window listeners) so render()
  // can re-attach against the new node set. Graph v1's canvas, if it
  // happens to be the next tab the user opens, will rebuild from
  // scratch because we cleared its layout cache.
  const g2ShowAll = e.target.closest('[data-g2-show-all]')
  if (g2ShowAll) {
    tree.showAll = !tree.showAll
    tree.layoutCache = null
    cleanupGraphInteraction()
    graph2.layoutCache = null
    // Selection might have pointed at a file that's now filtered
    // out — clear it so the right panel doesn't render against a
    // missing node.
    graph2.selected = null
    cleanupGraph2()
    render()
    return
  }
  // Trash toggle in graph v2's topbar — same body-level effect
  // as the findings tab's #toggle-trash (flips state.showDeleted),
  // PLUS canvas teardown / cache invalidation so the graph
  // rebuilds against the new file set. The findings tab's own
  // handler still works when the user is over there; this one
  // adds the v2-specific cleanup.
  if (e.target.closest('#g2-toggle-trash')) {
    state.showDeleted = !state.showDeleted
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
  // Tree-tab: click a graph node to select it (drives the sidebar).
  const treeNode = e.target.closest('.tree-canvas-svg .tree-node[data-file]')
  if (treeNode) {
    tree.selected = treeNode.dataset.file
    render()
    return
  }
  // Tree-tab sidebar: importer / import buttons select the linked file.
  const selectFileBtn = e.target.closest('[data-select-file]')
  if (selectFileBtn) {
    tree.selected = selectFileBtn.dataset.selectFile
    // Update canvas selection highlight + sidebar without rebuilding canvas DOM.
    if (tree.graphState) {
      const canvasEl = document.querySelector('#tree-canvas')
      if (canvasEl) canvasEl.dispatchEvent(new CustomEvent('tree-node-select', { bubbles: true }))
    } else {
      render()
    }
    return
  }
  // Tree-tab sidebar: hubs tab toggle (Issues / Imports).
  const hubsTabBtn = e.target.closest('[data-hubs-tab]')
  if (hubsTabBtn) {
    if (tree.graphState) {
      tree.graphState._hubsTab = hubsTabBtn.dataset.hubsTab
      refreshTreeSidebar()
    } else {
      render()
    }
    return
  }
  // Tree-tab toolbar: fullscreen toggle. Adds / removes a class on
  // <body>; the @media-style rules in CSS hide the chrome.
  if (e.target.closest('#tree-fullscreen')) {
    document.body.classList.toggle('report-fullscreen')
    return
  }
  // Tree-tab sidebar: "Open in Findings" resets ALL filters, then narrows
  // to the selected file's path so only that file's findings show.
  const jumpFindingsBtn = e.target.closest('[data-jump-findings]')
  if (jumpFindingsBtn) {
    resetFilters()
    state.filterConfMin = ''
    state.filterInclude = jumpFindingsBtn.dataset.jumpFindings
    state.currentView = 'findings'
    render()
    return
  }
  // Tree-tab sidebar: "Open in Files" jumps to the Files tab and
  // scrolls to the selected file's card.
  const jumpBtn = e.target.closest('[data-jump-file]')
  if (jumpBtn) {
    const targetFile = jumpBtn.dataset.jumpFile
    state.currentView = 'files'
    render()
    // Wait one frame so the Files tab DOM exists before we look up
    // the anchor (render() rewrote innerHTML).
    requestAnimationFrame(() => {
      const target = document.getElementById(treeAnchor(targetFile))
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return
  }
  // Tab click — switch the active tab within a group. Re-render because
  // tab highlight + tab body visibility + marks row color all update.
  const tabEl = e.target.closest('.tab')
  if (tabEl && tabEl.closest('.tabs')) {
    const findingEl = tabEl.closest('[data-gid]')
    const gid = findingEl.dataset.gid
    const tid = tabEl.dataset.tid
    state.activeTabByGroup.set(gid, tid)
    render()
    return
  }
  // Mark-dot: color applies to the ACTIVE tab only (per spec rule 4).
  // This may change tab sort order (colored tabs come first), so a full
  // re-render is necessary — we can't just flip classes in place.
  const dot = e.target.closest('.mark-dot')
  if (dot) {
    const findingEl = dot.closest('[data-gid]')
    const gid = findingEl.dataset.gid
    const group = findGroupById(gid)
    if (!group) return
    const activeKey = tabKey(activeTabFor(group))
    const color = dot.dataset.color
    const current = state.markers.get(activeKey)
    if (current === color) state.markers.delete(activeKey)
    else state.markers.set(activeKey, color)
    saveTriage()
    render()
    return
  }
  // Delete-x: soft-delete (moved to trash, not discarded).
  //   - No color conflict → delete the whole group (spec rule 4 exception).
  //   - Color conflict     → per-tab delete (spec rule 4 general case).
  // Markers are preserved so restore recovers the full prior state.
  const xBtn = e.target.closest('.mark-x')
  if (xBtn) {
    const findingEl = xBtn.closest('[data-gid]')
    const gid = findingEl.dataset.gid
    const group = findGroupById(gid)
    if (!group) return
    const groupSt = groupState(group)
    if (groupSt.hasConflict) {
      state.deletedIds.add(tabKey(activeTabFor(group)))
    } else {
      for (const f of group) state.deletedIds.add(tabKey(f))
    }
    saveTriage()
    render()
    return
  }
  // Restore: per spec rule 5, applies to EVERY tab in the group — a
  // user in trash view clicking restore expects the whole entry back,
  // not just one member left behind.
  const restoreBtn = e.target.closest('.mark-restore')
  if (restoreBtn) {
    const findingEl = restoreBtn.closest('[data-gid]')
    const gid = findingEl.dataset.gid
    const group = findGroupById(gid)
    if (!group) return
    for (const f of group) state.deletedIds.delete(tabKey(f))
    saveTriage()
    render()
    return
  }
  // Trash toggle — switches the render path from "non-deleted" to
  // "deleted only". Filters (severity, confidence, text match) still
  // apply, just against the trash rather than the live set.
  if (e.target.closest('#toggle-trash')) {
    state.showDeleted = !state.showDeleted
    render()
    return
  }
  // View-mode icon buttons (table / list / grouped). Replaces the
  // earlier select + checkbox combo; the same `state.viewMode` field
  // drives findingsBodyHtml's branch.
  const viewModeBtn = e.target.closest('[data-view-mode]')
  if (viewModeBtn) {
    state.viewMode = viewModeBtn.dataset.viewMode
    // Persist so the user's preferred view sticks across reloads —
    // state.js reads it back on boot.
    try { localStorage.setItem(VIEW_MODE_KEY, state.viewMode) } catch {}
    render()
    return
  }
  // Severity / color stat toggle. Both are multi-select — click toggles
  // membership in the matching Set, empty Set = no filter.
  const sevStat = e.target.closest('.stat[data-sev]')
  if (sevStat) {
    const sev = sevStat.dataset.sev
    if (state.filterSeverities.has(sev)) state.filterSeverities.delete(sev)
    else state.filterSeverities.add(sev)
    render()
    return
  }
  // Scoped to `.stat[data-color]` so mark-dot buttons (which also carry
  // `data-color` but are `<button>`s, not `.stat` cards) don't match —
  // they were already handled above.
  const colorStat = e.target.closest('.stat[data-color]')
  if (colorStat) {
    const col = colorStat.dataset.color
    if (state.filterColors.has(col)) state.filterColors.delete(col)
    else state.filterColors.add(col)
    render()
    return
  }
  // Table-view row click — expand / collapse the full description block.
  // Has to come AFTER all the .tab / .mark-* / link handlers so a
  // click on those still does its specific thing without also toggling
  // expansion. The closest('a, button, label') guard is belt-and-
  // suspenders for clicks that fall through (e.g. the row's own .marks
  // wrapper area between buttons).
  const rowEl = e.target.closest('.finding-row')
  if (rowEl && !e.target.closest('a, button, label')) {
    rowEl.classList.toggle('expanded')
    return
  }
})

// Print button — fixed top-right icon, lives OUTSIDE #report (see
// view.html / styles/theme.css), so the report-level click delegate
// can't see it. Attach directly. Sets document.title to the filename
// (or longest common prefix when multiple files are loaded) so the
// OS print dialog and any saved PDF default to a meaningful name,
// then calls window.print() and restores the original title.
// window.print() is synchronous in current browsers (blocks until the
// dialog is dismissed), so the restore lands before anything else
// can read the title.
document.getElementById('print-btn').addEventListener('click', () => {
  const fileNames = state.reports.map((r) => r.fileName)
  let target = ''
  if (fileNames.length === 1) target = fileNames[0]
  else if (fileNames.length > 1) target = commonPrefix(fileNames)
  // Strip the `.json` suffix so a "Save as PDF" doesn't end up named
  // `<report>.json.pdf`. Also handles a stripped trailing `.` from a
  // partial common prefix like `security-foo.j` — only `.json` exactly
  // at the end gets removed.
  target = target.replace(/\.json$/u, '')
  const oldTitle = document.title
  if (target) document.title = target
  window.print()
  document.title = oldTitle
})

report.addEventListener('change', (e) => {
  const id = e.target.id
  const val = e.target.value
  if (id === 'sort-select') { state.sortBy = val; render() }
  else if (id === 'source-select') { state.filterSource = val; render() }
  else if (id === 'conf-min') { state.filterConfMin = val === '' ? '' : parseInt(val, 10); render() }
  else if (id === 'conf-max') { state.filterConfMax = val === '' ? '' : parseInt(val, 10); render() }
  // Tree-tab: include clean files in the force graph. Invalidates the
  // cached layout so the next render computes fresh positions.
  else if (id === 'tree-show-all') {
    tree.showAll = e.target.checked
    tree.layoutCache = null
    cleanupGraphInteraction()
    // showAll changes the file set on graph v2 too (same filter),
    // so its cached layout is stale. Drop it so the next switch to
    // graph v2 recomputes positions.
    graph2.layoutCache = null
    cleanupGraph2()
    render()
  }
})

report.addEventListener('input', (e) => {
  const id = e.target.id
  const val = e.target.value
  if (id === 'filter-include') { state.filterInclude = val; renderKeepFocus(id) }
  else if (id === 'filter-exclude') { state.filterExclude = val; renderKeepFocus(id) }
  else if (id === 'repo-url') { state.repoUrl = val; renderKeepFocus(id) }
  // Graph v2 — sliders write straight into state.graph2 and update
  // the inline value label. No re-render: the canvas's draw loop
  // already reads from graph2 every frame, so the change shows up
  // immediately.
  else if (id === 'g2-r-edge-op') {
    graph2.edgeOpacity = parseFloat(val) / 100
    const lbl = document.getElementById('g2-lbl-edge-op')
    if (lbl) lbl.textContent = graph2.edgeOpacity.toFixed(2)
  }
  else if (id === 'g2-r-min-deg') {
    graph2.minDegree = parseInt(val, 10)
    const lbl = document.getElementById('g2-lbl-min-deg')
    if (lbl) lbl.textContent = graph2.minDegree
  }
  else if (id === 'g2-r-node-size') {
    graph2.nodeSize = parseInt(val, 10) / 100
    const lbl = document.getElementById('g2-lbl-node-size')
    if (lbl) lbl.textContent = graph2.nodeSize.toFixed(1) + '×'
  }
  else if (id === 'g2-palette-search') {
    graph2.paletteSearch = val
    const q = val.trim().toLowerCase()
    document.querySelectorAll('#g2-palette .g2-swatch').forEach((s) => {
      const pkg = s.dataset.g2Pkg
      const label = pkg === '__own__' ? 'own source' : pkg
      const match = !q || label.toLowerCase().includes(q)
      s.classList.toggle('muted', !match)
    })
  }
})
