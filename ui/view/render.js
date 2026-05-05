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

// Build the analyzer-breakdown header line. One entry per unique
// `<analyzer> (<model>, <effort>, <exportsMode>)` combo seen across all
// findings. The parenthetical lists whichever modifiers are set on
// that combo, in the same order as the per-finding run-meta line so
// the title and the per-finding annotations read consistently. Source
// data comes from the run-meta lifted onto each finding at ingest, so
// a single load can contain several combos when the user merges
// multiple analyzer outputs. Model name is prettified the same way
// (provider prefix + `claude-` stripped, dashes → spaces).
function headerHtml(allGroupsLength, fileNames) {
  // Claude Security MD reports get their own title (no analyzer
  // breakdown — those reports don't carry model / effort metadata,
  // and "DeepView results, analyzers: security, performance, …" reads
  // as if multiple analyzer runs were merged when really they're just
  // per-finding category tags within one Claude Security report).
  // Only switches when EVERY loaded report is claude-security; mixing
  // a Claude Security MD with a JSON dump goes back to the regular
  // breakdown so the JSON's analyzer info doesn't get hidden.
  const allClaudeSecurity = state.reports.length > 0
    && state.reports.every((r) => r.source === 'claude-security')

  let headerText
  if (allClaudeSecurity) {
    headerText = 'Claude Security results'
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
  const statItems = [
    ['critical', counts.critical, '--critical'],
    ['high', counts.high, '--high'],
    ['medium', counts.medium, '--medium'],
    ['low', counts.low, '--low'],
  ]
  for (const [sev, count, color] of statItems) {
    if (!count) continue
    const active = state.filterSeverities.has(sev) ? ' active' : ''
    html += `<div class="stat${active}" data-sev="${sev}"><strong style="color:var(${color})">${count}</strong>${sev}</div>`
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
  const { showSource, showConfidence, showMetadataToggle, showRepoInput } = flags
  let html = '<div class="toolbar">'
  html += '<div class="toolbar-row">'
  html += `<label for="sort-select">Sort:</label>`
  html += `<select id="sort-select">`
  html += `<option value="file"${state.sortBy === 'file' ? ' selected' : ''}>By file</option>`
  html += `<option value="severity"${state.sortBy === 'severity' ? ' selected' : ''}>By severity</option>`
  html += `<option value="confidence-desc"${state.sortBy === 'confidence-desc' ? ' selected' : ''}>Confidence (high first)</option>`
  html += `<option value="confidence-asc"${state.sortBy === 'confidence-asc' ? ' selected' : ''}>Confidence (low first)</option>`
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
  // View mode switch — list (per-finding cards) or table (compact
  // 2-row blocks). Group-by-file only meaningfully applies to list
  // mode (table view is always flat by spec), so the checkbox is
  // omitted entirely in table mode rather than greyed-out — keeps
  // the toolbar honest about what's actually toggleable.
  html += `<label for="view-mode">View:</label>`
  html += `<select id="view-mode">`
  html += `<option value="list"${state.viewMode === 'list' ? ' selected' : ''}>List</option>`
  html += `<option value="table"${state.viewMode === 'table' ? ' selected' : ''}>Table</option>`
  html += `</select>`
  if (showMetadataToggle && state.viewMode === 'list') {
    html += `<label class="checkbox-label"><input type="checkbox" id="show-metadata"${state.showMetadata ? ' checked' : ''}> metadata</label>`
  }
  if (state.viewMode === 'list') {
    html += `<label class="checkbox-label"><input type="checkbox" id="group-by-file"${state.groupByFile ? ' checked' : ''}> group by file</label>`
  }
  const trashTitle = state.showDeleted ? 'exit trash view' : 'show deleted findings'
  const trashLabel = `Trash${deletedCount ? ` (${deletedCount})` : ''}`
  html += `<button type="button" id="toggle-trash" class="trash-btn${state.showDeleted ? ' active' : ''}" title="${trashTitle}">${trashLabel}</button>`
  html += `<button type="button" id="print-btn" class="trash-btn" title="print report (sets the document title to the filename / common prefix while printing)">Print</button>`
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
    // severity / confidence sorts.
    const items = state.sortBy === 'file'
      ? [...filtered].sort((a, b) => {
        const pa = primaryTab(a), pb = primaryTab(b)
        return pa.file.localeCompare(pb.file) || parseInt(pa.line) - parseInt(pb.line)
      })
      : filtered
    for (const g of items) html += renderTableRow(g)
    return html
  }
  if (state.groupByFile) {
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
    const lineHtml = `<span class="line-num">${lineLink(p.file, p.line, p.repo?.github)}</span>`
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
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
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
  const hasAnyModulesPath = mergedGroups.some((g) => g.some((f) => isModule(f.file)))
  const hasAnyHashMetadata = mergedGroups.some((g) => g.some((f) => f.fileHash || f.treeHash))
  // Repo URL input is useful only when at least one finding could
  // benefit from it: non-node_modules AND no per-finding repo.github.
  const repoInputUseful = mergedGroups.some((g) => g.some((f) => !f.repo?.github && !isModule(f.file)))
  // If a previously-loaded report had node_modules and the user
  // narrowed the source filter, switching to a report without any
  // node_modules paths would leave the filter at 'own' or 'modules'
  // and silently empty the list. resetFilters() runs only on isFirst
  // in ingest.js, so guard here too.
  if (!hasAnyModulesPath && state.filterSource !== 'all') state.filterSource = 'all'
  if (!hasAnyConfidence) { state.filterConfMin = ''; state.filterConfMax = '' }
  if (!hasAnyHashMetadata) state.showMetadata = false

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
  if (!showTreeTab && (state.currentView === 'tree' || state.currentView === 'files')) {
    state.currentView = 'findings'
  }
  if (showTreeTab) {
    html += '<div class="report-tabs">'
    html += `<button type="button" class="report-tab${state.currentView === 'findings' ? ' active' : ''}" data-view="findings">Findings</button>`
    html += `<button type="button" class="report-tab${state.currentView === 'tree' ? ' active' : ''}" data-view="tree">Graph</button>`
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
    report.classList.toggle('show-metadata', state.showMetadata)
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
    report.classList.toggle('show-metadata', state.showMetadata)
    dropZone.classList.add('hidden')
    document.title = `DeepView results — ${typeLabel || 'no analyzer'}`
    return
  }

  html += statsHtml(counts, colorCounts)
  html += toolbarHtml(filtered.length, allGroups.length, deletedCount, {
    showSource: hasAnyModulesPath,
    showConfidence: hasAnyConfidence,
    showMetadataToggle: hasAnyHashMetadata,
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

  report.innerHTML = html
  report.classList.add('active')
  report.classList.toggle('show-metadata', state.showMetadata)
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
