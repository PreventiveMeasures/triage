import { state, VIEW_MODE_KEY } from './state.js'
import { report } from './dom.js'
import { commonPrefix } from './format.js'
import { tabKey, activeTabFor, groupState, findGroupById } from './group.js'
import { resetFilters } from './filters.js'
import { saveTriage } from './triage.js'
import { render, renderKeepFocus, refreshGraph2Sidebar, refreshGraph2TopPkgs } from './render.js'
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
    refreshGraph2Sidebar()
    refreshGraph2TopPkgs()
    graph2.graphState?.requestDraw?.()
    return
  }
  const g2Sev = e.target.closest('[data-g2-sev]')
  if (g2Sev) {
    // Toggle membership in the highlight-filter set. Empty set
    // = no filter (all nodes full opacity); non-empty = matching
    // nodes full, others dim to 0.1. The class swap keeps the
    // pill's active appearance in sync without a full re-render.
    const sev = g2Sev.dataset.g2Sev
    if (graph2.selectedSeverities.has(sev)) graph2.selectedSeverities.delete(sev)
    else graph2.selectedSeverities.add(sev)
    g2Sev.classList.toggle('on', graph2.selectedSeverities.has(sev))
    g2Sev.setAttribute('aria-pressed', String(graph2.selectedSeverities.has(sev)))
    graph2.graphState?.requestDraw?.()
    // Refresh the Top-packages block — its Issues counts now
    // factor the selected severities in, so flipping a pill
    // should re-rank the list. Selection card untouched (file
    // / package selection isn't filter-derived).
    refreshGraph2TopPkgs()
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
  // Delete-x: soft-delete (moved to trash, not discarded).
  //   - No color conflict → delete the whole group (spec rule 4 exception).
  //   - Color conflict     → per-tab delete (spec rule 4 general case).
  // Markers are preserved so restore recovers the full prior state.
  const xBtn = pathClosest(e, '.mark-x')
  if (xBtn) {
    const findingEl = pathClosest(e, '[data-gid]')
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
  const restoreBtn = pathClosest(e, '.mark-restore')
  if (restoreBtn) {
    const findingEl = pathClosest(e, '[data-gid]')
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
  // Table-view details panel close button — clears selection and
  // re-renders so the list expands back to full width.
  if (e.target.closest('[data-table-deselect]')) {
    state.tableSelectedGid = null
    render()
    return
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
})

report.addEventListener('input', (e) => {
  const id = e.target.id
  const val = e.target.value
  if (id === 'filter-include') { state.filterInclude = val; renderKeepFocus(id) }
  else if (id === 'filter-exclude') { state.filterExclude = val; renderKeepFocus(id) }
  else if (id === 'repo-url') { state.repoUrl = val; renderKeepFocus(id) }
  else if (id === 'g2-path-filter') {
    graph2.pathFilter = val
    graph2.graphState?.requestDraw?.()
  }
})
