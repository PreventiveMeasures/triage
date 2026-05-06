import { state } from './state.js'
import { dropZone, report } from './dom.js'
import { esc, prettyModel, fileLink, lineLink, isModule } from './format.js'
import { tabKey, primaryTab, activeTabFor, isGroupDeleted } from './group.js'
import { applyFilters, applySorting } from './filters.js'
import { renderGroup, renderTableRow } from './render-finding.js'
import { tree } from './graph/state.js'
import { computeFindingCountsByFile, computeTransitiveCounts } from './graph/utils.js'
import { renderTreeCanvas, attachTreeGraphInteraction } from './graph/canvas.js'
import { renderTreeSidebarFull } from './graph/sidebar.js'
import { renderTreeView } from './graph/files.js'
import { graph2 } from './graph2/state.js'
import { buildGraph } from './graph2/data.js'
import { renderGraph2Layout, renderSelectionCard, renderTopPkgsBlock } from './graph2/render.js'
import { attachGraph2Interaction } from './graph2/canvas.js'
import { fileHasFindings, packageOf } from './graph/utils.js'

// Inline SVGs for the View-mode icon buttons. currentColor lets the
// CSS .active rule recolor them to var(--accent) on selection without
// re-rendering. Kept as raw strings so the toolbar HTML can compose
// them directly; size is set via the SVG width/height (14px) and the
// stroke widths are tuned to read clearly at that size.
//   table   — four dense rows, like a spreadsheet
//   list    — three taller items with a row-bullet on the left
//   grouped — items under a section header band on top
const VIEW_ICONS = {
  table: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">'
    + '<rect x="2" y="3" width="12" height="1.6"/><rect x="2" y="6" width="12" height="1.6"/>'
    + '<rect x="2" y="9" width="12" height="1.6"/><rect x="2" y="12" width="12" height="1.6"/></svg>',
  list: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">'
    + '<rect x="2" y="3" width="2" height="2.2" rx=".4"/><rect x="6" y="3" width="9" height="2.2" rx=".4"/>'
    + '<rect x="2" y="7" width="2" height="2.2" rx=".4"/><rect x="6" y="7" width="9" height="2.2" rx=".4"/>'
    + '<rect x="2" y="11" width="2" height="2.2" rx=".4"/><rect x="6" y="11" width="9" height="2.2" rx=".4"/></svg>',
  grouped: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">'
    + '<rect x="2" y="2" width="12" height="2.4" rx=".5"/>'
    + '<rect x="3" y="6" width="11" height="1.6"/><rect x="3" y="8.5" width="11" height="1.6"/>'
    + '<rect x="3" y="11" width="11" height="1.6"/><rect x="3" y="13.5" width="11" height="1.6"/></svg>',
}

const VIEW_TITLES = {
  table: 'Table view (compact rows, click a row to expand)',
  list: 'List view (flat, one card per finding)',
  grouped: 'List view, grouped by file',
}

// Refresh just the tree-tab right sidebar in place. Called by the
// canvas after selection changes, and by event handlers when the
// selection is driven from the sidebar itself, so the canvas DOM
// (and its hover state) survives.
export function refreshTreeSidebar() {
  const infoEl = document.querySelector('.tree-info')
  if (!infoEl || !tree.graphState) return
  const treeData = state.reports[0]?.tree
  if (!treeData) return
  const findingCounts = computeFindingCountsByFile(state.reports.flatMap((r) => r.groups))
  const transitiveCounts = computeTransitiveCounts(treeData, findingCounts)
  infoEl.innerHTML = renderTreeSidebarFull(tree.selected, treeData, findingCounts, transitiveCounts)
}

// Build the v2 graph data from the currently-loaded report. Returns
// null when no tree-bearing report is loaded — callers (the tab
// switcher in render(), the "Graph v2" event handler) use that to
// fall back to a friendlier state.
//
// Two filters compose:
//   - state.showDeleted splits findings the same way the findings
//     tab does: live findings by default, deleted findings in trash
//     mode. Visibility is at the GROUP level (a group is "deleted"
//     when every member is in state.deletedIds), matching the
//     findings tab so swapping tabs reads consistently.
//   - tree.showAll then optionally pads the file set with clean
//     files whose subtree contains a (filtered-in) finding,
//     reachable through imports. Off by default so the canvas
//     focuses on issue-bearing code.
export function buildGraph2Data() {
  const treeData = state.reports[0]?.tree
  if (!treeData) return null
  const allFiles = Object.keys(treeData)
  const allGroups = state.reports.flatMap((r) => r.groups)
  // Filter to live (default) or deleted (trash mode) groups
  // BEFORE counting per-file findings, so the layout, statistics,
  // and severity-row counts all reflect the active tab's split.
  const visibleGroups = allGroups.filter((g) =>
    state.showDeleted ? isGroupDeleted(g) : !isGroupDeleted(g))
  const findingCounts = computeFindingCountsByFile(visibleGroups)
  const transitiveCounts = computeTransitiveCounts(treeData, findingCounts)
  // Package-focus mode narrows to files in the focused package.
  // tree.showAll still gates the clean-file filter inside that
  // scope: when off, drop files that have neither own findings
  // nor a subtree (transitive) finding reachable through imports
  // — same predicate the full-graph view uses, applied to the
  // package subset. The canvas's intra-package import set falls
  // out automatically since buildGraph filters edges to the file
  // set; cross-package imports outside the focus aren't drawn,
  // but their transitive findings still count toward keeping a
  // file in scope (they're part of "reachable issues" the user
  // expects to see represented).
  let files
  if (graph2.focusedPkg) {
    files = allFiles.filter((f) => (packageOf(f) ?? '__own__') === graph2.focusedPkg)
    if (!tree.showAll) {
      files = files.filter((f) => fileHasFindings(f, findingCounts, transitiveCounts))
    }
  } else {
    files = tree.showAll
      ? allFiles
      : allFiles.filter((f) => fileHasFindings(f, findingCounts, transitiveCounts))
  }
  return { graph: buildGraph(treeData, files, findingCounts, transitiveCounts), findingCounts }
}

// Re-render only the right-panel selection card in the graph v2 tab.
// Same role as refreshTreeSidebar above — keeps the canvas DOM (and
// thus the active rAF / hover state) intact when the user just
// clicked a node or a neighbor button.
export function refreshGraph2Sidebar() {
  const area = document.getElementById('g2-selection-area')
  if (!area) return
  const data = buildGraph2Data()
  if (!data) return
  area.innerHTML = renderSelectionCard(data.graph)
}

// Re-render only the right-panel "Top packages" block. Called when
// the user flips the Issues/Files mini-tab. Same canvas-preserving
// pattern as refreshGraph2Sidebar — surgical innerHTML swap, no
// teardown of the rAF loop / hover state on the main canvas.
export function refreshGraph2TopPkgs() {
  const block = document.getElementById('g2-top-pkgs-block')
  if (!block) return
  const data = buildGraph2Data()
  if (!data) return
  block.innerHTML = renderTopPkgsBlock(data.graph)
}

// Build the analyzer-breakdown header line. One entry per unique
// `<analyzer> (<model>, <effort>, <exportsMode>)` combo seen across all
// findings. The parenthetical lists whichever modifiers are set on
// that combo, in the same order as the per-finding run-meta line so
// the title and the per-finding annotations read consistently. Source
// data comes from the run-meta lifted onto each finding at ingest, so
// a single load can contain several combos when the user merges
// multiple analyzer outputs. Model name is prettified the same way
// (provider prefix + `claude-` stripped, dashes → spaces).
// Source-specific header titles. Used when every loaded report shares
// the same `source` marker — those reports lack the analyzer
// (model / effort / exportsMode) metadata that `combos` builds from,
// and the regular "DeepView results, analyzers: security,
// performance, …" line would read as if multiple analyzer runs were
// merged when really they're per-finding category tags within one
// product's report.
const SOURCE_TITLES = {
  'claude-security': 'Claude Security results',
  'codex-security': 'Codex Security results',
  'deepseek': 'DeepSeek results',
}

function headerHtml(allGroupsLength, fileNames) {
  // Single-source title only fires when EVERY loaded report carries
  // the same source marker. Mixing a Claude / Codex report with a
  // JSON dump (or with each other) falls back to the analyzer
  // breakdown so neither product's info gets hidden.
  const sources = new Set(state.reports.map((r) => r.source))
  const singleSource = sources.size === 1 ? [...sources][0] : null
  const sourceTitle = singleSource ? SOURCE_TITLES[singleSource] : null

  let headerText
  if (sourceTitle) {
    headerText = sourceTitle
  } else {
    const combos = [...new Set(state.reports.flatMap((r) =>
      r.groups.flatMap((g) => g.map((f) => {
        const type = f.type ?? 'unknown'
        const parts = []
        const model = prettyModel(f.model)
        if (model) parts.push(model)
        if (f.effort) parts.push(f.effort)
        if (f.exportsMode) parts.push(f.exportsMode)
        return parts.length > 0 ? `${type} (${parts.join(', ')})` : type
      }))
    ))]
    // Singular/plural keyed off the number of distinct combos shown —
    // one combo says "analyzer", any more says "analyzers". Two runs
    // of the same analyzer with different effort/exportsMode count as
    // two combos and pluralize accordingly.
    const analyzerLabel = combos.length === 1 ? 'analyzer' : 'analyzers'
    // headerText is pre-escaped (combo strings esc'd here) so it can
    // include mixed safe + interpolated content without re-escaping.
    headerText = combos.length > 0
      ? `DeepView results, ${analyzerLabel}: ${combos.map(esc).join(', ')}`
      : 'DeepView results'
  }
  const reportLabel = state.reports.length === 1
    ? esc(fileNames[0])
    : `${state.reports.length} reports: ${esc(fileNames.join(', '))}`
  const findingNoun = `finding${allGroupsLength !== 1 ? 's' : ''}`
  const countLabel = state.showDeleted
    ? `Trash: ${allGroupsLength} deleted ${findingNoun}`
    : `${allGroupsLength} ${findingNoun}`
  let html = '<header>'
  html += `<h1>${headerText}</h1>`
  html += `<div class="meta">${reportLabel} &mdash; ${countLabel}</div>`
  html += '</header>'
  return html
}

// Stats — clickable filter chips. Severity chips on the left, mark-color
// chips on the right. Both are multi-select: empty selection = no
// filter; multiple selections = union across the ticked chips (so
// ticking every chip is equivalent to ticking none). A zero-count
// chip is hidden so the row stays compact.
function statsHtml(counts, colorCounts) {
  let html = '<div class="stats">'
  // Order matches the SEVERITIES iteration in format.js. Each chip
  // auto-hides when its count is zero (the loop below skips !count),
  // so the bug tiers only appear when a DeepSec report contains them
  // and stay invisible for Claude / Codex / JSON dumps.
  const statItems = [
    ['critical', counts.critical, '--critical'],
    ['high', counts.high, '--high'],
    ['medium', counts.medium, '--medium'],
    ['low', counts.low, '--low'],
    ['high_bug', counts.high_bug, '--high-bug'],
    ['bug', counts.bug, '--bug'],
    ['informational', counts.informational, '--info'],
  ]
  for (const [sev, count, color] of statItems) {
    if (!count) continue
    const active = state.filterSeverities.has(sev) ? ' active' : ''
    // `high_bug` → `high bug` for the human-readable label; data-sev
    // keeps the raw token so click filtering still matches f.severity.
    const label = sev.replace(/_/gu, ' ')
    html += `<div class="stat${active}" data-sev="${sev}"><strong style="color:var(${color})">${count}</strong>${label}</div>`
  }
  const colorStatItems = [
    ['red', colorCounts.red, 'red'],
    ['blue', colorCounts.blue, 'blue'],
    ['green', colorCounts.green, 'green'],
    ['gray', colorCounts.gray, 'gray'],
    ['none', colorCounts.none, 'unmarked'],
  ]
  for (const [col, count, label] of colorStatItems) {
    if (!count) continue
    const active = state.filterColors.has(col) ? ' active' : ''
    html += `<div class="stat${active}" data-color="${col}"><strong>${count}</strong><span class="stat-dot stat-dot-${col}"></span>${label}</div>`
  }
  html += '</div>'
  return html
}

// `flags` carries per-render applicability: when no finding in the
// current report has confidence / a node_modules path / file or tree
// hash metadata, the corresponding control is omitted entirely (and
// the underlying filter state is forced to its no-op value upstream
// for confidence / source so it can't be left set from a previous
// report). Hides chrome the user can't act on usefully.
function toolbarHtml(filteredCount, allCount, deletedCount, flags) {
  const { showSource, showConfidence, showPriority, showRepoInput } = flags
  let html = '<div class="toolbar">'
  html += '<div class="toolbar-row">'
  html += `<label for="sort-select">Sort:</label>`
  html += `<select id="sort-select">`
  html += `<option value="file"${state.sortBy === 'file' ? ' selected' : ''}>By file</option>`
  html += `<option value="severity"${state.sortBy === 'severity' ? ' selected' : ''}>By severity</option>`
  // Confidence sort options drop out alongside the Confidence
  // min/max filter when no finding carries a confidence value
  // (codex / claude security imports). Without this guard the
  // user could pick "Confidence (high first)" on a report where
  // every confidence is undefined and end up with applySorting's
  // ?? -1 fallback shuffling the list arbitrarily.
  if (showConfidence) {
    html += `<option value="confidence-desc"${state.sortBy === 'confidence-desc' ? ' selected' : ''}>Confidence (high first)</option>`
    html += `<option value="confidence-asc"${state.sortBy === 'confidence-asc' ? ' selected' : ''}>Confidence (low first)</option>`
  }
  // Priority — same pattern as Confidence: only renders when at
  // least one finding carries a numeric `priority` (0.0–10.0). State
  // is forced back to 'file' upstream if a previously-set priority
  // sort no longer applies.
  if (showPriority) {
    html += `<option value="priority-desc"${state.sortBy === 'priority-desc' ? ' selected' : ''}>Priority (high first)</option>`
    html += `<option value="priority-asc"${state.sortBy === 'priority-asc' ? ' selected' : ''}>Priority (low first)</option>`
  }
  html += `</select>`
  if (showSource) {
    html += `<div class="sep"></div>`
    html += `<label for="source-select">Source:</label>`
    html += `<select id="source-select">`
    html += `<option value="all"${state.filterSource === 'all' ? ' selected' : ''}>All files</option>`
    html += `<option value="own"${state.filterSource === 'own' ? ' selected' : ''}>Own source</option>`
    html += `<option value="modules"${state.filterSource === 'modules' ? ' selected' : ''}>node_modules</option>`
    html += `</select>`
  }
  if (showConfidence) {
    html += `<div class="sep"></div>`
    html += `<label for="conf-min">Confidence:</label>`
    html += `<select id="conf-min">`
    html += `<option value="">min</option>`
    for (let i = 0; i <= 10; i++) html += `<option value="${i}"${state.filterConfMin === i ? ' selected' : ''}>${i}</option>`
    html += `</select>`
    html += ` &ndash; `
    html += `<select id="conf-max">`
    html += `<option value="">max</option>`
    for (let i = 0; i <= 10; i++) html += `<option value="${i}"${state.filterConfMax === i ? ' selected' : ''}>${i}</option>`
    html += `</select>`
  }
  html += `<div class="sep"></div>`
  // View mode — three icon buttons replacing the previous
  // dropdown + group-by-file checkbox combo. 'grouped' rolls in what
  // used to be `list + groupByFile=true`. Click handler in events.js
  // matches `[data-view-mode]`. Metadata checkbox stays scoped to the
  // card-based views (list / grouped) — table view doesn't render
  // .hashes anywhere so the toggle has nothing to act on there.
  html += `<span class="view-mode-label">View:</span>`
  html += '<div class="view-mode-group" role="group" aria-label="View mode">'
  for (const mode of ['table', 'list', 'grouped']) {
    const active = state.viewMode === mode ? ' active' : ''
    html += `<button type="button" class="view-mode-btn${active}" data-view-mode="${mode}" title="${esc(VIEW_TITLES[mode])}" aria-label="${esc(VIEW_TITLES[mode])}" aria-pressed="${state.viewMode === mode}">${VIEW_ICONS[mode]}</button>`
  }
  html += '</div>'
  // Trash toggle only shows when there's something to toggle: either
  // findings are already deleted (count > 0) or the user is currently
  // viewing the trash (showDeleted=true) and needs a way back. Empty
  // trash + live view = button is dead chrome, hide it.
  if (deletedCount > 0 || state.showDeleted) {
    const trashTitle = state.showDeleted ? 'exit trash view' : 'show deleted findings'
    const trashLabel = `Trash${deletedCount ? ` (${deletedCount})` : ''}`
    html += `<button type="button" id="toggle-trash" class="trash-btn${state.showDeleted ? ' active' : ''}" title="${trashTitle}">${trashLabel}</button>`
  }
  // Print button moved out of the toolbar — now a fixed icon in the
  // top-right corner under the theme toggle, see styles/theme.css and
  // view.html. Visibility is gated by `body.show-print-btn` toggled in
  // render() so it only appears on the findings tab with a report
  // loaded.
  html += `<span class="result-count">${filteredCount} of ${allCount}</span>`
  html += '</div>'
  html += '<div class="toolbar-row">'
  html += `<label for="filter-include">Include:</label>`
  html += `<input type="text" id="filter-include" value="${esc(state.filterInclude)}" placeholder="match text">`
  html += `<label for="filter-exclude">Exclude:</label>`
  html += `<input type="text" id="filter-exclude" value="${esc(state.filterExclude)}" placeholder="hide text">`
  html += '</div>'
  // The Repo URL input only contributes to fileUrl() for findings
  // that are non-node_modules AND lack a per-finding `repo.github`
  // (see format.js fileUrl). When every finding either carries its
  // own repo.github or sits in node_modules, the typed URL has
  // nothing to apply to — hide the row entirely. State is preserved
  // so a later report that needs it inherits any URL the user
  // previously typed.
  if (showRepoInput) {
    html += '<div class="toolbar-row">'
    html += `<label for="repo-url">Repo:</label>`
    html += `<input type="text" id="repo-url" value="${esc(state.repoUrl)}" placeholder="https://github.com/user/repo">`
    html += '</div>'
  }
  html += '</div>'
  return html
}

// Render the body of the findings tab — table view (compact 2-row
// blocks, never grouped by file) or list view (per-finding cards,
// optionally grouped by file). `applySorting` already ordered
// `filtered` by sortBy.
function findingsBodyHtml(filtered) {
  let html = ''
  if (state.viewMode === 'table') {
    // Table view is always flat. For 'file' sort we still want
    // line-within-file ordering to match the file-grouped layout's
    // intra-file order; applySorting only handles file→line for
    // severity / confidence sorts. All rows live inside a single
    // .finding-table glass wrapper — rows themselves are transparent
    // with just a border-bottom separator, so the whole list reads
    // as one continuous panel rather than a strip of detached cards.
    // Skip the wrapper entirely when nothing matched: an empty
    // .finding-table still paints its border + glass surface, which
    // shows up as a thin panel under the "no findings match" message.
    const items = state.sortBy === 'file'
      ? [...filtered].sort((a, b) => {
        const pa = primaryTab(a), pb = primaryTab(b)
        return pa.file.localeCompare(pb.file) || parseInt(pa.line) - parseInt(pb.line)
      })
      : filtered
    if (items.length === 0) return html
    html += '<div class="finding-table">'
    for (const g of items) html += renderTableRow(g)
    html += '</div>'
    return html
  }
  if (state.viewMode === 'grouped') {
    // Group groups by file. All tabs in a dedup group share the same file
    // (dedup runs per-file by fileHash upstream), so the primary tab's
    // file is a safe representative.
    const byFile = new Map()
    for (const g of filtered) {
      const file = primaryTab(g).file
      if (!byFile.has(file)) byFile.set(file, [])
      byFile.get(file).push(g)
    }

    // For file sort, sort files alphabetically; otherwise preserve first-appearance order
    const fileKeys = state.sortBy === 'file' ? [...byFile.keys()].sort() : [...byFile.keys()]

    for (const file of fileKeys) {
      const items = state.sortBy === 'file'
        ? byFile.get(file).sort((a, b) => parseInt(primaryTab(a).line) - parseInt(primaryTab(b).line))
        : byFile.get(file)
      html += '<div class="file-group">'
      // All findings under one file share the same `repo.github` (it's
      // a property of the source file's package), so probe the first
      // group's primary tab — every other tab in this file would carry
      // the same value or none at all.
      const githubRepo = primaryTab(items[0])?.repo?.github
      html += `<div class="file-header"><span>${fileLink(file, githubRepo)}</span><span class="count">${items.length}</span></div>`
      html += '<div class="file-body">'
      for (const g of items) html += renderGroup(g)
      html += '</div></div>'
    }
    return html
  }
  // Flat mode: each dedup group renders inside its own card (.flat-group)
  // with a small location header on top (file · line · exportName).
  // For the 'file' sort we extend that ordering with line-within-file,
  // which the file-grouped path achieves by sorting per-file.
  const items = state.sortBy === 'file'
    ? [...filtered].sort((a, b) => {
      const pa = primaryTab(a), pb = primaryTab(b)
      return pa.file.localeCompare(pb.file) || parseInt(pa.line) - parseInt(pb.line)
    })
    : filtered
  // Each group's location header carries the FULL line row (file +
  // line + exportName + run-meta) for the active tab. The in-body
  // line-row inside the .finding card is hidden (CSS rule under
  // `.flat-group .finding .line-row`) so the same info doesn't
  // appear twice. Tab switches re-render, so the header tracks the
  // active tab automatically.
  for (const g of items) {
    const p = activeTabFor(g)
    // Skip the line span entirely when there's no line number — a
    // bare "line ?" reads as broken metadata. lineLink returns '' in
    // that case (codex / claude-security imports don't carry lines).
    const lineLinkHtml = lineLink(p.file, p.line, p.repo?.github)
    const lineHtml = lineLinkHtml ? `<span class="line-num">${lineLinkHtml}</span>` : ''
    const exportHtml = p.exportName ? `<span class="meta">${esc(p.exportName)}</span>` : ''
    const meta = [p.type, prettyModel(p.model), p.effort, p.exportsMode].filter(Boolean).join(' · ')
    const metaHtml = meta ? `<span class="run-meta">${esc(meta)}</span>` : ''
    html += '<div class="flat-group">'
    html += `<div class="flat-group-loc"><span class="file">${fileLink(p.file, p.repo?.github)}</span>${lineHtml}${exportHtml}${metaHtml}</div>`
    html += renderGroup(g)
    html += '</div>'
  }
  return html
}

export function render() {
  // Fixed top-right print icon visibility — only show on the
  // findings tab with a report loaded (graph / files tabs would
  // print useless content). Toggled via a body class so the
  // button itself doesn't need to re-render.
  document.body.classList.toggle('show-print-btn',
    state.reports.length > 0 && state.currentView === 'findings')
  if (state.reports.length === 0) return
  // Merge across all loaded reports. Every entry is a Finding[] (a dedup
  // group); single findings were wrapped at ingest, so downstream code
  // doesn't branch on shape. The trash-view split happens here, not in
  // applyFilters, so the "X of Y" counter and severity stats reflect
  // the set currently being viewed (live groups, or the trash).
  const mergedGroups = state.reports.flatMap((r) => r.groups)
  const deletedCount = mergedGroups.reduce((n, g) => n + (isGroupDeleted(g) ? 1 : 0), 0)
  const allGroups = mergedGroups.filter((g) => state.showDeleted ? isGroupDeleted(g) : !isGroupDeleted(g))
  // Preserve first-seen order for the type label so "security, correctness"
  // reads in load order rather than alphabetical.
  const types = [...new Set(state.reports.map((r) => r.type))]
  const typeLabel = types.join(', ')
  const fileNames = state.reports.map((r) => r.fileName)

  // Severity + color stats count GROUPS (not individual tabs). A group is
  // counted under every severity/color that appears in any of its tabs —
  // so sums can exceed the total group count when groups have mixed tabs.
  // This matches the filter semantics (click "high" → all groups where
  // any tab is high; click "red" → all groups with any red-marked tab),
  // and gives a useful preview of filter-click results. Unmarked tabs
  // bucket under `'none'` so the user can isolate unreviewed findings.
  const counts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  const colorCounts = { red: 0, blue: 0, green: 0, gray: 0, none: 0 }
  for (const g of allGroups) {
    const sevs = new Set(g.map((f) => f.severity))
    for (const s of sevs) counts[s] = (counts[s] || 0) + 1
    const cols = new Set(g.map((f) => state.markers.get(tabKey(f)) ?? 'none'))
    for (const c of cols) colorCounts[c] = (colorCounts[c] || 0) + 1
  }

  // Per-render applicability flags. The toolbar hides controls the
   // user can't act on usefully, and the underlying filter state is
   // forced back to its no-op value so a previously-set filter from
   // a prior report can't keep findings hidden silently. Stats /
   // sorting / include-exclude always make sense, so no flags for
   // those.
  const hasAnyConfidence = mergedGroups.some((g) => g.some((f) => f.confidence !== undefined))
  const hasAnyPriority = mergedGroups.some((g) => g.some((f) => f.priority !== undefined))
  const hasAnyModulesPath = mergedGroups.some((g) => g.some((f) => isModule(f.file)))
  // Repo URL input is useful only when at least one finding could
  // benefit from it: non-node_modules AND no per-finding repo.github.
  const repoInputUseful = mergedGroups.some((g) => g.some((f) => !f.repo?.github && !isModule(f.file)))
  // If a previously-loaded report had node_modules and the user
  // narrowed the source filter, switching to a report without any
  // node_modules paths would leave the filter at 'own' or 'modules'
  // and silently empty the list. resetFilters() runs only on isFirst
  // in ingest.js, so guard here too.
  if (!hasAnyModulesPath && state.filterSource !== 'all') state.filterSource = 'all'
  if (!hasAnyConfidence) {
    state.filterConfMin = ''; state.filterConfMax = ''
    // Sort options for confidence drop out alongside the filter, so a
    // user-set confidence sort would stay selected against an absent
    // option in the dropdown and applySorting would fall through to
    // its `?? -1` placeholder. Reset to 'file' when that happens.
    if (state.sortBy === 'confidence-desc' || state.sortBy === 'confidence-asc') state.sortBy = 'file'
  }
  // Same guard for priority — the option drops out of the dropdown
  // when no finding carries it, so a stale state.sortBy would point
  // at a non-existent option and applySorting would shuffle on `?? -1`.
  if (!hasAnyPriority && (state.sortBy === 'priority-desc' || state.sortBy === 'priority-asc')) {
    state.sortBy = 'file'
  }

  const filtered = applySorting(applyFilters(allGroups))

  let html = headerHtml(allGroups.length, fileNames)

  // Top-level view switcher. Tree tab only appears for tree-bearing
  // reports with >1 file — a single-file tree adds no navigation value.
  // Both Tree (graph + sidebar) and Files (per-file cards) tabs share
  // the same gate; switching files / loading a tree-less report falls
  // back to 'findings' so the user doesn't end up on a hidden tab.
  const treeData = state.reports[0]?.tree
  const treeFileCount = treeData ? Object.keys(treeData).length : 0
  const showTreeTab = treeFileCount > 1
  if (!showTreeTab && (state.currentView === 'tree' || state.currentView === 'files' || state.currentView === 'graph2')) {
    state.currentView = 'findings'
  }
  if (showTreeTab) {
    // Tab bar — note that the "Graph" tab routes to v2, not the
    // legacy v1 graph. v1 is still reachable via the "v0" button
    // in v2's topbar; the standalone Graph tab button for v1 was
    // dropped because v2 supersedes it for the common case. We
    // mark the Graph tab active for BOTH currentView values
    // ('graph2' and 'tree') so the user always sees a visible
    // active tab while inside either graph; clicking it always
    // navigates back to v2 (so v0 is one click away on v2 and
    // the round trip back to v2 is also one click).
    const graphActive = state.currentView === 'graph2' || state.currentView === 'tree'
    html += '<div class="report-tabs">'
    html += `<button type="button" class="report-tab${state.currentView === 'findings' ? ' active' : ''}" data-view="findings">Findings</button>`
    html += `<button type="button" class="report-tab${graphActive ? ' active' : ''}" data-view="graph2">Graph</button>`
    html += `<button type="button" class="report-tab${state.currentView === 'files' ? ' active' : ''}" data-view="files">Files (${treeFileCount})</button>`
    html += '</div>'
  }

  if (state.currentView === 'tree') {
    // Pre-filter finding counts (total per file, by severity); plus the
    // transitive subtree rollup that drives both the "subtree findings"
    // chips in the sidebar AND the show-all filter (a file with no own
    // findings is still kept when its subtree has some).
    const findingCounts = computeFindingCountsByFile(mergedGroups)
    const transitiveCounts = computeTransitiveCounts(treeData, findingCounts)
    html += '<div class="tree-layout">'
    html += `<div class="tree-canvas">${renderTreeCanvas(treeData, findingCounts, transitiveCounts)}</div>`
    html += `<div class="tree-info">${renderTreeSidebarFull(tree.selected, treeData, findingCounts, transitiveCounts)}</div>`
    html += '</div>'
    report.innerHTML = html
    report.classList.add('active')
    dropZone.classList.add('hidden')
    document.title = `DeepView results — ${typeLabel || 'no analyzer'}`
    attachTreeGraphInteraction(report.querySelector('.tree-canvas'), refreshTreeSidebar)
    return
  }

  if (state.currentView === 'files') {
    const findingCounts = computeFindingCountsByFile(mergedGroups)
    html += renderTreeView(treeData, findingCounts)
    report.innerHTML = html
    report.classList.add('active')
    dropZone.classList.add('hidden')
    document.title = `DeepView results — ${typeLabel || 'no analyzer'}`
    return
  }

  if (state.currentView === 'graph2') {
    // Build the same filtered file set graph v1 would use (clean
    // files dropped when tree.showAll=off) so the two tabs stay in
    // sync — flipping showAll on graph v1 affects v2 as well.
    const data = buildGraph2Data()
    if (!data) {
      // Tree-bearing report disappeared between renders; the tab
      // switcher above will already have reset state.currentView,
      // but the early-out here is defensive.
      state.currentView = 'findings'
    } else {
      html += renderGraph2Layout(data.graph)
      report.innerHTML = html
      report.classList.add('active')
      dropZone.classList.add('hidden')
      document.title = `DeepView results — ${typeLabel || 'no analyzer'}`
      attachGraph2Interaction(report, data.graph, refreshGraph2Sidebar)
      return
    }
  }

  // Wrap the findings-only body in a max-width container so the
  // header + tabs above can span full width (giving the graph
  // tabs more room to breathe), while finding cards stay
  // readable at typewriter widths. The wrapper is left-aligned,
  // not centered: the page reads top-down with the dense tab
  // bar full-bleed and the finding list anchored against the
  // sidebar edge with empty space to the right at wide
  // viewports.
  html += '<div class="findings-content">'
  html += statsHtml(counts, colorCounts)
  html += toolbarHtml(filtered.length, allGroups.length, deletedCount, {
    showSource: hasAnyModulesPath,
    showConfidence: hasAnyConfidence,
    showPriority: hasAnyPriority,
    showRepoInput: repoInputUseful,
  })

  if (state.showDeleted && allGroups.length === 0) {
    html += `<p style="color:var(--muted); margin: 1rem 0;">Trash is empty.</p>`
  } else if (filtered.length === 0 && allGroups.length > 0) {
    html += `<p style="color:var(--muted); margin: 1rem 0;">No findings match the current filters.</p>`
  } else if (allGroups.length === 0) {
    html += `<p style="color:var(--green)">No ${esc(typeLabel)} issues found.</p>`
  }

  html += findingsBodyHtml(filtered)
  html += '</div>'

  report.innerHTML = html
  report.classList.add('active')
  dropZone.classList.add('hidden')
  document.title = `DeepView results — ${typeLabel || 'no analyzer'}`
}

// Re-render while preserving focus + caret position on a text input —
// used by the "Include" / "Exclude" / "Repo" inputs whose every
// keystroke triggers a render. Without this, focus would jump out of
// the box mid-typing because the input element gets recreated.
export function renderKeepFocus(inputId) {
  const prev = document.getElementById(inputId)
  const pos = prev ? prev.selectionStart : 0
  render()
  const el = document.getElementById(inputId)
  if (el) { el.focus(); el.setSelectionRange(pos, pos) }
}
