import { sharedFindingTriage, usesReportIgnore } from '../../client/ignored-triage.js'
// Bundle-view rendering surface. Lifted out of `render.js` so the
// findings-tab path doesn't have to scroll past ~1500 lines of
// bundle chrome. Covers bundle data prep, the bundle graph, the
// bundles list + details panel + tabs + source-viewer modal, and
// `renderIssuesGroupedByFile` (the per-file grouped finding list
// shared with the package Issues slide via render-packages.js).
//
// `render()` in `render.js` keeps the `currentView === 'bundles'`
// dispatch (slot reuse + canvas attach), importing `renderBundlesList`,
// `buildBundleGraphData`, `setCurrentBundleGraphPrep`,
// `countBundleTriageBuckets`, `refreshBundleGraphSidebar`,
// `refreshBundleGraphTopPkgs`, and `renderBundleSourceModal` from
// this module.
import { html, nothing } from 'lit'
import { store } from '@rray/frontend/state-management'
import { getPublicShare } from '../../client/managed/public-share.js'
import { loadManagedBundle } from './client-managed.js'
import { managedBundleRoute } from './managed-bundle-navigation.js'
import { managedHistory } from './managed-history.js'
import { choose } from 'lit/directives/choose.js'
import { classMap } from 'lit/directives/class-map.js'
import { live } from 'lit/directives/live.js'
import { ref } from 'lit/directives/ref.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from 'lit/directives/style-map.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { FILE_ICONS, REPORT_LOGOS, displayName, groupOf } from './file-display.js'
import { sourceCargoIcon, sourceComposerIcon, sourceFileIcon, sourceNpmIcon, sourceSoldeerIcon } from './source-file-icon.js'
import { bundleFileGithub } from './bundle-file-github.js'
import { bundlePackageSourceStats } from './bundle-source-package.js'
import { buildBundleSourceTree, bundleSourceTreePrefix, compactSourceDirectory, filterBundleSourceTree, navigateBundleSourceTree, sourceDirectoryLabel } from './bundle-source-tree.js'
import { bundleSourceLinkResolver } from './bundle-source-links.js'
import { watchSourceWrap } from './source-wrap.js'
import { bundleFileHistory } from './bundle-code-history.js'
import { BUNDLE_ICON_SVG, COMMIT_ICON_SVG, GITHUB_ICON_SVG, SCAN_ICON_SVG } from './icons.js'
import { canScanBundle, openScan } from './scan-navigation.js'
import { bundleComparisonCandidates } from './bundle-comparison-candidates.js'
import { isManagedUiMode, findingsForFileHash as localFindingsForFileHash, indexedHashFindingCount as localIndexedHashFindingCount, reportsForFinding, reportsForFindingByPackage, reportsForFindingByRepo, state } from '#client/index.js'
const findingsForFileHash = hash => isManagedUiMode() ? [] : localFindingsForFileHash(hash)
const indexedHashFindingCount = () => isManagedUiMode() ? 0 : localIndexedHashFindingCount()

import { SEVERITIES, SEVERITY_ORDER, formatRunMeta, stripCommonPathPrefix, titledDescription } from './format.js'
import { formatBytes } from '../scan/metrics.js'
import { utf8ByteLength } from '../../common/utf8.js'
import { bundleFileKinds, bundleFileSizes, bundlePackageDirs, bundleSourceOrder, bundleSourceSizes, bundleSourcesAsMap } from './bundle-sources.js'
import { bundleCodeStats } from '../../common/bundle-stats.js'
import { bundleOriginLinks } from './bundle-origin-links.js'
import { bundleNeedsSources, bundleSourceLineCount, computeBundleFileHashes } from './bundle-metadata.js'
import { bundleHasSbomComponents } from './sbom.js'
import { buildSearchMatcher, runBundleSearch } from './bundle-search-scan.js'
import { bundlePkgOf, ownSourceFirst, pkgLabel } from './bundle-pkg-of.js'
import { bundleWhyQuery } from './bundle-why.js'
import { openWhyDialog } from './dialogs/why-dialog.js'
import { bundleEntryPackages, bundleGraphReasons, bundleImportsAsMap, bundleLayerRoots, bundleOwnSourcePackages, filterBundleGraphReason } from './bundle-graph-inputs.js'
import { tabKey } from './group.js'
import { langForPath, highlight as prismHighlight } from './prism-highlight.js'
import { computeTransitiveCounts } from './file-counts.js'
import { pkgColor } from './graph/utils.js'
import { graph2 } from './graph/state.js'
import { loadedGraphMod } from './graph-attach.js'
import { hideTooltip, showTooltip } from './tooltip.js'
import { ensureBundleAdvisories, renderBundleAdvisoriesTab, showAdvisoriesTab } from './render-bundle-advisories.js'
// Inline `` `code` `` / "quote" highlighting shared with the finding
// card so bundle-side descriptions read the same as the findings tab.
// Module-level circular import (render-finding → render → this
// module) — safe for the same hoisted-function reason as `render`
// below.
import { renderHighlighted } from './render-finding.js'
// `render` is the orchestrator in `render.js`; bundle code calls it
// back after async source-highlight completes so the next pass picks
// up the cached HTML. Module-level circular import — ESM resolves it
// for hoisted function declarations, and the call sites are async
// (always after init).
import { render } from './render.js'

// Bundles graph — like the findings-tab graph but sourced from a
// parsed bundle (sourcemap / stasis). The refresh helpers below
// (refreshBundleGraphSidebar / refreshBundleGraphTopPkgs) mirror
// their findings-tab counterparts so the same layout renders against
// either source, each call feeding this cached prep to the right-
// panel templates. Holds the raw-inputs shape, NOT the built graph:
// the `buildGraph` call lives in lazy `ui/graph.js`, which the
// refresh helpers re-dispatch this prep to on each chip click.
let _currentBundlePrep = null

// Synthesise a treeData blob shaped like the analyzer's tree dump so
// buildGraph (graph/data.js) consumes it unmodified. The shared
// directory prefix (a common build-output root) is stripped from
// every path BEFORE the tree is built so graph nodes — and the
// package buckets the canvas derives from them — use compact,
// prefix-free keys. Imports remap through the same stripping table
// so adjacency stays intact; out-of-bundle resolutions are dropped.
//
// Sizes are the source content's UTF-8 byte length. Returns
// `{ tree, origToStripped }`; callers translating other per-file
// metadata (e.g. SHA-512 hashes for finding match) onto stripped
// keys reuse the mapping.
const bundleTrees = new WeakMap()
function buildBundleTree(details) {
  if (bundleTrees.has(details)) return bundleTrees.get(details)
  const sizes = bundleSourceSizes(details)
  const imports = bundleImportsAsMap(details)
  const origFiles = [...sizes.keys()].filter((file) => sizes.get(file) !== null)
  const { stripped } = stripCommonPathPrefix(origFiles)
  const origToStripped = new Map(origFiles.map((f, i) => [f, stripped[i]]))
  const tree = {}
  for (const origFile of origFiles) {
    const file = origToStripped.get(origFile)
    const imps = imports.get(origFile)
    tree[file] = {
      imports: imps
        ? [...imps].map((i) => origToStripped.get(i)).filter(Boolean)
        : [],
      size: sizes.get(origFile),
    }
  }
  const result = { tree, origToStripped }
  bundleTrees.set(details, result)
  return result
}

// SHA-512 of each bundle source, in the canonical `sha512-${base64}`
// SRI form that `computeFileHash` (@preventive/report/src/finding-id.js) produces —
// the same hashing the analyzer stamps on findings, so the strings
// compare equal. Async because crypto.subtle.digest is. Returns
// Map<file, integrity>.
export { computeBundleFileHashes }

// Per-bucket counts of bundle-matched findings — drives the graph
// topbar's triage selector visibility / counts. Walks the same
// hash → finding index bundleFindingsByFile uses, bucketing each
// finding by triage state (or 'live' when none).
export function countBundleTriageBuckets(details, sourcePaths = null) {
  const counts = { inprogress: 0, fixed: 0, invalid: 0, deleted: 0, ignored: 0 }
  if (!details?.fileHashes) return counts
  const seen = new Set()
  for (const [file, hash] of details.fileHashes) {
    if (sourcePaths && !sourcePaths.has(file)) continue
    if (seen.has(hash)) continue
    seen.add(hash)
    for (const f of findingsForFileHash(hash)) {
      const t = sharedFindingTriage(f, state.triage.get(tabKey(f)))
      if (t && counts[t] !== undefined) counts[t]++
    }
  }
  return counts
}

// Match every indexed finding against the bundle's per-file hashes.
// Returns Map<file, Finding[]>. Pulls from the OPFS-wide
// `bundle-finding-index` (client/bundle-finding-index.js) rather than
// `state.reports` so a bundle is matched against EVERY report the
// user has ever dropped, not just the one open now. The index is
// populated in the background by `ensureBundleFindingsIndexed`; this
// lookup is synchronous, reading whatever is currently cached.
//
// Multiple findings can share a fileHash (one source may emit
// several), and one hash may map to multiple bundle files (rare —
// duplicate sources).
// Bundle-side per-finding filter. Two modes:
//
//   'graph'  — follows state.shownTriage for shared triage. Per-report
//              dependency ignores remain live in this cross-report view.
//
//   'issues' — bundle Issues list (and the source viewer's per-line
//              dots / panel). Always shows live + in-progress + fixed + ignored;
//              hides invalid + deleted. A bundle built before a fix
//              shipped is still affected; a per-report ignore signals
//              "anticipated future removal" but the bundle is still
//              affected today. Invalid / deleted dismiss the issue
//              entirely, so drop them.
function bundleFindingsByFile(fileHashes, mode = 'graph') {
  if (!fileHashes || fileHashes.size === 0) return new Map()
  const result = new Map()
  for (const [file, hash] of fileHashes) {
    const found = findingsForFileHash(hash)
    if (found.length === 0) continue
    const filtered = found.filter((f) => {
      const t = sharedFindingTriage(f, state.triage.get(tabKey(f))) ?? null
      if (mode === 'issues') return t !== 'invalid' && t !== 'deleted'
      return t === state.shownTriage
    })
    if (filtered.length === 0) continue
    result.set(file, filtered)
  }
  return result
}

// Build a graph2-shaped graph from the open bundle. Once per-file
// hashes are computed (events.js kicks the async digest after
// parse), findings from the loaded reports match onto bundle files
// via fileHash equality, rolled up into the `ownCounts` /
// `severitySet` / `colorSet` / `findings` shape buildGraph expects.
// Without hashes every node is "clean" — topbar chip counts collapse
// to zero, but the canvas still renders the import graph.
//
// The tree is keyed by stripped paths (see buildBundleTree), so
// `origToStripped` must also re-key `details.fileHashes` or the
// graph would never light up findings — they'd be looked up under
// original paths while nodes live under stripped ones.
//
// Every file in the chosen reason is a node; All includes the full bundle.
export function buildBundleGraphData(details) {
  const full = buildBundleTree(details)
  const reasons = bundleGraphReasons(details, full.origToStripped.keys())
  if (graph2.bundleReasonFor !== details.integrity) {
    graph2.bundleReasonFor = details.integrity
    graph2.dependencyPackagesView = false
    graph2.bundleReason = null
  }
  const { tree, origToStripped, selected } = filterBundleGraphReason(full.tree, full.origToStripped, reasons, graph2.bundleReason)
  graph2.bundleReason = selected
  const allFiles = Object.keys(tree)
  if (allFiles.length === 0) return null
  let strippedHashes = null
  if (details.fileHashes && details.fileHashes.size > 0) {
    strippedHashes = new Map()
    for (const [orig, hash] of details.fileHashes) {
      const stripped = origToStripped.get(orig)
      if (stripped !== undefined) strippedHashes.set(stripped, hash)
    }
  }
  const findingsByFile = bundleFindingsByFile(strippedHashes)
  // The topbar's Issues switch (offered only when something matched)
  // decides whether findings reach the graph at all: off, every layout
  // draws the bundle without issue markers, counts or filters. Offer it
  // for matches anywhere in the bundle (All files), not just the selected
  // scope, so picking a scope without findings doesn't take the switch
  // away; and in ANY triage bucket, not just the shown one: its row
  // carries the status filter, the only way to reach a bundle whose
  // findings are all fixed, invalid, deleted or ignored.
  const hasIssues = findingsByFile.size > 0
    || [...(details.fileHashes ?? [])].some(([orig, hash]) => full.origToStripped.has(orig) && findingsForFileHash(hash).length > 0)
  const issuesShown = hasIssues && graph2.bundleIssues
  const ownCounts = new Map()
  const severitySets = new Map()
  const colorSets = new Map()
  const fileFindings = new Map()
  for (const [file, findings] of issuesShown ? findingsByFile : []) {
    const counts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
    const sevs = new Set()
    const cols = new Set()
    const ff = []
    for (const f of findings) {
      counts[f.severity] = (counts[f.severity] || 0) + 1
      sevs.add(f.severity)
      const color = state.triage.get(tabKey(f))?.color ?? 'none'
      cols.add(color)
      ff.push({ severity: f.severity, color })
    }
    ownCounts.set(file, counts)
    severitySets.set(file, sevs)
    colorSets.set(file, cols)
    fileFindings.set(file, ff)
  }
  // Matrix cells use direct imports and own findings. Computing reachability
  // from every file is quadratic on large bundles and adds no matrix data.
  const transitiveCounts = graph2.bundleLayout === 'matrix' || ownCounts.size === 0
    ? null : computeTransitiveCounts(tree, ownCounts)
  // Stripped→original mapping the lazy `buildGraphFromPrep` applies
  // to each node's `origFile` field — the selection card's "View
  // source →" button hands the unstripped path to the source viewer
  // (keyed by original path in `bundleSourcesAsMap`). Findings-tab
  // nodes don't get `origFile`, so the button stays bundle-only.
  const strippedToOrig = new Map()
  for (const [orig, stripped] of origToStripped) strippedToOrig.set(stripped, orig)
  // Classify original paths so display-prefix stripping cannot turn
  // node_modules dependencies into own source. Recorded Stasis module
  // directories keep workspace and vendored packages distinct.
  const origPackageDirs = bundlePackageDirs(details)
  const pkgOf = (p) => {
    const orig = strippedToOrig.get(p) ?? p
    return bundlePkgOf(orig, { packageDir: origPackageDirs?.get(orig) })
  }
  const ownFiles = allFiles.filter((p) => pkgOf(p) === '__own__')
  const layerRoots = bundleLayerRoots(details, origToStripped, pkgOf, origPackageDirs, full.origToStripped)
  // `canPackagesView` gates the topbar "Packages" toggle (and the
  // mode itself, via the flag buildGraphFromPrep stamps on the
  // graph): a package-level view needs 3+ packages under the
  // CURRENT classifier — with 2 it's a dumbbell that says nothing
  // the file view doesn't. Counted on the full inventory (not the
  // focus-narrowed set below) so the toggle doesn't vanish while
  // drilled into a single package. Early exit at 3.
  const pkgSet = new Set()
  for (const f of allFiles) {
    pkgSet.add(pkgOf(f))
    if (pkgSet.size >= 3) break
  }
  const canPackagesView = pkgSet.size >= 3
  // Package-focus mode narrows to the focused package's files, same
  // semantics as the findings-tab path in buildGraph2Data (no
  // showAll sub-filter here — bundles always graph their full
  // inventory). A stale focus left over from a previously viewed
  // bundle matches nothing;
  // clear it and fall through to the full graph so the canvas
  // doesn't open on an empty focus with a dead back-button.
  let files = allFiles
  if (graph2.focusedPkg) {
    const focusFiles = allFiles.filter((f) => pkgOf(f) === graph2.focusedPkg)
    if (focusFiles.length > 0) files = focusFiles
    else graph2.focusedPkg = null
  }
  // Same staleness rule for the file selection: a `selected` carried
  // over from another bundle (or a report) names a file this tree
  // doesn't have. At file altitude that only costs an unhelpful
  // "File not in current view" card; at package altitude it would
  // put that card over a package canvas. Clear it like the focus.
  if (graph2.selected && !Object.hasOwn(tree, graph2.selected)) graph2.selected = null
  // Raw-inputs shape — lazy `ui/graph.js` runs the actual
  // `buildGraph(...)` in `buildGraphFromPrep`.
  return {
    treeData: tree, files, ownCounts, transitiveCounts,
    severitySets, colorSets, fileFindings,
    options: { pkgOf },
    strippedToOrig,
    canPackagesView,
    hasIssues,
    issuesShown,
    viewId: details.integrity ?? null,
    supportsLayers: true,
    layerRoots,
    // Entry packages are traversal roots too, but are not necessarily own source.
    ownSourcePackages: bundleOwnSourcePackages(origToStripped, pkgOf, origPackageDirs),
    entryPackages: bundleEntryPackages(details, origToStripped, pkgOf),
    // Preserve recorded file ownership for dependency-cycle classification.
    ownSourceFiles: new Set(ownFiles),
    reasons: [...reasons.keys()],
  }
}

// Always bundle context — these helpers serve only the bundle Graph
// tab, so the selection card's Files → / View source → branch picks
// View source. Dispatch into lazy `ui/graph.js` so its
// `<graph-layout>` shadow-DOM render code stays out of view.js.
export function refreshBundleGraphSidebar() {
  if (!_currentBundlePrep) return
  const mod = loadedGraphMod()
  if (!mod) return
  mod.refreshSidebar(_currentBundlePrep, { isBundleContext: true, findingsJump: !isManagedUiMode() })
}

export function refreshBundleGraphTopPkgs() {
  if (!_currentBundlePrep) return
  const mod = loadedGraphMod()
  if (!mod) return
  mod.refreshTopPkgs(_currentBundlePrep)
}

export function setCurrentBundleGraphPrep(prep) {
  _currentBundlePrep = prep
}
// Per-package size visualization for the bundles details panel.
// Builds a horizontal stacked bar (segments proportional to each
// package's total source-byte size) plus a sorted breakdown row
// per package. Mirrors the graph2 distribution chrome on the right
// panel — same `pkgColor` palette so the colors carry meaning
// across both views (a `@noble/hashes` package shows the same hue
// in the bundle-size chart and the canvas).
function renderBundleSizeDistribution(items, sort, details) {
  // items: Array<{path, size, pkgDir}>; size may be 0 / null when the
  // bundle didn't carry per-source content (rare for sourcemaps).
  // `pkgDir` is the path's stasis package dir (undefined for sourcemap
  // bundles), so workspace packages bucket apart from their parent dir.
  const totalByPkg = new Map()
  const whyQueries = new Map()
  let total = 0
  for (const { path, size, pkgDir } of items) {
    if (typeof size !== 'number' || size <= 0) continue
    const pkg = bundlePkgOf(path, { packageDir: pkgDir })
    totalByPkg.set(pkg, (totalByPkg.get(pkg) ?? 0) + size)
    if (!whyQueries.has(pkg)) whyQueries.set(pkg, bundleWhyQuery(details, pkgDir))
    total += size
  }
  if (total === 0) return nothing
  const sorted = [...totalByPkg.entries()].toSorted((a, b) => Number(b[0] === '__own__') - Number(a[0] === '__own__')
    || (sort === 'size' ? b[1] - a[1] : 0)
    || pkgLabel(a[0]).localeCompare(pkgLabel(b[0])) || a[0].localeCompare(b[0]))
  return html`<div class="bundles-dist">
    <div class="bundles-dist-bar" aria-hidden="true">
      ${repeat(sorted, ([pkg]) => pkg, ([pkg, size]) => html`<span
        class="bundles-dist-seg"
        style=${styleMap({ flexGrow: size, background: pkgColor(pkg) })}
        data-tooltip=${pkg === '__own__' ? nothing : `${pkg}: ${formatBytes(size)}`}
      ></span>`)}
    </div>
    <ul class="bundles-dist-list">
      ${repeat(sorted, ([pkg]) => pkg, ([pkg, size]) => {
        const pct = (size / total * 100).toFixed(1)
        // When the name is clipped, show the full package key.
        const label = pkgLabel(pkg)
        const c = pkgColor(pkg)
        const query = whyQueries.get(pkg)
        return html`<li>
          <span class="bundles-dist-dot" style=${styleMap({ background: c })}></span>
          ${query ? html`<button type="button" class="bundles-dist-pkg" aria-haspopup="dialog"
            aria-label=${`Show dependency chains for ${label}`} @click=${() => openBundleWhy(details, query)}
            data-tooltip-truncated data-tooltip=${pkg}>${label}</button>`
            : html`<span class="bundles-dist-pkg" data-tooltip-truncated data-tooltip=${pkg === '__own__' ? nothing : pkg}>${label}</span>`}
          <span class="bundles-dist-bar-row" aria-hidden="true">
            <span class="bundles-dist-bar-fill" style=${styleMap({ width: `${pct}%`, background: c })}></span>
          </span>
          <span class="bundles-dist-size">${formatBytes(size)}</span>
          <span class="bundles-dist-percent">${pct}%</span>
        </li>`
      })}
    </ul>
  </div>`
}

function openBundleWhy(details, query) {
  const team = state.currentManagedTeam, workspace = state.currentWorkspace
  const session = state.managedSession && store(state.managedSession)
  return openWhyDialog({ details, ...query, isCurrent: () => state.currentView === 'bundles'
    && state.selectedBundle === details.integrity && (state.bundleDetails && store(state.bundleDetails)) === store(details)
    && state.currentWorkspace === workspace && state.currentManagedTeam === team
    && (state.managedSession && store(state.managedSession)) === session })
}

// Sources panel for the bundles details view — shared between the
// sourcemap and stasis branches of `renderBundleDetails`. Wraps
// the metadata block + per-package size visualization + flat file
// list (+ the matching-reports list when any report contributes),
// laid out as side-by-side Packages / Files / Reports columns
// under the summary (see the Overview body comment below).
//
// `sources` and `sizes` are parallel arrays — same indices, same
// length. Sizes may be null when content wasn't shipped in the
// bundle (uncommon for sourcemaps).
//
// `exportsCol` is the Overview's exports column (Download bundle, …),
// built once by the caller (`renderBundleDetails`) so it rides every
// Overview branch — parsed or not — from a single source. It renders
// as the third column of `.bundles-detail-meta-row`.
//
// `resources` is the set of `sources` entries that are assets (images,
// fonts) rather than source — a stasis notion, null for sourcemaps. They
// weigh in the Packages column and list among the Files like any other
// file, but are counted apart from Sources and open no source viewer:
// there is no source to show.
//
// `unpackedSize` is the bytes every listed file adds up to once unpacked —
// what the Packages column totals — shown beside the artifact's own Size.
// Null leaves the row out.
function renderBundleSourcesPanel(renderMeta, extras, sources, sizes, packageDirs, exportsCol, { bundleSize = null, unpackedSize = null, resources = null, details = null } = {}) {
  const { prefix, stripped } = stripCommonPathPrefix(sources)
  // Package identities use original paths and recorded module boundaries;
  // the stripped paths are only for displaying the file list.
  const pkgDirOf = (i) => packageDirs?.get(sources[i])
  const packages = new Set()
  for (let i = 0; i < stripped.length; i++) {
    packages.add(bundlePkgOf(sources[i], { packageDir: pkgDirOf(i) }))
  }
  // Name ascends; Size puts the largest files first, with unknown
  // sizes last and name order breaking ties in either view.
  const filesSort = state.bundleOverviewFilesSort
  const order = stripped
    .map((_, i) => i)
    .toSorted((a, b) => (filesSort === 'size' ? (sizes[b] ?? -1) - (sizes[a] ?? -1) : 0)
      || stripped[a].localeCompare(stripped[b]))

  const distItems = sources.map((p, i) => ({ path: p, size: sizes[i], pkgDir: pkgDirOf(i) }))
  // `renderBundleSizeDistribution` returns `nothing` when no source
  // carries a positive byte size (common for stasis bundles without
  // inline `sourcesContent`). Mirror the Files / Reports column
  // empty-state so the Packages column doesn't render as a card
  // with a header and a yawning blank body.
  const packagesSort = state.bundleOverviewPackagesSort
  const distContent = renderBundleSizeDistribution(distItems, packagesSort, details)
  const distTpl = distContent === nothing
    ? html`<p class="bundles-overview-col-empty">No size information for this bundle's sources.</p>`
    : distContent

  // Issue summary — total findings across the bundle's matched
  // files, broken down by severity (same chip palette the Files
  // tab in the report's tree view uses). Empty when no findings
  // match yet (hashes still computing, no relevant reports
  // indexed). Drives whether the "Issues →" trailing button gets
  // rendered too.
  // Reports — distinct OPFS reports any matched finding came from
  // (preserves walk order via reportsForFinding's Set iteration).
  // Drives the conditional Reports tab below.
  const issueSummary = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  let issueTotal = 0
  // Per-report match count — how many of the bundle's matched
  // findings came from each indexed OPFS report. Used by the
  // Reports tab to caption each chip with its contribution. A
  // single finding can show up under multiple reports (the same
  // entry indexed from both a workspace export and the original
  // dump), so each finding counts toward every report it appears
  // in.
  const reportCounts = new Map()
  if (state.bundleDetails?.fileHashes) {
    const matches = bundleFindingsByFile(state.bundleDetails.fileHashes, 'issues')
    for (const findings of matches.values()) {
      for (const f of findings) {
        if (issueSummary[f.severity] !== undefined) issueSummary[f.severity]++
        issueTotal++
        for (const name of reportsForFinding(f.fileHash, f)) {
          reportCounts.set(name, (reportCounts.get(name) ?? 0) + 1)
        }
      }
    }
  }
  const reports = [...reportCounts.keys()].toSorted()

  const issueChips = SEVERITIES
    .filter((s) => issueSummary[s] > 0)
    .map((s) => html`<span class=${`tree-count-chip ${s}`}>${issueSummary[s]} ${s.replaceAll('_', ' ')}</span>`)
  // Each source row is a button so the whole strip is a click target +
  // keyboard-focusable; data-bundle-view-source carries the full
  // (un-stripped) path for the source viewer modal. Source rows render
  // as buttons regardless of whether the bundle carries content
  // (the click handler checks bundleSourcesAsMap and shows an
  // empty placeholder when content is missing). A resource has no
  // source to view at all, so its row is plain text.
  const filesTpl = sources.length > 0 ? html`<ul class="bundles-sources-list">
    ${order.map((i) => {
      const src = sources[i]
      const size = sizes[i]
      const row = html`<span class="bundles-source-path" data-tooltip-truncated data-tooltip=${src}>${stripped[i]}</span>
        ${size == null ? nothing : html`<span class="bundles-source-size">${formatBytes(size)}</span>`}`
      return html`<li>${resources?.has(src)
        ? html`<div class="bundles-source-row is-resource">${row}</div>`
        : html`<button type="button" class="bundles-source-row" data-bundle-view-source=${src}>${row}</button>`}</li>`
    })}
  </ul>` : html`<p class="bundles-overview-col-empty">No source files in this bundle.</p>`
  // Reports list — same brand-sticker chip the Issues tab uses on
  // each row, sized up so it reads as a list rather than a row
  // affordance. data-bundle-issue-report wires into the existing
  // events.js delegate that calls switchToFile.
  const reportsTpl = reports.length > 0 ? html`<ul class="bundles-reports-list">
    ${reports.map((name) => {
      const iconHtml = FILE_ICONS[groupOf(name)] ?? FILE_ICONS.default
      const count = reportCounts.get(name) ?? 0
      return html`<li>
        <button type="button" class="report-chip bundles-report-chip" data-bundle-issue-report=${name}>
          ${unsafeHTML(iconHtml)}<span class="report-chip-label" data-tooltip-truncated data-tooltip=${name}>${displayName(name)}</span>
          <span class="bundles-report-count">${count} ${count === 1 ? 'issue' : 'issues'}</span>
        </button>
      </li>`
    })}
  </ul>` : html`<p class="bundles-overview-col-empty">No matching reports indexed yet.</p>`

  // Overview body — metadata blocks on top, three side-by-side
  // columns (Packages / Files / Reports) below. The two meta groups
  // share a `.bundles-detail-meta-row` that pairs them into
  // side-by-side columns once the summary is wide enough for both
  // (700px each) and stacks them otherwise. Each column has its
  // own header + scroll container so a 2000-file bundle doesn't
  // stretch the meta block off-screen. The Reports column only
  // renders when at least one OPFS report carries findings that
  // match the bundle's files (no point in a column with a single
  // empty-state line when the bundle's just sitting there waiting
  // for an analyzer dump). The outer wrapper is a flex column so
  // the columns row takes the remaining height after the meta /
  // chips, and CSS handles the per-column scroll.
  return html`<div class="bundles-overview">
    <div class="bundles-overview-summary">
      <div class="bundles-detail-meta-row">
        ${renderMeta(prefix)}
        <dl class="bundles-detail-meta">
          ${extras}
          <dt>Sources</dt><dd>${sources.length - (resources?.size ?? 0)}</dd>
          ${bundleSize == null ? nothing : html`<dt>Size</dt><dd>${formatBytes(bundleSize)}</dd>`}
          ${unpackedSize == null ? nothing : html`<dt>Unpacked</dt><dd>${formatBytes(unpackedSize)}</dd>`}
          ${resources?.size ? html`<dt>Resources</dt><dd>${resources.size}</dd>` : nothing}
        </dl>
        ${exportsCol ?? nothing}
      </div>
      ${issueTotal > 0 ? html`<div class="bundles-issue-summary tree-count-chips">${issueChips}</div>` : nothing}
    </div>
    <div class="bundles-overview-columns">
      <section class="bundles-overview-col">
        <header class="bundles-overview-col-head">
          <span class="bundles-overview-col-title">Packages <span class="bundles-overview-col-count">${packages.size}</span></span>
          <span class="bundles-overview-sort" role="group" aria-label="Package order">
            ${[['name', 'Name'], ['size', 'Size']].map(([value, label]) => html`<button type="button" aria-pressed=${String(packagesSort === value)} @click=${() => { state.bundleOverviewPackagesSort = value; render() }}>${label}</button>`)}
          </span>
        </header>
        <div class="bundles-overview-col-body">${distTpl}</div>
      </section>
      <section class="bundles-overview-col">
        <header class="bundles-overview-col-head">
          <span class="bundles-overview-col-title">Files <span class="bundles-overview-col-count">${sources.length}</span></span>
          <span class="bundles-overview-sort" role="group" aria-label="File order">
            ${[['name', 'Name'], ['size', 'Size']].map(([value, label]) => html`<button type="button" aria-pressed=${String(filesSort === value)} @click=${() => { state.bundleOverviewFilesSort = value; render() }}>${label}</button>`)}
          </span>
        </header>
        <div class="bundles-overview-col-body bundles-overview-col-body--list">${filesTpl}</div>
      </section>
      ${reports.length > 0 ? html`<section class="bundles-overview-col">
        <header class="bundles-overview-col-head">
          Reports <span class="bundles-overview-col-count">${reports.length}</span>
        </header>
        <div class="bundles-overview-col-body bundles-overview-col-body--list">${reportsTpl}</div>
      </section>` : nothing}
    </div>
  </div>`
}

// Source viewer overlay — opens on top of any bundles view (regular
// or slide) when state.bundleSourceFile is set. Reads the open
// bundle's source map / stasis content via bundleSourcesAsMap;
// missing entries (sourcemap with no `sourcesContent`, stasis
// without that file) render as a placeholder line. Body is a plain
// `<pre><code>` with a CSS-counter-driven gutter so we don't have
// to slice the source per line — Lit interpolation auto-escapes
// the content, no XSS risk. Click-outside / × button / Escape all
// dismiss; the close handler clears state.bundleSourceFile.
// Cache: integrity\0path → highlighted HTML string (or null when
// prism doesn't support the language / failed). Persists for the
// session so re-opens of the same file are instant.
const _bundleHighlightCache = new Map()
const _bundleHighlightPending = new Set()

// A package's icon in the Code slide, by its ecosystem.
const packageIconFor = ecosystem => ecosystem === 'composer' ? sourceComposerIcon : ecosystem === 'cargo' ? sourceCargoIcon : ecosystem === 'soldeer' ? sourceSoldeerIcon : sourceNpmIcon

// Copy glyph for the Code slide's copy-path button — same two-rect
// shape and stroke weight as the finding card's copy action.
// Wrap toggle for a source viewer's bar. Hidden until source-wrap.js finds
// wrapping makes a difference to the open file at the viewer's width.
const WRAP_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5h12M2 8h9a2.5 2.5 0 0 1 0 5H8.5M10 11.5 8.5 13l1.5 1.5M2 13h3.5"/></svg>`
const renderSourceWrapToggle = () => html`<button type="button" class="bundle-source-wrap-toggle" data-bundle-source-wrap hidden
  aria-pressed=${state.bundleSourceWrap ? 'true' : 'false'} aria-label="Wrap lines" data-tooltip="Wrap lines">${WRAP_ICON}</button>`

const COPY_PATH_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <rect x="3" y="2.5" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
  <rect x="5.5" y="5" width="8" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

// Auto-pick bookkeeping for the Code slide. When the pick ran
// before any findings were indexed (page refresh straight into the
// Code tab: the hash pass and the OPFS finding index both land
// AFTER the first parsed render), the fallback file (entry /
// largest) is remembered here so a later render — once findings
// arrive — can upgrade the selection to the worst-issue file. The
// upgrade fires at most once, and only while the selection still IS
// the untouched fallback; any manual navigation drops the tracking.
let _bundleCodeAutoPick = null

// Bring the Code rail's selected file row into view. Deferred a
// microtask so it runs after Lit commits the pass that's currently
// building templates; `nearest` keeps the rail still when the row
// is already visible (tree links carry a scroll-margin so an
// off-screen reveal lands with breathing room). Shared with
// events.js (tab-switch / rail-mode-change reveals).
export function revealBundleCodeCurrent() {
  queueMicrotask(() => {
    document.querySelector('.bundle-code-rail-body .bundle-code-tree-link.current')
      ?.scrollIntoView({ block: 'nearest' })
  })
}

// Pick the worst severity (top of SEVERITIES order) among the
// findings on a given line so the gutter dot reads as the most
// urgent issue. Multiple findings on one line still resolve to a
// single dot — clicking it opens the panel which lists all of
// them.
function _topSeverityOf(findings) {
  for (const sev of SEVERITIES) {
    for (const f of findings) {
      if (f.severity === sev) return sev
    }
  }
  return findings[0]?.severity ?? null
}

// Per-line rendering for the source viewer. Renders a sticky
// gutter (one row per line) next to a single `<pre>` holding the
// full source. Two columns rather than per-line interleaving so
// prism's highlighted output (where tokens may span newlines)
// stays valid HTML — the pre takes the highlighted string as-is
// via unsafeHTML, the gutter walks lines by index. line-height
// matches across both columns so the rows align with their lines.
//
// `lineFindings` (Map<line, Finding[]>) drives the per-line dot in
// the gutter. Lines without findings render a plain number. The line
// a clicked result opened (state.bundleSourceTargetLine) gets a band
// across gutter and code (`.is-target`).
function renderBundleSourceLines(content, path, details, lineFindings, matchLines = null) {
  const lineCount = content.split('\n').length
  const target = state.bundleSourceTargetLine
  const targetLine = target && target.path === path && target.bundle === (details?.integrity ?? null) ? target.line : null
  const digits = String(lineCount).length
  const lang = langForPath(path, details?.kind === 'stasis' ? details.bundle?.formats?.get(path) : undefined)
  const cacheKey = `${details?.integrity ?? ''}\0${path}`
  // Trigger prism asynchronously on first sight of this file.
  // The cache value is undefined initially; once the highlight
  // resolves we set it (string for success, null for "no highlight
  // available") and re-render so the unsafeHTML branch picks it up.
  if (lang && !_bundleHighlightCache.has(cacheKey) && !_bundleHighlightPending.has(cacheKey)) {
    _bundleHighlightPending.add(cacheKey)
    // Fire-and-forget: the highlight runs in the background and
    // the next render() call (kicked from inside) injects the
    // result via unsafeHTML. Async IIFE rather than `.then` so
    // the empty `.then` body doesn't trip promise/always-return.
    ;(async () => {
      const highlightedHtml = await prismHighlight(content, lang, bundleSourceLinkResolver(details, path))
      _bundleHighlightCache.set(cacheKey, highlightedHtml ?? null)
      _bundleHighlightPending.delete(cacheKey)
      // Cheap re-render — Lit only patches what changed, so the cost
      // is just the highlighted string injected via unsafeHTML.
      if (state.bundleSourceFile === path) render()
    })()
  }
  const highlighted = _bundleHighlightCache.get(cacheKey)
  return html`<div class=${classMap({ 'bundle-source-lines': true, 'is-wrapped': state.bundleSourceWrap })} style=${styleMap({ '--lineno-width': `${digits}ch` })} ${ref(watchSourceWrap)}>
    <aside class="bundle-source-lineno-col" aria-hidden="true">
      ${Array.from({ length: lineCount }, (_, i) => {
        const ln = i + 1
        const entries = lineFindings.get(ln)
        const sev = entries ? _topSeverityOf(entries.map((e) => e.f)) : null
        const isActive = entries && state.bundleSourceFindingIdx != null
          && entries.some((e) => e.idx === state.bundleSourceFindingIdx)
        return html`<div class=${classMap({ 'bundle-source-lineno-row': true, 'is-match': matchLines?.has(ln) ?? false, 'is-target': ln === targetLine })} data-line=${ln}>
          ${entries
            ? html`<button
                type="button"
                class=${classMap({ 'bundle-source-dot': true, [`sev-${sev}`]: true, active: isActive })}
                data-bundle-source-finding=${entries[0].idx}
                data-tooltip=${`${entries.length} ${entries.length === 1 ? 'issue' : 'issues'} on line ${ln}`}
                aria-label=${`${entries.length} issues on line ${ln}`}
              ></button>`
            : html`<span class="bundle-source-dot-placeholder"></span>`}
          <span class="bundle-source-lineno-num">${ln}</span>
        </div>`
      })}
    </aside>
    <pre class="bundle-source-code" tabindex="-1" aria-label=${path}><code class=${lang ? `language-${lang}` : ''}>${typeof highlighted === 'string'
      ? unsafeHTML(highlighted)
      : content}</code></pre>
  </div>`
}

// Side panel inside the source viewer modal — populated when
// state.bundleSourceFindingIdx points at one of the file's
// findings. Shows the severity badge, description, line, and (if
// any) the OPFS report names that contributed the finding so the
// user can hop over from the viewer.
function renderBundleSourceFindingPanel(findings) {
  const idx = state.bundleSourceFindingIdx
  if (idx == null) return nothing
  const f = findings[idx]
  if (!f) return nothing
  const reports = f.fileHash ? reportsForFinding(f.fileHash, f) : []
  // Shared triage can be displayed across reports. Dependency report ignores
  // stay local to their report and have no aggregate badge.
  const triage = sharedFindingTriage(f, state.triage.get(tabKey(f)))
  const triageLabel = triage === 'fixed' ? 'Fixed' : triage === 'inprogress' ? 'In progress' : triage === 'ignored' ? 'Ignored' : null
  // Run meta — analyzer / model / effort / exportsMode chained
  // with `·`, same shape the report's tab-body uses (see
  // render-finding.js's `meta`). Sits to the right of the Line
  // row in the panel body so the header stays compact (just
  // severity + triage badge + close); empty when none of the
  // fields are populated.
  const meta = formatRunMeta(f)
  const lineLabel = formatFindingLine(f.line)
  return html`<aside class="bundle-source-panel">
    <header class="bundle-source-panel-bar">
      <span class=${`bundle-source-panel-sev sev-${f.severity}`}>${f.severity.replaceAll('_', ' ')}</span>
      ${triageLabel ? html`<span class=${`bundle-source-panel-triage triage-${triage}`}>${triageLabel}</span>` : nothing}
      <button
        type="button"
        class="bundle-source-panel-close"
        data-action="bundle-source-panel-close"
        aria-label="Close finding details"
      >×</button>
    </header>
    <div class="bundle-source-panel-body">
      ${(lineLabel || meta) ? html`<div class="bundle-source-panel-line-row">
        ${lineLabel ? html`<span class="bundle-source-panel-line">${lineLabel}</span>` : nothing}
        ${meta ? html`<span class="bundle-source-panel-meta" data-tooltip-truncated data-tooltip=${meta}>${meta}</span>` : nothing}
      </div>` : nothing}
      <div class="bundle-source-panel-desc">${renderHighlighted(titledDescription(f), { paragraphs: false })}</div>
      ${reports.length > 0 ? html`<div class="bundle-source-panel-reports">
        <div class="bundle-source-panel-reports-label">Reported by</div>
        ${reports.map((name) => {
          const iconHtml = REPORT_LOGOS[groupOf(name)] ?? REPORT_LOGOS.default
          return html`<button
            type="button"
            class="report-chip bundle-source-panel-report"
            data-bundle-issue-report=${name}
          >${unsafeHTML(iconHtml)}<span class="report-chip-label" data-tooltip-truncated data-tooltip=${name}>${displayName(name)}</span></button>`
        })}
      </div>` : nothing}
    </div>
  </aside>`
}

// Per-file findings for the source viewer: the flat list (indexed
// for the side panel) + a line→entries map for the gutter dots.
// Shared by the source-viewer modal, the Code slide's right pane,
// and the Search slide's right sidebar. Empty until the async hash
// pass populates `details.fileHashes`.
function bundleViewerFindings(details, path, content) {
  const fileFindings = []
  const lineFindings = new Map()
  if (typeof content === 'string' && details?.fileHashes) {
    const matches = bundleFindingsByFile(details.fileHashes, 'issues')
    const onThisFile = matches.get(path) ?? []
    for (let i = 0; i < onThisFile.length; i++) {
      const f = onThisFile[i]
      fileFindings.push(f)
      const ln = parseInt(f.line, 10)
      if (Number.isFinite(ln) && ln > 0) {
        if (!lineFindings.has(ln)) lineFindings.set(ln, [])
        lineFindings.get(ln).push({ f, idx: i })
      }
    }
  }
  return { fileFindings, lineFindings }
}

// Title bar shared by the source-viewer modal and the Search tab's
// docked sidebar — path + the shared bundle-source-close action.
function renderBundleSourceBar(path, history = null) {
  return html`<header class="bundle-source-bar">
      <div class="bundle-source-title mono" data-tooltip-truncated data-tooltip=${path}>${path}</div>
      ${history?.files.length > 1 ? renderBundleCodeFileNav(history) : nothing}
      ${renderSourceWrapToggle()}
      <button
        type="button"
        class="bundle-source-close"
        data-action="bundle-source-close"
        aria-label="Close source viewer"
      >×</button>
    </header>`
}

// Code wrap + finding side panel — the viewer body every source
// surface (modal, Code slide main pane, Search sidebar) renders.
function renderBundleSourceCodeWrap(path, content, details, fileFindings, lineFindings, matchLines = null) {
  return html`<div class="bundle-source-code-wrap">
        ${typeof content === 'string'
          ? renderBundleSourceLines(content, path, details, lineFindings, matchLines)
          : html`<div class="bundle-source-empty">Source content not bundled.</div>`}
      </div>
      ${renderBundleSourceFindingPanel(fileFindings)}`
}

// Public so render.js can mount it into the global overlay slot
// (`#bundle-source-overlay-slot` in index.html). The modal needs
// to overlay any view — the finding-card's [Code] shortcut
// pops it from the findings view without switching the user to
// the bundles view first.
export function renderBundleSourceModal() {
  const path = state.bundleSourceFile
  if (!path) return nothing
  // In the Code and Search slides the source already renders inline
  // (Code's right pane / Search's right sidebar); suppress the modal
  // so it doesn't stack over the slide. The slide owns
  // bundleSourceFile while it's active and resets it on slide exit
  // (events.js's tab-switch handler).
  if (state.bundleDetailsTab === 'code' || state.bundleDetailsTab === 'search') return nothing
  const details = state.bundleDetails
  const error = details?.sourceError || details?.error
  // A cold open has no details yet; a metadata-only open is still fetching
  // the bodies. Neither tells us whether this file's content was bundled.
  const loading = !error && (!details || details.metadataOnly === true)
  const sources = bundleSourcesAsMap(details)
  const content = sources.get(path)
  // Find this file's matched findings (bundle Issues filter: live +
  // in-progress + fixed + ignored, minus invalid / deleted) and bucket
  // by line so the gutter can stamp dots.
  // The map is also passed to the side panel: clicking a dot picks
  // the first finding on that line by default.
  const { fileFindings, lineFindings } = bundleViewerFindings(details, path, content)
  return html`<div class="bundle-source-overlay">
    <div class=${classMap({ 'bundle-source-modal': true, 'with-panel': state.bundleSourceFindingIdx != null })}>
      ${renderBundleSourceBar(path, bundleFileHistory(state.bundleCodeHistory, details?.integrity ?? null, path))}
      <div class="bundle-source-body" aria-busy=${String(loading)}>
        ${error ? html`<div class="bundles-slide-placeholder is-error" role="status">Failed to load source: ${error}</div>`
          : loading ? html`<div class="bundles-slide-placeholder" role="status">Loading source…</div>`
          : renderBundleSourceCodeWrap(path, content, details, fileFindings, lineFindings)}
      </div>
    </div>
  </div>`
}

// Remember deliberate expansion separately from search: filtering temporarily
// opens matching branches without losing the user's unfiltered layout.
// Keys use the first directory in a compact row, so changing its displayed
// chain while filtering doesn't change the identity of the disclosure.
const _bundleTreeUserOpen = new Map()
let _bundleTreeMapBundle = null
let _bundleTreeCurrentPath = null

function openBundleTreeAncestors(path, prefix) {
  const parts = stripPathPrefix(path ?? '', prefix).split('/')
  for (let i = 1; i < parts.length; i++) _bundleTreeUserOpen.set(parts.slice(0, i).join('/'), true)
}

function revealBundleTreeFile(path, prefix) {
  state.bundleCodeSearchMode = 'files'
  state.bundleCodeSearchQuery = ''
  openBundleTreeAncestors(path, prefix)
  render()
  revealBundleCodeCurrent()
}

function collapseBundleTree(tree) {
  const walk = (node) => {
    for (const child of node.dirs.values()) {
      _bundleTreeUserOpen.set(child.path, false)
      walk(child)
    }
  }
  walk(tree)
  render()
}

// Aggregate issue count + worst severity across every file under a
// dir node — the rollup chip a directory row shows so issue
// hotspots stay visible while the subtree is collapsed. Walks the
// (already-remapped) file values, so lookups hit the orig-path-keyed
// issueIndex directly. O(subtree) per dir, O(files × depth) for the
// whole tree — fine at bundle scale.
function dirIssueStats(node, issueIndex) {
  let count = 0
  let worst = null
  if (!issueIndex || issueIndex.size === 0) return { count, worst }
  const walk = (n) => {
    for (const full of n.files.values()) {
      const findings = issueIndex.get(full)
      if (!findings || findings.length === 0) continue
      count += findings.length
      const sev = _topSeverityOf(findings)
      if (worst === null || (SEVERITY_ORDER[sev] ?? 0) > (SEVERITY_ORDER[worst] ?? 0)) worst = sev
    }
    for (const d of n.dirs.values()) walk(d)
  }
  walk(node)
  return { count, worst }
}

// Recursive directory + file rendering for the Code slide's tree
// rail. Open the first level by default; deeper levels collapse
// so the user can drill in. Selected file gets a `current` class
// for its background; the click target is the data-bundle-
// view-source delegate (same one the Files tab uses).
function renderBundleSourceTree(node, currentPath, depth = 0, issueIndex = null, expandAll = false, formats = null, sources = null) {
  const dirs = [...node.dirs.entries()].toSorted(([a, an], [b, bn]) => sourceDirectoryLabel(a, an).localeCompare(sourceDirectoryLabel(b, bn)) || an.path.localeCompare(bn.path))
  const files = [...node.files.entries()].toSorted(([a], [b]) => a.localeCompare(b))
  // Auto-open dirs that contain the currently selected file so
  // the tree spotlights it on slide-open.
  const containsCurrent = (n) => {
    if (!currentPath) return false
    for (const p of n.files.values()) if (p === currentPath) return true
    for (const d of n.dirs.values()) if (containsCurrent(d)) return true
    return false
  }
  // Search opens every matching branch. Otherwise preserve manual toggles,
  // defaulting to the first level and ancestors of the selected source.
  // live(.open) also reconciles native summary toggles on the next render.
  const computeOpen = (childPath, child) => {
    if (expandAll) return true
    if (_bundleTreeUserOpen.has(childPath)) return _bundleTreeUserOpen.get(childPath)
    return depth === 0 || containsCurrent(child)
  }
  // Click precedes the browser's native toggle, including Enter/Space.
  // Listening to toggle would also record programmatic search expansion.
  const onSummaryClick = (childPath) => (e) => {
    _bundleTreeUserOpen.set(childPath, !e.currentTarget.parentElement.open)
  }
  return html`<ul class=${classMap({ 'bundle-code-tree': true, root: depth === 0 })}
    aria-label=${depth === 0 ? 'Source files' : nothing}
    @keydown=${depth === 0 ? navigateBundleSourceTree : nothing}
  >
    ${repeat(dirs, ([, child]) => child.path, ([name, child]) => {
      const childPath = child.path
      const compact = compactSourceDirectory(name, child, depth)
      const pkg = child.package
      const vendored = pkg?.ecosystem === 'cargo' || pkg?.ecosystem === 'composer' || pkg?.ecosystem === 'soldeer'
      const packageIcon = packageIconFor(pkg?.ecosystem)
      const tooltip = pkg?.variant ? `${compact.node.sourcePath}\nVariant ${pkg.variant}` : compact.node.sourcePath
      const info = child.packageInfo
      const hasDetails = !!info || !!pkg?.variant
      // Size and LoC read every source in the package, so count them only
      // when its tooltip shows: after the hover delay, not for a pointer
      // passing over the row on its way somewhere else.
      const weigh = info && sources ? (el) => {
        const { bytes, loc } = bundlePackageSourceStats(sources, child.sourcePath)
        Object.assign(el.dataset, { tooltipLoc: String(loc), tooltipSize: formatBytes(bytes) })
      } : undefined
      // Rollup chip — total findings under this dir, colored by the
      // worst severity present, so a collapsed subtree still shows
      // where the issues live (the per-file chips only help once
      // it's expanded).
      const stats = dirIssueStats(child, issueIndex)
      return html`<li class="bundle-code-tree-dir">
        <details .open=${live(computeOpen(childPath, child))}>
          <summary @click=${onSummaryClick(childPath)} .prepareTooltip=${weigh}
            data-tooltip-package=${info?.name ?? nothing}
            data-tooltip-ecosystem=${info?.ecosystem ?? nothing}
            data-tooltip-version=${info?.version ?? nothing}
            data-tooltip-files=${info?.fileCount ?? nothing}
            data-tooltip-repo=${info?.github ? info.github + (info.directory ? `/${info.directory}` : '') : nothing}
            data-tooltip-commit=${info?.commit ?? nothing}
            data-tooltip=${hasDetails ? tooltip : nothing}
            data-tooltip-placement=${hasDetails ? 'right-start' : nothing}>
            <span class="bundle-code-tree-chevron" aria-hidden="true"></span>
            ${pkg ? packageIcon : nothing}
            <span class=${classMap({ 'bundle-code-tree-dirname': true, 'bundle-code-tree-package': !!pkg, 'bundle-code-tree-package-vendored': vendored })}
              data-tooltip-truncated data-tooltip=${hasDetails ? nothing : tooltip}>
              ${pkg ? html`<span class="bundle-code-tree-package-name">${pkg.name}</span>${pkg.version ? html`<span class="bundle-code-tree-package-version">${vendored ? '- ' : '@'}${pkg.version}</span>` : nothing}` : compact.names.map((part, index) => html`${index > 0 ? html`<span class="bundle-code-tree-separator">/</span>` : nothing}${part}`)}
            </span>
            ${pkg?.variant ? html`<span class="bundle-code-tree-variant">variant ${pkg.variant}</span>` : nothing}
            ${stats.count > 0 ? html`<span class=${`bundle-code-tree-count sev-${stats.worst}`} data-tooltip=${`${stats.count} ${stats.count === 1 ? 'issue' : 'issues'} inside`}>${stats.count}</span>` : nothing}
          </summary>
          ${renderBundleSourceTree(compact.node, currentPath, depth + 1, issueIndex, expandAll, formats, sources)}
        </details>
      </li>`
    })}
    ${repeat(files, ([, full]) => full, ([name, full]) => {
      // Per-file issue chip — tiny pill with the count, colored by
      // the worst severity present on the file. Skipped when the
      // file has no matched findings (keeps clean files quiet).
      const findings = issueIndex?.get(full)
      const sev = findings && findings.length > 0 ? _topSeverityOf(findings) : null
      const count = findings?.length ?? 0
      return html`<li class="bundle-code-tree-file">
        <button
          type="button"
          class=${classMap({ 'bundle-code-tree-link': true, current: full === currentPath })}
          data-bundle-view-source=${full}
          aria-current=${full === currentPath ? 'true' : nothing}
        >
          ${sourceFileIcon(full, formats?.get(full))}<span class="bundle-code-tree-name" data-tooltip-truncated data-tooltip=${full}>${name}</span>
          ${count > 0 ? html`<span class=${`bundle-code-tree-count sev-${sev}`} data-tooltip=${`${count} ${count === 1 ? 'issue' : 'issues'}`}>${count}</span>` : nothing}
        </button>
      </li>`
    })}
  </ul>`
}

// Prefix-stripped display form of a bundle path — the shared root is
// shown once above the rail / in the summary line, so rows don't
// repeat it. Falls back to the full path when it doesn't start with
// `prefix` (defensive — shouldn't happen since the prefix is derived
// from the same set).
function stripPathPrefix(p, prefix) {
  return prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p
}

// Filter the full presentation so package boundaries and variant labels stay
// stable. Both physical paths and the displayed package names are searchable.
function renderBundleCodeFilesPanel(tree, currentPath, query, issueIndex, prefix = '', formats = null, sources = null) {
  if (!query) return renderBundleSourceTree(tree, currentPath, 0, issueIndex, false, formats, sources)
  const filtered = filterBundleSourceTree(tree, query, prefix)
  if (!filtered) {
    return html`<div class="bundle-code-search-empty">No files match.</div>`
  }
  // expandAll: filtered tree only contains matches; every dir
  // exists because something inside it matched, so opening them
  // all means the user sees every hit at a glance instead of
  // having to click every level open after typing.
  return renderBundleSourceTree(filtered, currentPath, 0, issueIndex, true, formats, sources)
}

// The Code rail's hit rows fit ~40 mono chars at the default rail
// width before the CSS ellipsis, so a match further along would be
// marked but off screen. When the first match sits past
// RAIL_HIT_VISIBLE chars of text (indentation doesn't count — the row
// collapses it), start the row RAIL_HIT_LEAD chars before the match
// behind a `…`. RAIL_HIT_MAX caps the rendered text.
const RAIL_HIT_MAX = 200
const RAIL_HIT_VISIBLE = 28
const RAIL_HIT_LEAD = 12

function clipRailHit(text, ranges) {
  const first = ranges.length > 0 ? ranges[0][0] : 0
  const indent = text.length - text.trimStart().length
  const from = first - indent > RAIL_HIT_VISIBLE ? first - RAIL_HIT_LEAD : 0
  return sliceSearchLine(text, ranges, from, RAIL_HIT_MAX)
}

// Scan order shared by the Code rail's code search and the Search tab:
// own source first, then dependencies, each in path order. Cached per
// sources map, which bundleSourcesAsMap itself caches per bundle.
const searchOrderCache = new WeakMap()
function bundleSearchOrder(details, sources) {
  let order = searchOrderCache.get(sources)
  if (!order) {
    order = ownSourceFirst([...sources.keys()].toSorted(), bundlePackageDirs(details))
    searchOrderCache.set(sources, order)
  }
  return order
}

// Code-mode result pane — flat list of files, each with up to
// `MAX_HITS_PER_FILE` matching lines underneath. Each hit is a
// click target that selects the file AND scrolls the source
// viewer to the matching line (via `data-bundle-view-line`,
// which the events.js delegate forwards to the existing
// scroll-to-line path). Line text is shown truncated, with each match
// marked as in the Search tab. Case-insensitive substring search (the
// Search tab's matcher with both toggles off), own source before
// dependencies; empty query shows a hint.
function renderBundleCodeContentResults(details, sources, query, currentPath, prefix = '') {
  if (!query) {
    return html`<div class="bundle-code-search-hint">Type to search across every source in this bundle.</div>`
  }
  const matcher = buildSearchMatcher(query, false, false)
  const MAX_HITS_PER_FILE = 20
  const MAX_FILES = 100
  const results = []
  let totalHits = 0
  for (const path of bundleSearchOrder(details, sources)) {
    const content = sources.get(path)
    if (typeof content !== 'string') continue
    const hits = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const ranges = matcher.ranges(lines[i])
      if (ranges.length === 0) continue
      hits.push({ ln: i + 1, text: lines[i], ranges })
      totalHits++
      if (hits.length >= MAX_HITS_PER_FILE) break
    }
    if (hits.length > 0) results.push({ path, hits })
    if (results.length >= MAX_FILES) break
  }
  if (results.length === 0) {
    return html`<div class="bundle-code-search-empty">No matches.</div>`
  }
  return html`<div class="bundle-code-search-results">
    <div class="bundle-code-search-summary">${totalHits} ${totalHits === 1 ? 'hit' : 'hits'} in ${results.length} ${results.length === 1 ? 'file' : 'files'}</div>
    ${results.map(({ path: p, hits }) => {
      const bare = stripPathPrefix(p, prefix)
      return html`<div class=${classMap({ 'bundle-code-search-file': true, current: p === currentPath })}>
      <button
        type="button"
        class="bundle-code-search-file-name"
        data-bundle-view-source=${p}
        data-tooltip-truncated data-tooltip=${p}
      >${bare}</button>
      <ul class="bundle-code-search-hits">
        ${hits.map((h) => {
          const clip = clipRailHit(h.text, h.ranges)
          return html`<li class="bundle-code-search-hit">
          <button
            type="button"
            class="bundle-code-search-hit-link"
            data-bundle-view-source=${p}
            data-bundle-view-line=${h.ln}
            data-bundle-view-scroll-block="start"
          >
            <span class="bundle-code-search-hit-ln">${h.ln}</span>
            <span class="bundle-code-search-hit-text mono">${clip.clipped
              ? html`<span class="bundle-search-clip">…</span>`
              : nothing}${renderSearchMarks(clip.text, clip.ranges)}</span>
          </button>
        </li>`
        })}
      </ul>
    </div>`
    })}
  </div>`
}

// Issues-mode result pane — substring match against the bundle's
// matched findings (severity / file / description). Each hit
// renders as severity badge + path + description; clicking
// selects the file (the source viewer's per-line dot can then
// pick up the specific finding).
function renderBundleCodeIssuesResults(details, query, currentPath, prefix = '') {
  if (!details.fileHashes) {
    return html`<div class="bundle-code-search-empty">Computing file hashes…</div>`
  }
  const matches = bundleFindingsByFile(details.fileHashes, 'issues')
  if (matches.size === 0) {
    return html`<div class="bundle-code-search-empty">No issues match this bundle's files.</div>`
  }
  const q = query.toLowerCase()
  const flat = []
  // Track each finding's per-file index — that's what
  // bundleSourceFindingIdx points at when the source viewer's
  // side panel opens. Stamping it on the click target lets the
  // events.js delegate hand the index back to state directly.
  for (const [file, findings] of matches) {
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i]
      const desc = f.description ?? ''
      // Severity matches both its raw form and the space-separated
      // form the row label displays, so "high bug" and "high_bug"
      // both hit `high_bug` findings.
      if (q && !file.toLowerCase().includes(q)
            && !f.severity.includes(q)
            && !f.severity.replaceAll('_', ' ').includes(q)
            && !desc.toLowerCase().includes(q)) continue
      flat.push({ file, finding: f, fileIdx: i })
    }
  }
  flat.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.finding.severity] ?? 0
    const sb = SEVERITY_ORDER[b.finding.severity] ?? 0
    if (sb !== sa) return sb - sa
    return a.file.localeCompare(b.file)
  })
  if (flat.length === 0) {
    return html`<div class="bundle-code-search-empty">No matches.</div>`
  }
  return html`<div class="bundle-code-search-results">
    <div class="bundle-code-search-summary">${flat.length} ${flat.length === 1 ? 'issue' : 'issues'}</div>
    <ul class="bundle-code-search-issues">
      ${flat.map(({ file, finding, fileIdx }) => {
        const sev = finding.severity
        // Prefix is shown above the rail (bundle-code-rail-prefix);
        // strip it here so the row's path doesn't repeat the
        // shared root.
        const bare = stripPathPrefix(file, prefix)
        const isCurrent = file === currentPath && state.bundleSourceFindingIdx === fileIdx
        return html`<li class=${classMap({ 'bundle-code-search-issue': true, current: isCurrent })}>
          <button
            type="button"
            class="bundle-code-search-issue-link"
            data-bundle-view-source=${file}
            data-bundle-view-finding-idx=${fileIdx}
            data-bundle-view-line=${finding.line ?? ''}
          >
            <div class="bundle-code-search-issue-row">
              <span class=${`bundle-code-search-issue-sev sev-${sev}`}>${sev.replaceAll('_', ' ')}</span>
              <span class="bundle-code-search-issue-path mono" data-tooltip-truncated data-tooltip=${file}>${bare}${finding.line ? `:${finding.line}` : ''}</span>
            </div>
            <div class="bundle-code-search-issue-desc">${renderHighlighted(titledDescription(finding), { paragraphs: false })}</div>
          </button>
        </li>`
      })}
    </ul>
  </div>`
}

// A named app/workspace module is still own source: package grouping
// is not dependency ownership. node_modules paths remain dependencies
// even in a flat capture; other dependency directories use recorded
// module boundaries so an app's internal dependencies/ folder stays own.
// Sourcemaps consider every source.
function bundleCodeDefaultSources(details, sources) {
  if (details.kind !== 'stasis') return sources
  const packageDirs = bundlePackageDirs(details)
  const ownSources = new Map([...sources].filter(([file]) =>
    !/(?:^|\/)node_modules(?:\/|$)/u.test(file)
      && !/(?:^|\/)(?:node_modules|dependencies|vendor)(?:\/|$)/u.test(packageDirs?.get(file) ?? file)))
  return ownSources.size > 0 ? ownSources : sources
}

// Default file for the Code slide when nothing is selected yet —
// the tab used to open on a "pick a file" placeholder, making the
// first paint useless. Preference order:
//   1. the file carrying the worst matched finding (severity, then
//      match count, then path order for determinism) — opening on
//      the hottest file matches the triage intent of the app;
//   2. the stasis entry point — the bundle's natural root (v0
//      stasis has an empty entries set and falls through);
//   3. the largest source — for bundles without findings, the main
//      chunk is the most informative default.
// `sources` has already been restricted to own files when applicable.
// Only files with actual string content qualify (a sourcemap can
// list sources without carrying their text). Returns null when
// nothing qualifies; the caller keeps the placeholder for that.
function pickDefaultBundleCodeFile(details, sources, issueIndex) {
  let bestFile = null
  let bestSev = -1
  let bestCount = 0
  for (const [file, findings] of issueIndex) {
    if (typeof sources.get(file) !== 'string') continue
    const sev = SEVERITY_ORDER[_topSeverityOf(findings)] ?? 0
    if (sev > bestSev
        || (sev === bestSev && findings.length > bestCount)
        || (sev === bestSev && findings.length === bestCount
            && (bestFile === null || file.localeCompare(bestFile) < 0))) {
      bestFile = file
      bestSev = sev
      bestCount = findings.length
    }
  }
  if (bestFile) return bestFile
  if (details.kind === 'stasis' && details.bundle) {
    for (const entry of details.bundle.entries) {
      if (typeof sources.get(entry) === 'string') return entry
    }
  }
  let largest = null
  let largestLen = -1
  for (const [file, content] of sources) {
    if (typeof content !== 'string') continue
    if (content.length > largestLen) {
      largest = file
      largestLen = content.length
    }
  }
  return largest
}

// Code slide — directory-tree rail on the left + the same
// source-viewer body (line-numbered gutter, prism highlight,
// per-line dot + side panel) on the right. Reuses
// renderBundleSourceLines / renderBundleSourceFindingPanel so the
// inspect features (line dots, finding panel, source highlight)
// behave identically to the modal version. Selection lives on
// state.bundleSourceFile; on a fresh visit (tab switch nulls the
// pointer) a default file is auto-opened via
// pickDefaultBundleCodeFile.
function renderBundleCodeView(details, entry = null) {
  const sources = bundleSourcesAsMap(details)
  if (sources.size === 0) {
    return html`<div class="bundle-code-empty">This bundle doesn't carry any source content.</div>`
  }
  // Drop the user-toggled tree state when the open bundle
  // changes — paths from one bundle don't carry meaning into
  // another (and same-named paths between bundles probably
  // aren't intended to share open state).
  if (_bundleTreeMapBundle !== state.selectedBundle) {
    _bundleTreeUserOpen.clear()
    _bundleTreeMapBundle = state.selectedBundle
    _bundleTreeCurrentPath = null
  }
  const codeFiles = bundleSourceOrder(sources)
  const allPaths = codeFiles.paths
  const packageModules = details.kind === 'stasis' ? details.bundle.modules : null
  const prefix = bundleSourceTreePrefix(stripCommonPathPrefix(allPaths).prefix, packageModules, allPaths)
  const stripped = allPaths.map(p => stripPathPrefix(p, prefix))
  // Tree built from STRIPPED paths so the visual hierarchy
  // doesn't waste horizontal space on a shared root prefix.
  // Stripped → original mapping lets the click handlers (and
  // sources.get) recover the full key.
  const tree = buildBundleSourceTree(stripped, allPaths, packageModules)
  // Per-file finding index for the tree's count chips, the default-
  // file pick, and the Issues-mode hidden-when-empty gate. Computed
  // once and reused — the tree walk reads it as
  // Map<originalPath, Finding[]>.
  const issueIndex = details.fileHashes
    ? bundleFindingsByFile(details.fileHashes, 'issues')
    : new Map()
  const defaultSources = bundleCodeDefaultSources(details, sources)
  const defaultIssueIndex = details.kind === 'stasis'
    ? new Map([...issueIndex].filter(([file]) => defaultSources.has(file)))
    : issueIndex
  let path = state.bundleSourceFile
  // A managed link's file, now that the sources it numbers have loaded. A
  // number past the last file falls back to the usual pick.
  const request = state.bundleCodeFileRequest
  if (request?.bundle === state.selectedBundle) {
    state.bundleCodeFileRequest = null
    const linked = allPaths[request.file - 1]
    if (linked) {
      path = linked
      state.bundleSourceFile = linked
      revealBundleCodeCurrent()
    }
  }
  // Any selection that isn't the untouched auto-pick (the user
  // clicked a file, came in via an Issues click, or switched
  // bundles) ends the auto-pick's lifecycle — the upgrade below
  // must never swap a file the user chose.
  if (_bundleCodeAutoPick
      && (_bundleCodeAutoPick.bundle !== state.selectedBundle || (path && path !== _bundleCodeAutoPick.path))) {
    _bundleCodeAutoPick = null
  }
  if (!path) {
    // Render-time selection write — same pattern as the slide's tab
    // coercions. The tab-switch handler nulls the pointer on entry,
    // so this runs once per visit and the pick stays sticky across
    // re-renders, EXCEPT the one-time findings upgrade below.
    path = pickDefaultBundleCodeFile(details, defaultSources, defaultIssueIndex)
    if (path) {
      state.bundleSourceFile = path
      _bundleCodeAutoPick = { bundle: state.selectedBundle, path, hadIssues: defaultIssueIndex.size > 0 }
      // No tab-click fires on a boot restore straight into the Code
      // tab, so the reveal has to ride the pick itself.
      revealBundleCodeCurrent()
    }
  } else if (_bundleCodeAutoPick && !_bundleCodeAutoPick.hadIssues && defaultIssueIndex.size > 0) {
    // Findings upgrade. A page refresh lands here before the hash
    // pass and the OPFS finding index finish, so the original pick
    // could only fall back to the entry / largest file — a file
    // with zero issues, while the bundle does have matches. Once
    // findings arrive (the finding-index subscription re-renders),
    // re-pick ONCE and follow it; the guard above ensures this only
    // happens while the fallback is still what's on screen.
    _bundleCodeAutoPick.hadIssues = true
    const upgraded = pickDefaultBundleCodeFile(details, defaultSources, defaultIssueIndex)
    if (upgraded && upgraded !== path) {
      path = upgraded
      state.bundleSourceFile = upgraded
      state.bundleSourceFindingIdx = null
      _bundleCodeAutoPick.path = upgraded
      revealBundleCodeCurrent()
    }
  }
  if (path !== _bundleTreeCurrentPath) {
    openBundleTreeAncestors(path, prefix)
    _bundleTreeCurrentPath = path
  }
  // Keep a managed bundle's URL on the file shown, however it was picked.
  // The other writers of its route add the file through managedCodeFile.
  if (path && entry?.managedId && isManagedUiMode()) {
    managedHistory?.replaceCodeRoute(managedBundleRoute(state.managedTeams, entry, state.currentManagedTeam, 'code', codeFiles.numbers.get(path)))
  }
  const content = path ? sources.get(path) : null
  // Per-file findings + line dots — same source-viewer pipeline
  // the modal uses; the panel renders inside the slide rather
  // than as an overlay so the user can read source + finding
  // details side by side.
  const { fileFindings, lineFindings } = bundleViewerFindings(details, path, content)
  // Search state — three modes share a single query field. Issues
  // mode is hidden when the bundle has no matched findings; the
  // selector falls back to Files automatically.
  const hasAnyIssues = issueIndex.size > 0
  const searchModes = hasAnyIssues
    ? ['files', 'code', 'issues']
    : ['files', 'code']
  const searchMode = searchModes.includes(state.bundleCodeSearchMode)
    ? state.bundleCodeSearchMode
    : 'files'
  const query = state.bundleCodeSearchQuery
  return html`<div class="bundle-code-view">
    <aside class="bundle-code-rail">
      <div class="bundle-code-rail-head">
        <span class="bundle-code-rail-label">Files</span>
        <span class="bundle-code-rail-count">${allPaths.length}</span>
        <span class="bundle-code-rail-actions">
          <button type="button" class="bundle-code-rail-action" aria-label="Reveal current file" data-tooltip="Reveal current file"
            ?disabled=${!path} @click=${() => revealBundleTreeFile(path, prefix)}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1.5"/><path d="M8 0v3m0 10v3M0 8h3m10 0h3"/></svg>
          </button>
          <button type="button" class="bundle-code-rail-action" aria-label="Collapse directories" data-tooltip="Collapse directories"
            ?disabled=${searchMode !== 'files' || !!query || tree.dirs.size === 0} @click=${() => collapseBundleTree(tree)}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M5 2h8a1 1 0 0 1 1 1v8M3 5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM4.5 9.5h4"/></svg>
          </button>
        </span>
      </div>
      ${prefix ? html`<div class="bundle-code-rail-prefix mono" data-tooltip-truncated data-tooltip=${prefix}>${prefix}</div>` : nothing}
      <bundle-code-search .modes=${searchModes}></bundle-code-search>
      <div class="bundle-code-rail-body">
        ${choose(searchMode, [
          ['files', () => renderBundleCodeFilesPanel(tree, path, query, issueIndex, prefix, details.kind === 'stasis' ? details.bundle.formats : null, sources)],
          ['code', () => renderBundleCodeContentResults(details, sources, query, path, prefix)],
          ['issues', () => renderBundleCodeIssuesResults(details, query, path, prefix)],
        ])}
      </div>
    </aside>
    <bundle-code-splitter role="separator" tabindex="0" aria-orientation="vertical"
      aria-label="Resize file tree" data-tooltip="Drag to resize · double-click to reset"
    ></bundle-code-splitter>
    <div class=${classMap({ 'bundle-code-main': true, 'with-panel': state.bundleSourceFindingIdx != null })}>
      ${path
        ? renderBundleCodeMain(details, path, content, fileFindings, lineFindings, entry)
        : html`<div class="bundle-code-placeholder">Pick a file from the tree to view its source.</div>`}
    </div>
  </div>`
}

function renderBundleCodeFileNav(history) {
  return html`<span class="bundle-code-file-nav">
    <button type="button" class="focus-code-nav-btn" data-bundle-code-history="back"
      aria-label="Back to the previously shown file" ?disabled=${history.at === 0}>
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 3-5 5 5 5"/></svg>
    </button>
    <button type="button" class="focus-code-nav-btn" data-bundle-code-history="forward"
      aria-label="Forward to the next shown file" ?disabled=${history.at >= history.files.length - 1}>
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>
    </button>
  </span>`
}

// Main pane of the Code slide — header bar (path + copy button + GitHub
// link where the file's location is known + file stats + issue stepper) over the shared source-viewer body.
// The stepper cycles the side panel through the open file's
// findings in line order; its (idx, line) pairs ride in a JSON
// attribute so the events.js delegate steps without re-deriving
// the per-file findings.
function renderBundleCodeMain(details, path, content, fileFindings, lineFindings, entry = null) {
  const history = bundleFileHistory(state.bundleCodeHistory, details.integrity, path)
  const lineCount = typeof content === 'string' ? content.split('\n').length : 0
  const byteSize = typeof content === 'string' ? utf8ByteLength(content) : 0
  const issueOrder = fileFindings
    .map((f, idx) => ({ idx, line: parseInt(f.line, 10) || 0 }))
    .toSorted((a, b) => a.line - b.line || a.idx - b.idx)
  // A managed bundle's stored repository fills in what its own stamp leaves out.
  const github = bundleFileGithub(details, path, entry?.managedId && entry.repoId != null ? { github: entry.repoFullName, directory: entry.repoDirectory } : null)
  return html`<header class="bundle-code-main-bar">
      ${renderBundleCodeFileNav(history)}
      ${sourceFileIcon(path, details.kind === 'stasis' ? details.bundle.formats?.get(path) : undefined)}
      <span class="bundle-code-main-path mono" data-tooltip-truncated data-tooltip=${path}>${path}</span>
      <button
        type="button"
        class="bundle-code-copy-path"
        data-copy-path=${path}
        aria-label="Copy file path"
      >${COPY_PATH_ICON}</button>
      ${github ? html`<a
        class="bundle-code-github-link"
        href=${github.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open on GitHub"
        data-tooltip=${github.path}
        data-tooltip-repo=${github.github}
        data-tooltip-commit=${github.commit ?? nothing}
        data-tooltip-package=${github.package?.name ?? nothing}
        data-tooltip-ecosystem=${github.package?.ecosystem ?? nothing}
        data-tooltip-version=${github.package?.version ?? nothing}
      >${unsafeHTML(GITHUB_ICON_SVG)}${github.package ? html`<span hidden data-tooltip-package-icon>${packageIconFor(github.package.ecosystem)}</span>` : nothing}</a>` : nothing}
      <span class="bundle-code-main-spacer"></span>
      ${renderSourceWrapToggle()}
      ${typeof content === 'string'
        ? html`<span class="bundle-code-main-stats">${lineCount.toLocaleString()} ${lineCount === 1 ? 'line' : 'lines'} · ${formatBytes(byteSize)}</span>`
        : nothing}
      ${fileFindings.length > 0 ? html`<span
        class="bundle-code-main-issues"
        data-bundle-code-issue-order=${JSON.stringify(issueOrder)}
      >
        <span
          class=${`bundle-code-tree-count sev-${_topSeverityOf(fileFindings)}`}
          data-tooltip=${`${fileFindings.length} ${fileFindings.length === 1 ? 'issue' : 'issues'} in this file`}
        >${fileFindings.length}</span>
        <button
          type="button"
          class="bundle-code-issue-step"
          data-bundle-code-issue-step="-1"
          aria-label="Previous issue"
        >‹</button>
        <button
          type="button"
          class="bundle-code-issue-step"
          data-bundle-code-issue-step="1"
          aria-label="Next issue"
        >›</button>
      </span>` : nothing}
    </header>
    <div class="bundle-code-main-body">
      ${renderBundleSourceCodeWrap(path, content, details, fileFindings, lineFindings)}
    </div>`
}

// ── Search tab — github-style full-bundle code search ────────────
// A full-width search over every source in the bundle. Where the
// Code tab's rail filter (renderBundleCodeContentResults) shows one
// truncated line per hit, this surfaces every match inside a snippet
// with the lines around it, so the user reads each hit in context.
// Plain queries match as a case-insensitive substring; the `.*`
// modifier (state.bundleSearchRegex) switches to a case-insensitive
// regular expression, matched per line.
//
// The scan itself (matching, scan caps, and the typing-refinement
// history that keeps per-keystroke cost off the full bundle) lives
// in bundle-search-scan.js; this section owns the rendering.

// Display-side cap: rendered lines clip to SEARCH_MAX_LINE chars
// (minified bundles ship single 100k-char lines). The scan caps
// (total hits / files / marks per line) live with the scan engine in
// bundle-search-scan.js.
const SEARCH_MAX_LINE = 400

// Context radius (lines above + below each match) scales INVERSELY
// with the total hit count: a handful of matches can afford a
// generous window; a flood tightens toward the github ±2 default so
// the page stays scannable.
function searchContextRadius(totalHits) {
  if (totalHits <= 5) return 8
  if (totalHits <= 15) return 6
  if (totalHits <= 40) return 4
  if (totalHits <= 120) return 3
  return 2
}

// Expand each hit line into a ±radius window, merging windows that
// touch or overlap. With context on (radius ≥ 1) a lone 1-line gap
// between nearby hits is absorbed; with context off (radius 0) only
// directly-adjacent hit lines merge, so non-adjacent matches stay in
// separate snippets. `hits` is line-sorted ascending. Returns
// inclusive 1-based { start, end } ranges.
function buildSearchWindows(hits, lineCount, radius) {
  const windows = []
  for (const h of hits) {
    const start = Math.max(1, h.ln - radius)
    const end = Math.min(lineCount, h.ln + radius)
    const last = windows.at(-1)
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end)
    else windows.push({ start, end })
  }
  return windows
}

// Clip a long line to SEARCH_MAX_LINE chars, sliding the window to
// keep the first match in view (minified sources put the only match
// thousands of chars in). Returns the display text, the match ranges
// shifted into it, and whether the head was cut (so the row can show
// a leading ellipsis).
function clipSearchLine(text, ranges, max) {
  if (text.length <= max) return { text, ranges, clipped: false }
  const firstStart = ranges.length > 0 ? ranges[0][0] : 0
  const from = firstStart > max - 60 ? Math.max(0, firstStart - 60) : 0
  return sliceSearchLine(text, ranges, from, max)
}

// Cut `text` to `max` chars starting at `from`, shifting the match
// ranges into the slice (spans cut by an edge are clamped, spans
// outside it dropped). `clipped` reports a cut head.
function sliceSearchLine(text, ranges, from, max) {
  const slice = text.slice(from, from + max)
  if (from === 0) return { text: slice, ranges, clipped: false }
  const shifted = []
  for (const [s, e] of ranges) {
    const ns = s - from
    const ne = e - from
    if (ne <= 0 || ns >= slice.length) continue
    shifted.push([Math.max(0, ns), Math.min(slice.length, ne)])
  }
  return { text: slice, ranges: shifted, clipped: true }
}

// Wrap each matched span in a <mark>, leaving the rest as plain text
// nodes (Lit auto-escapes both). `ranges` are already clipped into
// `text`; spans are clamped + de-overlapped defensively.
function renderSearchMarks(text, ranges) {
  if (ranges.length === 0) return text
  const out = []
  let pos = 0
  for (const [s, e] of ranges) {
    const cs = Math.max(pos, Math.min(s, text.length))
    const ce = Math.max(cs, Math.min(e, text.length))
    if (ce <= cs) continue
    if (cs > pos) out.push(text.slice(pos, cs))
    out.push(html`<mark class="bundle-search-mark">${text.slice(cs, ce)}</mark>`)
    pos = ce
  }
  if (pos < text.length) out.push(text.slice(pos))
  return out
}

// One source line inside a snippet: line-number gutter + code.
// Matched lines (ranges non-null) pick up `.is-match` and get their
// hits marked; context lines render plain.
function renderSearchRow(text, ln, ranges) {
  const clip = clipSearchLine(text, ranges ?? [], SEARCH_MAX_LINE)
  return html`<div class=${classMap({ 'bundle-search-line': true, 'is-match': ranges != null })}>
    <span class="bundle-search-lineno">${ln}</span>
    <span class="bundle-search-code">${clip.clipped
      ? html`<span class="bundle-search-clip">…</span>`
      : nothing}${renderSearchMarks(clip.text, clip.ranges)}</span>
  </div>`
}

// A single context snippet — rendered as a button so a click jumps
// the source viewer to the snippet's first matched line. `hitRanges`
// maps 1-based line → match spans for the matched lines in range.
function renderSearchSnippet(path, lines, win, hitRanges, showGap) {
  const { start, end } = win
  let anchor = start
  for (let ln = start; ln <= end; ln++) {
    if (hitRanges.has(ln)) { anchor = ln; break }
  }
  const digits = String(end).length
  const rows = []
  for (let ln = start; ln <= end; ln++) {
    rows.push(renderSearchRow(lines[ln - 1] ?? '', ln, hitRanges.get(ln) ?? null))
  }
  return html`${showGap ? html`<div class="bundle-search-gap" aria-hidden="true"></div>` : nothing}
    <button
      type="button"
      class="bundle-search-snippet"
      style=${styleMap({ '--bundle-search-lineno-w': `${digits}ch` })}
      data-bundle-view-source=${path}
      data-bundle-view-line=${anchor}
      data-bundle-view-scroll-block="center"
    >${rows}</button>`
}

// One file group — a clickable header (stripped path + match count)
// over its context snippets. The header opens the file at its first
// match; each snippet opens at its own anchor line.
function renderSearchFile(fileResult, prefix, radius) {
  const { path, lines, hits } = fileResult
  const bare = stripPathPrefix(path, prefix)
  const windows = buildSearchWindows(hits, lines.length, radius)
  const hitRanges = new Map(hits.map((h) => [h.ln, h.ranges]))
  const firstHit = hits[0].ln
  // Highlight the card whose source is open in the right sidebar.
  const isCurrent = path === state.bundleSourceFile
  return html`<section class=${classMap({ 'bundle-search-file': true, current: isCurrent })}>
    <header class="bundle-search-file-head">
      <button
        type="button"
        class="bundle-search-file-name mono"
        data-bundle-view-source=${path}
        data-bundle-view-line=${firstHit}
        data-bundle-view-scroll-block="center"
        data-tooltip-truncated data-tooltip=${path}
      >${bare}</button>
      <span class="bundle-search-file-count">${hits.length} ${hits.length === 1 ? 'match' : 'matches'}</span>
    </header>
    <div class="bundle-search-snippets">
      ${windows.map((w, i) => renderSearchSnippet(path, lines, w, hitRanges, i > 0))}
    </div>
  </section>`
}

// Scan every source for the active query (through the refinement
// history in bundle-search-scan.js, keyed by the bundle's integrity —
// typing forward only re-checks the previous keystroke's hit lines
// instead of re-walking the bundle), then render file groups with
// context snippets.
function renderBundleSearchResults(details, sources, query, useRegex, caseSensitive, showContext) {
  if (!query) {
    return html`<div class="bundle-search-results">
      <div class="bundle-search-hint">
        Search across every source in this bundle. Each match shows the surrounding
        lines for context — fewer matches get more context. Toggle
        <span class="bundle-search-hint-kbd">Aa</span> for case-sensitive and
        <span class="bundle-search-hint-kbd">.*</span> for regular-expression matching.
      </div>
    </div>`
  }
  const result = runBundleSearch(details.integrity ?? '', sources, query, useRegex, caseSensitive, bundleSearchOrder(details, sources))
  if (result.error) {
    return html`<div class="bundle-search-results">
      <div class="bundle-search-error">
        <span class="bundle-search-error-label">Invalid regular expression</span>
        <span class="bundle-search-error-msg mono">${result.error}</span>
      </div>
    </div>`
  }
  const { fileResults, totalHits, truncated } = result
  // Stable display prefix from ALL sources, so it doesn't jump as the
  // matched-file set shifts between keystrokes.
  const allPaths = [...sources.keys()].toSorted()
  const { prefix } = stripCommonPathPrefix(allPaths)
  if (fileResults.length === 0) {
    return html`<div class="bundle-search-results">
      <div class="bundle-search-empty">No matches.</div>
    </div>`
  }
  // Context off → radius 0: windows collapse to the matched lines
  // themselves (adjacent matches still merge into one block; the gap
  // rule keeps non-adjacent ones apart).
  const radius = showContext ? searchContextRadius(totalHits) : 0
  const fileCount = fileResults.length
  return html`<div class="bundle-search-results">
    <div class="bundle-search-summary">
      <span>${totalHits}${truncated ? '+' : ''} ${totalHits === 1 ? 'match' : 'matches'}
        in ${fileCount}${truncated ? '+' : ''} ${fileCount === 1 ? 'file' : 'files'}</span>
      ${prefix ? html`<span class="bundle-search-summary-prefix mono" data-tooltip-truncated data-tooltip=${prefix}>${prefix}</span>` : nothing}
      ${truncated ? html`<span class="bundle-search-summary-more">results capped — refine to narrow</span>` : nothing}
    </div>
    ${repeat(fileResults, (f) => f.path, (f) => renderSearchFile(f, prefix, radius))}
  </div>`
}

// Line numbers (1-based) in `content` matched by the active search —
// drives the matched-line highlight in the sidebar's gutter (the same
// lines the results column marks). Returns `null` when the query
// can't be evaluated at all (empty, missing content, or a regex that
// doesn't compile) — the caller treats null as "no signal": keep the
// sidebar open with no highlight, rather than reading it as a
// no-match eviction. An empty Set means the query is valid and the
// file genuinely has zero matches.
function searchMatchLines(content, query, useRegex, caseSensitive) {
  if (!query || typeof content !== 'string') return null
  const matcher = buildSearchMatcher(query, useRegex, caseSensitive)
  if (matcher.error) return null
  const out = new Set()
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (matcher.ranges(lines[i]).length > 0) out.add(i + 1)
  }
  return out
}

// Right sidebar for the Search tab — the clicked result's source,
// docked beside the results instead of in a popup. Reuses the
// modal's chrome (bar / body / code-wrap + finding panel) and the
// same renderBundleSourceLines + renderBundleSourceFindingPanel
// pipeline, so line gutter, prism highlight, per-line finding dots
// and the finding panel behave identically. Matched lines pick up the
// gutter highlight. Renders only once a result is clicked
// (state.bundleSourceFile set); the × button clears it via the shared
// bundle-source-close action.
function renderBundleSearchSide(details, sources, matchLines) {
  const path = state.bundleSourceFile
  if (!path) return nothing
  const content = sources.get(path)
  const { fileFindings, lineFindings } = bundleViewerFindings(details, path, content)
  return html`<aside class="bundle-search-side">
    ${renderBundleSourceBar(path)}
    <div class="bundle-source-body">
      ${renderBundleSourceCodeWrap(path, content, details, fileFindings, lineFindings, matchLines)}
    </div>
  </aside>`
}

// Search tab body — the github-style search bar over a results
// column, with the clicked result's source docked in a right
// sidebar. Reads its own query state (state.bundleSearchQuery /
// bundleSearchRegex / bundleSearchCase) so it never fights the Code
// tab's rail filter.
function renderBundleSearchView(details) {
  const sources = bundleSourcesAsMap(details)
  if (sources.size === 0) {
    return html`<div class="bundle-search-view">
      <div class="bundle-code-empty">This bundle doesn't carry any source content.</div>
    </div>`
  }
  const query = state.bundleSearchQuery
  const useRegex = state.bundleSearchRegex
  const caseSensitive = state.bundleSearchCase
  // Auto-close the sidebar when the open file no longer matches the
  // current query — it has dropped out of the results list. Only a
  // VALID query with zero matches closes it: an empty query (user
  // cleared the box) or a regex that doesn't compile (an in-progress
  // pattern like `merge(`) returns null and keeps the file open with
  // no highlight — evicting on every transient keystroke state lost
  // the user's place with no way back but re-finding the result. The
  // matched lines are computed once here and handed down to the
  // sidebar's gutter highlight so the file isn't scanned twice.
  let openMatchLines = null
  if (state.bundleSourceFile) {
    const lines = searchMatchLines(sources.get(state.bundleSourceFile), query, useRegex, caseSensitive)
    if (lines && lines.size === 0) {
      state.bundleSourceFile = null
      state.bundleSourceFindingIdx = null
    } else {
      openMatchLines = lines
    }
  }
  // Context toggle lives in the header, to the right of the search
  // field (not inside it) — a show/hide pill modelled on the Graph
  // tab's "All files" switch. On (default) shows the lines around
  // each match; off collapses to just the matched lines.
  const showContext = state.bundleSearchContext
  return html`<div class="bundle-search-view">
    <div class="bundle-search-bar-row">
      <bundle-search></bundle-search>
      <mode-switch
        data-bundle-search-context
        label="Context" .checked=${showContext}
        accessible-label="Toggle context lines"
      ></mode-switch>
    </div>
    <div class="bundle-search-main">
      ${renderBundleSearchResults(details, sources, query, useRegex, caseSensitive, showContext)}
      ${renderBundleSearchSide(details, sources, openMatchLines)}
    </div>
  </div>`
}

// Top-level bundle view. The header carries the bundle's filename
// (the canonical user-facing label; integrity lives in the Overview
// tab's metadata block) and the tab strip; the body dispatches on
// the active tab. Overview = the `renderBundleDetails` panel
// (metadata, integrity, packages, files, reports).
//
// `state.bundleDetailsTab` carries the active tab. 'overview' is
// the canonical Overview value; older persisted suffixes that named
// the long-removed nested-overview tabs ('packages' / 'files' /
// 'reports') fail BUNDLE_TABS validation in view.js's boot restore
// and fall back to 'overview' there — no migration needed.
function renderBundleSlide(entry) {
  // Advisories tab — tri-state visibility (see `showAdvisoriesTab`):
  // non-stasis bundles hide immediately, stasis bundles stay
  // optimistically visible across the parse window so a switch
  // between two stasis bundles doesn't flicker the tab away mid-
  // load, and v0 stasis bundles (or bundles without dependency
  // packages) hide post-parse once we've confirmed there's nothing to
  // audit — unless Advisories is the open tab, which a bundle switch or
  // a link keeps open. The tab is rendered as
  // the LEFTMOST entry on purpose, so the post-parse stamp-in for
  // a fresh stasis bundle pushes the other tabs right rather than
  // landing in their middle — no in-flight click theft.
  const showAdvisories = showAdvisoriesTab(entry, state.bundleDetails, state.bundleDetailsTab === 'advisories')
  // Coerce a `state.bundleDetailsTab === 'advisories'` value back to
  // 'overview' only without security access. A sourcemap, or a bundle
  // with nothing to audit, keeps the open tab.
  if (state.bundleDetailsTab === 'advisories' && !showAdvisories) {
    state.bundleDetailsTab = 'overview'
  }
  // Compare needs a second eligible bundle (the same repo in managed). With only
  // the open bundle present the picker would have nothing to offer, so
  // the tab is hidden — unless Compare is the open tab: a bundle switch or
  // a link keeps it open, and its body says there is nothing to compare.
  const canCompare = state.bundleDetailsTab === 'compare'
    || bundleComparisonCandidates(state.bundles ?? [], state.selectedBundle).length > 0
  // Managed bundles have no Issues tab: Code shows each file's issues. A
  // persisted or routed 'issues' selection coerces back to Overview.
  const showIssues = !isManagedUiMode()
  if (state.bundleDetailsTab === 'issues' && !showIssues) {
    state.bundleDetailsTab = 'overview'
  }
  const tab = state.bundleDetailsTab
  const overviewActive = tab === 'overview'
  // Shared readiness gates for the non-Overview tab bodies. While the
  // parse is in flight (`bundleDetails` null or still pointing at the
  // previously-open bundle) every slide tab shows the same Loading
  // line; a failed parse shows the error. Without this, each tab
  // fended for itself and most just returned `nothing` — a corrupt
  // bundle gave blank Issues / Code / Search bodies, an empty Graph /
  // Terminal slot, and a Compare stuck on "Loading bundle…", with the
  // parse error only visible on Overview.
  const details = state.bundleDetails
  const detailsReady = Boolean(details && details.integrity === entry.integrity)
  const detailsParsed = detailsReady && !details.error && Boolean(details.json || details.bundle)
    && !(details.metadataOnly && bundleNeedsSources(tab))
  // Kick the fetch lazily — only once the user has actually clicked
  // into the Advisories tab AND granted consent. The cache is
  // module-scoped (keyed by integrity); a re-render with the entry
  // already cached is a no-op. Gated on `detailsParsed` so the parse
  // window of a bundle switch can't issue a query for the PREVIOUS
  // bundle's (still-attached) module inventory, and on a Stasis bundle:
  // a sourcemap's open tab has nothing to audit.
  if (tab === 'advisories' && showAdvisories && detailsParsed && details.kind === 'stasis') {
    ensureBundleAdvisories(details, render).catch(() => {})
  }
  // Outside managed mode, Issues is always in the tab strip — the body's
  // empty state ("No issues match this bundle's files.") covers the
  // no-match case, and keeping the button stable avoids two prior bugs:
  // (1) a layout shift mid-parse when `state.bundleDetails.fileHashes`
  // becomes non-null and the button stamps in as the leftmost tab,
  // pushing every other tab right (and stealing in-flight clicks);
  // (2) an orphan tab state where a persisted `b:<integrity> issues`
  // selection paints the issues body but the matching tab button is
  // hidden, leaving the user with no visible escape hatch.
  return html`<div class="bundles-view bundles-slide-view">
    <bundle-slide-header class="bundles-slide-header"><header class="bundles-slide-bar">
      ${isManagedUiMode() && entry.managedId && entry.repoId == null ? html`<span class="bundles-slide-breadcrumb">
        <button type="button" @click=${() => document.dispatchEvent(new CustomEvent('managed-admin-navigate', { detail: { view: 'manage-bundles' }, bubbles: true, composed: true }))}>Bundles</button>
        <span aria-hidden="true">&gt;</span>
      </span>` : nothing}
      <span class="bundles-slide-icon" aria-hidden="true">${unsafeHTML(BUNDLE_ICON_SVG)}</span>
      <div class="bundles-slide-title">
        <div class="bundles-slide-name" data-tooltip-truncated data-tooltip=${entry.name}>${entry.name}</div>
      </div>
      <button type="button" class="bundles-download-btn bundles-scan-button" ?hidden=${!canScanBundle(entry)} @click=${() => void openScan(entry)}>${unsafeHTML(SCAN_ICON_SVG)}<span>Scan</span></button>
      <div class="bundles-slide-tabs" role="tablist">
        ${showAdvisories ? html`<button
          type="button"
          class=${classMap({ 'bundles-tab': true, active: tab === 'advisories' })}
          data-bundle-tab="advisories"
          aria-selected=${String(tab === 'advisories')}
          role="tab"
        >Advisories</button>` : nothing}
        ${showIssues ? html`<button
          type="button"
          class=${classMap({ 'bundles-tab': true, active: tab === 'issues' })}
          data-bundle-tab="issues"
          aria-selected=${String(tab === 'issues')}
          role="tab"
        >Issues</button>` : nothing}
        <button
          type="button"
          class=${classMap({ 'bundles-tab': true, active: tab === 'terminal' })}
          data-bundle-tab="terminal"
          aria-selected=${String(tab === 'terminal')}
          role="tab"
        >Terminal</button>
        <button
          type="button"
          class=${classMap({ 'bundles-tab': true, active: tab === 'treemap' })}
          data-bundle-tab="treemap"
          aria-selected=${String(tab === 'treemap')}
          role="tab"
        >Treemap</button>
        <button
          type="button"
          class=${classMap({ 'bundles-tab': true, active: tab === 'graph' })}
          data-bundle-tab="graph"
          aria-selected=${String(tab === 'graph')}
          role="tab"
        >Graph</button>
        <button
          type="button"
          class=${classMap({ 'bundles-tab': true, active: tab === 'code' })}
          data-bundle-tab="code"
          aria-selected=${String(tab === 'code')}
          role="tab"
        >Code</button>
        <button
          type="button"
          class=${classMap({ 'bundles-tab': true, active: tab === 'search' })}
          data-bundle-tab="search"
          aria-selected=${String(tab === 'search')}
          role="tab"
        >Search</button>
        ${canCompare ? html`<button
          type="button"
          class=${classMap({ 'bundles-tab': true, active: tab === 'compare' })}
          data-bundle-tab="compare"
          aria-selected=${String(tab === 'compare')}
          role="tab"
        >Compare</button>` : nothing}
        <button
          type="button"
          class=${classMap({ 'bundles-tab': true, active: overviewActive })}
          data-bundle-tab="overview"
          aria-selected=${String(overviewActive)}
          role="tab"
        >Overview</button>
      </div>
    </header></bundle-slide-header>
    <div class=${classMap({ 'bundles-slide-body': true, 'bundles-slide-body-overview': overviewActive })}>
      ${overviewActive
        ? renderBundleDetails(entry, details)
        : detailsParsed
          ? choose(tab, [
              ['terminal', () => html`<div id="bundle-terminal-slot" class="bundle-terminal-slot"></div>`],
              ['graph', () => html`<div id="bundle-graph-slot" class="bundle-graph-slot"></div>`],
              ['treemap', () => html`<bundle-treemap .details=${details}></bundle-treemap>`],
              ['code', () => renderBundleCodeView(details, entry)],
              ['search', () => renderBundleSearchView(details)],
              ['compare', () => html`<bundle-compare .details=${details} .integrity=${entry.integrity}></bundle-compare>`],
              ['issues', () => renderBundleIssuesList(details)],
              ['advisories', () => renderBundleAdvisoriesTab(details, render,
                canScanBundle(entry) ? () => void openScan(entry, { mode: 'dependencies' }) : null)],
            ])
          : detailsReady && details.sourceError
            ? html`<div class="bundles-slide-placeholder is-error">${details.sourceError} <button type="button" data-bundle-retry-sources>Retry</button></div>`
          : detailsReady && !details.metadataOnly
            ? html`<div class=${classMap({ 'bundles-slide-placeholder': true, 'is-error': Boolean(details.error) })}>
                ${details.error ? `Failed to parse: ${details.error}` : 'Bundle contents not parsed.'}
              </div>`
            : html`<div class="bundles-slide-placeholder">Loading bundle…</div>`}
    </div>
  </div>`
}

// Per-issue list of OPFS reports the finding showed up in. Up to
// two chips render with the brand sticker + display name (mirrors
// the workspace `.report-chip` from render-finding.js); a third+
// report collapses into a trailing ", and more…" hint so the row
// stays readable when a finding is shared across many reports.
// Each chip is clickable — the data attribute hands the report
// name to events.js, which calls switchToFile to navigate.
function bundleIssueReportsTemplate(finding, ctx = {}) {
  if (!finding) return nothing
  // Hash-keyed lookup is the original path — analyzer-native
  // findings carry a `fileHash`, so a single hash bucket
  // resolves to every report that mentioned the same source
  // file. Markdown-parsed findings (Codex / Claude Security)
  // don't carry a hash, so the bucket-keyed fallbacks below
  // pick them up via the package / repository index's
  // `keyReports` map. `ctx.kind` + `ctx.bucketKey` flow in from
  // `renderIssuesGroupedByFile` so this template knows which
  // index to consult when the hash path comes up empty.
  let reports = []
  if (finding.fileHash) reports = reportsForFinding(finding.fileHash, finding)
  if (reports.length === 0 && ctx.bucketKey) {
    if (ctx.kind === 'package') reports = reportsForFindingByPackage(ctx.bucketKey, finding)
    else if (ctx.kind === 'repository') reports = reportsForFindingByRepo(ctx.bucketKey, finding)
  }
  if (reports.length === 0) return nothing
  const visible = reports.slice(0, 2)
  const extra = reports.length - visible.length
  return html`<div class="bundle-issue-reports">
    ${visible.map((name) => {
      const iconHtml = REPORT_LOGOS[groupOf(name)] ?? REPORT_LOGOS.default
      return html`<button type="button" class="report-chip" data-bundle-issue-report=${name}>${unsafeHTML(iconHtml)}<span class="report-chip-label" data-tooltip-truncated data-tooltip=${name}>${displayName(name)}</span></button>`
    })}
    ${extra > 0 ? html`<span class="bundle-issue-reports-more">, and ${extra} more…</span>` : nothing}
  </div>`
}

// Human-readable line label for a finding. Accepts either a
// single line ("10" or 10) or a range string ("10-15"); returns
// "Line 10" / "Lines 10-15" / "" when the value isn't usable.
// Skips ranges where end ≤ start (treats them as a single line)
// since those usually come from a malformed source.
function formatFindingLine(line) {
  if (line == null || line === '') return ''
  const s = String(line)
  const dash = s.indexOf('-')
  if (dash > 0) {
    const a = parseInt(s.slice(0, dash), 10)
    const b = parseInt(s.slice(dash + 1), 10)
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) return `Lines ${a}-${b}`
    if (Number.isFinite(a)) return `Line ${a}`
    return ''
  }
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? `Line ${n}` : ''
}

// Centered empty state for the Issues tab — a headline plus an
// explanatory hint. The old single muted line rendered flush against
// the slide body's top-left corner and gave no clue what "issues"
// are or why none are listed.
function renderBundleIssuesEmpty(primary, hint) {
  return html`<div class="bundle-issues-empty">
    <p class="bundle-issues-empty-primary">${primary}</p>
    ${hint ? html`<p class="bundle-issues-empty-hint">${hint}</p>` : nothing}
  </div>`
}

// Issues tab — findings matched to the open bundle's files via
// SHA-512 fileHash equality, grouped per file (see
// renderIssuesGroupedByFile) with files sorted by worst severity
// first. Until the async hash computation completes (bundle-load.js
// kicks it after parse), shows a hashing placeholder; the no-match
// tiers below explain why nothing is listed.
function renderBundleIssuesList(details) {
  if (details.managedId) return renderBundleIssuesEmpty('Open a report to review its findings.', 'Bundle metadata includes source hashes; reports are available through your teams.')
  if (!details.fileHashes) {
    return renderBundleIssuesEmpty(
      'Computing file hashes…',
      'Hashing this bundle\'s sources so findings from your reports can be matched against them.',
    )
  }
  // A bundle without source content (a .map missing `sourcesContent`,
  // a stasis bundle without inline sources) hashes to an empty map —
  // there's nothing to match, whatever the index holds. Same message
  // the Code / Search / Treemap tabs show for that bundle shape; the
  // index-aware tiers below would misdirect ("different build won't
  // line up") when the truth is there are no sources to compare.
  if (details.fileHashes.size === 0) {
    return renderBundleIssuesEmpty(
      'This bundle doesn\'t carry any source content.',
      'Issues are matched by source-file hash, so a bundle without inline sources has nothing to match findings against.',
    )
  }
  const findingsByFile = bundleFindingsByFile(details.fileHashes, 'issues')
  if (findingsByFile.size === 0) {
    // Three distinct reasons nothing is listed — tell them apart so
    // the user knows whether anything (and what) would change that.
    // The finding-index subscription in events.js re-renders this
    // view as background indexing lands, so the first message
    // self-corrects without a tab flip once findings come in.
    const indexedCount = indexedHashFindingCount()
    if (indexedCount === 0) {
      // "hash-carrying" matters: markdown-parsed reports (DeepSec,
      // Claude Security, Codex) index without fileHash, so plain "no
      // findings are indexed" would tell a user who dropped those to
      // do something they already did.
      return renderBundleIssuesEmpty(
        'No issues match this bundle\'s files.',
        'Issues are analyzer findings matched to this bundle by source-file hash. No hash-carrying findings are indexed yet — hash matching needs the analyzer\'s native JSON reports; drop one and any matches will appear here automatically.',
      )
    }
    // Raw (pre-triage-filter) match count, mirroring the per-file
    // walk bundleFindingsByFile does. Non-zero here means every
    // match was filtered out as invalid / deleted — say so instead
    // of pretending nothing ever matched.
    let matchedAll = 0
    for (const hash of details.fileHashes.values()) matchedAll += findingsForFileHash(hash).length
    if (matchedAll > 0) {
      return renderBundleIssuesEmpty(
        'All matching issues are dismissed.',
        `${matchedAll} ${matchedAll === 1 ? 'finding matches' : 'findings match'} this bundle's files, but every one is triaged invalid or deleted.`,
      )
    }
    return renderBundleIssuesEmpty(
      'No issues match this bundle\'s files.',
      `None of the ${indexedCount.toLocaleString()} indexed ${indexedCount === 1 ? 'finding' : 'findings'} reference a source file in this bundle — matching compares exact file hashes, so findings from a different build of the same project won't line up.`,
    )
  }
  return renderIssuesGroupedByFile(findingsByFile, { kind: 'bundle' })
}

// Shared per-file grouped issue list — the bundle Issues tab and
// the package Issues tab both render through this helper. The
// `kind` opt selects whether the file header + finding row carry
// click handlers (bundle: opens the source viewer modal at the
// matched file/line) or render as plain labels (package: no source
// viewer applies — navigation lives in the per-finding report
// chips on the right). Sort + grouping logic is identical.
// `bucketKey` is the index key the caller's slide is rendering
// against — repo URL/slug for `kind === 'repository'`, package
// name for `kind === 'package'`. Two consumers:
//   * Repository slide: also drives the per-file-group HEAD
//     link to github (so a user/repo slug or full https URL
//     both work).
//   * Package + Repository slides: handed to
//     `bundleIssueReportsTemplate` so report chips for findings
//     without a `fileHash` (Codex / Claude Security markdown
//     findings) still surface, via the bucket's `keyReports`
//     map.
export function renderIssuesGroupedByFile(findingsByFile, { kind, bucketKey } = {}) {
  // Strip the shared root once for the file headers; the leading
  // prefix is shown in the summary line so each file row reads
  // tighter without it.
  const allFiles = [...findingsByFile.keys()]
  const { prefix, stripped } = stripCommonPathPrefix(allFiles)
  const fileToBare = new Map(allFiles.map((f, i) => [f, stripped[i]]))
  // Sort files by worst-severity descending, then by stripped name
  // — surfaces files with critical issues at the top, while
  // alphabetical tie-breaking keeps the list stable.
  const fileEntries = [...findingsByFile.entries()].toSorted(([fa, ga], [fb, gb]) => {
    const wa = SEVERITY_ORDER[_topSeverityOf(ga)] ?? 0
    const wb = SEVERITY_ORDER[_topSeverityOf(gb)] ?? 0
    if (wb !== wa) return wb - wa
    return (fileToBare.get(fa) ?? fa).localeCompare(fileToBare.get(fb) ?? fb)
  })
  const totalCount = [...findingsByFile.values()].reduce((n, fs) => n + fs.length, 0)
  return html`<div class="bundle-issues">
    <div class="bundle-issues-summary">
      ${totalCount} ${totalCount === 1 ? 'issue' : 'issues'} across
      ${findingsByFile.size} ${findingsByFile.size === 1 ? 'file' : 'files'}
      ${prefix ? html` <span class="mono">${prefix}</span>` : nothing}
    </div>
    <ul class="bundle-issues-list">
      ${repeat(fileEntries, ([file]) => file, ([file, findings]) => {
        const bare = fileToBare.get(file) ?? file
        // Sort findings within a file by severity desc → line asc
        // so the most urgent surfaces first; line ordering helps
        // when the user scrolls down within the same file.
        const sortedFindings = [...findings].toSorted((a, b) => {
          const sa = SEVERITY_ORDER[a.severity] ?? 0
          const sb = SEVERITY_ORDER[b.severity] ?? 0
          if (sb !== sa) return sb - sa
          const la = parseInt(a.line, 10) || 0
          const lb = parseInt(b.line, 10) || 0
          return la - lb
        })
        // Repository slide gets a HEAD link per file group so the
        // user can open the matching source on github with one
        // click. Bundle slide keeps its source-viewer button.
        // Package + everything else stay as static spans (no
        // unambiguous upstream to link against).
        const repoFileUrl = kind === 'repository' && bucketKey
          ? `${/^https?:/iu.test(bucketKey) ? bucketKey.replace(/\/$/u, '') : `https://github.com/${bucketKey}`}/blob/HEAD/${file}`
          : null
        return html`<li class="bundle-issues-file-group">
          <header class="bundle-issues-file-header">
            ${kind === 'bundle'
              ? html`<button type="button" class="bundle-issues-file-name mono" data-bundle-view-source=${file} data-tooltip-truncated data-tooltip=${file}>${bare}</button>`
              : repoFileUrl
                ? html`<a class="bundle-issues-file-name bundle-issues-file-name-link mono" href=${repoFileUrl} target="_blank" rel="noopener" data-tooltip-truncated data-tooltip=${file}>${bare}</a>`
                : html`<span class="bundle-issues-file-name bundle-issues-file-name-static mono" data-tooltip-truncated data-tooltip=${file}>${bare}</span>`}
            <span class="bundle-issues-file-count">${findings.length} ${findings.length === 1 ? 'issue' : 'issues'}</span>
          </header>
          <ul class="bundle-issues-findings">
            ${repeat(sortedFindings, (finding) => JSON.stringify([finding.id ?? `${file}\0${finding.line ?? ''}\0${finding.severity ?? ''}\0${finding.description ?? ''}`, usesReportIgnore(finding)]), (finding) => {
              // findingIdx is the position in the ORIGINAL per-file
              // findings array (the one findingsByFile returned);
              // the source viewer's bundleSourceFindingIdx points at
              // that index, so the sorted display order doesn't
              // break the lookup. Only used by the bundle path.
              const findingIdx = findings.indexOf(finding)
              const sev = finding.severity
              const lineLabel = formatFindingLine(finding.line)
              const triage = sharedFindingTriage(finding, state.triage.get(tabKey(finding)))
              // Match the aggregate filters: a shared App/own-code ignore
              // does not give a dependency occurrence an Ignored badge.
              const triageLabel = (triage === 'fixed' || triage === 'invalid' || triage === 'deleted')
                ? triage.toUpperCase()
                : triage === 'inprogress' ? 'In progress' : triage === 'ignored' ? 'Ignored' : null
              const inner = html`<div class="bundle-issues-finding-head">
                <span class=${`bundle-issue-sev sev-${sev}`}>${sev.replaceAll('_', ' ')}</span>
                ${lineLabel ? html`<span class="bundle-issues-finding-line">${lineLabel}</span>` : nothing}
                ${triageLabel ? html`<span class=${`bundle-issues-finding-triage triage-${triage}`}>${triageLabel}</span>` : nothing}
                <span class="bundle-issues-finding-spacer"></span>
                ${bundleIssueReportsTemplate(finding, { kind, bucketKey })}
              </div>
              <div class="bundle-issues-finding-desc">${renderHighlighted(titledDescription(finding), { paragraphs: false })}</div>`
              return html`<li class="bundle-issues-finding">
                ${kind === 'bundle'
                  ? html`<button
                      type="button"
                      class="bundle-issues-finding-link"
                      data-bundle-view-source=${file}
                      data-bundle-view-finding-idx=${findingIdx}
                      data-bundle-view-line=${finding.line ?? ''}
                    >${inner}</button>`
                  : html`<div class="bundle-issues-finding-link bundle-issues-finding-static">${inner}</div>`}
              </li>`
            })}
          </ul>
        </li>`
      })}
    </ul>
  </div>`
}

// Bundles view entry. The list of all bundles lives in the sidebar
// now — clicking a bundle row there sets `state.selectedBundle` and
// switches `state.currentView` to 'bundles', and this entry renders
// the selected bundle's full-width slide (header + tab strip +
// active tab content). When no bundle is selected (post-delete, or
// an external navigate that lands on the bundles view without
// picking a row), we paint a placeholder pointing the user back at
// the sidebar — the `bundles` argument is kept so the entry's
// signature matches render.js's `litRender(renderBundlesList(state.bundles), slot)`
// call site even though the list itself isn't rendered here.
export function renderBundlesList(bundles) {
  const selected = state.selectedBundle
  const selectedEntry = selected ? bundles.find((b) => b.integrity === selected) : null
  if (!selectedEntry) {
    return html`<div class="bundles-view bundles-view-empty">
      <p class="bundles-empty-hint">
        ${bundles.length === 0
          ? html`No bundles yet. Drop a <code>.map</code> sourcemap or a <code>.stasis.code.br</code> bundle to start.`
          : 'Pick a bundle from the sidebar to open it.'}
      </p>
    </div>`
  }
  return renderBundleSlide(selectedEntry)
}

// Tray-with-down-arrow glyph for the Overview's "Download bundle"
// button. Stroke-based (`currentColor`) so it tracks the button's
// text color on hover, same treatment as the COPY_PATH_ICON above.
const DOWNLOAD_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M8 2v8"/>
  <path d="m4.5 7 3.5 3.5L11.5 7"/>
  <path d="M2.5 13h11"/>
</svg>`

// SPDX (Linux Foundation) brand mark — monochrome, from the CC0 Simple
// Icons set. Fill-based glyph (`currentColor`) so it tints with the
// button text like the other icons. The sibling CycloneDX segment
// stays text-only on purpose: that logo is CC BY-ND (no derivatives),
// so a monochrome variant can't be shipped.
const SPDX_ICON = html`<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
  <path d="M0 0v24H8.222l2.089-2.373 2.09-2.374V13.2H18.978l2.51-2.488L24 8.223V0H12zm5.2 5.2h13.791L12.2 12c-3.735 3.74-6.838 6.8-6.896 6.8-.057 0-.104-3.06-.104-6.8zm8.4 8.8v10H24V14h-5.2z"/>
</svg>`

// GitHub-style language bar for parsed Stasis bundles. The segments use
// source lines, which makes the bar describe the code the user can read
// rather than the compressed/encoded artifact size. Resource entries have no
// textual source body and are therefore excluded. Unknown extensions still
// get a segment; their labels stay in the shared hover tooltip instead of
// adding another legend to the Overview.
const BUNDLE_LANGUAGE_COLORS = Object.freeze({
  javascript: '#f1e05a', jsx: '#f1e05a', typescript: '#3178c6', tsx: '#3178c6',
  json: '#f1e05a', css: '#663399', markup: '#e34c26', yaml: '#cb171e',
  bash: '#89e051', markdown: '#083fa1', solidity: '#AA6746', php: '#4F5D95',
  rust: '#dea584', ruby: '#701516', java: '#b07219', cpp: '#f34b7d',
  c: '#555555', objectivec: '#438eff', python: '#3572A5', go: '#00ADD8',
  kotlin: '#A97BFF', swift: '#F05138', dart: '#00B4AB', sql: '#e38c00',
  lua: '#000080', csharp: '#178600', scala: '#DC322F', vue: '#41B883', svelte: '#FF3E00',
})
const UNKNOWN_BUNDLE_LANGUAGE_COLORS = Object.freeze([
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16', '#e11d48', '#a855f7',
])

function bundleLanguageColor(key) {
  if (BUNDLE_LANGUAGE_COLORS[key]) return BUNDLE_LANGUAGE_COLORS[key]
  let hash = 0
  for (const char of key) hash = Math.imul(hash, 31) + char.codePointAt(0) | 0
  return UNKNOWN_BUNDLE_LANGUAGE_COLORS[(hash >>> 0) % UNKNOWN_BUNDLE_LANGUAGE_COLORS.length]
}

function languageBarPointerOver(e) {
  const bar = e.currentTarget
  const segment = e.target.closest?.('.bundles-languages-segment')
  if (!segment || !bar.contains(segment)) return
  bar.dataset.tooltip = segment.dataset.languageTooltip ?? ''
  // The entire bar owns the tooltip. Moving between segments only changes
  // its text; it does not trigger the normal hide/show hand-off between
  // adjacent elements.
  showTooltip(bar)
}

function languageBarPointerLeave(e) {
  delete e.currentTarget.dataset.tooltip
  hideTooltip()
}

function renderBundleLanguagesBar(details) {
  if (details?.kind !== 'stasis' || !details.bundle) return nothing
  // `bundleSourcesAsMap` includes only textual sources. Stasis resources
  // (images, fonts, and other binary payloads) are intentionally absent,
  // so they cannot distort the language shares or get a fake extension.
  const lines = details.lineCounts?.size > 0
    ? details.lineCounts
    : new Map([...bundleSourcesAsMap(details)].map(([path, content]) => [path, bundleSourceLineCount(content)]))
  const stats = details.codeStats ?? bundleCodeStats(lines, bundleFileSizes(details))
  const total = stats.lines
  const segments = stats.languages.filter(language => language.lines > 0)
  if (total <= 0 || segments.length === 0) return nothing
  return html`<div
    class="bundles-languages-bar"
    data-tooltip-managed
    aria-label="Languages in this bundle"
    @pointerover=${languageBarPointerOver}
    @pointerleave=${languageBarPointerLeave}
  >
    ${segments.map(({ key, label, lines: lineCount }) => {
      const pct = lineCount / total * 100
      return html`<span
        class="bundles-languages-segment"
        style=${styleMap({ flexGrow: lineCount, background: bundleLanguageColor(key) })}
        data-language-tooltip=${`${label} · ${pct < 1 ? pct.toFixed(1) : pct.toFixed(0)}% · ${lineCount.toLocaleString()} LoC`}
      ></span>`
    })}
  </div>`
}

// Exports column for the Overview's `.bundles-detail-meta-row` — a
// sibling "column" to the metadata blocks holding the bundle's export
// actions. "Download bundle" saves the raw artifact (events.js reads
// the bytes via `readBundle`, fronts the unencrypted-download
// confirmation, and saves under the original filename); it's always
// present since the bytes live on disk regardless of parse state. The
// SPDX / CycloneDX SBOM exports are derived from the parsed stasis
// module inventory, so they only appear once that's available and
// carries at least one named+versioned component (`details` is null /
// sourcemap / un-parsed on the other Overview branches → bundle-only).
async function downloadPublicBundle(entry) {
  try { await (await loadManagedBundle()).downloadManagedBundle(entry.managedId, entry.filename ?? entry.name ?? 'bundle') }
  catch (error) { alert(error.message) }
}

function bundleExportsColumn(entry, details) {
  const hasSbom = bundleHasSbomComponents(details)
  const languages = renderBundleLanguagesBar(details)
  // Inner `-row` wrapper holds the buttons so the outer column can be a
  // size container (CSS): the buttons right-align while the column sits
  // narrow and flip to a left-aligned row once it spans its own line.
  return html`<div class="bundles-overview-exports">
    ${languages}
    <div class="bundles-overview-exports-row">
      ${entry.managedId ? getPublicShare()
        ? html`<button type="button" class="bundles-download-btn" @click=${() => void downloadPublicBundle(entry)}>${DOWNLOAD_ICON}<span>Download bundle</span></button>`
        : html`<a class="bundles-download-btn" href=${`/api/bundles/${encodeURIComponent(entry.managedId)}/download`}>${DOWNLOAD_ICON}<span>Download bundle</span></a>` : html`<button type="button" class="bundles-download-btn" data-bundle-download=${entry.integrity}>
        ${DOWNLOAD_ICON}<span>Download bundle</span>
      </button>`}
      ${hasSbom ? html`<div class="bundles-export-pair">
        <button type="button" class="bundles-download-btn" data-bundle-export-sbom="cyclonedx" data-tooltip="Export a CycloneDX SBOM (.cdx.json)">CycloneDX</button>
        <button type="button" class="bundles-download-btn" data-bundle-export-sbom="spdx" data-tooltip="Export an SPDX SBOM (.spdx.json)">${SPDX_ICON}<span>SPDX</span></button>
      </div>` : nothing}
    </div>
  </div>`
}

// Shared `.bundles-overview` shell for the Overview branches that
// have no parsed sources to show (loading / error / un-parsed) —
// metadata row on top, optional placeholder line below.
function renderBundleOverviewFallback(meta, exportsCol, placeholder = nothing) {
  return html`<div class="bundles-overview">
    <div class="bundles-overview-summary">
      <div class="bundles-detail-meta-row">${meta}${exportsCol}</div>
    </div>
    ${placeholder}
  </div>`
}

// The bytes a bundle's files take once unpacked: the sum of every known
// file size, by the measure the Packages column weighs them with. Null
// when no file has a size to add.
function bundleUnpackedSize(sizes) {
  const known = sizes.filter((size) => typeof size === 'number')
  return known.length > 0 ? known.reduce((sum, size) => sum + size, 0) : null
}

// Overview tab body for the open bundle. Until bundle-load.js finishes
// the readBundle + parse, `state.bundleDetails` is null (or stale for
// a previous selection); the metadata block renders on its own. Parsed
// .map files render sourcemap fields (version, output, source root,
// names) and parsed stasis bundles their version + resolution kinds,
// both through `renderBundleSourcesPanel`; a parse error, or a stasis
// bundle with no parsed `bundle`, gets the metadata row plus a
// placeholder line.
function renderBundleDetails(entry, details) {
  const origin = details?.integrity === entry.integrity && !details.error && details.kind === 'stasis' ? details.bundle : null
  const meta = (prefix = '', includeSize = false) => html`<dl class="bundles-detail-meta">
    <dt>Name</dt><dd>${entry.name}</dd>
    ${entry.managedId ? html`<dt>Repository</dt><dd>${entry.repoFullName || 'Unattached'}</dd>${entry.repoId == null ? nothing : html`<dt>Directory</dt><dd class="mono">/${entry.repoDirectory ?? ''}</dd>`}` : nothing}
    ${bundleOriginLinks(origin, prefix).map(link => html`<dt>${link.label}</dt><dd class="bundle-origin-row">
      <a class="bundle-origin-link" href=${link.href} target="_blank" rel="noopener noreferrer">${link.label === 'GitHub' ? unsafeHTML(GITHUB_ICON_SVG) : nothing}<span>${link.text}</span></a>
      ${link.commit ? html`<a class="bundle-origin-link bundle-commit-link" href=${link.commit.href} data-tooltip=${link.commit.hash} target="_blank" rel="noopener noreferrer">${unsafeHTML(COMMIT_ICON_SVG)}<span>${link.commit.text}</span></a>` : nothing}
    </dd>`)}
    <dt>Integrity</dt><dd class="mono bundle-integrity">${entry.integrity}</dd>
    ${prefix ? html`<dt>Prefix</dt><dd class="mono">${prefix}</dd>` : nothing}
    ${origin?.entries.size > 0 ? html`<dt>${origin.entries.size === 1 ? 'Entry' : 'Entries'}</dt><dd class="mono"><ul class="bundles-entry-points">
      ${[...origin.entries].map(file => html`<li><button type="button" class="bundle-entry-point" data-bundle-view-source=${file}>${stripPathPrefix(file, prefix)}</button></li>`)}
    </ul></dd>` : nothing}
    ${includeSize && details && details.integrity === entry.integrity
      ? html`<dt>Size</dt><dd>${formatBytes(details.size)}</dd>`
      : nothing}
  </dl>`
  // The bundle's bytes live on disk regardless of whether the parse
  // below succeeds (or has even finished), so the exports column
  // rides every branch — loading, error, and parsed alike. `details`
  // gates the SBOM exports (parsed stasis only); on the loading / error
  // branches it's null / mismatched, so only "Download bundle" shows.
  const exportsCol = bundleExportsColumn(entry, details)
  // Loading / error / un-parsed states share the same `.bundles-overview`
  // shell as the parsed-content branch so the Overview body's flex
  // layout + summary padding apply consistently — without the wrapper
  // the body is `display: flex; overflow: hidden;` with no padding
  // and a bare `<dl>` lands flush against the panel edge. The
  // loading branch shows just the metadata (name + integrity are
  // already known); a "Loading…" placeholder flickered too briefly
  // to be useful and pushed the columns down on every open.
  if (!details || details.integrity !== entry.integrity) return renderBundleOverviewFallback(meta('', true), exportsCol)
  if (details.error) {
    return renderBundleOverviewFallback(meta('', true), exportsCol,
      html`<div class="bundles-overview-placeholder is-error">Failed to parse: ${details.error}</div>`)
  }
  if (details.kind === 'sourcemap' && details.json) {
    const json = details.json
    const sources = json.sources ?? []
    const sizeMap = bundleFileSizes(details)
    const sizes = details.sourceSizes ?? (sizeMap.size === sources.length
      ? sources.map((path) => sizeMap.get(path) ?? null)
      : sources.map((_, i) => typeof json.sourcesContent?.[i] === 'string' ? utf8ByteLength(json.sourcesContent[i]) : null))
    const extras = html`
      <dt>Version</dt><dd>${String(json.version ?? '?')}</dd>
      ${json.file ? html`<dt>Output</dt><dd class="mono">${json.file}</dd>` : nothing}
      ${json.sourceRoot ? html`<dt>Source root</dt><dd class="mono">${json.sourceRoot}</dd>` : nothing}
      ${json.names || details.namesCount != null ? html`<dt>Names</dt><dd>${json.names?.length ?? details.namesCount}</dd>` : nothing}
    `
    // Sourcemaps carry no package metadata — pass null so the panel
    // falls back to the path heuristic for bucketing.
    return renderBundleSourcesPanel(meta, extras, sources, sizes, null, exportsCol, { bundleSize: details.size, unpackedSize: bundleUnpackedSize(sizes) })
  }
  if (details.kind === 'stasis' && details.bundle) {
    const bundle = details.bundle
    // Every file, weighed by its bytes — images and fonts included, so the
    // Packages column adds up to what `du` says of the mounted tree. A
    // directory capture is recorded at a path its real directory also
    // holds and is no file: listed, it would sit among the files as one.
    const sizeMap = bundleFileSizes(details)
    const kinds = bundleFileKinds(details)
    const sourceNames = [...kinds.keys()]
    const resources = new Set(sourceNames.filter((path) => kinds.get(path) === 'resource'))
    // Each `bundle.imports` key is either `*` or a `, `-joined
    // condition set (see `State#conditionsKey` in @exodus/stasis-core);
    // a bundle commonly carries several keys whose underlying
    // conditions overlap (`node, import` + `node, require`),
    // so split / dedupe / sort surfaces a clean unique list of
    // conditions rather than a comma-joined wall of raw keys.
    // The optional ` (with: {...})` import-attributes suffix
    // belongs to the condition it follows; strip it so attribute
    // flavors collapse back into their base condition.
    const importKinds = new Set()
    for (const key of bundle.imports.keys()) {
      const base = key.replace(/\s*\(with: .*\)\s*$/u, '')
      for (const cond of base.split(', ')) importKinds.add(cond)
    }
    const sortedKinds = [...importKinds].toSorted()
    const sizes = sourceNames.map((s) => sizeMap.get(s))
    const extras = html`
      <dt>Version</dt><dd>${String(bundle.version)}</dd>
      ${sortedKinds.length > 0
        ? html`<dt>Resolution kinds</dt><dd>${sortedKinds.join(', ')}</dd>`
        : nothing}
    `
    // Stasis records authoritative package boundaries — feed them in so
    // workspace packages bucket apart from their shared parent dir.
    return renderBundleSourcesPanel(meta, extras, sourceNames, sizes, bundlePackageDirs(details), exportsCol, { bundleSize: details.size, unpackedSize: bundleUnpackedSize(sizes), resources, details })
  }
  // Stasis without a parsed bundle — likely a brotli decompression
  // that failed silently (no error path filled in). Fall back to
  // the metadata block above plus a generic "not parsed" line,
  // wrapped in the same shell so layout is consistent.
  return renderBundleOverviewFallback(meta('', true), exportsCol,
    html`<div class="bundles-overview-placeholder">Bundle contents not parsed.</div>`)
}
