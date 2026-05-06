import { SEVERITIES, esc } from '../format.js'
import { state } from '../state.js'
import { graph2 } from './state.js'
import { tree } from '../graph/state.js'
import { pkgColor } from '../graph/utils.js'
import { isGroupDeleted } from '../group.js'

const SEV_COLORS = {
  critical: '#ff5470',
  high: '#ff9d4a',
  medium: '#f4d35e',
  low: '#67c2ff',
}

// Build the entire v2 layout HTML in one pass. Three columns —
// left panel (palette / stats / issues / display / options), stage
// (canvas + corner readouts + zoom controls + tooltip), right
// panel (selection + top groups). The stage canvas needs
// real dimensions before its layout can run, so all ancestor
// elements ship with a flex / grid sizing rule that's set by CSS
// (.graph2-layout / .graph2-stage). attachGraph2Interaction wires
// up everything below.
//
// Tab-state inputs:
//   graph     — buildGraph(...) result; nodes/edges/packages/etc.
//   ownCounts — file → severity-count map; drives the "Top groups"
//               distribution and the per-package issue counts
export function renderGraph2Layout(graph) {
  let html = '<div class="graph2-layout">'
  html += renderTopBar(graph)
  html += renderStage(graph)
  html += renderRightPanel(graph)
  html += '</div>'
  return html
}

function renderTopBar(graph) {
  let html = '<div class="graph2-topbar">'
  // Severity highlight pills — same tier set as the findings
  // tab (critical, high, medium, low, high_bug, bug,
  // informational from format.js's SEVERITIES). Skip tiers
  // with zero count UNLESS that tier is currently in the
  // selected set, so the user can always click an active pill
  // to deselect it even if the dataset has stopped containing
  // that severity. Empty selectedSeverities = no canvas dimming.
  // Lives at the left edge of the topbar (before All files)
  // since it's the most-frequently-used control.
  const issueCounts = {}
  for (const sev of SEVERITIES) issueCounts[sev] = 0
  for (const n of graph.nodes) if (n.issue && issueCounts[n.issue] !== undefined) issueCounts[n.issue]++
  const hasAnyVisible = SEVERITIES.some((sev) => issueCounts[sev] > 0 || graph2.selectedSeverities.has(sev))
  if (hasAnyVisible) {
    html += '<div class="g2-sev-filters">'
    for (const sev of SEVERITIES) {
      const count = issueCounts[sev]
      const isSelected = graph2.selectedSeverities.has(sev)
      if (count === 0 && !isSelected) continue
      const on = isSelected ? ' on' : ''
      const label = sev.replace(/_/gu, ' ')
      html += `<button type="button" class="g2-sev-pill${on}" data-g2-sev="${sev}" style="--sev:${SEV_COLORS[sev]}" aria-pressed="${isSelected}">`
      html += '<span class="g2-sev-mark"></span>'
      html += `<span class="g2-sev-pill-label">${esc(label)}</span>`
      html += `<span class="g2-sev-pill-count">${count}</span>`
      html += '</button>'
    }
    html += '</div>'
  }
  // Path / package substring filter — case-insensitive match
  // against each node's file path AND its package name. Same
  // soft-dim treatment as the severity / solo filters: non-
  // matching nodes drop to 0.1 opacity, no hard hide.
  //
  // Clear button is always rendered, hidden via CSS when the
  // input is empty (using :placeholder-shown sibling). Doing
  // it that way keeps the button live across user typing
  // without needing to re-render the topbar on every keystroke
  // — the canvas redraws on input but the chrome doesn't.
  html += '<div class="g2-path-filter-wrap">'
  html += `<input type="text" class="g2-path-filter" id="g2-path-filter" placeholder="filter path/package…" value="${esc(graph2.pathFilter)}">`
  html += '<button type="button" class="g2-path-filter-clear" id="g2-path-filter-clear" title="Clear filter" aria-label="Clear filter">✕</button>'
  html += '</div>'
  // "All files" controls the FILE SET, not just rendering —
  // flipping it rebuilds the graph (different nodes, different
  // edges, different layout). Reads / writes tree.showAll
  // (shared with graph v1 so the two tabs stay consistent on
  // the same dataset). Defaults to off → only files with own
  // or subtree findings are kept.
  html += `<button type="button" class="g2-topbar-toggle${tree.showAll ? ' on' : ''}" data-g2-show-all aria-pressed="${tree.showAll}">`
  html += '<span>All files</span><span class="g2-switch"></span>'
  html += '</button>'
  // Trash toggle — same role as the findings tab's trash button.
  // Visible when there are deleted findings to show OR when the
  // user is already in trash view (so they can exit without
  // first un-deleting). Toggling flips state.showDeleted (shared
  // with findings) and rebuilds the graph data: the file set,
  // statistics, and per-package issue counts all switch to the
  // deleted-only view. This is a data-level filter, not a
  // visual overlay.
  const allGroups = state.reports.flatMap((r) => r.groups)
  const deletedCount = allGroups.reduce((n, g) => n + (isGroupDeleted(g) ? 1 : 0), 0)
  if (deletedCount > 0 || state.showDeleted) {
    const trashTitle = state.showDeleted ? 'exit trash view' : 'show deleted findings'
    const trashLabel = `Trash${deletedCount ? ` (${deletedCount})` : ''}`
    html += `<button type="button" class="g2-topbar-toggle g2-trash-btn${state.showDeleted ? ' on' : ''}" id="g2-toggle-trash" title="${trashTitle}" aria-pressed="${state.showDeleted}">`
    html += `<span>${esc(trashLabel)}</span>`
    html += '</button>'
  }
  html += '<div class="g2-spacer"></div>'
  // v0 button — fall back to graph v1's force-directed canvas
  // for users who still prefer the old presentation. Sits to
  // the left of fullscreen so it reads as part of the chrome
  // controls. The Graph tab itself is shared between v1 and
  // v2 (active when currentView is either), so coming back to
  // v2 from v1 is just clicking Graph again.
  html += '<button type="button" class="g2-icon-btn g2-v0-btn" id="g2-v0-btn" title="Old graph (v0)">v0</button>'
  // Fullscreen — same affordance as graph v1's toolbar button.
  // Toggles `body.report-fullscreen`, which hides the sidebar /
  // header / page padding and lets the layout grow to the viewport.
  // Esc handler in ingest.js exits fullscreen for both tabs. The
  // fit-to-view affordance lives on the floating zoom control over
  // the canvas (⟲ in the bottom-left stack), not duplicated here.
  html += '<button type="button" class="g2-icon-btn" id="g2-fullscreen" title="Toggle fullscreen">⛶</button>'
  html += '</div>'
  return html
}

// Controls that previously lived in the left panel — display
// sliders + visual toggles. Returned as inner HTML (no
// wrapping <aside>) so renderRightPanel can append them after
// the Selection / Top-packages blocks.
//
// The "Packages" color grid + search box used to live here too;
// dropped because the topbar's path/package filter covers the
// search use case (with soft-dim instead of palette muting),
// and the Top packages block in the right panel above already
// shows package colors next to names — clicking a row solos
// the package, same as the swatches did.
function renderControls(graph) {
  let html = ''

  // (Statistics block moved to the canvas overlay — see
  // renderStage's top-left readout. Lives there now so the
  // control panel stays focused on filters / display tweaks.)


  // (Severity filter pills moved to the topbar; the standalone
  // "Show only issues" toggle is gone — selecting all four
  // severities up there gives the same visual.)

  // Display — sliders for the visual knobs that take a
  // numeric value, then toggles for the booleans. Wrapped in a
  // collapsible section so the panel doesn't carry six rows
  // of always-visible controls (most users don't tweak edge
  // opacity / node size every visit). Header acts as the toggle
  // button; the body is hidden via CSS when .collapsed is on
  // its parent.
  const isCollapsed = graph2.displayCollapsed
  html += `<section class="g2-collapsible${isCollapsed ? ' collapsed' : ''}">`
  html += '<button type="button" class="g2-collapsible-header" data-g2-toggle-section="display" aria-expanded="' + (!isCollapsed) + '">'
  html += '<span>Display</span>'
  html += '<span class="g2-collapsible-chevron">▸</span>'
  html += '</button>'
  html += '<div class="g2-collapsible-body">'
  html += sliderRow('edge-op', 'Edge opacity', graph2.edgeOpacity.toFixed(2), 0, 100, Math.round(graph2.edgeOpacity * 100))
  html += sliderRow('node-size', 'Node size', graph2.nodeSize.toFixed(1) + '×', 40, 220, Math.round(graph2.nodeSize * 100))
  html += toggleRow('labels', 'Labels (zoom > 140%)', graph2.showLabels)
  html += '</div></section>'
  return html
}

function sliderRow(id, label, valueLabel, min, max, value) {
  return '<div class="g2-filter-row">'
    + `<div class="g2-filter-label"><span>${label}</span><span class="v" id="g2-lbl-${id}">${valueLabel}</span></div>`
    + `<input type="range" id="g2-r-${id}" min="${min}" max="${max}" value="${value}">`
    + '</div>'
}

function toggleRow(key, label, on) {
  return `<button type="button" class="g2-toggle-row${on ? ' on' : ''}" data-g2-toggle="${key}">`
    + `<span>${label}</span><span class="g2-switch"></span>`
    + '</button>'
}

// Compute a path relative to a directory. Both inputs are
// forward-slash separated; the result starts with `./` for
// same-dir or `../` for an ancestor. No trailing slash on the
// reference dir is assumed; we strip empties before walking.
function relativePath(fromDir, toFile) {
  const fromParts = fromDir.split('/').filter(Boolean)
  const toParts = toFile.split('/').filter(Boolean)
  let common = 0
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++
  }
  const ups = fromParts.length - common
  const down = toParts.slice(common).join('/')
  if (ups === 0) return './' + down
  return '../'.repeat(ups) + down
}

// Pick the shorter representation between absolute and
// relative-to-referenceDir. Used in the import lists so a
// sibling file shows up as `./Logo.js` instead of
// `src/components/Logo.js`, but a deep cross-tree import
// still shows its full path when relative would only add
// `../` segments.
function shorterPath(file, referenceDir) {
  if (!referenceDir && referenceDir !== '') return file
  const rel = relativePath(referenceDir, file)
  return rel.length < file.length ? rel : file
}

// File-link list — shared between file card's Imported by /
// Imports sections and the package card's Imported by section.
// Each row is clickable, routes through data-g2-select to the
// existing file-selection handler. The list itself becomes a
// scroll container past 5 visible rows so the section doesn't
// dominate the right panel on hub-y files. Each row gets a
// little package-color dot so cross-package importers read
// instantly without parsing the path prefix.
//
// referenceDir (optional): when present, paths shorter than
// the absolute form get displayed as `./...` / `../...`
// relative to it. Title attribute always carries the full
// absolute path so hovering reveals the canonical location
// regardless of how the visible text reads.
function renderFileList(graph, label, files, referenceDir) {
  const count = files.length
  let html = `<div class="g2-sel-section"><div class="g2-sel-section-label">${label} (${count})</div>`
  if (count === 0) {
    html += '<div class="g2-sel-section-empty">none</div>'
  } else {
    // Sort by the displayed string so the list reads in the
    // order it visually shows. Computing display once per file
    // (vs. inside the comparator) keeps it O(n + n log n)
    // rather than recomputing relativePath on every compare.
    const items = files.map((f) => ({ file: f, display: shorterPath(f, referenceDir) }))
    items.sort((a, b) => a.display.localeCompare(b.display))
    html += '<ul class="g2-sel-file-list">'
    for (const { file: f, display } of items) {
      const node = graph.nodeByFile.get(f)
      const c = node ? pkgColor(node.pkg) : '#666'
      html += `<li><button type="button" class="g2-sel-file-link" data-g2-select="${esc(f)}" title="${esc(f)}">`
      html += `<span class="g2-sel-file-dot" style="background:${c}"></span>`
      html += `<span class="g2-sel-file-path">${esc(display)}</span>`
      html += '</button></li>'
    }
    html += '</ul>'
  }
  html += '</div>'
  return html
}

// Severity-count chip block — used by the selection card's
// Own / Subtree finding sections AND by the canvas tooltip.
// Reuses graph v1's `.tree-count-chip` palette (already defined
// global in styles/graph.css), so the chips look identical in
// both graph tabs. Returns "none" placeholder when the counts
// object is null or all-zero, matching v1's "none"-on-empty.
export function renderSevChips(counts) {
  if (!counts) return '<div class="g2-sel-section-empty">none</div>'
  const tiers = ['critical', 'high', 'medium', 'low', 'high_bug', 'bug', 'informational']
  const present = tiers.filter((s) => (counts[s] ?? 0) > 0)
  if (present.length === 0) return '<div class="g2-sel-section-empty">none</div>'
  return '<div class="tree-count-chips">'
    + present.map((s) => `<span class="tree-count-chip ${s}">${counts[s]} ${s.replace(/_/gu, ' ')}</span>`).join('')
    + '</div>'
}

function renderStage(graph) {
  let html = '<main class="graph2-stage">'
  html += '<canvas id="g2-canvas"></canvas>'
  // Top-left overlay — back button only (in package-focus
  // mode). Stats moved to the bottom-left where they don't
  // compete with the focused subgraph for attention; only
  // shown here when there's something to render (the back
  // button), so the corner is empty in normal mode.
  if (graph2.focusedPkg) {
    html += '<div class="g2-stage-overlay">'
    const label = graph2.focusedPkg === '__own__' ? 'own source' : graph2.focusedPkg
    html += `<button type="button" class="g2-back-btn" id="g2-back-to-full" title="Back to the full graph">← ${esc(label)}</button>`
    html += '</div>'
  }
  // Bottom-left stats — file/package/edge/hub/issue counts.
  // The earlier "X of Y visible" readout is gone: every node
  // stays on screen now (filters / solo soft-dim instead of
  // hiding), so visibleCount always equaled total.
  let cross = 0; for (const e of graph.edges) if (e.cross) cross++
  const intra = graph.edges.length - cross
  let issues = 0; for (const n of graph.nodes) issues += n.totalIssues
  const avgDeg = graph.nodes.length === 0 ? '0.0' : (graph.edges.length * 2 / graph.nodes.length).toFixed(1)
  html += '<div class="g2-stage-stats">'
  html += `<span><b>${graph.nodes.length}</b> files</span>`
  html += `<span><b>${graph.packages.length}</b> packages</span>`
  html += `<span><b>${graph.edges.length}</b> edges (${intra} intra · ${cross} cross)</span>`
  html += `<span><b>${issues}</b> issues</span>`
  html += `<span>avg degree <b>${avgDeg}</b></span>`
  html += '</div>'
  // Bottom-right: zoom controls.
  html += '<div class="g2-zoom-ctrl">'
  html += '<button id="g2-zoom-in" title="Zoom in">+</button>'
  html += '<div class="g2-zoom-pct" id="g2-zoom-pct">100%</div>'
  html += '<button id="g2-zoom-out" title="Zoom out">−</button>'
  html += '<button id="g2-zoom-fit" class="g2-zoom-fit-btn" title="Fit to view">fit</button>'
  html += '</div>'
  html += '<div class="g2-tooltip" id="g2-tooltip"></div>'
  html += '</main>'
  return html
}

function renderRightPanel(graph) {
  let html = '<aside class="graph2-right">'
  html += '<div class="g2-panel-title">Selection</div>'
  html += '<div id="g2-selection-area">'
  html += renderSelectionCard(graph)
  html += '</div>'
  html += '<div id="g2-top-pkgs-block">'
  html += renderTopPkgsBlock(graph)
  html += '</div>'
  // Migrated from the old left panel — palette / stats / issues
  // / display / options. Lives at the bottom of the right panel
  // and shares its scroll. Trade-off: less "always visible"
  // chrome, more horizontal canvas room.
  html += renderControls(graph)
  html += '</aside>'
  return html
}

// Top-packages section — exported so events.js can re-render it
// in place when the user flips the Issues/Files tab without
// rebuilding the whole canvas. Returns the title row + dist bar
// + dist list as HTML; the caller wraps this in #g2-top-pkgs-block.
export function renderTopPkgsBlock(graph) {
  const tab = graph2.topPkgsTab
  let html = '<div class="g2-panel-title g2-panel-title-row">'
  html += '<span>Top packages</span>'
  html += '<div class="g2-mini-tabs">'
  html += `<button type="button" class="g2-mini-tab${tab === 'issues' ? ' on' : ''}" data-g2-top-pkgs="issues">Issues</button>`
  html += `<button type="button" class="g2-mini-tab${tab === 'files' ? ' on' : ''}" data-g2-top-pkgs="files">Files</button>`
  html += '</div>'
  html += '</div>'
  html += renderDistribution(graph)
  return html
}

// Selection card — extracted so it can be re-rendered in place when
// the user clicks a node, without rebuilding the whole canvas (which
// would drop hover state).
//
// Three states, in priority order:
//   1. A file is selected (canvas click) → file card
//   2. A package is solo'd (palette swatch or top-pkgs click) → pkg card
//   3. Neither → empty placeholder
export function renderSelectionCard(graph) {
  const file = graph2.selected
  if (file) {
    const n = graph.nodeByFile.get(file)
    if (n) return renderFileCard(graph, n, file)
    return '<div class="g2-empty-state"><strong>File not in current view</strong>Adjust filters or pick another file.</div>'
  }
  if (graph2.solo) {
    return renderPackageCard(graph, graph2.solo)
  }
  return '<div class="g2-empty-state">'
    + 'Click a node or a package row to inspect.'
    + '</div>'
}

function renderFileCard(graph, n, file) {
  const col = pkgColor(n.pkg)
  const pkgLabel = n.pkg === '__own__' ? 'own source' : n.pkg

  let html = ''
  html += '<div class="g2-selection-card">'
  html += '<div class="g2-sel-head">'
  html += `<span class="g2-sel-dot" style="--dot:${col}; background:${col}"></span>`
  html += `<span class="g2-sel-id">${esc(n.label)}</span>`
  html += `<span class="g2-sel-grp">${esc(pkgLabel)}</span>`
  html += '</div>'
  html += '<div class="g2-sel-body">'
  html += `<div class="g2-sel-row"><span class="k">Path</span><span class="v" title="${esc(file)}">${esc(file)}</span></div>`
  html += '</div>'
  // Own + subtree finding chips — same chrome as graph v1's
  // sidebar (.tree-info-section / .tree-count-chip), so the
  // visual reads consistently across the two graph tabs. The
  // single-severity Status row + issue-text bar that lived
  // here previously duplicated the data without showing the
  // breakdown — chips are strictly more informative.
  html += `<div class="g2-sel-section"><div class="g2-sel-section-label">Own findings</div>${renderSevChips(n.own)}</div>`
  html += `<div class="g2-sel-section"><div class="g2-sel-section-label">Subtree findings</div>${renderSevChips(n.subtree)}</div>`
  // Quick jumps over to the existing tabs — same data, different
  // presentation. Findings filters get cleared first so the user
  // doesn't land on an empty list because of a stale exclude.
  html += '<div class="g2-sel-jumps">'
  if (n.totalIssues > 0) html += `<button type="button" class="g2-sel-jump" data-g2-jump-findings="${esc(file)}">Findings →</button>`
  html += `<button type="button" class="g2-sel-jump" data-g2-jump-file="${esc(file)}">Files →</button>`
  // Package-graph drill-in — narrows the canvas to this file's
  // package, with v1-style rendering (single hue, arrowheads,
  // file labels). Hidden when only one file is in the package
  // (nothing to visualize), and when already focused on it.
  const pkgSize = graph.pkgCount.get(n.pkg) ?? 0
  if (pkgSize > 1 && graph2.focusedPkg !== n.pkg) {
    html += `<button type="button" class="g2-sel-jump" data-g2-focus-pkg="${esc(n.pkg)}">Package graph →</button>`
  }
  html += '</div>'
  // Directional import lists. Imported by = files that point
  // AT this one; Imports = files this one points at. The
  // earlier "Top neighbors" combined both directions and lost
  // that information, which made the section less useful for
  // tracing what depends on what. Each list scrolls past 5
  // entries via CSS. Paths are displayed relative to the
  // selected file's directory when that's shorter than the
  // absolute form.
  const importers = graph.importedBy.get(file) ?? []
  const imports = graph.importsOf.get(file) ?? []
  const lastSlash = file.lastIndexOf('/')
  const referenceDir = lastSlash >= 0 ? file.slice(0, lastSlash) : ''
  html += renderFileList(graph, 'Imported by', importers, referenceDir)
  html += renderFileList(graph, 'Imports', imports, referenceDir)
  html += '</div>'
  return html
}

// Package selection card — shown when a package is solo'd via
// the palette swatch or Top packages list (and no file is
// selected). Aggregates per-file stats up to package level:
// total file / hub counts, intra vs cross edges, summed own
// findings broken down by severity, and a "Package graph →"
// drill-in for the v1-style subview.
function renderPackageCard(graph, pkg) {
  const filesInPkg = graph.nodes.filter((n) => n.pkg === pkg)
  const fileCount = filesInPkg.length
  if (fileCount === 0) {
    // The solo'd package has nothing visible — typically because
    // the user toggled show-all off and every file in that
    // package was clean. Offer a way out via the empty state.
    return '<div class="g2-empty-state">'
      + '<strong>Package has no files in view</strong>'
      + 'Toggle "All files" to widen the file set, or pick another package.'
      + '</div>'
  }
  const col = pkgColor(pkg)
  const pkgLabel = pkg === '__own__' ? 'own source' : pkg

  // Aggregate per-severity own counts across the package's files.
  const ownAgg = {}
  for (const sev of SEVERITIES) ownAgg[sev] = 0
  for (const n of filesInPkg) {
    if (!n.own) continue
    for (const sev of SEVERITIES) ownAgg[sev] += n.own[sev] ?? 0
  }
  // Edge stats: intra = both endpoints in this pkg, cross = one
  // endpoint here + the other elsewhere. Walk edges once.
  let intraEdges = 0, crossEdges = 0
  for (const e of graph.edges) {
    const a = graph.nodeByFile.get(e.a)
    const b = graph.nodeByFile.get(e.b)
    if (!a || !b) continue
    if (a.pkg === pkg && b.pkg === pkg) intraEdges++
    else if (a.pkg === pkg || b.pkg === pkg) crossEdges++
  }
  let hubs = 0
  for (const n of filesInPkg) if (n.isHub) hubs++

  let html = '<div class="g2-selection-card">'
  html += '<div class="g2-sel-head">'
  html += `<span class="g2-sel-dot" style="--dot:${col}; background:${col}"></span>`
  html += `<span class="g2-sel-id">${esc(pkgLabel)}</span>`
  html += '<span class="g2-sel-grp">package</span>'
  html += '</div>'
  html += '<div class="g2-sel-body">'
  html += `<div class="g2-sel-row"><span class="k">Files</span><span class="v">${fileCount}</span></div>`
  html += `<div class="g2-sel-row"><span class="k">Hubs</span><span class="v">${hubs}</span></div>`
  html += `<div class="g2-sel-row"><span class="k">Intra edges</span><span class="v">${intraEdges}</span></div>`
  html += `<div class="g2-sel-row"><span class="k">Cross edges</span><span class="v">${crossEdges}</span></div>`
  html += '</div>'
  html += `<div class="g2-sel-section"><div class="g2-sel-section-label">Findings</div>${renderSevChips(ownAgg)}</div>`
  // Drill-in — same affordance as the file card. Hidden when
  // only one file is in the package (nothing to visualize) and
  // when already focused on it.
  if (fileCount > 1 && graph2.focusedPkg !== pkg) {
    html += '<div class="g2-sel-jumps">'
    html += `<button type="button" class="g2-sel-jump" data-g2-focus-pkg="${esc(pkg)}">Package graph →</button>`
    html += '</div>'
  }
  // Imported by — every file from a different package that
  // points at any file in this package. Dedup via Set since a
  // single importer file may point at multiple files in the
  // package; we want to list each importer once. Same scrollable
  // list rendering the file card uses.
  const importerSet = new Set()
  for (const n of filesInPkg) {
    for (const f of (graph.importedBy.get(n.file) ?? [])) {
      const importerNode = graph.nodeByFile.get(f)
      if (importerNode && importerNode.pkg !== pkg) importerSet.add(f)
    }
  }
  html += renderFileList(graph, 'Imported by', [...importerSet])
  html += '</div>'
  return html
}

function renderDistribution(graph) {
  const totalFiles = graph.nodes.length || 1
  const tab = graph2.topPkgsTab
  // Aggregate own-issue counts per package. When the topbar's
  // severity filter has 1+ tiers selected, count only those
  // tiers — same scope the canvas highlights — so the Issues
  // tab here reflects what the user is currently looking at.
  // Empty selection = count every tier (default).
  const sevFilter = graph2.selectedSeverities
  const useFilter = sevFilter.size > 0
  const issueByPkg = new Map()
  let totalIssues = 0
  for (const n of graph.nodes) {
    let count
    if (useFilter) {
      count = 0
      if (n.own) for (const sev of sevFilter) count += n.own[sev] ?? 0
    } else {
      count = n.totalIssues
    }
    issueByPkg.set(n.pkg, (issueByPkg.get(n.pkg) ?? 0) + count)
    totalIssues += count
  }
  // The dist BAR follows the active tab so the segment widths
  // line up with the percentages in the list rows below. On
  // Files: width = pkg's file share. On Issues (with the
  // severity filter applied if any): width = pkg's share of
  // the visible issue total. Packages with 0 in the chosen
  // axis collapse to zero-width segments.
  let html = '<div class="g2-dist-bar">'
  for (const pkg of graph.packages) {
    const c = pkgColor(pkg)
    let w
    if (tab === 'issues') {
      w = totalIssues > 0
        ? ((issueByPkg.get(pkg) ?? 0) / totalIssues * 100).toFixed(2)
        : '0'
    } else {
      w = (graph.pkgCount.get(pkg) / totalFiles * 100).toFixed(2)
    }
    html += `<span style="background:${c}; width:${w}%"></span>`
  }
  html += '</div>'
  // Ranked list reorders + filters per tab. On Issues, drop
  // packages with no issues — they're noise in an issues-first
  // ranking (matches graph v1's hubs filter). Tie-break by the
  // other axis so equal-issue packages don't shuffle alpha.
  let sorted
  if (tab === 'issues') {
    sorted = graph.packages
      .filter((p) => (issueByPkg.get(p) ?? 0) > 0)
      .sort((a, b) => {
        const ia = issueByPkg.get(a) ?? 0, ib = issueByPkg.get(b) ?? 0
        if (ib !== ia) return ib - ia
        return (graph.pkgCount.get(b) ?? 0) - (graph.pkgCount.get(a) ?? 0)
      })
  } else {
    sorted = [...graph.packages].sort((a, b) => {
      const fa = graph.pkgCount.get(a) ?? 0, fb = graph.pkgCount.get(b) ?? 0
      if (fb !== fa) return fb - fa
      return (issueByPkg.get(b) ?? 0) - (issueByPkg.get(a) ?? 0)
    })
  }
  const top = sorted.slice(0, 8)
  html += '<div class="g2-dist-list">'
  if (top.length === 0) {
    html += '<div class="g2-dist-empty">No packages with issues</div>'
  }
  for (const pkg of top) {
    const c = pkgColor(pkg)
    const fileCnt = graph.pkgCount.get(pkg) ?? 0
    const issueCnt = issueByPkg.get(pkg) ?? 0
    // Count + percentage both follow the active tab — reading
    // "30 88.2%" on Issues makes the row monotonically decrease
    // with the sort; mixing issue counts with file percentages
    // (the previous behavior) read as a sorting bug.
    const cnt = tab === 'issues' ? issueCnt : fileCnt
    const pct = tab === 'issues'
      ? (totalIssues > 0 ? (issueCnt / totalIssues * 100).toFixed(1) : '0.0')
      : (fileCnt / totalFiles * 100).toFixed(1)
    const label = pkg === '__own__' ? 'own source' : pkg
    // Each row is a button with data-g2-pkg so the existing
    // package-click handler in events.js (used by the palette
    // swatches) handles top-pkgs clicks too: same toggle-solo
    // semantics, same right-panel refresh, no duplicated logic.
    const isSelected = graph2.solo === pkg
    html += `<button type="button" class="g2-dist-item${isSelected ? ' on' : ''}" data-g2-pkg="${esc(pkg)}" title="${esc(label)}">`
    html += `<span class="g2-dist-dot" style="background:${c}"></span>`
    html += `<span class="g2-dist-name">${esc(label)}</span>`
    html += `<span class="g2-dist-count">${cnt}</span>`
    html += `<span class="g2-dist-pct">${pct}%</span>`
    html += '</button>'
  }
  html += '</div>'
  return html
}
