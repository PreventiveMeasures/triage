import { html, render as litRender, nothing } from 'lit'
import { state } from './state.js'
import { dropZone, report } from './dom.js'
import { prettyModel, fileLink, lineLink, isModule, SEVERITIES } from './format.js'
import { tabKey, primaryTab, activeTabFor, isGroupDeleted, groupKey } from './group.js'
import { applyFilters, applySorting } from './filters.js'
import { findingCardGid } from './render-finding.js'
import { computeFindingCountsByFile, computeTransitiveCounts } from './graph/utils.js'
import { renderTreeView } from './graph/files.js'
import { graph2 } from './graph2/state.js'
import { buildGraph } from './graph2/data.js'
import { listWorkspaces } from './workspaces.js'
import { renderGraph2Layout, renderSelectionCard, renderTopPkgsBlock, renderFocusOverlay } from './graph2/render.js'
import { attachGraph2Interaction } from './graph2/canvas.js'
import { fileHasFindings, packageOf } from './graph/utils.js'

// View-mode icons + titles + click handling all live in
// `<view-mode-buttons>` (see view/view-mode-buttons.js); the host
// passes the current `state.viewMode` and listens for
// `view-mode-change` events.

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
  area.innerHTML = ''
  litRender(renderSelectionCard(data.graph), area)
  // The top-right canvas overlay (drill-in icon button) depends
  // on the same selection / solo / focus state the selection
  // card does, so refresh both from the same trigger. Slot
  // element is rendered unconditionally by renderStage; we just
  // swap its content.
  const focusSlot = document.getElementById('g2-focus-overlay-slot')
  if (focusSlot) {
    focusSlot.innerHTML = ''
    litRender(renderFocusOverlay(data.graph), focusSlot)
  }
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
  block.innerHTML = ''
  litRender(renderTopPkgsBlock(data.graph), block)
}

// Source-specific header titles. Used when every loaded report shares
// the same `source` marker — those reports lack the analyzer
// (model / effort / exportsMode) metadata that the analyzer-combo
// breakdown builds from, so they get a fixed product name instead.
// DeepSec is Vercel's tool (https://github.com/vercel-labs/deepsec).
const SOURCE_TITLES = {
  'claude-security': 'Claude Security findings',
  'codex-security': 'Codex Security findings',
  'deepsec': 'DeepSec findings',
}

// Outline file glyph for the title's filename chip. Matches the icon
// used in the sidebar's file-list rows for visual continuity.
const HEADER_FILE_ICON = html`<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>`

// Build the repo-chip element for the page header. The actual visual
// (three modes — editable+collapsed, editable+expanded, read-only)
// lives in the `<repo-chip>` Lit component (see view/repo-chip.js);
// this function picks which props to set based on the load state:
//
//   * Workspace merge (`state.currentWorkspace`) — only the
//     read-only chip when every finding shares a `repo.github`;
//     the per-report URL is stamped on findings as
//     `_repoFallback` so the global `state.repoUrl` doesn't apply.
//   * Single report with `repoInputUseful` true — editable chip
//     fed by `state.repoUrl` / `state.repoEditing`.
//   * Single report with all per-finding `repo.github` known —
//     read-only chip showing the common slug.
//
// `repoInputUseful` is the existing flag computed in the main render
// path — true when at least one non-module finding lacks per-finding
// repo info, so user-typed `state.repoUrl` is needed to build links.
function repoChipTemplate(repoInputUseful, knownRepo) {
  if (state.currentWorkspace) {
    if (knownRepo) return html`<repo-chip url=${knownRepo}></repo-chip>`
    return nothing
  }
  if (repoInputUseful) {
    return html`<repo-chip url=${state.repoUrl} editable ?editing=${state.repoEditing}></repo-chip>`
  }
  if (knownRepo) return html`<repo-chip url=${knownRepo}></repo-chip>`
  return nothing
}

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
// findings`, `DeepSec findings`); otherwise it's `DeepView findings`,
// matching the prior single-vs-mixed selection rule.
function headerTemplate(totalCount, fileNames, repoInputUseful, knownRepo) {
  const sources = new Set(state.reports.map((r) => r.source))
  const singleSource = sources.size === 1 ? [...sources][0] : null
  // Workspace mode wins over the source-based title — the user
  // picked a named workspace, so the header should say so.
  // Falls through to the source / generic title when the workspace
  // can't be resolved (deleted between switch and render).
  const ws = state.currentWorkspace
    ? listWorkspaces().find((w) => w.id === state.currentWorkspace)
    : null
  const titleText = ws
    ? `Workspace: ${ws.name}`
    : (singleSource ? SOURCE_TITLES[singleSource] : 'DeepView findings')

  // File chip: single-file reports get the filename verbatim; merged
  // loads collapse to a count to keep the chip compact. The chip is
  // omitted entirely when no files are loaded (shouldn't happen at
  // this code path, but defensive).
  let fileChip = nothing
  if (fileNames.length === 1) {
    fileChip = html`<span class="file-chip">${HEADER_FILE_ICON}<span>${fileNames[0]}</span></span>`
  } else if (fileNames.length > 1) {
    fileChip = html`<span class="file-chip">${HEADER_FILE_ICON}<span>${fileNames.length} reports</span></span>`
  }

  const findings = state.reports.flatMap((r) => r.groups.flatMap((g) => g))

  // Count covers EVERY loaded finding (live + trashed) — the trashed
  // entries are still part of the report, just hidden from the active
  // list. The trash mode toggle button (in the toolbar) is the user's
  // signal that they're in the deleted view; the header stays steady
  // so the load total doesn't visually shift when the toggle flips.
  const findingNoun = `finding${totalCount !== 1 ? 's' : ''}`
  const countLabel = `${totalCount} ${findingNoun}`

  // Source-marked reports (claude-security, codex-security, deepsec)
  // carry per-finding `type` as a category, not an analyzer name, so
  // it's omitted from the header tags here — the title already
  // conveys the product (`Claude Security findings`, etc.). The
  // analyzer-prefix label only makes sense for the DeepView native
  // bucket and any mixed loads. Workspace mode also drops the
  // `analyzer:` tag — a merged view of multiple reports tends to
  // accumulate several combos and the prefix tag inflates the
  // header into a visually crowded strip.
  const dropAnalyzerType = singleSource || state.currentWorkspace
  const tagFields = dropAnalyzerType
    ? COMBO_FIELDS.filter((f) => f !== 'type')
    : COMBO_FIELDS
  const tags = buildAnalyzerTags(findings, tagFields)

  // Severity status bar — workspace-merged views show a stacked bar
  // sized proportionally to each severity's group count (using the
  // primary tab's severity, so each group contributes once and the
  // segments sum to totalCount). Gives a quick "how bad is this
  // workspace overall" signal without scanning the toolbar chips.
  let statusBarTpl = nothing
  if (state.currentWorkspace && totalCount > 0) {
    const sevCounts = {}
    for (const r of state.reports) {
      for (const g of r.groups) {
        const sev = primaryTab(g).severity
        if (sev) sevCounts[sev] = (sevCounts[sev] || 0) + 1
      }
    }
    const presentSevs = SEVERITIES.filter((s) => sevCounts[s] > 0)
    if (presentSevs.length > 0) {
      statusBarTpl = html`<span class="status-bar" aria-hidden="true">${presentSevs.map((s) => {
        const tip = `${sevCounts[s]} ${s.replace(/_/gu, ' ')}`
        return html`<span class=${`status-seg sev-${s}`} style=${`flex-grow: ${sevCounts[s]}`} title=${tip}></span>`
      })}</span>`
    }
  }

  const repoTpl = repoChipTemplate(repoInputUseful, knownRepo)
  const sep = html`<span class="sep" aria-hidden="true"></span>`

  return html`<header class="page-head">
    <div class="page-title">
      <h1>${titleText}${fileChip}</h1>
      <div class="meta-row">
        <span>${countLabel}</span>
        ${statusBarTpl}
        ${tags.length > 0 ? html`${sep}${tags.map((t) => html`<span class="tag">${t}</span>`)}` : nothing}
        ${repoTpl !== nothing ? html`${sep}${repoTpl}` : nothing}
      </div>
    </div>
  </header>`
}

// Stats — clickable filter chips. Severity chips on the left, mark-color
// chips on the right. Both are multi-select: empty selection = no
// filter; multiple selections = union across the ticked chips (so
// ticking every chip is equivalent to ticking none). A zero-count
// chip is hidden so the row stays compact.
// Severity-filter chips — ported from the DeepView.0 prototype's
// `.sev-chip` design. Each chip pairs a small color square (the
// severity's hue swatch) with the severity name and a count badge.
// Active chips pick up a 50%-alpha border and a 10%-alpha
// background tint of their own severity color, so the active state
// reads as "this severity is highlighted" without overpowering the
// chip's content. Hidden when count is zero — keeps the row tight
// for Claude / Codex / JSON dumps that don't carry every tier.
//
// Unlike the prototype the chips live inside the toolbar block (see
// `toolbarHtml`) rather than in their own outer row, and the
// "X shown / All / None" actions group is intentionally left off:
// the result count + filter-clearing affordances live elsewhere
// (the search row's `X of Y` and the per-chip toggle), so the
// extra summary just duplicates them.
// Severity / mark-color filter strips — these used to be string-
// concatenated blocks here that interpolated counts + active state.
// Both moved to Lit components (`<severity-chips>`,
// `<triage-filter>`) which take the data as JSON-encoded attributes
// and dispatch `severity-toggle` / `color-toggle` events; events.js
// has the matching handlers. The CSS still lives in toolbar.css
// (the components render to light DOM so those rules apply).
function severityChipsTemplate(counts) {
  return html`<severity-chips
    counts=${JSON.stringify(counts)}
    selected=${JSON.stringify([...state.filterSeverities])}
  ></severity-chips>`
}

function triageFilterTemplate(colorCounts) {
  return html`<triage-filter
    counts=${JSON.stringify(colorCounts)}
    selected=${JSON.stringify([...state.filterColors])}
  ></triage-filter>`
}

// `flags` carries per-render applicability: when no finding in the
// current report has confidence / a node_modules path / file or tree
// hash metadata, the corresponding control is omitted entirely (and
// the underlying filter state is forced to its no-op value upstream
// for confidence / source so it can't be left set from a previous
// report). Hides chrome the user can't act on usefully.
function toolbarTemplate(filteredCount, allCount, deletedCount, counts, colorCounts, flags) {
  const { showSource, showConfidence, showPriority } = flags
  const sortOpt = (value, label) => html`<option value=${value} ?selected=${state.sortBy === value}>${label}</option>`
  const sourceOpt = (value, label) => html`<option value=${value} ?selected=${state.filterSource === value}>${label}</option>`

  return html`<div class="toolbar">
    <div class="toolbar-row">
      <!-- View mode leads the row — <view-mode-buttons> renders the
           table / list / grouped icon group; immediately followed by
           the Sort dropdown with no separator between them. -->
      <view-mode-buttons mode=${state.viewMode}></view-mode-buttons>
      <!-- Sort dropdown — bare select (no Sort: label preceding it).
           The selected option's text already advertises what it sorts
           by, plus a ↓ / ↑ arrow showing direction. Class
           sort-select lets toolbar.css give the button a touch more
           padding than the generic toolbar select. -->
      <select id="sort-select" class="sort-select" aria-label="Sort findings">
        ${sortOpt('severity', 'Severity ↓')}
        ${sortOpt('file', 'File ↑')}
        ${showConfidence ? html`${sortOpt('confidence-desc', 'Confidence ↓')}${sortOpt('confidence-asc', 'Confidence ↑')}` : nothing}
        ${showPriority ? html`${sortOpt('priority-desc', 'Priority ↓')}${sortOpt('priority-asc', 'Priority ↑')}` : nothing}
      </select>
      ${showSource ? html`<div class="sep"></div>
        <label for="source-select">Source:</label>
        <select id="source-select">
          ${sourceOpt('all', 'All files')}
          ${sourceOpt('own', 'Own source')}
          ${sourceOpt('modules', 'node_modules')}
        </select>` : nothing}
      ${showConfidence ? html`<div class="sep"></div>
        <label for="conf-range">Confidence</label>
        <!-- Dual-thumb slider replaces the prior min / max select
             pair. Lower bound at 0 means "include findings without a
             confidence rating"; upper bound at 10 means "no upper cap
             (allow >10 outliers)" — both edges are how the user opts
             out of that half of the filter (see filters.js /
             matchesFilters). The conf-range-vals span mirrors the
             live value during drag (events.js patches its textContent
             on range-input); on release a range-change event triggers
             a full re-render and the span gets re-baked here. -->
        <range-slider
          id="conf-range" min="0" max="10" step="1"
          low=${state.filterConfMin}
          high=${state.filterConfMax}
          aria-label="Confidence range"></range-slider>
        <span id="conf-range-vals" class="conf-vals">${state.filterConfMin}–${state.filterConfMax}</span>` : nothing}
      ${(deletedCount > 0 || state.showDeleted) ? html`<button
        type="button"
        id="toggle-trash"
        class=${`trash-btn${state.showDeleted ? ' active' : ''}`}
        title=${state.showDeleted ? 'exit trash view' : 'show deleted findings'}
      >${`Trash${deletedCount ? ` (${deletedCount})` : ''}`}</button>` : nothing}
    </div>
    <!-- Filter row: severity chips + mark-color triage pill + search
         field, all inline so they read as one composable filter strip.
         The "X shown / All / None" actions block from the prototype's
         outer .sev-row is intentionally left off — the result count
         at the row's right edge and the per-chip toggle cover those
         needs. -->
    <div class="toolbar-row sev-row">
      ${severityChipsTemplate(counts)}
      ${triageFilterTemplate(colorCounts)}
      <!-- Search field + result count grouped into a single flex item
           so they wrap as a unit — when the row is too narrow to keep
           the strip inline, the search and the X of Y count move to a
           new line together rather than the count clinging to the
           right of the chips while the search drops below alone. See
           the .search-row rule in toolbar.css + the wrapping
           breakpoints under @media (max-width: 1200px) and
           .findings-content.with-details. -->
      <div class="search-row">
        <div class="toolbar-search">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/>
            <path d="m20 20-3.5-3.5"/>
          </svg>
          <input
            type="text"
            id="filter-search"
            .value=${state.filterInclude}
            placeholder="Search findings…">
        </div>
        <span class="result-count">${filteredCount} of ${allCount}</span>
      </div>
    </div>
  </div>`
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
  return inGroup
    ? html`<finding-card data-gid=${gid} in-group></finding-card>`
    : html`<finding-card data-gid=${gid}></finding-card>`
}

function findingsBodyTemplate(filtered) {
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
    if (items.length === 0) return nothing
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
    return html`<div class=${layoutClass}>
      <!-- Placeholder div — render() reattaches the persistent
           <finding-table> here after innerHTML lands. Keeping the
           table element across renders preserves its <finding-row>
           children (and StateElement-driven reactivity inside them),
           avoiding a full shadow-DOM rebuild on every state change. -->
      <div class="findings-table-list"><div class="finding-table-slot"></div></div>
      ${selectedGroup ? html`<aside class="findings-table-details" id="findings-table-details">
        <header class="findings-table-details-bar">
          <span class="findings-table-details-label">Details</span>
          <button type="button" class="findings-table-details-close" data-table-deselect title="Close details" aria-label="Close details">×</button>
        </header>
        <div class="findings-table-details-body">${findingCardPlaceholder(selectedGroup)}</div>
      </aside>` : nothing}
    </div>`
  }
  if (state.viewMode === 'grouped') {
    // Group groups by file. All tabs in a dedup group share the same
    // file (dedup runs per-file by fileHash upstream), so the primary
    // tab's file is a safe representative.
    const byFile = new Map()
    for (const g of filtered) {
      const file = primaryTab(g).file
      if (!byFile.has(file)) byFile.set(file, [])
      byFile.get(file).push(g)
    }
    // For file sort, sort files alphabetically; otherwise preserve
    // first-appearance order.
    const fileKeys = state.sortBy === 'file' ? [...byFile.keys()].sort() : [...byFile.keys()]
    return html`${fileKeys.map((file) => {
      const items = state.sortBy === 'file'
        ? byFile.get(file).sort((a, b) => parseInt(primaryTab(a).line) - parseInt(primaryTab(b).line))
        : byFile.get(file)
      // All findings under one file share the same `repo.github` (it's
      // a property of the source file's package), so probe the first
      // group's primary tab — every other tab in this file would carry
      // the same value or none at all. The per-report `_repoFallback`
      // is also a per-file property (every finding from one report
      // carries the same value), so the same probe gets its fallback.
      const probe = primaryTab(items[0])
      return html`<div class="file-group">
        <div class="file-header">
          <span>${fileLink(file, probe?.repo?.github, probe?._repoFallback)}</span>
          <span class="count">${items.length}</span>
        </div>
        <div class="file-body">${items.map((g) => findingCardPlaceholder(g))}</div>
      </div>`
    })}`
  }
  // Flat mode: each dedup group renders inside its own card
  // (.flat-group) with a small location header on top
  // (file · line · exportName). For the 'file' sort we extend that
  // ordering with line-within-file, which the file-grouped path
  // achieves by sorting per-file.
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
  return html`${items.map((g) => {
    const p = activeTabFor(g)
    const lineLinkTpl = lineLink(p.file, p.line, p.repo?.github, p._repoFallback)
    const meta = [p.type, prettyModel(p.model), p.effort, p.exportsMode].filter(Boolean).join(' · ')
    return html`<div class="flat-group">
      <div class="flat-group-loc">
        <span class="file">${fileLink(p.file, p.repo?.github, p._repoFallback)}</span>
        ${lineLinkTpl !== nothing ? html`<span class="line-num">${lineLinkTpl}</span>` : nothing}
        ${p.exportName ? html`<span class="meta">${p.exportName}</span>` : nothing}
        ${meta ? html`<span class="run-meta">${meta}</span>` : nothing}
      </div>
      ${findingCardPlaceholder(g, true)}
    </div>`
  })}`
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
  // The slider only makes sense when every loaded report has
  // confidence-bearing findings. A single-file load reduces to "any
  // finding has confidence" (one report → its own contribution
  // gates the slider). Workspace-merged views with mixed analyzers
  // (one analyzer-native report with confidence + one DeepSec /
  // Claude Security import without) still hide the slider, because
  // a min>0 would silently drop the no-confidence half — the gate
  // applies per-report so a single confidence-less report blocks
  // the whole workspace.
  const hasAnyConfidence = state.reports.length > 0
    && state.reports.every((r) => r.groups.some((g) => g.some((f) => f.confidence !== undefined)))
  const hasAnyPriority = mergedGroups.some((g) => g.some((f) => f.priority !== undefined))
  const hasAnyModulesPath = mergedGroups.some((g) => g.some((f) => isModule(f.file)))
  // Repo URL input is useful only when at least one finding could
  // benefit from it: non-node_modules AND no per-finding repo.github.
  const repoInputUseful = mergedGroups.some((g) => g.some((f) => !f.repo?.github && !isModule(f.file)))
  // Single common per-finding `repo.github` across every non-module
  // finding — drives the read-only repo chip in the header when the
  // user doesn't need to type anything. `null` for mixed-repo loads
  // (different findings carry different `repo.github`) so we don't
  // mislead by showing one of several.
  const perFindingRepos = new Set()
  for (const g of mergedGroups) for (const f of g) {
    if (!isModule(f.file) && f.repo?.github) perFindingRepos.add(f.repo.github)
  }
  const knownRepo = perFindingRepos.size === 1 ? [...perFindingRepos][0] : null
  // If a previously-loaded report had node_modules and the user
  // narrowed the source filter, switching to a report without any
  // node_modules paths would leave the filter at 'own' or 'modules'
  // and silently empty the list. resetFilters() runs only on isFirst
  // in ingest.js, so guard here too.
  if (!hasAnyModulesPath && state.filterSource !== 'all') state.filterSource = 'all'
  if (!hasAnyConfidence) {
    state.filterConfMin = 0; state.filterConfMax = 10
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

  // `headerTemplate` returns a Lit template — drop a slot in the
  // string-built HTML, then `litRender` into it after the
  // `report.innerHTML = html` flush at the bottom of this function.
  const headerTpl = headerTemplate(mergedGroups.length, fileNames, repoInputUseful, knownRepo)
  let html = '<div id="header-slot"></div>'

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
    // `renderTreeView` returns a Lit template now — drop a slot in
    // the string-built HTML, then litRender into it post-flush.
    html += '<div id="tree-view-slot"></div>'
    report.innerHTML = html
    const treeSlot = document.getElementById('tree-view-slot')
    if (treeSlot) litRender(renderTreeView(treeData, findingCounts), treeSlot)
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
      // Placeholder slot for the Lit-rendered graph2 layout; the
      // surrounding `html` string is still string-built (report
      // tabs, etc.), so we drop a slot here, do the innerHTML
      // assign, then `litRender` the layout into the slot.
      // `renderGraph2Layout` is a Lit template — its outer
      // `.graph2-layout` ends up as a child of the slot, which CSS
      // doesn't care about (the layout class targets descendants).
      html += '<div id="g2-layout-slot"></div>'
      report.innerHTML = html
      const slot = document.getElementById('g2-layout-slot')
      if (slot) litRender(renderGraph2Layout(data.graph), slot)
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
  // `toolbarTemplate` returns a Lit template — drop a slot here, then
  // litRender into it after innerHTML lands.
  html += '<div id="toolbar-slot"></div>'
  const toolbarTpl = toolbarTemplate(filtered.length, allGroups.length, deletedCount, counts, colorCounts, {
    showSource: hasAnyModulesPath,
    showConfidence: hasAnyConfidence,
    showPriority: hasAnyPriority,
  })

  // Empty-state line — slot-based so the typeLabel (which can carry
  // user-controlled analyzer-type strings) flows through Lit's
  // auto-escape rather than a hand-rolled `esc()`. Empty template
  // when none of the empty-state branches matches.
  let emptyStateTpl = nothing
  if (state.showDeleted && allGroups.length === 0) {
    emptyStateTpl = html`<p style="color:var(--muted); margin: 1rem 0;">Trash is empty.</p>`
  } else if (filtered.length === 0 && allGroups.length > 0) {
    emptyStateTpl = html`<p style="color:var(--muted); margin: 1rem 0;">No findings match the current filters.</p>`
  } else if (allGroups.length === 0) {
    emptyStateTpl = html`<p style="color:var(--green)">No ${typeLabel} issues found.</p>`
  }
  html += '<div id="empty-state-slot"></div>'

  pendingTableItems = null
  pendingFindingCards.clear()
  // `findingsBodyTemplate` returns a Lit template — drop a slot
  // here, then `litRender` into it after `report.innerHTML = html`.
  // The outer findings-content wrapper closes BEFORE the slot
  // because the slot wraps the body content the template expects to
  // sit inside it.
  html += '<div id="findings-body-slot"></div>'
  const bodyTemplate = findingsBodyTemplate(filtered)
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

  const headerSlot = document.getElementById('header-slot')
  if (headerSlot) litRender(headerTpl, headerSlot)
  const toolbarSlot = document.getElementById('toolbar-slot')
  if (toolbarSlot) litRender(toolbarTpl, toolbarSlot)
  const emptyStateSlot = document.getElementById('empty-state-slot')
  if (emptyStateSlot && emptyStateTpl !== nothing) litRender(emptyStateTpl, emptyStateSlot)

  // Now that the slots are in the DOM, litRender the Lit-templated
  // findings body into its placeholder. The body template covers
  // every viewMode (table / list / grouped); the table case still
  // emits a `.finding-table-slot` div inside the template, which
  // the `<finding-table>` reattach below targets.
  const bodySlot = document.getElementById('findings-body-slot')
  if (bodySlot && bodyTemplate !== nothing) litRender(bodyTemplate, bodySlot)

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
