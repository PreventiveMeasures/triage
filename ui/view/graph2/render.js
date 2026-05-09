import { html } from 'lit'
import { SEVERITIES, formatBytes } from '../format.js'
import { state } from '../../../client/state.js'
import { graph2 } from './state.js'
import { pkgColor } from '../graph/utils.js'
import { pkgRelative } from './data.js'
import { isGroupDeleted } from '../group.js'

// Build the entire v2 layout as a Lit template — three columns:
// left panel (palette / stats / issues / display / options), stage
// (canvas + corner readouts + zoom controls + tooltip), right
// panel (selection + top groups). All sub-fragments are Lit
// templates too (returns from the per-section helpers below), so
// interpolated user-derived values (file paths, package names,
// the path-filter input) auto-escape through Lit's `${…}` slot.
//
// attachGraph2Interaction (in canvas.js) wires up the canvas
// rAF / hover / click / pan / zoom on top of the rendered DOM.
//
// Tab-state inputs:
//   graph     — buildGraph(...) result; nodes/edges/packages/etc.
//   ownCounts — file → severity-count map; drives the "Top groups"
//               distribution and the per-package issue counts
// `options.extraTopRow` — optional Lit template emitted as a
// SECOND row above the main topbar contents. Used by the
// Findings-tab embed to host the view-mode chooser inside the
// graph's own toolbar instead of stacking a separate findings
// toolbar above the canvas.
export function renderGraph2Layout(graph, options = {}) {
  return html`<div class="graph2-layout">
    ${renderTopBar(graph, options)}
    ${renderStage(graph)}
    ${renderRightPanel()}
  </div>`
}

function renderTopBar(graph, options) {
  const extraTopRow = options.extraTopRow
  const hideAllFiles = options.hideAllFiles ?? false
  const deletedCountOverride = options.deletedCount
  // Severity highlight pills — same tier set as the findings
  // tab (critical, high, medium, low, high_bug, bug,
  // informational from format.js's SEVERITIES). Skip tiers
  // with zero count UNLESS that tier is currently in the
  // selected set, so the user can always click an active pill
  // to deselect it even if the dataset has stopped containing
  // that severity. Empty selectedSeverities = no canvas dimming.
  // Lives at the left edge of the topbar (before All files)
  // since it's the most-frequently-used control.
  // Each file contributes to EVERY severity tier present in its
  // findings (same union semantic the findings-tab toolbar uses),
  // not just its top-tier — so a file with high+low findings
  // counts under both chips and toggling either one keeps the file
  // highlighted. Mirrors `severitySet` on the node, populated by
  // buildGraph2Data from the visible groups.
  const issueCounts = {}
  for (const sev of SEVERITIES) issueCounts[sev] = 0
  for (const n of graph.nodes) {
    if (!n.severitySet) continue
    for (const s of n.severitySet) if (issueCounts[s] !== undefined) issueCounts[s]++
  }
  const hasAnyVisible = SEVERITIES.some((sev) => issueCounts[sev] > 0 || graph2.selectedSeverities.has(sev))

  // Triage filter — same buttons / colors as the findings-tab pill
  // (none / red / blue / green / gray). Counts are per-FILE: a file
  // contributes to every color present on any of its findings,
  // matching the union semantic the severity counts use.
  const COLORS = ['none', 'red', 'blue', 'green', 'gray']
  const colorCounts = { none: 0, red: 0, blue: 0, green: 0, gray: 0 }
  for (const n of graph.nodes) {
    if (!n.colorSet) continue
    for (const c of n.colorSet) if (colorCounts[c] !== undefined) colorCounts[c]++
  }
  const hasAnyColor = COLORS.some((c) => colorCounts[c] > 0 || graph2.selectedColors.has(c))

  // Trash toggle — same role as the findings tab's trash button.
  // Visible when there are deleted findings to show OR when the
  // user is already in trash view (so they can exit without
  // first un-deleting). Toggling flips state.showDeleted (shared
  // with findings) and rebuilds the graph data: the file set,
  // statistics, and per-package issue counts all switch to the
  // deleted-only view. This is a data-level filter, not a
  // visual overlay.
  // Bundle path passes a precomputed `deletedCount` so the topbar
  // tracks deleted findings within the bundle's matched set, not
  // state.reports' (which may be empty in bundle-only sessions, or
  // count deletions from reports unrelated to the open bundle).
  let deletedCount
  if (typeof deletedCountOverride === 'number') {
    deletedCount = deletedCountOverride
  } else {
    const allGroups = state.reports.flatMap((r) => r.groups)
    deletedCount = allGroups.reduce((n, g) => n + (isGroupDeleted(g) ? 1 : 0), 0)
  }
  const showTrash = deletedCount > 0 || state.showDeleted
  const trashTitle = state.showDeleted ? 'exit trash view' : 'show deleted findings'
  const trashLabel = `Trash${deletedCount ? ` (${deletedCount})` : ''}`

  const trashBtn = showTrash ? html`<button
    type="button"
    class=${`trash-btn${state.showDeleted ? ' active' : ''}`}
    id="g2-toggle-trash"
    title=${trashTitle}
    aria-pressed=${String(state.showDeleted)}
  >${trashLabel}</button>` : null

  // "All files" controls the FILE SET, not just rendering —
  // flipping it rebuilds the graph (different nodes, different
  // edges, different layout). The findings tab defaults to off
  // (issue-bearing files + their deps); the bundle graph defaults
  // to on (full inventory). Hidden entirely when the caller passes
  // `hideAllFiles` — bundle sourcemaps don't carry import edges,
  // so there's nothing for the toggle to filter against.
  const allFilesBtn = hideAllFiles ? null : html`<button
    type="button"
    class=${`g2-topbar-toggle${graph2.showAll ? ' on' : ''}`}
    data-g2-show-all
    aria-pressed=${String(graph2.showAll)}
  ><span>All files</span><span class="g2-switch"></span></button>`

  // When the topbar carries an extra row (Findings-tab embed), the
  // view-mode chooser + All files + Trash sit on the new top row,
  // and the main row keeps the data-shaping filters (severity /
  // triage / path / fullscreen). Standalone Graph tab keeps
  // everything on a single row exactly as before.
  return html`<div class="graph2-topbar">
    ${extraTopRow ? html`<div class="graph2-topbar-row graph2-topbar-row-extra toolbar-row">
      ${extraTopRow}
      ${allFilesBtn}
      <div class="g2-spacer"></div>
      ${trashBtn}
    </div>` : null}
    <div class="graph2-topbar-row graph2-topbar-row-main toolbar-row sev-row">
    ${hasAnyVisible ? html`<severity-chips
      counts=${JSON.stringify(issueCounts)}
      selected=${JSON.stringify([...graph2.selectedSeverities])}
      kind="graph"
    ></severity-chips>` : null}
    ${hasAnyColor ? html`<triage-filter
      counts=${JSON.stringify(colorCounts)}
      selected=${JSON.stringify([...graph2.selectedColors])}
      kind="graph"
    ></triage-filter>` : null}
    <!-- Path / package substring filter — same .toolbar-search shell
         the findings tab uses for "Search findings", just wired to
         the canvas dim predicate instead of the row filter. Clear
         button is always rendered, hidden via CSS when the input is
         empty (using :placeholder-shown sibling). Keeps the button
         live across user typing without re-rendering the topbar on
         every keystroke — the canvas redraws on input but the chrome
         doesn't. -->
    <div class="toolbar-search g2-path-filter-wrap">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7"/>
        <path d="m20 20-3.5-3.5"/>
      </svg>
      <input
        type="text"
        class="g2-path-filter"
        id="g2-path-filter"
        placeholder="filter path/package…"
        .value=${graph2.pathFilter}>
      <button type="button" class="g2-path-filter-clear" id="g2-path-filter-clear" title="Clear filter" aria-label="Clear filter">✕</button>
    </div>
    ${extraTopRow ? null : allFilesBtn}
    ${extraTopRow ? null : trashBtn}
    <div class="g2-spacer"></div>
    <!-- Fullscreen — toggles body.report-fullscreen. With the
         sidebar now spanning both grid rows, the topbar covers only
         the stage column, so the button's right-edge position here
         sits right at the stage / sidebar boundary. -->
    <button type="button" class="g2-icon-btn" id="g2-fullscreen" title="Toggle fullscreen">⛶</button>
    </div>
  </div>`
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
  if (count === 0) {
    return html`<div class="g2-sel-section">
      <div class="g2-sel-section-label">${label} (${count})</div>
      <div class="g2-sel-section-empty">none</div>
    </div>`
  }
  // Sort by the displayed string so the list reads in the
  // order it visually shows. Computing display once per file
  // (vs. inside the comparator) keeps it O(n + n log n)
  // rather than recomputing relativePath on every compare.
  const items = files.map((f) => ({ file: f, display: shorterPath(f, referenceDir) }))
  items.sort((a, b) => a.display.localeCompare(b.display))
  return html`<div class="g2-sel-section">
    <div class="g2-sel-section-label">${label} (${count})</div>
    <ul class="g2-sel-file-list">
      ${items.map(({ file: f, display }) => {
        const node = graph.nodeByFile.get(f)
        const c = node ? pkgColor(node.pkg) : '#666'
        return html`<li><button type="button" class="g2-sel-file-link" data-g2-select=${f} title=${f}>
          <span class="g2-sel-file-dot" style=${`background:${c}`}></span>
          <span class="g2-sel-file-path">${display}</span>
        </button></li>`
      })}
    </ul>
  </div>`
}

// Severity-count chip block — used by the selection card's
// Own / Subtree finding sections AND by the canvas tooltip.
// Reuses graph v1's `.tree-count-chip` palette (already defined
// global in styles/graph.css), so the chips look identical in
// both graph tabs. Returns "none" placeholder when the counts
// object is null or all-zero, matching v1's "none"-on-empty.
export function renderSevChips(counts) {
  if (!counts) return html`<div class="g2-sel-section-empty">none</div>`
  const tiers = ['critical', 'high', 'medium', 'low', 'high_bug', 'bug', 'informational']
  const present = tiers.filter((s) => (counts[s] ?? 0) > 0)
  if (present.length === 0) return html`<div class="g2-sel-section-empty">none</div>`
  return html`<div class="tree-count-chips">
    ${present.map((s) => html`<span class=${`tree-count-chip ${s}`}>${counts[s]} ${s.replace(/_/gu, ' ')}</span>`)}
  </div>`
}

function renderStage(graph) {
  // Bottom-left stats — file/package/edge/hub/issue counts. The
  // earlier "X of Y visible" readout is gone: every node stays on
  // screen now (filters / solo soft-dim instead of hiding), so
  // visibleCount always equaled total.
  let cross = 0; for (const e of graph.edges) if (e.cross) cross++
  const intra = graph.edges.length - cross
  let issues = 0; for (const n of graph.nodes) issues += n.totalIssues
  const avgDeg = graph.nodes.length === 0 ? '0.0' : (graph.edges.length * 2 / graph.nodes.length).toFixed(1)

  const focusedLabel = graph2.focusedPkg === '__own__' ? 'own source' : graph2.focusedPkg

  return html`<main class="graph2-stage">
    <canvas id="g2-canvas"></canvas>
    <!-- Top-left overlay — back button only (in package-focus
         mode). Stats moved to the bottom-left where they don't
         compete with the focused subgraph for attention; only
         shown here when there's something to render (the back
         button), so the corner is empty in normal mode. -->
    ${graph2.focusedPkg ? html`<div class="g2-stage-overlay">
      <button type="button" class="g2-back-btn" id="g2-back-to-full" title="Back to the full graph">← ${focusedLabel}</button>
    </div>` : null}
    <!-- Top-right overlay slot — pairs with the top-left back button
         (both are in-canvas graph actions, not navigation jumps). The
         wrapper is always present so we can hot-swap its content from
         refreshGraph2Sidebar when selection / solo / focus state
         changes; renderFocusOverlay decides whether the slot is
         populated (button) or empty (nothing to drill into). -->
    <div id="g2-focus-overlay-slot" class="g2-stage-overlay-tr"></div>
    <div class="g2-stage-stats">
      <span><b>${graph.nodes.length}</b> files</span>
      <span><b>${graph.packages.length}</b> packages</span>
      <span><b>${graph.edges.length}</b> edges (${intra} intra · ${cross} cross)</span>
      <span><b>${issues}</b> issues</span>
      <span>avg degree <b>${avgDeg}</b></span>
    </div>
    <!-- Bottom-right: zoom controls. -->
    <div class="g2-zoom-ctrl">
      <button id="g2-zoom-in" title="Zoom in">+</button>
      <div class="g2-zoom-pct" id="g2-zoom-pct">100%</div>
      <button id="g2-zoom-out" title="Zoom out">−</button>
      <button id="g2-zoom-fit" class="g2-zoom-fit-btn" title="Fit to view">fit</button>
    </div>
    <div class="g2-tooltip" id="g2-tooltip"></div>
  </main>`
}

// Decides whether the top-right overlay slot is populated. Shown
// when there's a package context to drill into:
//   - a file is selected → use that file's package, OR
//   - a package is solo'd → use that package.
// Hidden when there's only one file in the package (nothing to
// visualize) or when already focused on it. Returns the button
// template, or null/`''` to leave the slot empty. Exported so the
// refresh helper in render.js can swap it on selection change.
export function renderFocusOverlay(graph) {
  let pkg = null
  if (graph2.selected) {
    const sel = graph.nodeByFile.get(graph2.selected)
    if (sel) pkg = sel.pkg
  } else if (graph2.solo) {
    pkg = graph2.solo
  }
  if (!pkg) return null
  if ((graph.pkgCount.get(pkg) ?? 0) <= 1) return null
  if (graph2.focusedPkg === pkg) return null
  const label = pkg === '__own__' ? 'own source' : pkg
  // Subgraph icon — three nodes connected by edges, evoking
  // "this is a smaller graph you can zoom into".
  return html`<button
    type="button"
    class="g2-focus-pkg-btn"
    data-g2-focus-pkg=${pkg}
    title=${`Focus on ${label}'s graph`}
  ><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 4.6 L4 11 M8 4.6 L12 11 M5 11.4 L11 11.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      <circle cx="8" cy="3.6" r="2" fill="currentColor"/>
      <circle cx="3.6" cy="11.4" r="2" fill="currentColor"/>
      <circle cx="12.4" cy="11.4" r="2" fill="currentColor"/>
    </svg></button>`
}

function renderRightPanel() {
  // The selection-card area and top-packages block are populated
  // by `refreshGraph2Sidebar` / `refreshGraph2TopPkgs` (in
  // view/render.js) which `litRender` directly into these slots.
  // Leaving them empty here means each refresh manages its own
  // Lit PartInfo on the slot — populating inline would mean two
  // separate Lit caches both touching the same DOM, and the
  // refresh's manual `innerHTML = ''` wipe would orphan the
  // parent's cache (TypeError on the next click).
  return html`<aside class="graph2-right">
    <div class="g2-panel-title">Selection</div>
    <div id="g2-selection-area"></div>
    <div id="g2-top-pkgs-block"></div>
  </aside>`
}

// Top-packages section — exported so events.js can re-render it
// in place when the user flips the Issues/Files tab without
// rebuilding the whole canvas. The caller wraps the returned
// template in #g2-top-pkgs-block.
//
// The Size mini-tab only shows when (a) the user has flipped the
// "All files" toggle on (so the file set isn't pre-filtered to
// issue-bearing files only — a bundle's Size view is most useful
// against the unfiltered set) AND (b) every node carries a `size`.
// Without a size on every node, the tab's percentages would be
// meaningless. The Issues tab hides when no node carries any
// findings (a clean bundle / report — there's nothing to rank).
// If the active tab is gated off, the renderer falls back to
// Files.
export function renderTopPkgsBlock(graph) {
  const showSize = graph2.showAll && graph.nodes.length > 0
    && graph.nodes.every((n) => typeof n.size === 'number')
  const showIssues = graph.nodes.some((n) => n.totalIssues > 0)
  let tab = graph2.topPkgsTab
  if (tab === 'size' && !showSize) tab = 'files'
  if (tab === 'issues' && !showIssues) tab = 'files'
  return html`<div class="g2-panel-title g2-panel-title-row">
    <span>Packages</span>
    <div class="g2-mini-tabs">
      ${showIssues ? html`<button type="button" class=${`g2-mini-tab${tab === 'issues' ? ' on' : ''}`} data-g2-top-pkgs="issues">Issues</button>` : null}
      <button type="button" class=${`g2-mini-tab${tab === 'files' ? ' on' : ''}`} data-g2-top-pkgs="files">Files</button>
      ${showSize ? html`<button type="button" class=${`g2-mini-tab${tab === 'size' ? ' on' : ''}`} data-g2-top-pkgs="size">Size</button>` : null}
    </div>
  </div>
  ${renderDistribution(graph, tab)}`
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
    return html`<div class="g2-empty-state">
      <strong>File not in current view</strong>Adjust filters or pick another file.
    </div>`
  }
  if (graph2.solo) {
    return renderPackageCard(graph, graph2.solo)
  }
  return html`<div class="g2-empty-state">Click a node or a package row to inspect.</div>`
}

function renderFileCard(graph, n, file) {
  const col = pkgColor(n.pkg)
  const pkgLabel = n.pkg === '__own__' ? 'own source' : n.pkg
  const relPath = pkgRelative(file, n.pkg)

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

  return html`<div class="g2-selection-card">
    <!-- Three-line header (matches the hover tooltip):
           1. file path relative to the package root — primary
              identifier, monospace, full text colour.
           2. dot + package name — secondary context.
           3. (below the head's border) full path in small muted
              monospace, ellipsis-clipped if the column is narrow.
              Title attr keeps the full path discoverable on hover
              when truncation kicks in. -->
    <div class="g2-sel-file-head">
      <div class="g2-sel-path">${relPath}</div>
      <div class="g2-sel-pkg-row">
        <span class="g2-sel-dot" style=${`--dot:${col}; background:${col}`}></span>
        <span class="g2-sel-pkg">${pkgLabel}</span>
      </div>
    </div>
    <div class="g2-sel-fullpath" title=${file}>${file}</div>
    ${formatBytes(n.size) ? html`<div class="g2-sel-size">${formatBytes(n.size)}</div>` : null}
    <!-- Own + subtree finding chips — same chrome as graph v1's
         sidebar (.tree-info-section / .tree-count-chip), so the
         visual reads consistently across the two graph tabs. The
         single-severity Status row + issue-text bar that lived
         here previously duplicated the data without showing the
         breakdown — chips are strictly more informative. -->
    <div class="g2-sel-section">
      <div class="g2-sel-section-label">Own findings</div>
      ${renderSevChips(n.own)}
    </div>
    <div class="g2-sel-section">
      <div class="g2-sel-section-label">Subtree findings</div>
      ${renderSevChips(n.subtree)}
    </div>
    <!-- Bottom row carries only the navigation jumps (Findings /
         Files). The package-graph drill-in is a different kind of
         action — it stays on the Graph tab and just narrows the
         canvas — so it lives on the canvas itself as a top-right
         icon button (rendered in renderStage), pairing with the
         top-left back button. -->
    <div class="g2-sel-jumps">
      ${n.totalIssues > 0 ? html`<button type="button" class="g2-sel-jump" data-g2-jump-findings=${file}>Findings →</button>` : null}
      ${state.currentView === 'bundles'
        ? (n.origFile ? html`<button type="button" class="g2-sel-jump" data-bundle-view-source=${n.origFile}>View source →</button>` : null)
        : html`<button type="button" class="g2-sel-jump" data-g2-jump-file=${file}>Files →</button>`}
    </div>
    ${renderFileList(graph, 'Imported by', importers, referenceDir)}
    ${renderFileList(graph, 'Imports', imports, referenceDir)}
  </div>`
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
    return html`<div class="g2-empty-state">
      <strong>Package has no files in view</strong>
      Toggle "All files" to widen the file set, or pick another package.
    </div>`
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

  return html`<div class="g2-selection-card">
    <div class="g2-sel-head">
      <span class="g2-sel-dot" style=${`--dot:${col}; background:${col}`}></span>
      <span class="g2-sel-id">${pkgLabel}</span>
      <span class="g2-sel-grp">package</span>
    </div>
    <div class="g2-sel-body">
      <div class="g2-sel-row"><span class="k">Files</span><span class="v">${fileCount}</span></div>
      <div class="g2-sel-row"><span class="k">Hubs</span><span class="v">${hubs}</span></div>
      <div class="g2-sel-row"><span class="k">Intra edges</span><span class="v">${intraEdges}</span></div>
      <div class="g2-sel-row"><span class="k">Cross edges</span><span class="v">${crossEdges}</span></div>
    </div>
    <div class="g2-sel-section">
      <div class="g2-sel-section-label">Findings</div>
      ${renderSevChips(ownAgg)}
    </div>
    ${renderFileList(graph, 'Imported by', [...importerSet])}
  </div>`
}

function renderDistribution(graph, activeTab) {
  const totalFiles = graph.nodes.length || 1
  const tab = activeTab ?? graph2.topPkgsTab
  // Aggregate own-issue counts per package. The topbar's severity
  // and triage filters narrow what's counted — empty filters = full
  // count, otherwise count only findings whose severity AND color
  // both pass their respective filter (intersection across axes,
  // matching what the canvas dim predicate highlights). Per-finding
  // {severity, color} pairs are stamped on each node by
  // buildGraph2Data; without them an empty `n.findings` falls back
  // to `n.totalIssues` (which equals the unfiltered count).
  const sevFilter = graph2.selectedSeverities
  const colorFilter = graph2.selectedColors
  const useSev = sevFilter.size > 0
  const useColor = colorFilter.size > 0
  const useFilter = useSev || useColor
  const issueByPkg = new Map()
  const sizeByPkg = new Map()
  let totalIssues = 0
  let totalSize = 0
  for (const n of graph.nodes) {
    let count
    if (useFilter) {
      count = 0
      if (n.findings) for (const f of n.findings) {
        if (useSev && !sevFilter.has(f.severity)) continue
        if (useColor && !colorFilter.has(f.color)) continue
        count++
      }
    } else {
      count = n.totalIssues
    }
    issueByPkg.set(n.pkg, (issueByPkg.get(n.pkg) ?? 0) + count)
    totalIssues += count
    if (typeof n.size === 'number') {
      sizeByPkg.set(n.pkg, (sizeByPkg.get(n.pkg) ?? 0) + n.size)
      totalSize += n.size
    }
  }
  // Ranked list reorders + filters per tab. On Issues, drop
  // packages with no issues — they're noise in an issues-first
  // ranking (matches graph v1's hubs filter). On Size, drop
  // packages with zero / unknown bytes for the same reason. Files
  // shows everything so the user gets the full pkg.count breakdown.
  // Each axis tie-breaks by the next-most-stable axis so equal
  // primary-axis packages don't shuffle alpha.
  let sorted
  if (tab === 'issues') {
    sorted = graph.packages
      .filter((p) => (issueByPkg.get(p) ?? 0) > 0)
      .sort((a, b) => {
        const ia = issueByPkg.get(a) ?? 0, ib = issueByPkg.get(b) ?? 0
        if (ib !== ia) return ib - ia
        return (graph.pkgCount.get(b) ?? 0) - (graph.pkgCount.get(a) ?? 0)
      })
  } else if (tab === 'size') {
    sorted = graph.packages
      .filter((p) => (sizeByPkg.get(p) ?? 0) > 0)
      .sort((a, b) => {
        const sa = sizeByPkg.get(a) ?? 0, sb = sizeByPkg.get(b) ?? 0
        if (sb !== sa) return sb - sa
        return (graph.pkgCount.get(b) ?? 0) - (graph.pkgCount.get(a) ?? 0)
      })
  } else {
    sorted = [...graph.packages].sort((a, b) => {
      const fa = graph.pkgCount.get(a) ?? 0, fb = graph.pkgCount.get(b) ?? 0
      if (fb !== fa) return fb - fa
      return (issueByPkg.get(b) ?? 0) - (issueByPkg.get(a) ?? 0)
    })
  }

  // The dist BAR follows the active tab so the segment widths
  // line up with the percentages in the list rows below. On
  // Files: width = pkg's file share. On Issues: pkg's share of
  // the (filter-narrowed) issue total. On Size: pkg's share of
  // the bundle's total source bytes. Packages with 0 in the
  // chosen axis collapse to zero-width segments.
  const widthFor = (pkg) => {
    if (tab === 'issues') return totalIssues > 0 ? ((issueByPkg.get(pkg) ?? 0) / totalIssues * 100).toFixed(2) : '0'
    if (tab === 'size')   return totalSize   > 0 ? ((sizeByPkg.get(pkg)  ?? 0) / totalSize   * 100).toFixed(2) : '0'
    return (graph.pkgCount.get(pkg) / totalFiles * 100).toFixed(2)
  }
  const emptyMsg = tab === 'issues' ? 'No packages with issues'
                : tab === 'size'   ? 'No packages with size'
                : 'No packages'
  return html`<div class="g2-dist-bar">
    ${graph.packages.map((pkg) => {
      const c = pkgColor(pkg)
      return html`<span style=${`background:${c}; width:${widthFor(pkg)}%`}></span>`
    })}
  </div>
  <!-- Show every package — the wrapping section flexes to fill
       the available sidebar height and scrolls past that, so the
       top-N cap that lived here previously is no longer needed. -->
  <div class="g2-dist-list">
    ${sorted.length === 0 ? html`<div class="g2-dist-empty">${emptyMsg}</div>` : null}
    ${sorted.map((pkg) => {
      const c = pkgColor(pkg)
      const fileCnt = graph.pkgCount.get(pkg) ?? 0
      const issueCnt = issueByPkg.get(pkg) ?? 0
      const sizeBytes = sizeByPkg.get(pkg) ?? 0
      // Count + percentage both follow the active tab — reading
      // "30 88.2%" on Issues makes the row monotonically decrease
      // with the sort; mixing issue counts with file percentages
      // (the previous behavior) read as a sorting bug. On Size
      // the count slot becomes a byte readout via formatBytes.
      const cnt = tab === 'issues' ? issueCnt
               : tab === 'size'   ? formatBytes(sizeBytes)
               : fileCnt
      const pct = tab === 'issues' ? (totalIssues > 0 ? (issueCnt / totalIssues * 100).toFixed(1) : '0.0')
                : tab === 'size'   ? (totalSize   > 0 ? (sizeBytes / totalSize   * 100).toFixed(1) : '0.0')
                : (fileCnt / totalFiles * 100).toFixed(1)
      const label = pkg === '__own__' ? 'own source' : pkg
      // Each row is a button with data-g2-pkg so the existing
      // package-click handler in events.js (used by the palette
      // swatches) handles top-pkgs clicks too: same toggle-solo
      // semantics, same right-panel refresh, no duplicated logic.
      const isSelected = graph2.solo === pkg
      return html`<button
        type="button"
        class=${`g2-dist-item${isSelected ? ' on' : ''}`}
        data-g2-pkg=${pkg}
        title=${label}
      ><span class="g2-dist-dot" style=${`background:${c}`}></span><span class="g2-dist-name">${label}</span><span class="g2-dist-count">${cnt}</span><span class="g2-dist-pct">${pct}%</span></button>`
    })}
  </div>`
}
