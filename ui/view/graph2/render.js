import { esc } from '../format.js'
import { state } from '../state.js'
import { graph2 } from './state.js'
import { tree } from '../graph/state.js'
import { pkgColor } from '../graph/utils.js'
import { isGroupDeleted } from '../group.js'
import { issueSummary } from './data.js'

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
  html += renderTopBar()
  html += renderLeftPanel(graph)
  html += renderStage()
  html += renderRightPanel(graph)
  html += '</div>'
  return html
}

function renderTopBar() {
  let html = '<div class="graph2-topbar">'
  // "Show all" controls the FILE SET, not just rendering —
  // flipping it rebuilds the graph (different nodes, different
  // edges, different layout). Reads / writes tree.showAll
  // (shared with graph v1 so the two tabs stay consistent on
  // the same dataset). Defaults to off → only files with own
  // or subtree findings are kept; the "Show only issues"
  // toggle on the left is a separate, view-level filter that
  // still operates on whatever set this leaves behind.
  html += `<button type="button" class="g2-topbar-toggle${tree.showAll ? ' on' : ''}" data-g2-show-all aria-pressed="${tree.showAll}">`
  html += '<span>Show all</span><span class="g2-switch"></span>'
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

function renderLeftPanel(graph) {
  let html = '<aside class="graph2-left">'

  // Palette
  html += '<div class="g2-panel-title">Packages '
  html += `<span class="g2-count">${graph.packages.length}</span>`
  html += '</div>'
  html += '<div class="g2-palette-toolbar">'
  html += `<input type="text" class="g2-palette-search" id="g2-palette-search" placeholder="search package…" value="${esc(graph2.paletteSearch)}">`
  html += '<button type="button" class="g2-palette-clear" id="g2-palette-clear">Reset</button>'
  html += '</div>'
  html += '<div class="g2-palette" id="g2-palette">'
  const q = graph2.paletteSearch.trim().toLowerCase()
  for (const pkg of graph.packages) {
    const c = pkgColor(pkg)
    const label = pkg === '__own__' ? 'own source' : pkg
    const muted = q && !label.toLowerCase().includes(q) ? ' muted' : ''
    const solo = graph2.solo === pkg ? ' solo' : ''
    const dim = graph2.solo && graph2.solo !== pkg ? ' dim' : ''
    const hidden = graph2.hidden.has(pkg) ? ' hidden-pkg' : ''
    html += `<button type="button" class="g2-swatch${muted}${solo}${dim}${hidden}" data-g2-pkg="${esc(pkg)}" title="${esc(label)} · ${graph.pkgCount.get(pkg)} files" style="--c:${c}"></button>`
  }
  html += '</div>'

  // Statistics
  html += '<div class="g2-panel-title">Statistics</div>'
  html += '<div class="g2-stat-grid">'
  let cross = 0; for (const e of graph.edges) if (e.cross) cross++
  const intra = graph.edges.length - cross
  let hubs = 0; for (const n of graph.nodes) if (n.isHub) hubs++
  const avgDeg = graph.nodes.length === 0 ? '0.0' : (graph.edges.length * 2 / graph.nodes.length).toFixed(1)
  html += `<div class="g2-stat"><div class="g2-stat-label">Files</div><div class="g2-stat-val">${graph.nodes.length}</div><div class="g2-stat-sub">${graph.packages.length} packages</div></div>`
  html += `<div class="g2-stat"><div class="g2-stat-label">Edges</div><div class="g2-stat-val">${graph.edges.length}</div><div class="g2-stat-sub">${intra} intra · ${cross} cross</div></div>`
  html += `<div class="g2-stat"><div class="g2-stat-label">Hubs</div><div class="g2-stat-val">${hubs}</div><div class="g2-stat-sub">load-bearing</div></div>`
  html += `<div class="g2-stat"><div class="g2-stat-label">Avg Degree</div><div class="g2-stat-val">${avgDeg}</div><div class="g2-stat-sub">per file</div></div>`
  html += '</div>'

  // Issues
  const issueCounts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const n of graph.nodes) if (n.issue) issueCounts[n.issue]++
  const total = issueCounts.critical + issueCounts.high + issueCounts.medium + issueCounts.low
  html += '<div class="g2-panel-title">Issues '
  html += `<span class="g2-count">${total}</span></div>`
  html += '<div class="g2-sev-list">'
  for (const sev of ['critical', 'high', 'medium', 'low']) {
    const on = graph2.showIssues[sev] ? ' on' : ''
    html += `<button type="button" class="g2-sev-row${on}" data-g2-sev="${sev}" style="--sev:${SEV_COLORS[sev]}">`
    html += '<span class="g2-sev-mark"></span>'
    html += `<span class="g2-sev-label">${sev}</span>`
    html += `<span class="g2-sev-n">${issueCounts[sev]}</span>`
    html += '</button>'
  }
  html += '</div>'
  html += `<button type="button" class="g2-toggle-row${graph2.issuesOnly ? ' on' : ''}" data-g2-toggle="issuesOnly">`
  html += '<span>Show only issues</span><span class="g2-switch"></span>'
  html += '</button>'

  // Display sliders
  html += '<div class="g2-panel-title">Display</div>'
  html += sliderRow('edge-op', 'Edge opacity', graph2.edgeOpacity.toFixed(2), 0, 100, Math.round(graph2.edgeOpacity * 100))
  const maxDeg = Math.max(1, ...graph.nodes.map((n) => n.deg))
  html += sliderRow('min-deg', 'Min degree', graph2.minDegree, 0, Math.min(20, maxDeg), graph2.minDegree)
  html += sliderRow('node-size', 'Node size', graph2.nodeSize.toFixed(1) + '×', 40, 220, Math.round(graph2.nodeSize * 100))

  // Options
  html += '<div class="g2-panel-title">Options</div>'
  html += toggleRow('halos', 'Glow halos', graph2.showHalos)
  html += toggleRow('hubs', 'Highlight hubs', graph2.highlightHubs)
  html += toggleRow('labels', 'Labels (zoom > 140%)', graph2.showLabels)

  html += '</aside>'
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

function renderStage() {
  let html = '<main class="graph2-stage">'
  html += '<canvas id="g2-canvas"></canvas>'
  html += '<div class="g2-corner-bl"><span id="g2-visible">— of — visible</span></div>'
  html += '<div class="g2-corner-br" id="g2-fps">— fps</div>'
  html += '<div class="g2-zoom-ctrl">'
  html += '<button id="g2-zoom-in" title="Zoom in">+</button>'
  html += '<div class="g2-zoom-pct" id="g2-zoom-pct">100%</div>'
  html += '<button id="g2-zoom-out" title="Zoom out">−</button>'
  html += '<button id="g2-zoom-fit" title="Fit to view">⟲</button>'
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
// would drop hover state). renderSelectionPanel is exported for that.
export function renderSelectionCard(graph) {
  const file = graph2.selected
  if (!file) {
    return '<div class="g2-empty-state">'
      + '<strong>No file selected</strong>'
      + 'Click any node in the graph to inspect its package, dependencies, and findings.'
      + '</div>'
  }
  const n = graph.nodeByFile.get(file)
  if (!n) {
    return '<div class="g2-empty-state"><strong>File not in current view</strong>Adjust filters or pick another file.</div>'
  }
  const col = pkgColor(n.pkg)
  let intra = 0, cross = 0
  const neighborIds = []
  for (const ei of (graph.adj.get(file) ?? [])) {
    const e = graph.edges[ei]
    const other = e.a === file ? e.b : e.a
    neighborIds.push({ file: other, cross: e.cross })
    e.cross ? cross++ : intra++
  }
  // Cross-package neighbors first; within each bucket, by total
  // findings then degree — surfaces the "what else is going wrong
  // in adjacent code" view first.
  neighborIds.sort((a, b) => {
    if (a.cross !== b.cross) return b.cross - a.cross
    const na = graph.nodeByFile.get(a.file), nb = graph.nodeByFile.get(b.file)
    if (!na || !nb) return 0
    if (na.totalIssues !== nb.totalIssues) return nb.totalIssues - na.totalIssues
    return nb.deg - na.deg
  })
  const top = neighborIds.slice(0, 12)

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
  html += `<div class="g2-sel-row"><span class="k">Type</span><span class="v">${n.isHub ? 'Hub' : 'Member'}</span></div>`
  html += `<div class="g2-sel-row"><span class="k">Degree</span><span class="v">${n.deg}</span></div>`
  html += `<div class="g2-sel-row"><span class="k">Intra-pkg</span><span class="v">${intra}</span></div>`
  html += `<div class="g2-sel-row"><span class="k">Cross-pkg</span><span class="v">${cross}</span></div>`
  if (n.issue) {
    html += `<div class="g2-sel-row"><span class="k">Status</span><span class="v"><span class="g2-issue-badge" style="--sev:${SEV_COLORS[n.issue]}">${n.issue}</span></span></div>`
  } else {
    html += `<div class="g2-sel-row"><span class="k">Status</span><span class="v">clean</span></div>`
  }
  html += '</div>'
  if (n.issueText) html += `<div class="g2-issue-text" style="--sev:${SEV_COLORS[n.issue] ?? '#888'}">${esc(n.issueText)}</div>`
  // Quick jumps over to the existing tabs — same data, different
  // presentation. Findings filters get cleared first so the user
  // doesn't land on an empty list because of a stale exclude.
  html += '<div class="g2-sel-jumps">'
  if (n.totalIssues > 0) html += `<button type="button" class="g2-sel-jump" data-g2-jump-findings="${esc(file)}">Findings →</button>`
  html += `<button type="button" class="g2-sel-jump" data-g2-jump-file="${esc(file)}">Files →</button>`
  html += '</div>'
  html += '</div>'

  // Neighbors
  html += '<div class="g2-panel-title" style="margin-top:14px">Top neighbors</div>'
  html += '<div class="g2-neighbor-list">'
  for (const nb of top) {
    const m = graph.nodeByFile.get(nb.file)
    if (!m) continue
    const c = pkgColor(m.pkg)
    const meta = `deg ${m.deg}${nb.cross ? ' · cross' : ''}`
    html += `<button type="button" class="g2-nb" data-g2-select="${esc(nb.file)}">`
    html += `<span class="g2-nb-dot" style="background:${c}"></span>`
    html += `<span class="g2-nb-id">${esc(m.label)}</span>`
    html += `<span class="g2-nb-meta">${meta}</span>`
    html += '</button>'
  }
  if (neighborIds.length > top.length) {
    html += `<div class="g2-nb-more">+${neighborIds.length - top.length} more</div>`
  }
  html += '</div>'
  return html
}

function renderDistribution(graph) {
  const totalFiles = graph.nodes.length || 1
  const tab = graph2.topPkgsTab
  // Aggregate own-issue counts per package — sum totalIssues
  // across every node in the package. Drives the Issues sort
  // and the count column when that tab is active.
  const issueByPkg = new Map()
  let totalIssues = 0
  for (const n of graph.nodes) {
    issueByPkg.set(n.pkg, (issueByPkg.get(n.pkg) ?? 0) + n.totalIssues)
    totalIssues += n.totalIssues
  }
  // The dist BAR always shows file-count proportions (preserves
  // the "share of codebase" reading regardless of which tab is
  // active — the bar is a stable spatial reference for "how the
  // codebase splits up", not a re-sortable listing).
  let html = '<div class="g2-dist-bar">'
  for (const pkg of graph.packages) {
    const c = pkgColor(pkg)
    const w = (graph.pkgCount.get(pkg) / totalFiles * 100).toFixed(2)
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
    html += '<div class="g2-dist-item">'
    html += `<span class="g2-dist-dot" style="background:${c}"></span>`
    html += `<span class="g2-dist-name" title="${esc(label)}">${esc(label)}</span>`
    html += `<span class="g2-dist-count">${cnt}</span>`
    html += `<span class="g2-dist-pct">${pct}%</span>`
    html += '</div>'
  }
  html += '</div>'
  return html
}
