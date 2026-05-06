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

// Controls that previously lived in the left panel — palette /
// statistics / issues / display sliders / options. Returned as
// inner HTML (no wrapping <aside>) so renderRightPanel can append
// them after the Selection / Top-packages blocks. The left panel
// is gone — this content piggybacks on the right panel's
// scroll, trading a fixed sidebar of always-visible controls for
// more horizontal canvas room.
function renderControls(graph) {
  let html = ''
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

  // (Statistics block moved to the canvas overlay — see
  // renderStage's top-left readout. Lives there now so the
  // control panel stays focused on filters / display tweaks.)


  // (Severity filter pills moved to the topbar; the standalone
  // "Show only issues" toggle is gone — selecting all four
  // severities up there gives the same visual.)

  // Display — sliders for the visual knobs that take a
  // numeric value, then toggles for the booleans. Earlier
  // versions split these into Display + Options sections,
  // but the boundary was arbitrary (every control here is
  // a "display tweak") and the extra heading mostly cost
  // vertical space.
  html += '<div class="g2-panel-title">Display</div>'
  html += sliderRow('edge-op', 'Edge opacity', graph2.edgeOpacity.toFixed(2), 0, 100, Math.round(graph2.edgeOpacity * 100))
  const maxDeg = Math.max(1, ...graph.nodes.map((n) => n.deg))
  html += sliderRow('min-deg', 'Min degree', graph2.minDegree, 0, Math.min(20, maxDeg), graph2.minDegree)
  html += sliderRow('node-size', 'Node size', graph2.nodeSize.toFixed(1) + '×', 40, 220, Math.round(graph2.nodeSize * 100))
  html += toggleRow('halos', 'Glow halos', graph2.showHalos)
  html += toggleRow('hubs', 'Highlight hubs', graph2.highlightHubs)
  html += toggleRow('labels', 'Labels (zoom > 140%)', graph2.showLabels)
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
  // Top-left overlay — context line + statistics. In the
  // full-graph mode this reads like the design's "DEEPVIEW ·
  // 2,500 nodes · …" status block; in package-focus mode the
  // first row becomes the back-button / breadcrumb out of
  // the drill-in. Statistics underneath stay informative
  // either way (counts reflect whatever's currently in scope).
  html += '<div class="g2-stage-overlay">'
  if (graph2.focusedPkg) {
    const label = graph2.focusedPkg === '__own__' ? 'own source' : graph2.focusedPkg
    html += `<button type="button" class="g2-back-btn" id="g2-back-to-full" title="Back to the full graph">← ${esc(label)}</button>`
  } else {
    html += '<div class="g2-stage-title">DeepView · graph</div>'
  }
  let cross = 0; for (const e of graph.edges) if (e.cross) cross++
  const intra = graph.edges.length - cross
  let hubs = 0; for (const n of graph.nodes) if (n.isHub) hubs++
  const avgDeg = graph.nodes.length === 0 ? '0.0' : (graph.edges.length * 2 / graph.nodes.length).toFixed(1)
  html += '<div class="g2-stage-stats">'
  html += `<span><b>${graph.nodes.length}</b> files</span>`
  html += `<span><b>${graph.packages.length}</b> packages</span>`
  html += `<span><b>${graph.edges.length}</b> edges (${intra} intra · ${cross} cross)</span>`
  html += `<span><b>${hubs}</b> hubs</span>`
  html += `<span>avg degree <b>${avgDeg}</b></span>`
  html += '</div>'
  html += '</div>'
  // Bottom-left: live "X of Y visible" readout (updates on
  // hover-driven dim changes too via the canvas's redraw).
  html += '<div class="g2-corner-bl"><span id="g2-visible">— of — visible</span></div>'
  // Bottom-right: zoom controls.
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
