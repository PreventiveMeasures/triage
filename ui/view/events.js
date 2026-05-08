import { state, VIEW_MODE_KEY, saveRepoUrlFor } from './state.js'
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
  // (graph2 severity filter is now a `<severity-chips kind="graph">`
  // — the click dispatches a `severity-toggle` CustomEvent that the
  // dedicated listener at the bottom of this file handles, doing
  // the same canvas redraw + Top-packages refresh as the old
  // `[data-g2-sev]` click delegate did.)

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
    state.filterConfMin = 0
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
document.getElementById('print-btn').addEventListener('click', async () => {
  if (state.reports.length === 0) return
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
  // Strip the `.json` suffix so a "Save as PDF" doesn't end up named
  // `<report>.json.pdf`. Also handles a stripped trailing `.` from a
  // partial common prefix like `security-foo.j` — only `.json` exactly
  // at the end gets removed.
  target = target.replace(/\.json$/u, '')
  const oldTitle = document.title
  if (target) document.title = target
  window.print()
  document.title = oldTitle
  if (state.viewMode !== oldMode) {
    state.viewMode = oldMode
    render()
  }
})

report.addEventListener('change', (e) => {
  const id = e.target.id
  const val = e.target.value
  if (id === 'sort-select') { state.sortBy = val; render() }
  else if (id === 'source-select') { state.filterSource = val; render() }
})

// Confidence range slider. `range-input` fires continuously during
// drag and only updates the labelled values + the row-visibility
// (no full re-render — that would tear the slider out from under
// the user's mouse). `range-change` fires on release and triggers
// the full render so any chrome that keys off the live counts
// (severity-chip badges, the search row's `X of Y`) catches up.
report.addEventListener('range-input', (e) => {
  if (e.target.id !== 'conf-range') return
  state.filterConfMin = e.detail.low
  state.filterConfMax = e.detail.high
  // Update only the live label so the user can read the range
  // they're dragging through; defer the heavy filter render to
  // `range-change`.
  const label = document.getElementById('conf-range-vals')
  if (label) label.textContent = `${state.filterConfMin}–${state.filterConfMax}`
})
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
    refreshGraph2TopPkgs()
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
    refreshGraph2TopPkgs()
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
