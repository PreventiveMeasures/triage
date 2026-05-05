import { state } from './state.js'
import { report } from './dom.js'
import { commonPrefix } from './format.js'
import { tabKey, activeTabFor, groupState, findGroupById } from './group.js'
import { resetFilters } from './filters.js'
import { saveTriage } from './triage.js'
import { render, renderKeepFocus, refreshTreeSidebar } from './render.js'
import { tree, cleanupGraphInteraction } from './graph/state.js'
import { treeAnchor } from './graph/utils.js'

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
    state.currentView = viewTab.dataset.view
    document.body.classList.remove('report-fullscreen')
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
  // Print button — set document.title to the filename (or longest common
  // prefix when multiple files are loaded) so the OS print dialog and any
  // saved PDF default to a meaningful name, then call window.print() and
  // restore the original title. window.print() is synchronous in current
  // browsers (blocks until the dialog is dismissed), so the restore lands
  // before anything else can read the title.
  if (e.target.closest('#print-btn')) {
    const fileNames = state.reports.map((r) => r.fileName)
    let target = ''
    if (fileNames.length === 1) target = fileNames[0]
    else if (fileNames.length > 1) target = commonPrefix(fileNames)
    // Strip the `.json` suffix so a "Save as PDF" doesn't end up named
    // `<report>.json.pdf`. Also handles a stripped trailing `.` from
    // a partial common prefix like `security-foo.j` — only `.json`
    // exactly at the end gets removed.
    target = target.replace(/\.json$/u, '')
    const oldTitle = document.title
    if (target) document.title = target
    window.print()
    document.title = oldTitle
  }
})

report.addEventListener('change', (e) => {
  const id = e.target.id
  const val = e.target.value
  if (id === 'sort-select') { state.sortBy = val; render() }
  else if (id === 'view-mode') { state.viewMode = val; render() }
  else if (id === 'source-select') { state.filterSource = val; render() }
  else if (id === 'conf-min') { state.filterConfMin = val === '' ? '' : parseInt(val, 10); render() }
  else if (id === 'conf-max') { state.filterConfMax = val === '' ? '' : parseInt(val, 10); render() }
  // Toggle `show-metadata` on #report without a full re-render —
  // avoids reallocating the checkbox mid-click (which would blur it)
  // and is cheap since this is a pure CSS effect.
  else if (id === 'show-metadata') { state.showMetadata = e.target.checked; report.classList.toggle('show-metadata', state.showMetadata) }
  // `group-by-file` reshapes the rendered DOM (per-file headers vs flat
  // location labels), so it goes through a full render — checkbox blur
  // is acceptable here since the change is structural.
  else if (id === 'group-by-file') { state.groupByFile = e.target.checked; render() }
  // Tree-tab: include clean files in the force graph. Invalidates the
  // cached layout so the next render computes fresh positions.
  else if (id === 'tree-show-all') {
    tree.showAll = e.target.checked
    tree.layoutCache = null
    cleanupGraphInteraction()
    render()
  }
})

report.addEventListener('input', (e) => {
  const id = e.target.id
  const val = e.target.value
  if (id === 'filter-include') { state.filterInclude = val; renderKeepFocus(id) }
  else if (id === 'filter-exclude') { state.filterExclude = val; renderKeepFocus(id) }
  else if (id === 'repo-url') { state.repoUrl = val; renderKeepFocus(id) }
})
