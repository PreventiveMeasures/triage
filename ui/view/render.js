import { state } from './state.js'
import { dropZone, report } from './dom.js'
import { esc, prettyModel, fileLink, lineLink, isModule } from './format.js'
import { tabKey, primaryTab, activeTabFor, isGroupDeleted, groupKey } from './group.js'
import { applyFilters, applySorting } from './filters.js'
import { findingCardGid } from './render-finding.js'
import { computeFindingCountsByFile, computeTransitiveCounts } from './graph/utils.js'
import { renderTreeView } from './graph/files.js'
import { graph2 } from './graph2/state.js'
import { buildGraph } from './graph2/data.js'
import { renderGraph2Layout, renderSelectionCard, renderTopPkgsBlock, renderFocusOverlay } from './graph2/render.js'
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
//   - graph2.showAll then optionally pads the file set with clean
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
  // graph2.showAll still gates the clean-file filter inside that
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
    if (!graph2.showAll) {
      files = files.filter((f) => fileHasFindings(f, findingCounts, transitiveCounts))
    }
  } else {
    files = graph2.showAll
      ? allFiles
      : allFiles.filter((f) => fileHasFindings(f, findingCounts, transitiveCounts))
  }
  return { graph: buildGraph(treeData, files, findingCounts, transitiveCounts), findingCounts }
}

// Re-render only the right-panel selection card in the graph tab.
// Surgical innerHTML swap so the canvas DOM (and thus the active
// rAF / hover state) survives a click on a node or a sidebar
// neighbor link.
export function refreshGraph2Sidebar() {
  const area = document.getElementById('g2-selection-area')
  if (!area) return
  const data = buildGraph2Data()
  if (!data) return
  area.innerHTML = renderSelectionCard(data.graph)
  // The top-right canvas overlay (drill-in icon button) depends
  // on the same selection / solo / focus state the selection
  // card does, so refresh both from the same trigger. Slot
  // element is rendered unconditionally by renderStage; we just
  // swap its innerHTML.
  const focusSlot = document.getElementById('g2-focus-overlay-slot')
  if (focusSlot) focusSlot.innerHTML = renderFocusOverlay(data.graph)
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

// Source-specific header titles. Used when every loaded report shares
// the same `source` marker — those reports lack the analyzer
// (model / effort / exportsMode) metadata that the analyzer-combo
// breakdown builds from, so they get a fixed product name instead.
// `'deepseek'` is a legacy internal marker kept for OPFS / parser
// stability — the upstream product is Vercel's DeepSec
// (https://github.com/vercel-labs/deepsec).
const SOURCE_TITLES = {
  'claude-security': 'Claude Security findings',
  'codex-security': 'Codex Security findings',
  'deepseek': 'DeepSec findings',
}

// Outline file glyph for the title's filename chip. Matches the icon
// used in the sidebar's file-list rows for visual continuity.
const HEADER_FILE_ICON = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>'

// Canonical order for analyzer-combo fields. Each finding contributes
// one combo (a tuple of these four values lifted off the run-meta at
// ingest); multiple combos arise when the user merges several
// analyzer outputs into a single view.
const COMBO_FIELDS = ['type', 'model', 'effort', 'exportsMode']

// Format a single combo-field value as a tag-display string. The
// type field carries the `analyzer: ` label and always renders
// (even when null) so the slot is never silently dropped — `analyzer:
// null` reads as "this run had no analyzer subtype" the same way the
// DeepView.0 prototype's `<code>null</code>` did. Non-type fields
// return `null` from this function when the value is missing so the
// caller can drop them entirely; rendering a bare `null` for a
// missing model / effort / exports just clutters the header.
function formatComboField(field, value) {
  if (field === 'type') return `analyzer: ${value ?? 'null'}`
  if (value == null) return null
  return value
}

// Project the loaded findings into a list of meta-row tag strings. The
// fields aren't independent flags — they describe one analyzer run
// each — so a naive `Set` per field would drop the cross-field
// relationship. This routine instead:
//
//   1. Builds the list of unique combos across all findings, over
//      whichever subset of `COMBO_FIELDS` the caller requested.
//   2. Marks each field "common" when every combo agrees on its value
//      and "varying" otherwise.
//   3. Walks the slot order, emitting common fields as single-value
//      tags at their natural slot. The first time a varying slot is
//      hit, every combo is emitted as one tag joined by ` · ` over
//      the varying fields only — preserving the cross-field tuple
//      while hiding the common columns that would just repeat.
//
// `formatComboField` runs at every emission point: the type field
// gets the `analyzer: ` prefix, and missing non-type values are
// dropped. A combo whose entire varying-field projection is empty
// (after null filtering) is skipped entirely so a single all-empty
// combo doesn't render an empty tag.
//
// `fields` defaults to all four slots; pass a narrower list (e.g.
// without `type`) to suppress a slot — used for source-marked
// reports where the per-finding `type` is a category, not an
// analyzer name, and the title already conveys the product.
//
// Examples (combos as `type · model · effort · exportsMode`):
//   `null · opus 4.7 · max · list` + `null · gpt 5.5 · xhigh · list`
//     → `analyzer: null` `opus 4.7 · max` `gpt 5.5 · xhigh` `list`
//   `null · opus 4.7 · xhigh · isolate` + `null · opus 4.7 · max · list`
//     → `analyzer: null` `opus 4.7` `xhigh · isolate` `max · list`
//   `correctness · null · null · null`  →  `analyzer: correctness`
function buildAnalyzerTags(findings, fields = COMBO_FIELDS) {
  const comboMap = new Map()
  for (const f of findings) {
    const combo = {}
    for (const k of fields) {
      combo[k] = k === 'model' ? (prettyModel(f.model) ?? null) : (f[k] ?? null)
    }
    const key = fields.map((k) => combo[k] ?? '').join('|')
    if (!comboMap.has(key)) comboMap.set(key, combo)
  }
  const combos = [...comboMap.values()]
  if (combos.length === 0) return []

  const isCommon = {}
  for (const k of fields) {
    isCommon[k] = new Set(combos.map((c) => c[k])).size === 1
  }
  const varyingSlots = fields.filter((k) => !isCommon[k])

  const tags = []
  let combosEmitted = false
  for (const k of fields) {
    if (isCommon[k]) {
      const t = formatComboField(k, combos[0][k])
      if (t != null) tags.push(t)
    } else if (!combosEmitted) {
      for (const combo of combos) {
        const parts = varyingSlots
          .map((s) => formatComboField(s, combo[s]))
          .filter((p) => p != null)
        if (parts.length > 0) tags.push(parts.join(' · '))
      }
      combosEmitted = true
    }
  }
  return tags
}

// Page header — port of the prototype's `.page-head` block. The h1
// carries the tool name plus a pill-shaped file chip naming the
// active report; the meta-row underneath strings together the count
// followed by the analyzer-combo tags from `buildAnalyzerTags`.
//
// Tool name comes from the source marker when every loaded report
// agrees on one (`Claude Security findings`, `Codex Security
// findings`, `DeepSeek findings`); otherwise it's `DeepView findings`,
// matching the prior single-vs-mixed selection rule.
function headerHtml(totalCount, deletedCount, fileNames) {
  const sources = new Set(state.reports.map((r) => r.source))
  const singleSource = sources.size === 1 ? [...sources][0] : null
  const titleText = singleSource ? SOURCE_TITLES[singleSource] : 'DeepView findings'

  // File chip: single-file reports get the filename verbatim; merged
  // loads collapse to a count to keep the chip compact. The chip is
  // omitted entirely when no files are loaded (shouldn't happen at
  // this code path, but defensive).
  let fileChip = ''
  if (fileNames.length === 1) {
    fileChip = `<span class="file-chip">${HEADER_FILE_ICON}<span>${esc(fileNames[0])}</span></span>`
  } else if (fileNames.length > 1) {
    fileChip = `<span class="file-chip">${HEADER_FILE_ICON}<span>${fileNames.length} reports</span></span>`
  }

  const findings = state.reports.flatMap((r) => r.groups.flatMap((g) => g))

  // Header count covers EVERY loaded finding (live + trashed) — the
  // trashed entries are still part of the report, just hidden from
  // the active list, so a user merging reports with different
  // delete states wants the load total here. Trash view still shows
  // a trash-specific label so the user knows which subset they're
  // looking at.
  const findingNoun = `finding${totalCount !== 1 ? 's' : ''}`
  const countLabel = state.showDeleted
    ? `Trash: ${deletedCount} deleted finding${deletedCount !== 1 ? 's' : ''}`
    : `${totalCount} ${findingNoun}`

  // Source-marked reports (claude-security, codex-security, deepseek)
  // carry per-finding `type` as a category, not an analyzer name, so
  // it's omitted from the header tags here — the title already
  // conveys the product (`Claude Security findings`, etc.). The
  // analyzer-prefix label only makes sense for the DeepView native
  // bucket and any mixed loads.
  const tagFields = singleSource
    ? COMBO_FIELDS.filter((f) => f !== 'type')
    : COMBO_FIELDS
  const tags = buildAnalyzerTags(findings, tagFields)
  const tagHtml = tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')

  const sep = '<span class="sep" aria-hidden="true"></span>'
  const metaParts = [`<span>${esc(countLabel)}</span>`]
  if (tagHtml) metaParts.push(sep, tagHtml)

  let html = '<header class="page-head">'
  html += '<div class="page-title">'
  html += `<h1>${esc(titleText)}${fileChip}</h1>`
  html += `<div class="meta-row">${metaParts.join('')}</div>`
  html += '</div>'
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
// Set by findingsBodyHtml's table branch and consumed by render()
// after report.innerHTML lands; passes the sorted dedup-group list
// to the <finding-table> custom element via property assignment so
// item identity survives the trip.
let pendingTableItems = null

// Persistent <finding-table> instance, kept across render() calls so
// the row list (and its StateElement reactivity) survives the
// innerHTML reset. We detach this element BEFORE replacing
// report.innerHTML — the bare `.remove()` is enough to keep it alive
// in JS — and reinsert it into the new HTML's `.finding-table-slot`
// placeholder afterwards. Stays null until the first time the table
// view renders with non-empty items.
let persistentFindingTable = null

// gid → {group, inGroup} for each <finding-card> placeholder emitted
// during HTML build. After innerHTML lands, render() walks every
// `<finding-card>` and assigns `.group` (and reads in-group from the
// attribute set in HTML). Cleared at the top of each render.
const pendingFindingCards = new Map()

function findingCardPlaceholder(g, inGroup = false) {
  const gid = findingCardGid(g)
  pendingFindingCards.set(gid, { group: g, inGroup })
  return `<finding-card data-gid="${esc(gid)}"${inGroup ? ' in-group' : ''}></finding-card>`
}

function findingsBodyHtml(filtered) {
  let html = ''
  if (state.viewMode === 'table') {
    // Table view is always flat. For 'file' sort we still want
    // line-within-file ordering to match the file-grouped layout's
    // intra-file order; applySorting only handles file→line for
    // severity / confidence sorts. Rows are owned by the
    // <finding-table> Lit component (see view/finding-table.js); we
    // stash the sorted list in pendingTableItems so render() can
    // assign it as a property after innerHTML lands.
    const items = state.sortBy === 'file'
      ? [...filtered].sort((a, b) => {
        const pa = primaryTab(a), pb = primaryTab(b)
        return pa.file.localeCompare(pb.file) || parseInt(pa.line) - parseInt(pb.line)
      })
      : filtered
    if (items.length === 0) return html
    // Re-validate against the current filtered set so a stale gid
    // (filter or sort changed, showDeleted flipped) doesn't open the
    // details panel against a row no longer rendered.
    const selectedGroup = state.tableSelectedGid
      ? items.find((g) => groupKey(g) === state.tableSelectedGid)
      : null
    pendingTableItems = items
    // Two-column layout when a row is selected: list on the left
    // (3 fr, capped at 1200px), details panel on the right (2 fr,
    // capped at 800px). Collapses to single-column when no row is
    // selected.
    const layoutClass = selectedGroup ? 'findings-table-layout open' : 'findings-table-layout'
    html += `<div class="${layoutClass}">`
    // Placeholder div — render() reattaches the persistent
    // <finding-table> here after innerHTML lands. Keeping the table
    // element across renders preserves its <finding-row> children
    // (and StateElement-driven reactivity inside them), avoiding a
    // full shadow-DOM rebuild on every state change.
    html += '<div class="findings-table-list"><div class="finding-table-slot"></div></div>'
    if (selectedGroup) {
      html += '<aside class="findings-table-details" id="findings-table-details">'
      html += '<header class="findings-table-details-bar">'
      html += '<span class="findings-table-details-label">Details</span>'
      html += '<button type="button" class="findings-table-details-close" data-table-deselect title="Close details" aria-label="Close details">×</button>'
      html += '</header>'
      html += '<div class="findings-table-details-body">'
      html += findingCardPlaceholder(selectedGroup)
      html += '</div>'
      html += '</aside>'
    }
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
      for (const g of items) html += findingCardPlaceholder(g)
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
    html += findingCardPlaceholder(g, true)
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
    if (state.sortBy === 'confidence-desc' || state.sortBy === 'confidence-asc') state.sortBy = 'severity'
  }
  // Same guard for priority — the option drops out of the dropdown
  // when no finding carries it, so a stale state.sortBy would point
  // at a non-existent option and applySorting would shuffle on `?? -1`.
  if (!hasAnyPriority && (state.sortBy === 'priority-desc' || state.sortBy === 'priority-asc')) {
    state.sortBy = 'severity'
  }

  const filtered = applySorting(applyFilters(allGroups))

  let html = headerHtml(mergedGroups.length, deletedCount, fileNames)

  // Top-level view switcher. Tree tab only appears for tree-bearing
  // reports with >1 file — a single-file tree adds no navigation value.
  // Both Tree (graph + sidebar) and Files (per-file cards) tabs share
  // the same gate; switching files / loading a tree-less report falls
  // back to 'findings' so the user doesn't end up on a hidden tab.
  const treeData = state.reports[0]?.tree
  const treeFileCount = treeData ? Object.keys(treeData).length : 0
  const showTreeTab = treeFileCount > 1
  if (!showTreeTab && (state.currentView === 'files' || state.currentView === 'graph2')) {
    state.currentView = 'findings'
  }
  if (showTreeTab) {
    html += '<div class="report-tabs">'
    html += `<button type="button" class="report-tab${state.currentView === 'findings' ? ' active' : ''}" data-view="findings">Findings</button>`
    html += `<button type="button" class="report-tab${state.currentView === 'graph2' ? ' active' : ''}" data-view="graph2">Graph</button>`
    html += `<button type="button" class="report-tab${state.currentView === 'files' ? ' active' : ''}" data-view="files">Files (${treeFileCount})</button>`
    html += '</div>'
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
  //
  // When the table view has its details panel open, the wrapper
  // expands to accommodate both the 1200px list + the 800px
  // details panel side-by-side (max 2000px). The .with-details
  // modifier flips the cap; CSS handles the rest.
  const tableWithDetails =
    state.viewMode === 'table' &&
    state.tableSelectedGid &&
    filtered.some((g) => groupKey(g) === state.tableSelectedGid)
  html += `<div class="findings-content${tableWithDetails ? ' with-details' : ''}">`
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

  pendingTableItems = null
  pendingFindingCards.clear()
  html += findingsBodyHtml(filtered)
  html += '</div>'

  // Detach the persistent <finding-table> (if mounted) before the
  // innerHTML wipe so the element + its <finding-row> children
  // survive. `.remove()` fires disconnectedCallback on the subtree,
  // but the JS reference keeps everything alive; the reattach below
  // brings the same instances back into the document, where Lit's
  // diff happily reuses the existing children when items / selection
  // change.
  if (persistentFindingTable && persistentFindingTable.isConnected) {
    persistentFindingTable.remove()
  }

  report.innerHTML = html

  // Hand the sorted item list and current selection to the
  // <finding-table> custom element after the DOM lands. Stashing the
  // items via a property (rather than serialising through an
  // attribute) keeps object identity and avoids a JSON round-trip on
  // every re-render.
  if (pendingTableItems) {
    const slot = report.querySelector('.finding-table-slot')
    if (slot) {
      if (!persistentFindingTable) {
        persistentFindingTable = document.createElement('finding-table')
      }
      persistentFindingTable.items = pendingTableItems
      persistentFindingTable.selectedGid = state.tableSelectedGid
      slot.replaceWith(persistentFindingTable)
    }
  }
  // Pair each <finding-card> with its dedup group via the gid stamped
  // on the placeholder. The component itself can't know which group
  // it represents from HTML attributes alone (group is a structured
  // object, not a string), so render.js wires it up by gid lookup
  // here. `in-group` is already set as an attribute, so the
  // component's reflective `inGroup` boolean comes from the HTML.
  if (pendingFindingCards.size > 0) {
    for (const card of report.querySelectorAll('finding-card')) {
      const entry = pendingFindingCards.get(card.dataset.gid)
      if (entry) card.group = entry.group
    }
  }
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
