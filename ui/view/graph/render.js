import { html } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from '../style-map.js'
import { appMarkup } from '../markup.js'
import { DEPENDENCIES_ICON_SVG, GRAPH_ICON_SVG, LAYERS_ICON_SVG, MATRIX_ICON_SVG, PACKAGE_FLOW_ICON_SVG } from '../icons.js'
import { SEVERITIES, formatBytes } from '../format.js'
import { graph2 } from './state.js'
import { pkgColor } from './utils.js'
import { graphTerms, packageVersions } from './data.js'
import { pkgLabel } from '../../../common/bundle-pkg-of.js'
import { pkgRelative } from './file-label.js'
import { dependencyFilesOn, dependencyNetwork, packageNetwork } from './package-network.js'

// The bundle layouts, in their selector's order: id, label, icon.
const BUNDLE_LAYOUTS = [
  ['graph', 'Graph', appMarkup(GRAPH_ICON_SVG)],
  ['layers', 'Layers', appMarkup(LAYERS_ICON_SVG)],
  ['matrix', 'Matrix', appMarkup(MATRIX_ICON_SVG)],
  ['dependencies', 'Dependencies', appMarkup(DEPENDENCIES_ICON_SVG)],
  ['flow', 'Size flow', html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 3h18M3 10h7m4 0h7M3 20h6m3 0h9M5 3v7m13-7v7M6 10c0 5 10 5 10 10m2-10c0 5-12 5-12 10"/></svg>`],
  // Size flow's chart, of packages weighed by how many packages they bring.
  ['package-flow', 'Package flow', appMarkup(PACKAGE_FLOW_ICON_SVG)],
]

// The triage filter's mark colors, as in the findings tab.
const COLORS = ['none', 'red', 'blue', 'green', 'gray']

// Lit templates for the sections `<graph-layout>` composes (graph-layout.js
// imports this module, never the reverse); the refresh helpers in ui/graph.js
// render the selection card, focus overlay and Packages block directly.
// canvas.js wires the canvas on top.
//
// `options.extraTopRow`: a second row above the main one, where the
// Findings-tab embed hosts its view-mode chooser. `options.layouts` narrows
// the bundle layouts offered (all by default): a lockfile's graph has no
// bytes for Layers and Size flow. `placement.issuesWrapped` (measured by
// `<graph-layout>`) moves the bundle Issues switch to the start of the issue
// row when it would wrap onto a line of its own.
export function renderTopBar(graph, options, extraControls = null, placement = {}) {
  const layout = options.showBundleLayouts && BUNDLE_LAYOUTS.some(([id]) => id === graph2.bundleLayout) ? graph2.bundleLayout : 'graph'
  const [layers, matrix, dependencies, flow, packageFlow] = ['layers', 'matrix', 'dependencies', 'flow', 'package-flow'].map((id) => layout === id)
  const layoutSelector = options.showBundleLayouts ? html`<div class="g2-layout-tabs" role="group" aria-label="Bundle layout">
    ${BUNDLE_LAYOUTS.filter(([id]) => options.layouts?.includes(id) ?? true).map(([id, label, icon]) =>
      html`<button type="button" data-g2-layout=${id} aria-label=${label} aria-pressed=${String(id === layout)}>${icon}</button>`)}
  </div>` : null
  const extraTopRow = options.extraTopRow
  const hideAllFiles = options.hideAllFiles ?? false
  const triageCounts = options.triageCounts ?? { inprogress: 0, fixed: 0, invalid: 0, deleted: 0, ignored: 0 }
  const triageStates = options.triageStates ?? ['inprogress', 'fixed', 'invalid', 'deleted', 'ignored']
  // Severity and mark-color chips count files, each toward every severity
  // and color among its findings (its severitySet / colorSet), as the
  // findings tab's toolbar does. A chip with no files still shows while
  // selected, so it can be deselected.
  const countFiles = (ids, key) => {
    const counts = Object.fromEntries(ids.map((id) => [id, 0]))
    for (const n of graph.nodes) for (const value of n[key] ?? []) if (counts[value] !== undefined) counts[value]++
    return counts
  }
  const issueCounts = countFiles(SEVERITIES, 'severitySet')
  const hasAnyVisible = SEVERITIES.some((sev) => issueCounts[sev] > 0 || graph2.selectedSeverities.has(sev))
  const colorCounts = countFiles(COLORS, 'colorSet')
  const hasAnyColor = COLORS.some((c) => colorCounts[c] > 0 || graph2.selectedColors.has(c))

  const triageBtn = html`<triage-selector variant="graph" .counts=${triageCounts} .states=${triageStates}></triage-selector>`

  // "All files" picks the file set (off: files with issues and their
  // dependencies), so flipping it rebuilds the graph.
  const allFilesBtn = hideAllFiles ? null : html`<mode-switch
    label="All files" .checked=${graph2.showAll}
    data-g2-show-all
  ></mode-switch>`

  // "Packages": one node per package, in the bundle Graph layout when the
  // caller offers it (`showPackagesView`: 3+ packages), in Size flow, and in
  // Dependencies up to 100 files. A graph of packages alone has nothing to
  // flip to, nor has Package flow.
  const showPackagesView = !graph.packagesOnly && !packageFlow
    && (flow || (dependencies ? graph.nodes.length <= 100 : !layers && !matrix && (options.showPackagesView ?? false)))
  const packagesViewBtn = showPackagesView ? html`<mode-switch
    label="Packages" .checked=${flow ? graph2.flowPackagesView : dependencies ? graph2.dependencyPackagesView : graph2.packagesView}
    data-g2-packages-view
  ></mode-switch>` : null

  // The bundle scope (reason or entry point) selector the Advisories, Treemap
  // and Scan views use. The main bundle defines it (render-bundle-advisories.js):
  // importing it here would bundle a second Lit into this lazy chunk.
  const reasonFilter = graph.reasons?.length > 0 ? html`<bundle-scope-selector class="g2-reason-scope"
    .reasons=${graph.reasons} .value=${graph2.bundleReason ?? ''} label="Filter files"
    @scope-change=${(e) => e.currentTarget.dispatchEvent(new CustomEvent('bundle-graph-reason-change', {
      detail: { reason: e.detail.value || null }, bubbles: true, composed: true,
    }))}
  ></bundle-scope-selector>` : null

  const severityChips = hasAnyVisible ? html`<severity-chips
    .counts=${issueCounts}
    .selected=${[...graph2.selectedSeverities]}
    kind="graph"
  ></severity-chips>` : null
  const markFilter = hasAnyColor ? html`<triage-filter
    .counts=${colorCounts}
    .selected=${[...graph2.selectedColors]}
    kind="graph"
  ></triage-filter>` : null
  // Path / package filter, dimming the canvas. Its clear button is always
  // rendered and hidden by CSS while empty, so typing redraws the canvas
  // without re-rendering the topbar.
  const pathFilter = html`<div class="toolbar-search g2-path-filter-wrap">
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
    <button type="button" class="g2-path-filter-clear" id="g2-path-filter-clear" aria-label="Clear filter">✕</button>
  </div>`
  // Toggles body.report-fullscreen.
  const fullscreenBtn = html`<button type="button" class="g2-icon-btn" id="g2-fullscreen" aria-label="Toggle fullscreen">⛶</button>`

  // Bundle graphs: the first row shapes the file set and view and ends with
  // the Issues switch (offered when findings matched the bundle) and
  // fullscreen, pinned to its top-right corner even when the controls wrap.
  // While Issues is on, an issue row carries the severity, mark and status
  // filters.
  if (options.showBundleLayouts) {
    const issuesOn = (options.hasIssues ?? false) && graph2.bundleIssues
    const issuesSwitch = options.hasIssues ? html`<mode-switch
      class="g2-issues-switch"
      label="Issues" .checked=${graph2.bundleIssues}
      data-g2-bundle-issues
    ></mode-switch>` : null
    const switchInIssueRow = issuesSwitch && placement.issuesWrapped
    return html`<div class="graph2-topbar">
      <div class="graph2-topbar-row graph2-topbar-row-main graph2-topbar-row-pinned toolbar-row">
        <div class="g2-topbar-controls">
          ${layoutSelector}
          ${pathFilter}
          ${packagesViewBtn}
          ${extraControls}
          ${reasonFilter}
          ${switchInIssueRow ? null : issuesSwitch}
        </div>
        ${fullscreenBtn}
      </div>
      ${issuesOn || switchInIssueRow ? html`<div class="graph2-topbar-row graph2-topbar-row-issues toolbar-row sev-row">
        ${switchInIssueRow ? issuesSwitch : null}
        ${issuesOn ? html`${severityChips}${markFilter}${triageBtn}` : null}
      </div>` : null}
    </div>`
  }

  // With an extra row (the Findings-tab embed), All files, Packages and the
  // status selector join it; the main row keeps the filters.
  return html`<div class="graph2-topbar">
    ${extraTopRow ? html`<div class="graph2-topbar-row graph2-topbar-row-extra toolbar-row">
      ${extraTopRow}
      ${allFilesBtn}
      ${packagesViewBtn}
      <div class="g2-spacer"></div>
      ${triageBtn}
    </div>` : null}
    <div class="graph2-topbar-row graph2-topbar-row-main toolbar-row sev-row">
    ${layoutSelector}
    ${reasonFilter}
    ${severityChips}
    ${markFilter}
    ${pathFilter}
    ${extraTopRow ? null : allFilesBtn}
    ${extraTopRow ? null : packagesViewBtn}
    ${extraControls}
    <div class="g2-spacer"></div>
    ${extraTopRow ? null : triageBtn}
    ${fullscreenBtn}
    </div>
  </div>`
}

// `file` as a neighbor sees it (`./Logo.js`, `../lib/x.js`) from
// `referenceDir`, when that's shorter than the path itself.
function shorterPath(file, referenceDir) {
  if (referenceDir === undefined) return file
  const fromParts = referenceDir.split('/').filter(Boolean)
  const toParts = file.split('/').filter(Boolean)
  let common = 0
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++
  const ups = fromParts.length - common
  const down = toParts.slice(common).join('/')
  const rel = ups === 0 ? './' + down : '../'.repeat(ups) + down
  return rel.length < file.length ? rel : file
}

// A selection card's file links (data-g2-select), in the order they read,
// each with its package's color dot and the full path as its tooltip.
function renderFileList(graph, label, files, referenceDir) {
  const items = files.map((f) => ({ file: f, display: shorterPath(f, referenceDir) }))
  items.sort((a, b) => a.display.localeCompare(b.display))
  return html`<div class="g2-sel-section">
    <div class="g2-sel-section-label">${label} (${files.length})</div>
    ${files.length === 0 ? html`<div class="g2-sel-section-empty">none</div>` : html`<ul class="g2-sel-file-list">
      ${items.map(({ file: f, display }) => {
        const node = graph.nodeByFile.get(f)
        const c = node ? pkgColor(node.pkg) : '#666'
        return html`<li><button type="button" class="g2-sel-file-link" data-g2-select=${f}>
          <span class="g2-sel-file-dot" style=${styleMap({ background: c })}></span>
          <span class="g2-sel-file-path" data-tooltip-truncated data-tooltip=${f}>${display}</span>
        </button></li>`
      })}
    </ul>`}
  </div>`
}

// Severity-count chips for the selection card and the canvas tooltip, or
// "none".
export function renderSevChips(counts) {
  const present = SEVERITIES.filter((s) => (counts?.[s] ?? 0) > 0)
  if (present.length === 0) return html`<div class="g2-sel-section-empty">none</div>`
  return html`<div class="tree-count-chips">
    ${present.map((s) => html`<span class=${`tree-count-chip ${s}`}>${counts[s]} ${s.replaceAll('_', ' ')}</span>`)}
  </div>`
}

// The canvas, its corner overlays (the focused package's back button top
// left, the focus button's slot top right, refreshed with the selection),
// bottom-left stats, zoom controls and tooltip. Filters dim rather than
// hide, so the stats count every node.
export function renderStage(graph) {
  const cross = graph.edges.filter((e) => e.cross).length
  const intra = graph.edges.length - cross
  const issues = graph.nodes.reduce((sum, n) => sum + n.totalIssues, 0)
  // A graph of packages alone counts its package dependencies in every layout.
  const network = graph.supportsLayers && (graph.packagesOnly || graph2.bundleLayout === 'dependencies') && !graph2.focusedPkg
    ? dependencyNetwork(graph, graph2.dependencyPackagesView) : null
  const nodeCount = network?.nodes.length ?? graph.nodes.length
  const edgeCount = network?.directedEdges.length ?? graph.edges.length
  const avgDeg = nodeCount === 0 ? '0.0' : (edgeCount * 2 / nodeCount).toFixed(1)

  return html`<main class="graph2-stage">
    <canvas id="g2-canvas"></canvas>
    ${graph2.focusedPkg ? html`<div class="g2-stage-overlay">
      <button type="button" class="g2-back-btn" id="g2-back-to-full">← ${pkgLabel(graph2.focusedPkg)}</button>
    </div>` : null}
    <div id="g2-focus-overlay-slot" class="g2-stage-overlay-tr"></div>
    <div class="g2-stage-stats">
      ${!network || network.fileLevel ? html`<span><b>${graph.nodes.length}</b> files</span>` : null}
      <span><b>${network && !network.fileLevel ? network.nodes.length : graph.packages.length}</b> packages</span>
      <span><b>${edgeCount}</b> ${network ? 'dependencies' : html`edges (${intra} intra · ${cross} cross)`}</span>
      ${graph.issuesHidden ? null : html`<span><b>${issues}</b> issues</span>`}
      <span>avg degree <b>${avgDeg}</b></span>
    </div>
    <div class="g2-zoom-ctrl">
      <button id="g2-zoom-in" aria-label="Zoom in">+</button>
      <div class="g2-zoom-pct" id="g2-zoom-pct">100%</div>
      <button id="g2-zoom-out" aria-label="Zoom out">−</button>
      <button id="g2-zoom-fit" class="g2-zoom-fit-btn" aria-label="Fit to view">fit</button>
    </div>
    <div class="g2-tooltip" id="g2-tooltip"></div>
  </main>`
}

// The top-right button focusing the selected file's package, or the solo'd
// one: not for a single-file package or the one already focused, nor on a
// graph of packages alone, whose members are no files to draw.
export function renderFocusOverlay(graph) {
  if (graph.packagesOnly || graph.supportsLayers && graph2.bundleLayout === 'dependencies') return null
  const pkg = graph2.selected ? graph.nodeByFile.get(graph2.selected)?.pkg : graph2.solo
  if (!pkg || (graph.pkgCount.get(pkg) ?? 0) <= 1 || graph2.focusedPkg === pkg) return null
  const label = `Focus on ${pkgLabel(pkg)}'s graph`
  return html`<button
    type="button"
    class="g2-focus-pkg-btn"
    data-g2-focus-pkg=${pkg}
    aria-label=${label}
    data-tooltip=${label}
  ><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 4.6 L4 11 M8 4.6 L12 11 M5 11.4 L11 11.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      <circle cx="8" cy="3.6" r="2" fill="currentColor"/>
      <circle cx="3.6" cy="11.4" r="2" fill="currentColor"/>
      <circle cx="12.4" cy="11.4" r="2" fill="currentColor"/>
    </svg></button>`
}

// The refresh helpers (ui/graph.js) render into these slots, each slot its
// own Lit render root: content rendered here too would put two Lit caches on
// the same DOM.
export function renderRightPanel() {
  return html`<aside class="graph2-right">
    <div class="g2-panel-title">Selection</div>
    <div id="g2-selection-area"></div>
    <div id="g2-top-pkgs-block"></div>
  </aside>`
}

// The Packages block, re-rendered in place when its tab flips. Size is
// offered with "All files" on and a size on every node, Issues when any node
// has findings; a tab not offered falls back to Files.
export function renderTopPkgsBlock(graph) {
  if (packageDependencyPanel(graph)) {
    const pg = packageNetwork(graph)
    const ids = pg.nodes.toSorted((a, b) => pg.importedBy.get(b.pkg).length - pg.importedBy.get(a.pkg).length || a.pkg.localeCompare(b.pkg)).map((n) => n.pkg)
    return html`<div class="g2-panel-title">Packages · ${graphTerms(graph).importers}</div>${renderDependencyList(pg, ids, true)}`
  }
  const showSize = graph2.showAll && graph.nodes.length > 0
    && graph.nodes.every((n) => typeof n.size === 'number')
  const showIssues = graph.nodes.some((n) => n.totalIssues > 0)
  let tab = graph2.topPkgsTab
  if (tab === 'size' && !showSize) tab = 'files'
  if (tab === 'issues' && !showIssues) tab = 'files'
  return html`<div class="g2-panel-title g2-panel-title-row">
    <span>Packages</span>
    <div class="g2-mini-tabs">
      ${[['issues', 'Issues', showIssues], ['files', 'Files', true], ['size', 'Size', showSize]].map(([id, label, offered]) => offered
        ? html`<button type="button" class=${classMap({ 'g2-mini-tab': true, on: tab === id })} data-g2-top-pkgs=${id}>${label}</button>` : null)}
    </div>
  </div>
  ${renderDistribution(graph, tab)}`
}

// Re-rendered in place on a click, keeping the canvas (and its hover). The
// selected file's card, else the solo'd package's.
export function renderSelectionCard(graph, ctx = {}) {
  if (packageDependencyPanel(graph)) {
    return renderDependencyCard(graph, packageNetwork(graph), graph2.solo)
  }
  const file = graph2.selected
  if (file) {
    const n = graph.nodeByFile.get(file)
    if (n) return renderFileCard(graph, n, file, ctx)
    return html`<div class="g2-empty-state">
      <strong>File not in current view</strong>Adjust filters or pick another file.
    </div>`
  }
  if (graph2.solo) {
    if (graph2.solo === '__own__' && !graph.pkgCount.has('__own__') && graph.layerRoots?.appImports.length > 0) {
      return html`<div class="g2-empty-state"><strong>App</strong>App source is not included in this view. Connections come from its recorded imports.</div>`
    }
    return renderPackageCard(graph, graph2.solo)
  }
  return html`<div class="g2-empty-state">Click a node or a package row to inspect.</div>`
}

// Like the hover tooltip: the path in its package and the package, then the
// full path (its tooltip showing it when clipped), findings, navigation
// jumps, and the import lists, paths relative to this file's directory where
// that's shorter.
function renderFileCard(graph, n, file, ctx) {
  const col = pkgColor(n.pkg)
  const lastSlash = file.lastIndexOf('/')
  const referenceDir = lastSlash >= 0 ? file.slice(0, lastSlash) : ''
  return html`<div class="g2-selection-card">
    <div class="g2-sel-file-head">
      <div class="g2-sel-path">${pkgRelative(file, n.pkg)}</div>
      <div class="g2-sel-pkg-row">
        <span class="g2-sel-dot" style=${styleMap({ '--dot': col, background: col })}></span>
        <span class="g2-sel-pkg">${pkgLabel(n.pkg)}</span>
      </div>
    </div>
    <div class="g2-sel-fullpath" data-tooltip-truncated data-tooltip=${file}>${file}</div>
    ${formatBytes(n.size) ? html`<div class="g2-sel-size">${formatBytes(n.size)}</div>` : null}
    <div class="g2-sel-section">
      <div class="g2-sel-section-label">Own findings</div>
      ${renderSevChips(n.own)}
    </div>
    <div class="g2-sel-section">
      <div class="g2-sel-section-label">Subtree findings</div>
      ${renderSevChips(n.subtree)}
    </div>
    <div class="g2-sel-jumps">
      ${n.totalIssues > 0 && ctx.findingsJump !== false ? html`<button type="button" class="g2-sel-jump" data-g2-jump-findings=${file}>Findings →</button>` : null}
      ${ctx.isBundleContext
        ? (n.origFile ? html`<button type="button" class="g2-sel-jump" data-bundle-view-source=${n.origFile}>View source →</button>` : null)
        : html`<button type="button" class="g2-sel-jump" data-g2-jump-file=${file}>Files →</button>`}
    </div>
    ${renderFileList(graph, 'Imported by', graph.importedBy.get(file) ?? [], referenceDir)}
    ${renderFileList(graph, 'Imports', graph.importsOf.get(file) ?? [], referenceDir)}
  </div>`
}

// A solo'd package's files, hubs, edges inside and out, summed own findings,
// and the files of other packages importing it.
function renderPackageCard(graph, pkg) {
  const filesInPkg = graph.nodes.filter((n) => n.pkg === pkg)
  if (filesInPkg.length === 0) {
    // Typically "All files" is off and every file in it is clean.
    return html`<div class="g2-empty-state">
      <strong>Package has no files in view</strong>
      Toggle "All files" to widen the file set, or pick another package.
    </div>`
  }
  const col = pkgColor(pkg)
  const ownAgg = Object.fromEntries(SEVERITIES.map((sev) => [sev, filesInPkg.reduce((sum, n) => sum + (n.own?.[sev] ?? 0), 0)]))
  let crossEdges = 0, intraEdges = 0
  for (const e of graph.edges) {
    const a = graph.nodeByFile.get(e.a)
    const b = graph.nodeByFile.get(e.b)
    if (!a || !b) continue
    if (a.pkg === pkg && b.pkg === pkg) intraEdges++
    else if (a.pkg === pkg || b.pkg === pkg) crossEdges++
  }
  const importers = new Set(filesInPkg.flatMap((n) => (graph.importedBy.get(n.file) ?? [])
    .filter((f) => graph.nodeByFile.get(f) && graph.nodeByFile.get(f).pkg !== pkg)))

  return html`<div class="g2-selection-card">
    <div class="g2-sel-head">
      <span class="g2-sel-dot" style=${styleMap({ '--dot': col, background: col })}></span>
      <span class="g2-sel-id">${pkgLabel(pkg)}</span>
      <span class="g2-sel-grp">package</span>
    </div>
    <div class="g2-sel-body">
      <div class="g2-sel-row"><span class="k">Files</span><span class="v">${filesInPkg.length}</span></div>
      <div class="g2-sel-row"><span class="k">Hubs</span><span class="v">${filesInPkg.filter((n) => n.isHub).length}</span></div>
      <div class="g2-sel-row"><span class="k">Intra edges</span><span class="v">${intraEdges}</span></div>
      <div class="g2-sel-row"><span class="k">Cross edges</span><span class="v">${crossEdges}</span></div>
    </div>
    <div class="g2-sel-section">
      <div class="g2-sel-section-label">Findings</div>
      ${renderSevChips(ownAgg)}
    </div>
    ${renderFileList(graph, 'Imported by', [...importers])}
  </div>`
}

function renderDistribution(graph, tab) {
  // Own-issue counts per package. With a severity or mark filter set, only
  // the findings passing both count (the canvas dims alike): a severity and
  // a color found on one file needn't share a finding (`findings` pairs).
  const sevFilter = graph2.selectedSeverities
  const colorFilter = graph2.selectedColors
  const useSev = !graph.issuesHidden && sevFilter.size > 0
  const useColor = !graph.issuesHidden && colorFilter.size > 0
  const issueByPkg = new Map()
  const sizeByPkg = new Map()
  let totalIssues = 0
  let totalSize = 0
  for (const n of graph.nodes) {
    const count = useSev || useColor
      ? (n.findings ?? []).filter((f) => (!useSev || sevFilter.has(f.severity)) && (!useColor || colorFilter.has(f.color))).length
      : n.totalIssues
    issueByPkg.set(n.pkg, (issueByPkg.get(n.pkg) ?? 0) + count)
    totalIssues += count
    if (typeof n.size === 'number') {
      sizeByPkg.set(n.pkg, (sizeByPkg.get(n.pkg) ?? 0) + n.size)
      totalSize += n.size
    }
  }
  // Each tab ranks, sizes the bar's segments and reads its rows by its own
  // axis, ties broken by the next most stable one. Issues and Size leave
  // out packages with none.
  const files = (pkg) => graph.pkgCount.get(pkg) ?? 0
  const issues = (pkg) => issueByPkg.get(pkg) ?? 0
  const sizes = (pkg) => sizeByPkg.get(pkg) ?? 0
  const axes = {
    issues: { value: issues, tie: files, total: totalIssues, count: issues, empty: 'No packages with issues' },
    size: { value: sizes, tie: files, total: totalSize, count: (pkg) => formatBytes(sizes(pkg)), empty: 'No packages with size' },
    files: { value: files, tie: issues, total: graph.nodes.length || 1, count: files, empty: 'No packages', all: true },
  }
  const axis = axes[tab] ?? axes.files
  const sorted = (axis.all ? graph.packages : graph.packages.filter((p) => axis.value(p) > 0))
    .toSorted((a, b) => axis.value(b) - axis.value(a) || axis.tie(b) - axis.tie(a))
  const share = (pkg, digits, none) => axis.total > 0 ? (axis.value(pkg) / axis.total * 100).toFixed(digits) : none
  return html`<div class="g2-dist-bar">
    ${graph.packages.map((pkg) => {
      const c = pkgColor(pkg)
      return html`<span style=${styleMap({ background: c, width: `${share(pkg, 2, '0')}%` })}></span>`
    })}
  </div>
  <div class="g2-dist-list">
    ${sorted.length === 0 ? html`<div class="g2-dist-empty">${axis.empty}</div>` : null}
    ${repeat(sorted, (pkg) => pkg, (pkg) => {
      const c = pkgColor(pkg)
      const label = pkgLabel(pkg)
      // data-g2-pkg toggles the solo'd package (events.js).
      return html`<button
        type="button"
        class=${classMap({ 'g2-dist-item': true, on: graph2.solo === pkg })}
        data-g2-pkg=${pkg}
      ><span class="g2-dist-dot" style=${styleMap({ background: c })}></span><span class="g2-dist-name" data-tooltip-truncated data-tooltip=${label}>${label}</span><span class="g2-dist-count">${axis.count(pkg)}</span><span class="g2-dist-pct">${share(pkg, 1, '0.0')}%</span></button>`
    })}
  </div>`
}

// The right panel inspects packages by what they depend on, at the same
// altitude as the canvas: in Dependencies at package altitude, and in every
// layout of a graph of packages alone.
function packageDependencyPanel(graph) {
  return (graph.packagesOnly || graph.supportsLayers && graph2.bundleLayout === 'dependencies' && !graph2.focusedPkg)
    && !dependencyFilesOn(graph, graph2.dependencyPackagesView)
}

function renderDependencyList(pg, ids, counts = false) {
  return html`<div class="g2-dist-list">
    ${repeat(ids, (id) => id, (id) => html`<button type="button" class=${classMap({ 'g2-dist-item': true, on: graph2.solo === id })} data-g2-pkg=${id}>
      <span class="g2-dist-dot" style=${styleMap({ background: pkgColor(id) })}></span>
      <span class="g2-dist-name">${pkgLabel(id)}</span>
      ${counts ? html`<span class="g2-dist-count">${pg.importedBy.get(id).length}</span>` : null}
    </button>`)}
  </div>`
}

// A graph of packages alone also lists the versions installed.
function renderDependencyCard(graph, pg, id) {
  const n = pg.byPkg.get(id)
  const terms = graphTerms(graph)
  if (!n) return html`<div class="g2-empty-state">Select a package to trace its ${terms.links}.</div>`
  const importers = pg.importedBy.get(id) ?? [], imports = pg.importsOf.get(id) ?? []
  const versions = graph.packagesOnly ? packageVersions(graph, id) : []
  return html`<div class="g2-selection-card">
    <div class="g2-sel-head">
      <span class="g2-sel-dot" style=${styleMap({ background: pkgColor(id) })}></span>
      <span class="g2-sel-id">${n.label}</span>
    </div>
    ${n.totalIssues ? html`<div class="g2-sel-section">${renderSevChips(n.own)}</div>` : null}
    ${versions.length > 0 ? html`<div class="g2-sel-section">
      <div class="g2-sel-section-label">${versions.length === 1 ? 'Version' : `Versions (${versions.length})`}</div>
      <div class="g2-sel-versions">${versions.join(', ')}</div>
    </div>` : null}
    <div class="g2-sel-section">
      <div class="g2-sel-section-label">${terms.incoming} (${importers.length})</div>
      ${renderDependencyList(pg, importers.toSorted())}
    </div>
    <div class="g2-sel-section">
      <div class="g2-sel-section-label">Dependencies (${imports.length})</div>
      ${renderDependencyList(pg, imports.toSorted())}
    </div>
  </div>`
}
