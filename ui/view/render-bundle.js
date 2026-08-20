// Bundle-view rendering surface. Lifted out of `render.js` so the
// findings-tab path doesn't have to scroll past ~1500 lines of
// bundle chrome. Covers bundle data prep, the bundle graph, the
// bundles list + details panel + tabs + source-viewer modal, and
// `renderIssuesGroupedByFile` (the per-file grouped finding list
// shared with the package Issues slide via render-packages.js).
//
// `render()` in `render.js` keeps the `currentView === 'bundles'`
// dispatch (slot reuse + canvas attach), importing `renderBundlesList`,
// `buildBundleGraphData`, `setCurrentBundleGraph`,
// `countBundleTriageBuckets`, `refreshBundleGraphSidebar`, and
// `refreshBundleGraphTopPkgs` from this module.
import { html, nothing } from 'lit'
import { choose } from 'lit/directives/choose.js'
import { classMap } from 'lit/directives/class-map.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from 'lit/directives/style-map.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { FILE_ICONS, displayName, groupOf } from './file-display.js'
import { BUNDLE_ICON_SVG } from './icons.js'
import { findingsForFileHash, indexedHashFindingCount, reportsForFinding, reportsForFindingByPackage, reportsForFindingByRepo, state } from '#client/index.js'
import { SEVERITIES, SEVERITY_ORDER, formatBytes, formatRunMeta, stripCommonPathPrefix } from './format.js'
import { bundlePackageDirs, bundleSourcesAsMap } from './bundle-sources.js'
import { bundleHasSbomComponents } from './sbom.js'
import { buildSearchMatcher, runBundleSearch } from './bundle-search-scan.js'
import { bundlePkgOf, ownSourceSplittable } from './bundle-pkg-of.js'
import { tabKey } from './group.js'
import { computeFileHash } from '../../common/finding-id.js'
import { langForPath, highlight as prismHighlight } from './prism-highlight.js'
import { computeTransitiveCounts } from './file-counts.js'
import { pkgColor } from './graph/utils.js'
import { graph2 } from './graph/state.js'
import { loadedGraphMod } from './graph-attach.js'
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

// File → set of resolved import paths. The stasis Bundle exposes
// imports as Map<conditionsKey, Map<parent, Map<specifier, resolved>>>
// (see `@exodus/stasis-core/bundle`); union resolved targets across all
// condition keys (node, import, module-sync, ...) and dedupe per
// parent. Sourcemaps have no import info, so the map is empty.
function bundleImportsAsMap(details) {
  const result = new Map()
  if (!details || details.kind !== 'stasis' || !details.bundle) return result
  for (const byParent of details.bundle.imports.values()) {
    for (const [parent, specMap] of byParent) {
      if (!result.has(parent)) result.set(parent, new Set())
      for (const resolved of specMap.values()) {
        if (typeof resolved === 'string') result.get(parent).add(resolved)
      }
    }
  }
  return result
}

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
function buildBundleTree(details) {
  const sources = bundleSourcesAsMap(details)
  const imports = bundleImportsAsMap(details)
  const origFiles = [...sources.keys()]
  const { stripped } = stripCommonPathPrefix(origFiles)
  const origToStripped = new Map(origFiles.map((f, i) => [f, stripped[i]]))
  const tree = {}
  for (const [origFile, content] of sources) {
    const file = origToStripped.get(origFile)
    const imps = imports.get(origFile)
    tree[file] = {
      imports: imps
        ? [...imps].map((i) => origToStripped.get(i)).filter(Boolean)
        : [],
      size: new TextEncoder().encode(content).byteLength,
    }
  }
  return { tree, origToStripped }
}

// SHA-512 of each bundle source, in the canonical `sha512-${base64}`
// SRI form that `computeFileHash` (common/finding-id.js) produces —
// the same hashing the analyzer stamps on findings, so the strings
// compare equal. Async because crypto.subtle.digest is. Returns
// Map<file, integrity>.
export async function computeBundleFileHashes(details) {
  const sources = bundleSourcesAsMap(details)
  const result = new Map()
  for (const [file, content] of sources) {
    result.set(file, await computeFileHash(content))
  }
  return result
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
// Per-bucket counts of bundle-matched findings — drives the graph
// topbar's triage selector visibility / counts. Walks the same
// hash → finding index bundleFindingsByFile uses, bucketing each
// finding by triage state (or 'live' when none).
export function countBundleTriageBuckets(details) {
  const counts = { inprogress: 0, fixed: 0, invalid: 0, deleted: 0 }
  if (!details?.fileHashes) return counts
  const seen = new Set()
  for (const hash of details.fileHashes.values()) {
    if (seen.has(hash)) continue
    seen.add(hash)
    for (const f of findingsForFileHash(hash)) {
      const t = state.triage.get(tabKey(f))?.triage
      if (t && counts[t] !== undefined) counts[t]++
    }
  }
  return counts
}

// Bundle-side per-finding filter. Two modes:
//
//   'graph'  — bundle graph view. Follows state.shownTriage (null =
//              live + ignored, 'fixed'/'invalid'/'deleted' = exact
//              bucket). Ignore is intentionally NOT considered: it's
//              a per-report flag and a bundle aggregates across
//              reports, so an ignored finding still counts as live
//              in the non-triaged view. The selector exposes only
//              the three triage buckets accordingly.
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
      const t = state.triage.get(tabKey(f))?.triage ?? null
      if (mode === 'issues') return t !== 'invalid' && t !== 'deleted'
      return t === state.shownTriage
    })
    if (filtered.length === 0) continue
    if (!result.has(file)) result.set(file, [])
    const arr = result.get(file)
    for (const f of filtered) arr.push(f)
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
// Every file in the bundle is a node — unlike the findings-tab graph,
// the bundle graph has no "All files" toggle (see `files` below).
export function buildBundleGraphData(details) {
  const { tree, origToStripped } = buildBundleTree(details)
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
  const ownCounts = new Map()
  const severitySets = new Map()
  const colorSets = new Map()
  const fileFindings = new Map()
  for (const [file, findings] of findingsByFile) {
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
  const transitiveCounts = computeTransitiveCounts(tree, ownCounts)
  // Stripped→original mapping the lazy `buildGraphFromPrep` applies
  // to each node's `origFile` field — the selection card's "View
  // source →" button hands the unstripped path to the source viewer
  // (keyed by original path in `bundleSourcesAsMap`). Findings-tab
  // nodes don't get `origFile`, so the button stays bundle-only.
  const strippedToOrig = new Map()
  for (const [orig, stripped] of origToStripped) strippedToOrig.set(stripped, orig)
  // Re-key the stasis package map onto the stripped paths the graph
  // nodes use (the tree is built from stripped paths), so the classifier
  // can look a node's authoritative package dir up by node id. The dir
  // VALUE stays the original package path — that's the package identity
  // (label + color), independent of any stripped display prefix. Null
  // for sourcemap bundles, where the classifier falls back to the path
  // heuristic alone.
  const origPackageDirs = bundlePackageDirs(details)
  const strippedPackageDirs = origPackageDirs
    ? new Map([...origToStripped].map(([orig, stripped]) => [stripped, origPackageDirs.get(orig)]))
    : null
  const packageDirOf = strippedPackageDirs ? (p) => strippedPackageDirs.get(p) : null
  // `canSplitOwnDirs` lets the render path hide the "Split dirs" toggle
  // when own source can't actually be divided (all in one top-level
  // dir, or none at all) — flipping it would be a no-op. Workspace
  // packages are excluded via the package map so they don't masquerade
  // as splittable own source.
  const canSplitOwnDirs = ownSourceSplittable(allFiles, packageDirOf)
  // `pkgOf` rides in `options` so packaging recognizes both
  // `node_modules/` and `dependencies/` regardless of the global
  // depsDir picked from state.reports, which would otherwise miss
  // bundle paths under whichever dir the loaded reports don't use,
  // plus the stasis `packageDir` for each node so workspace packages
  // (the PHP `vendor/<vendor>/<pkg>` case, monorepo `packages/<name>`)
  // split out instead of collapsing under a shared parent dir.
  // `graph2.splitOwnDirs` (topbar "Split dirs" toggle) decides whether
  // own source fans out into per-directory groups or collapses into
  // one `__own__` bucket; it's read here so flipping it + re-rendering
  // rebuilds the graph with the new package set. AND-ed with
  // `canSplitOwnDirs` so a bundle that can't be split stays merged
  // regardless of a toggle value persisted from a previous, splittable
  // bundle — its hidden toggle can't be the reason the grouping looks
  // different.
  const splitOwnDirs = graph2.splitOwnDirs && canSplitOwnDirs
  const pkgOf = (p) => bundlePkgOf(p, { splitOwnDirs, packageDir: packageDirOf?.(p) })
  // `canPackagesView` gates the topbar "Packages" toggle (and the
  // mode itself, via the flag buildGraphFromPrep stamps on the
  // graph): a package-level view needs 3+ packages under the
  // CURRENT classifier — with 2 it's a dumbbell that says nothing
  // the file view doesn't. Counted on the full inventory (not the
  // focus-narrowed set below) so the toggle doesn't vanish while
  // drilled into a single package. Early exit at 3, same pattern
  // as ownSourceSplittable.
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
  // bundle (or invalidated by a Split-dirs flip) matches nothing;
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
    canSplitOwnDirs,
    canPackagesView,
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
  mod.refreshSidebar(_currentBundlePrep, { isBundleContext: true })
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
function renderBundleSizeDistribution(items) {
  // items: Array<{path, size, pkgDir}>; size may be 0 / null when the
  // bundle didn't carry per-source content (rare for sourcemaps).
  // `pkgDir` is the path's stasis package dir (undefined for sourcemap
  // bundles), so workspace packages bucket apart from their parent dir.
  const totalByPkg = new Map()
  let total = 0
  for (const { path, size, pkgDir } of items) {
    if (typeof size !== 'number' || size <= 0) continue
    const pkg = bundlePkgOf(path, { packageDir: pkgDir })
    totalByPkg.set(pkg, (totalByPkg.get(pkg) ?? 0) + size)
    total += size
  }
  if (total === 0) return nothing
  const sorted = [...totalByPkg.entries()].toSorted((a, b) => b[1] - a[1])
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
        const label = pkg === '__own__' ? 'own source' : pkg
        const c = pkgColor(pkg)
        return html`<li>
          <span class="bundles-dist-dot" style=${styleMap({ background: c })}></span>
          <span class="bundles-dist-pkg" data-tooltip=${pkg === '__own__' ? nothing : pkg}>${label}</span>
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

// Sources panel for the bundles details view — shared between the
// sourcemap and stasis branches of `renderBundleDetails`. Wraps
// the metadata block + per-package size visualization + flat file
// list, splitting the viz and the list across Packages / Files
// tabs when the bundle has more than 5 packages (a flat layout is
// readable up to that count; beyond it the two views compete for
// vertical space).
//
// `sources` and `sizes` are parallel arrays — same indices, same
// length. Sizes may be null when content wasn't shipped in the
// bundle (uncommon for sourcemaps).
//
// `exportsCol` is the Overview's exports column (Download bundle, …),
// built once by the caller (`renderBundleDetails`) so it rides every
// Overview branch — parsed or not — from a single source. It renders
// as the third column of `.bundles-detail-meta-row`.
function renderBundleSourcesPanel(meta, extras, sources, sizes, packageDirs, exportsCol) {
  const { prefix, stripped } = stripCommonPathPrefix(sources)
  // Compute packages from the STRIPPED paths so the visualization
  // reflects what differs between files (a shared `dist/src/...`
  // prefix would otherwise bucket everything under `dist`). Paths
  // without a remaining directory map to `__own__`. `packageDirs`
  // (keyed by the ORIGINAL `sources` paths) carries the stasis package
  // boundary per file so sibling workspace packages (`vendor/aws/*`,
  // monorepo `packages/*`) stay separate instead of collapsing under a
  // shared parent dir; null for sourcemap bundles, which have none.
  const pkgDirOf = (i) => packageDirs?.get(sources[i])
  const packages = new Set()
  for (let i = 0; i < stripped.length; i++) {
    packages.add(bundlePkgOf(stripped[i], { packageDir: pkgDirOf(i) }))
  }
  // Stable alphabetical order — size signal is in the dist viz.
  const order = stripped
    .map((_, i) => i)
    .toSorted((a, b) => stripped[a].localeCompare(stripped[b]))

  const distItems = stripped.map((p, i) => ({ path: p, size: sizes[i], pkgDir: pkgDirOf(i) }))
  // `renderBundleSizeDistribution` returns `nothing` when no source
  // carries a positive byte size (common for stasis bundles without
  // inline `sourcesContent`). Mirror the Files / Reports column
  // empty-state so the Packages column doesn't render as a card
  // with a header and a yawning blank body.
  const distContent = renderBundleSizeDistribution(distItems)
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
  // Each row is a button so the whole strip is a click target +
  // keyboard-focusable; data-bundle-view-source carries the full
  // (un-stripped) path for the source viewer modal. Rows render
  // as buttons regardless of whether the bundle carries content
  // (the click handler checks bundleSourcesAsMap and shows an
  // empty placeholder when content is missing).
  const filesTpl = sources.length > 0 ? html`<ul class="bundles-sources-list">
    ${order.map((i) => {
      const src = sources[i]
      const bareSrc = stripped[i]
      const size = sizes[i]
      return html`<li>
        <button type="button" class="bundles-source-row" data-bundle-view-source=${src} data-tooltip=${src}>
          <span class="bundles-source-path">${bareSrc}</span>
          ${size == null ? nothing : html`<span class="bundles-source-size">${formatBytes(size)}</span>`}
        </button>
      </li>`
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
        <button type="button" class="report-chip bundles-report-chip" data-tooltip=${name} data-bundle-issue-report=${name}>
          ${unsafeHTML(iconHtml)}<span class="report-chip-label">${displayName(name)}</span>
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
        ${meta}
        <dl class="bundles-detail-meta">
          ${extras}
          <dt>Sources</dt><dd>${sources.length}</dd>
          ${prefix ? html`<dt>Prefix</dt><dd class="mono">${prefix}</dd>` : nothing}
        </dl>
        ${exportsCol ?? nothing}
      </div>
      ${issueTotal > 0 ? html`<div class="bundles-issue-summary tree-count-chips">${issueChips}</div>` : nothing}
    </div>
    <div class="bundles-overview-columns">
      <section class="bundles-overview-col">
        <header class="bundles-overview-col-head">
          Packages <span class="bundles-overview-col-count">${packages.size}</span>
        </header>
        <div class="bundles-overview-col-body">${distTpl}</div>
      </section>
      <section class="bundles-overview-col">
        <header class="bundles-overview-col-head">
          Files <span class="bundles-overview-col-count">${sources.length}</span>
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

// Full-width "slide" view for the Graph and Issues tabs. The
// bundles list and the regular details panel both step aside; a
// header bar across the top carries the back button + bundle name
// + integrity, plus a Graph / Issues sub-tab switcher. Body
// renders the active sub-tab's content edge to edge.
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

// Copy glyph for the Code slide's copy-path button — same two-rect
// shape and stroke weight as the finding card's copy action.
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
// the gutter. Lines without findings render a plain number.
function renderBundleSourceLines(content, path, integrity, lineFindings, matchLines = null) {
  const lineCount = content.split('\n').length
  const digits = String(lineCount).length
  const lang = langForPath(path)
  const cacheKey = `${integrity ?? ''}\0${path}`
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
      const highlightedHtml = await prismHighlight(content, lang)
      _bundleHighlightCache.set(cacheKey, highlightedHtml ?? null)
      _bundleHighlightPending.delete(cacheKey)
      // Cheap re-render — Lit only patches what changed, so the cost
      // is just the highlighted string injected via unsafeHTML.
      if (state.bundleSourceFile === path) render()
    })()
  }
  const highlighted = _bundleHighlightCache.get(cacheKey)
  return html`<div class="bundle-source-lines" style=${styleMap({ '--lineno-width': `${digits}ch` })}>
    <aside class="bundle-source-lineno-col" aria-hidden="true">
      ${Array.from({ length: lineCount }, (_, i) => {
        const ln = i + 1
        const entries = lineFindings.get(ln)
        const sev = entries ? _topSeverityOf(entries.map((e) => e.f)) : null
        const isActive = entries && state.bundleSourceFindingIdx != null
          && entries.some((e) => e.idx === state.bundleSourceFindingIdx)
        return html`<div class=${classMap({ 'bundle-source-lineno-row': true, 'is-match': matchLines?.has(ln) ?? false })} data-line=${ln}>
          ${entries
            ? html`<button
                type="button"
                class=${classMap({ 'bundle-source-dot': true, [`sev-${sev}`]: true, active: isActive })}
                data-bundle-source-finding=${entries[0].idx}
                title=${`${entries.length} ${entries.length === 1 ? 'issue' : 'issues'} on line ${ln}`}
                aria-label=${`${entries.length} issues on line ${ln}`}
              ></button>`
            : html`<span class="bundle-source-dot-placeholder"></span>`}
          <span class="bundle-source-lineno-num">${ln}</span>
        </div>`
      })}
    </aside>
    <pre class="bundle-source-code"><code class=${lang ? `language-${lang}` : ''}>${typeof highlighted === 'string'
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
  // Display-only triage badge in the header. The bundle Issues
  // filter excludes invalid/deleted, and ignored is per-report
  // (the bundle treats ignored findings as live), so the only
  // statuses that surface here are 'fixed' and 'inprogress' —
  // every other case (live or ignored) renders without a badge. An
  // "Untriaged" label would conflate live + ignored, which is
  // misleading because the user might have ignored the finding in a
  // report even though the bundle still treats it as active.
  const triage = state.triage.get(tabKey(f))?.triage
  const triageLabel = triage === 'fixed' ? 'Fixed' : triage === 'inprogress' ? 'In progress' : null
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
        title="Close (Esc)"
        aria-label="Close finding details"
      >×</button>
    </header>
    <div class="bundle-source-panel-body">
      ${(lineLabel || meta) ? html`<div class="bundle-source-panel-line-row">
        ${lineLabel ? html`<span class="bundle-source-panel-line">${lineLabel}</span>` : nothing}
        ${meta ? html`<span class="bundle-source-panel-meta" title=${meta}>${meta}</span>` : nothing}
      </div>` : nothing}
      <div class="bundle-source-panel-desc">${renderHighlighted(f.description ?? '')}</div>
      ${reports.length > 0 ? html`<div class="bundle-source-panel-reports">
        <div class="bundle-source-panel-reports-label">Reported by</div>
        ${reports.map((name) => {
          const iconHtml = FILE_ICONS[groupOf(name)] ?? FILE_ICONS.default
          return html`<button
            type="button"
            class="report-chip bundle-source-panel-report"
            title=${name}
            data-bundle-issue-report=${name}
          >${unsafeHTML(iconHtml)}<span class="report-chip-label">${displayName(name)}</span></button>`
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
  const sources = bundleSourcesAsMap(state.bundleDetails)
  const content = sources.get(path)
  // Find this file's matched findings (live or trash, depending on
  // showDeleted) and bucket by line so the gutter can stamp dots.
  // The map is also passed to the side panel: clicking a dot picks
  // the first finding on that line by default.
  const { fileFindings, lineFindings } = bundleViewerFindings(state.bundleDetails, path, content)
  return html`<div class="bundle-source-overlay">
    <div class=${classMap({ 'bundle-source-modal': true, 'with-panel': state.bundleSourceFindingIdx != null })}>
      <header class="bundle-source-bar">
        <div class="bundle-source-title" title=${path}>${path}</div>
        <button
          type="button"
          class="bundle-source-close"
          data-action="bundle-source-close"
          title="Close source viewer (Esc)"
          aria-label="Close source viewer"
        >×</button>
      </header>
      <div class="bundle-source-body">
        <div class="bundle-source-code-wrap">
          ${typeof content === 'string'
            ? renderBundleSourceLines(content, path, state.bundleDetails?.integrity, lineFindings)
            : html`<div class="bundle-source-empty">Source content not bundled.</div>`}
        </div>
        ${renderBundleSourceFindingPanel(fileFindings)}
      </div>
    </div>
  </div>`
}

// Build a directory tree from a flat list of paths so the Code
// slide's left rail can render as nested `<details>` elements.
// Each tree node is `{ name, files: Map<basename, fullpath>,
// dirs: Map<dirname, node> }`. Files are placed under their
// immediate parent; dirs are nested by every '/'-separated
// segment of the prefix. Returns the root node; callers walk
// dirs first (sorted), then files (sorted).
function buildBundleSourceTree(paths) {
  const root = { name: '', files: new Map(), dirs: new Map() }
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]
      let child = node.dirs.get(seg)
      if (!child) {
        child = { name: seg, files: new Map(), dirs: new Map() }
        node.dirs.set(seg, child)
      }
      node = child
    }
    node.files.set(parts.at(-1), p)
  }
  return root
}

// User-driven open/close overrides for the Code slide's tree
// rail, keyed by full dir path. The default `?open=` formula
// (root + ancestors of currentPath = open, rest = closed) is
// what we'd write in a fresh render; this Map records the
// user's deliberate toggles on top of that, so a filter-typing
// pass — which forces every dir open via `expandAll` — doesn't
// erase the user's pre-filter state when the filter clears.
//
// Updated only on `<summary>` click, which the browser also
// dispatches for keyboard activation (Enter / Space). Lit's own
// `?open=` writes don't fire a click, so they never touch this
// Map; the toggle event would, which is why we don't listen on
// that side.
//
// Cleared when `state.selectedBundle` changes — paths from one
// bundle don't carry meaning into another.
const _bundleTreeUserOpen = new Map()
let _bundleTreeMapBundle = null

// Recursive directory + file rendering for the Code slide's tree
// rail. Open the first level by default; deeper levels collapse
// so the user can drill in. Selected file gets a `current` class
// for the highlight strip; the click target is the data-bundle-
// view-source delegate (same one the Files tab uses).
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

function renderBundleSourceTree(node, currentPath, depth = 0, issueIndex = null, parentPath = '', expandAll = false) {
  const dirs = [...node.dirs.entries()].toSorted(([a], [b]) => a.localeCompare(b))
  const files = [...node.files.entries()].toSorted(([a], [b]) => a.localeCompare(b))
  // Auto-open dirs that contain the currently selected file so
  // the tree spotlights it on slide-open.
  const containsCurrent = (n) => {
    if (!currentPath) return false
    for (const p of n.files.values()) if (p === currentPath) return true
    for (const d of n.dirs.values()) if (containsCurrent(d)) return true
    return false
  }
  // `repeat` keyed by the dir / file path so Lit reuses existing
  // `<details>` when the user types in the search box and the
  // filtered tree rebuilds. The `?open=` formula layers three
  // signals:
  //   1. `expandAll` (filter-active) wins — the user typed a
  //      filter and expects to see every match, even ones in
  //      dirs they had previously closed.
  //   2. The user's explicit toggles — captured below by the
  //      `<summary>` click handler — win over the default. This
  //      is what restores the pre-filter tree state when the
  //      user clears the search box: dirs the user had open
  //      stay open, dirs they hadn't touched go back to default.
  //   3. The default — root open, ancestors of currentPath open,
  //      everything else closed.
  // Lit's part-cache short-circuits when the computed value
  // matches the last committed one, so renders that don't change
  // anyone's effective state issue zero attribute writes.
  const computeOpen = (childPath, child) => {
    if (expandAll) return true
    if (_bundleTreeUserOpen.has(childPath)) return _bundleTreeUserOpen.get(childPath)
    return depth === 0 || containsCurrent(child)
  }
  // Click on `<summary>` toggles the parent `<details>`; the
  // browser fires a click for both mouse and keyboard activation
  // (Enter / Space on a focused summary). Record the upcoming
  // open state — the click handler runs before the default
  // action, so `parentElement.open` is the OLD value here. A
  // separate `@toggle` listener would also catch Lit's own
  // attribute writes (expandAll renders), which we explicitly
  // do NOT want to record; clicks side-step that entirely.
  const onSummaryClick = (childPath) => (e) => {
    _bundleTreeUserOpen.set(childPath, !e.currentTarget.parentElement.open)
  }
  return html`<ul class=${classMap({ 'bundle-code-tree': true, root: depth === 0 })}>
    ${repeat(dirs, ([name]) => `${parentPath}/${name}`, ([name, child]) => {
      const childPath = parentPath ? `${parentPath}/${name}` : name
      // Rollup chip — total findings under this dir, colored by the
      // worst severity present, so a collapsed subtree still shows
      // where the issues live (the per-file chips only help once
      // it's expanded).
      const stats = dirIssueStats(child, issueIndex)
      return html`<li class="bundle-code-tree-dir">
        <details ?open=${computeOpen(childPath, child)}>
          <summary @click=${onSummaryClick(childPath)}>
            <span class="bundle-code-tree-dirname">${name}</span>
            ${stats.count > 0 ? html`<span class=${`bundle-code-tree-count sev-${stats.worst}`} title=${`${stats.count} ${stats.count === 1 ? 'issue' : 'issues'} inside`}>${stats.count}</span>` : nothing}
          </summary>
          ${renderBundleSourceTree(child, currentPath, depth + 1, issueIndex, childPath, expandAll)}
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
          title=${full}
        >
          <span class="bundle-code-tree-name">${name}</span>
          ${count > 0 ? html`<span class=${`bundle-code-tree-count sev-${sev}`} title=${`${count} ${count === 1 ? 'issue' : 'issues'}`}>${count}</span>` : nothing}
        </button>
      </li>`
    })}
  </ul>`
}

// Files-mode result pane — the directory tree, optionally
// filtered to paths matching `query` (case-insensitive
// substring on the prefix-stripped path the user actually sees
// in the rail). Empty query renders the full tree. The filtered
// tree is rebuilt from scratch (rather than hiding nodes) so the
// auto-open `containsCurrent` logic in renderBundleSourceTree
// falls out naturally on hits.
function renderBundleCodeFilesPanel(tree, currentPath, query, issueIndex, prefix = '') {
  if (!query) return renderBundleSourceTree(tree, currentPath, 0, issueIndex)
  const q = query.toLowerCase()
  // Walk the (already-remapped) tree to collect every full path
  // whose prefix-stripped form contains the query. Matching
  // against the stripped form keeps the filter UX consistent
  // with what the rail prefix label promises ("paths under here
  // are RELATIVE to <prefix>").
  const matches = []
  const collect = (n) => {
    for (const [, child] of n.dirs) collect(child)
    for (const [, full] of n.files) {
      const view = prefix && full.startsWith(prefix) ? full.slice(prefix.length) : full
      if (view.toLowerCase().includes(q)) matches.push(full)
    }
  }
  collect(tree)
  if (matches.length === 0) {
    return html`<div class="bundle-code-search-empty">No files match.</div>`
  }
  // Build a fresh tree from the STRIPPED forms of the matches so
  // the visual hierarchy doesn't waste rows on a shared prefix
  // that's already shown above the rail. Files at the leaves are
  // remapped back to original paths so the click delegate's
  // `data-bundle-view-source=${full}` resolves against
  // `sources` (which keys by the original path).
  const stripped = prefix
    ? matches.map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p))
    : matches
  const strippedToOrig = new Map()
  for (let i = 0; i < matches.length; i++) strippedToOrig.set(stripped[i], matches[i])
  const filtered = buildBundleSourceTree(stripped)
  const remap = (n) => {
    const remappedFiles = new Map()
    for (const [name, p] of n.files) remappedFiles.set(name, strippedToOrig.get(p) ?? p)
    n.files = remappedFiles
    for (const d of n.dirs.values()) remap(d)
  }
  remap(filtered)
  // expandAll: filtered tree only contains matches; every dir
  // exists because something inside it matched, so opening them
  // all means the user sees every hit at a glance instead of
  // having to click every level open after typing.
  return renderBundleSourceTree(filtered, currentPath, 0, issueIndex, '', true)
}

// Code-mode result pane — flat list of files, each with up to
// `MAX_HITS_PER_FILE` matching lines underneath. Each hit is a
// click target that selects the file AND scrolls the source
// viewer to the matching line (via `data-bundle-view-line`,
// which the events.js delegate forwards to the existing
// scroll-to-line path). Line text is shown truncated. Strict
// substring search; empty query shows a hint.
function renderBundleCodeContentResults(sources, query, currentPath, prefix = '') {
  if (!query) {
    return html`<div class="bundle-code-search-hint">Type to search across every source in this bundle.</div>`
  }
  const q = query.toLowerCase()
  const MAX_HITS_PER_FILE = 20
  const MAX_FILES = 100
  const results = []
  let totalHits = 0
  for (const [path, content] of sources) {
    if (typeof content !== 'string') continue
    const hits = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.toLowerCase().includes(q)) {
        hits.push({ ln: i + 1, text: line })
        totalHits++
        if (hits.length >= MAX_HITS_PER_FILE) break
      }
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
      const bare = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p
      return html`<div class=${classMap({ 'bundle-code-search-file': true, current: p === currentPath })}>
      <button
        type="button"
        class="bundle-code-search-file-name"
        data-bundle-view-source=${p}
        title=${p}
      >${bare}</button>
      <ul class="bundle-code-search-hits">
        ${hits.map((h) => html`<li class="bundle-code-search-hit">
          <button
            type="button"
            class="bundle-code-search-hit-link"
            data-bundle-view-source=${p}
            data-bundle-view-line=${h.ln}
            data-bundle-view-scroll-block="start"
            title=${`${p}:${h.ln}`}
          >
            <span class="bundle-code-search-hit-ln">${h.ln}</span>
            <span class="bundle-code-search-hit-text mono">${h.text.slice(0, 200)}</span>
          </button>
        </li>`)}
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
        // shared root. Falls back to the full path when the file
        // doesn't actually start with prefix (defensive — shouldn't
        // happen since prefix is derived from the same set).
        const bare = prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file
        const isCurrent = file === currentPath && state.bundleSourceFindingIdx === fileIdx
        return html`<li class=${classMap({ 'bundle-code-search-issue': true, current: isCurrent })}>
          <button
            type="button"
            class="bundle-code-search-issue-link"
            data-bundle-view-source=${file}
            data-bundle-view-finding-idx=${fileIdx}
            data-bundle-view-line=${finding.line ?? ''}
            title=${file}
          >
            <div class="bundle-code-search-issue-row">
              <span class=${`bundle-code-search-issue-sev sev-${sev}`}>${sev.replaceAll('_', ' ')}</span>
              <span class="bundle-code-search-issue-path mono">${bare}${finding.line ? `:${finding.line}` : ''}</span>
            </div>
            <div class="bundle-code-search-issue-desc">${renderHighlighted(finding.description ?? '')}</div>
          </button>
        </li>`
      })}
    </ul>
  </div>`
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
function renderBundleCodeView(details) {
  if (!details || (!details.json && !details.bundle)) return nothing
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
  }
  const allPaths = [...sources.keys()].toSorted()
  const { prefix, stripped } = stripCommonPathPrefix(allPaths)
  // Tree built from STRIPPED paths so the visual hierarchy
  // doesn't waste horizontal space on a shared root prefix.
  // Stripped → original mapping lets the click handlers (and
  // sources.get) recover the full key.
  const strippedToOrig = new Map()
  for (let i = 0; i < allPaths.length; i++) strippedToOrig.set(stripped[i], allPaths[i])
  // Build a tree node whose file values are ORIGINAL paths so the
  // tree-link buttons can hand them to data-bundle-view-source
  // directly. We feed buildBundleSourceTree stripped-keyed paths
  // and remap files at the leaves.
  const tree = buildBundleSourceTree(stripped)
  const remap = (n) => {
    const remappedFiles = new Map()
    for (const [name, p] of n.files) remappedFiles.set(name, strippedToOrig.get(p) ?? p)
    n.files = remappedFiles
    for (const d of n.dirs.values()) remap(d)
  }
  remap(tree)
  // Per-file finding index for the tree's count chips, the default-
  // file pick, and the Issues-mode hidden-when-empty gate. Computed
  // once and reused — the tree walk reads it as
  // Map<originalPath, Finding[]>.
  const issueIndex = details.fileHashes
    ? bundleFindingsByFile(details.fileHashes, 'issues')
    : new Map()
  let path = state.bundleSourceFile
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
    path = pickDefaultBundleCodeFile(details, sources, issueIndex)
    if (path) {
      state.bundleSourceFile = path
      _bundleCodeAutoPick = { bundle: state.selectedBundle, path, hadIssues: issueIndex.size > 0 }
      // No tab-click fires on a boot restore straight into the Code
      // tab, so the reveal has to ride the pick itself.
      revealBundleCodeCurrent()
    }
  } else if (_bundleCodeAutoPick && !_bundleCodeAutoPick.hadIssues && issueIndex.size > 0) {
    // Findings upgrade. A page refresh lands here before the hash
    // pass and the OPFS finding index finish, so the original pick
    // could only fall back to the entry / largest file — a file
    // with zero issues, while the bundle does have matches. Once
    // findings arrive (the finding-index subscription re-renders),
    // re-pick ONCE and follow it; the guard above ensures this only
    // happens while the fallback is still what's on screen.
    _bundleCodeAutoPick.hadIssues = true
    const upgraded = pickDefaultBundleCodeFile(details, sources, issueIndex)
    if (upgraded && upgraded !== path) {
      path = upgraded
      state.bundleSourceFile = upgraded
      state.bundleSourceFindingIdx = null
      _bundleCodeAutoPick.path = upgraded
      revealBundleCodeCurrent()
    }
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
      </div>
      ${prefix ? html`<div class="bundle-code-rail-prefix mono" title=${prefix}>${prefix}</div>` : nothing}
      <bundle-code-search .modes=${searchModes}></bundle-code-search>
      <div class="bundle-code-rail-body">
        ${choose(searchMode, [
          ['files', () => renderBundleCodeFilesPanel(tree, path, query, issueIndex, prefix)],
          ['code', () => renderBundleCodeContentResults(sources, query, path, prefix)],
          ['issues', () => renderBundleCodeIssuesResults(details, query, path, prefix)],
        ])}
      </div>
    </aside>
    <div class=${classMap({ 'bundle-code-main': true, 'with-panel': state.bundleSourceFindingIdx != null })}>
      ${path
        ? renderBundleCodeMain(details, path, content, fileFindings, lineFindings)
        : html`<div class="bundle-code-placeholder">Pick a file from the tree to view its source.</div>`}
    </div>
  </div>`
}

// Main pane of the Code slide — header bar (path + copy button +
// file stats + issue stepper) over the shared source-viewer body.
// The stepper cycles the side panel through the open file's
// findings in line order; its (idx, line) pairs ride in a JSON
// attribute so the events.js delegate steps without re-deriving
// the per-file findings.
function renderBundleCodeMain(details, path, content, fileFindings, lineFindings) {
  const lineCount = typeof content === 'string' ? content.split('\n').length : 0
  const byteSize = typeof content === 'string' ? new TextEncoder().encode(content).byteLength : 0
  const issueOrder = fileFindings
    .map((f, idx) => ({ idx, line: parseInt(f.line, 10) || 0 }))
    .toSorted((a, b) => a.line - b.line || a.idx - b.idx)
  return html`<header class="bundle-code-main-bar">
      <span class="bundle-code-main-path mono" title=${path}>${path}</span>
      <button
        type="button"
        class="bundle-code-copy-path"
        data-copy-path=${path}
        title="Copy file path"
        aria-label="Copy file path"
      >${COPY_PATH_ICON}</button>
      <span class="bundle-code-main-spacer"></span>
      ${typeof content === 'string'
        ? html`<span class="bundle-code-main-stats">${lineCount.toLocaleString()} ${lineCount === 1 ? 'line' : 'lines'} · ${formatBytes(byteSize)}</span>`
        : nothing}
      ${fileFindings.length > 0 ? html`<span
        class="bundle-code-main-issues"
        data-bundle-code-issue-order=${JSON.stringify(issueOrder)}
      >
        <span
          class=${`bundle-code-tree-count sev-${_topSeverityOf(fileFindings)}`}
          title=${`${fileFindings.length} ${fileFindings.length === 1 ? 'issue' : 'issues'} in this file`}
        >${fileFindings.length}</span>
        <button
          type="button"
          class="bundle-code-issue-step"
          data-bundle-code-issue-step="-1"
          title="Previous issue"
          aria-label="Previous issue"
        >‹</button>
        <button
          type="button"
          class="bundle-code-issue-step"
          data-bundle-code-issue-step="1"
          title="Next issue"
          aria-label="Next issue"
        >›</button>
      </span>` : nothing}
    </header>
    <div class="bundle-code-main-body">
      <div class="bundle-source-code-wrap">
        ${typeof content === 'string'
          ? renderBundleSourceLines(content, path, details.integrity, lineFindings)
          : html`<div class="bundle-source-empty">Source content not bundled.</div>`}
      </div>
      ${renderBundleSourceFindingPanel(fileFindings)}
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
      title=${`${path}:${anchor}`}
    >${rows}</button>`
}

// One file group — a clickable header (stripped path + match count)
// over its context snippets. The header opens the file at its first
// match; each snippet opens at its own anchor line.
function renderSearchFile(fileResult, prefix, radius) {
  const { path, lines, hits } = fileResult
  const bare = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
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
        title=${path}
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
  const result = runBundleSearch(details.integrity ?? '', sources, query, useRegex, caseSensitive)
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
      ${prefix ? html`<span class="bundle-search-summary-prefix mono" title=${prefix}>${prefix}</span>` : nothing}
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
    <header class="bundle-source-bar">
      <div class="bundle-source-title" title=${path}>${path}</div>
      <button
        type="button"
        class="bundle-source-close"
        data-action="bundle-source-close"
        title="Close source viewer (Esc)"
        aria-label="Close source viewer"
      >×</button>
    </header>
    <div class="bundle-source-body">
      <div class="bundle-source-code-wrap">
        ${typeof content === 'string'
          ? renderBundleSourceLines(content, path, details.integrity, lineFindings, matchLines)
          : html`<div class="bundle-source-empty">Source content not bundled.</div>`}
      </div>
      ${renderBundleSourceFindingPanel(fileFindings)}
    </div>
  </aside>`
}

// Search tab body — the github-style search bar over a results
// column, with the clicked result's source docked in a right
// sidebar. Reads its own query state (state.bundleSearchQuery /
// bundleSearchRegex / bundleSearchCase) so it never fights the Code
// tab's rail filter.
function renderBundleSearchView(details) {
  if (!details || (!details.json && !details.bundle)) return nothing
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
      <button
        type="button"
        class=${classMap({ 'bundle-search-context-toggle': true, on: showContext })}
        data-bundle-search-context
        aria-pressed=${String(showContext)}
        aria-label="Toggle context lines"
      ><span>Context</span><span class="bundle-search-switch" aria-hidden="true"></span></button>
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
  // load, and v0 stasis bundles hide post-parse once we've
  // confirmed there's no version metadata. The tab is rendered as
  // the LEFTMOST entry on purpose, so the post-parse stamp-in for
  // a fresh stasis bundle pushes the other tabs right rather than
  // landing in their middle — no in-flight click theft.
  const showAdvisories = showAdvisoriesTab(entry, state.bundleDetails)
  // Coerce a `state.bundleDetailsTab === 'advisories'` value back to
  // 'overview' when the tab button is hidden (sourcemap bundle,
  // post-parse v0 stasis, or a persisted state carried over from
  // another bundle). `showAdvisoriesTab` returns true through the
  // parse window for stasis-by-filename bundles, so this coercion
  // doesn't fire prematurely on a stasis → stasis navigation.
  if (state.bundleDetailsTab === 'advisories' && !showAdvisories) {
    state.bundleDetailsTab = 'overview'
  }
  // Compare needs a second bundle on disk to diff against. With only
  // the open bundle present the picker would have nothing to offer, so
  // the tab is hidden and a persisted 'compare' selection (carried
  // over from when a second bundle existed, or from another bundle's
  // state) coerces back to Overview — same pattern as the advisories
  // coercion above.
  const canCompare = (state.bundles?.length ?? 0) >= 2
  if (state.bundleDetailsTab === 'compare' && !canCompare) {
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
  // Kick the fetch lazily — only once the user has actually clicked
  // into the Advisories tab AND granted consent. The cache is
  // module-scoped (keyed by integrity); a re-render with the entry
  // already cached is a no-op. Gated on `detailsParsed` so the parse
  // window of a bundle switch can't issue a query for the PREVIOUS
  // bundle's (still-attached) module inventory.
  if (tab === 'advisories' && showAdvisories && detailsParsed) {
    ensureBundleAdvisories(details, render).catch(() => {})
  }
  // Issues is always in the tab strip — the body's empty state
  // ("No issues match this bundle's files.") covers the no-match
  // case, and keeping the button stable avoids two prior bugs:
  // (1) a layout shift mid-parse when `state.bundleDetails.fileHashes`
  // becomes non-null and the button stamps in as the leftmost tab,
  // pushing every other tab right (and stealing in-flight clicks);
  // (2) an orphan tab state where a persisted `b:<integrity> issues`
  // selection paints the issues body but the matching tab button is
  // hidden, leaving the user with no visible escape hatch.
  return html`<div class="bundles-view bundles-slide-view">
    <header class="bundles-slide-bar">
      <span class="bundles-slide-icon" aria-hidden="true">${unsafeHTML(BUNDLE_ICON_SVG)}</span>
      <div class="bundles-slide-title">
        <div class="bundles-slide-name">${entry.name}</div>
      </div>
      <div class="bundles-slide-tabs" role="tablist">
        ${showAdvisories ? html`<button
          type="button"
          class=${classMap({ 'bundles-tab': true, active: tab === 'advisories' })}
          data-bundle-tab="advisories"
          aria-selected=${String(tab === 'advisories')}
          role="tab"
        >Advisories</button>` : nothing}
        <button
          type="button"
          class=${classMap({ 'bundles-tab': true, active: tab === 'issues' })}
          data-bundle-tab="issues"
          aria-selected=${String(tab === 'issues')}
          role="tab"
        >Issues</button>
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
    </header>
    <div class=${classMap({ 'bundles-slide-body': true, 'bundles-slide-body-overview': overviewActive })}>
      ${overviewActive
        ? renderBundleDetails(entry, details)
        : detailsParsed
          ? choose(tab, [
              ['terminal', () => html`<div id="bundle-terminal-slot" class="bundle-terminal-slot"></div>`],
              ['graph', () => html`<div id="bundle-graph-slot" class="bundle-graph-slot"></div>`],
              ['treemap', () => html`<bundle-treemap .details=${details}></bundle-treemap>`],
              ['code', () => renderBundleCodeView(details)],
              ['search', () => renderBundleSearchView(details)],
              ['compare', () => html`<bundle-compare .details=${details} .integrity=${entry.integrity}></bundle-compare>`],
              ['issues', () => renderBundleIssuesList(details)],
              ['advisories', () => renderBundleAdvisoriesTab(details)],
            ])
          : detailsReady
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
      const iconHtml = FILE_ICONS[groupOf(name)] ?? FILE_ICONS.default
      return html`<button type="button" class="report-chip" title=${name} data-bundle-issue-report=${name}>${unsafeHTML(iconHtml)}<span class="report-chip-label">${displayName(name)}</span></button>`
    })}
    ${extra > 0 ? html`<span class="bundle-issue-reports-more">, and ${extra} more…</span>` : nothing}
  </div>`
}

// Issues tab — flat list of findings matched to the open bundle's
// files via SHA-512 fileHash equality. Sorted by severity (most
// severe first), tie-breaking by file path. Until the async hash
// computation completes (events.js kicks it after parse), shows a
// loading placeholder. No matches → "no issues" line so the user
// knows there isn't a render glitch.
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

function renderBundleIssuesList(details) {
  if (!details || (!details.json && !details.bundle)) return nothing
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
              ? html`<button type="button" class="bundle-issues-file-name mono" data-bundle-view-source=${file} title=${file}>${bare}</button>`
              : repoFileUrl
                ? html`<a class="bundle-issues-file-name bundle-issues-file-name-link mono" href=${repoFileUrl} target="_blank" rel="noopener" title=${file}>${bare}</a>`
                : html`<span class="bundle-issues-file-name bundle-issues-file-name-static mono" title=${file}>${bare}</span>`}
            <span class="bundle-issues-file-count">${findings.length} ${findings.length === 1 ? 'issue' : 'issues'}</span>
          </header>
          <ul class="bundle-issues-findings">
            ${repeat(sortedFindings, (finding) => finding.id ?? `${file}\0${finding.line ?? ''}\0${finding.severity ?? ''}\0${finding.description ?? ''}`, (finding) => {
              // findingIdx is the position in the ORIGINAL per-file
              // findings array (the one findingsByFile returned);
              // the source viewer's bundleSourceFindingIdx points at
              // that index, so the sorted display order doesn't
              // break the lookup. Only used by the bundle path.
              const findingIdx = findings.indexOf(finding)
              const sev = finding.severity
              const triage = state.triage.get(tabKey(finding))?.triage
              // Show the badge for any persisted triage state. The
              // bundle Issues tab + the package slide's `live` view
              // both filter invalid + deleted out of `findingsByFile`
              // upstream, so only `fixed` ever surfaces there. On the
              // package slide's `[Invalid]` / `[Deleted]` tabs the
              // findings carry the matching state by construction —
              // tagging each row makes it obvious which bucket the
              // user is looking at without having to remember which
              // tab they clicked.
              const triageLabel = (triage === 'fixed' || triage === 'invalid' || triage === 'deleted')
                ? triage.toUpperCase()
                : triage === 'inprogress' ? 'In progress' : null
              const inner = html`<div class="bundle-issues-finding-head">
                <span class=${`bundle-issue-sev sev-${sev}`}>${sev.replaceAll('_', ' ')}</span>
                ${(() => { const lbl = formatFindingLine(finding.line); return lbl ? html`<span class="bundle-issues-finding-line">${lbl}</span>` : nothing })()}
                ${triageLabel ? html`<span class=${`bundle-issues-finding-triage triage-${triage}`}>${triageLabel}</span>` : nothing}
                <span class="bundle-issues-finding-spacer"></span>
                ${bundleIssueReportsTemplate(finding, { kind, bucketKey })}
              </div>
              <div class="bundle-issues-finding-desc">${renderHighlighted(finding.description ?? '')}</div>`
              return html`<li class="bundle-issues-finding">
                ${kind === 'bundle'
                  ? html`<button
                      type="button"
                      class="bundle-issues-finding-link"
                      data-bundle-view-source=${file}
                      data-bundle-view-finding-idx=${findingIdx}
                      data-bundle-view-line=${finding.line ?? ''}
                      title=${file}
                    >${inner}</button>`
                  : html`<div class="bundle-issues-finding-link bundle-issues-finding-static" title=${file}>${inner}</div>`}
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
function bundleExportsColumn(entry, details) {
  const hasSbom = bundleHasSbomComponents(details)
  // Inner `-row` wrapper holds the buttons so the outer column can be a
  // size container (CSS): the buttons right-align while the column sits
  // narrow and flip to a left-aligned row once it spans its own line.
  return html`<div class="bundles-overview-exports">
    <div class="bundles-overview-exports-row">
      <button type="button" class="bundles-download-btn" data-bundle-download=${entry.integrity}>
        ${DOWNLOAD_ICON}<span>Download bundle</span>
      </button>
      ${hasSbom ? html`<div class="bundles-export-pair">
        <button type="button" class="bundles-download-btn" data-bundle-export-sbom="cyclonedx" title="Export a CycloneDX SBOM (.cdx.json)">CycloneDX</button>
        <button type="button" class="bundles-download-btn" data-bundle-export-sbom="spdx" title="Export an SPDX SBOM (.spdx.json)">${SPDX_ICON}<span>SPDX</span></button>
      </div>` : nothing}
    </div>
  </div>`
}

// Right-panel content for the open bundle. Until events.js finishes
// the readBundle + parse, `state.bundleDetails` is null (or stale
// for a previous selection); show a Loading… placeholder. For .map
// files we render parsed sourcemap fields (version, output, sources
// list with per-source content sizes). Anything else (stasis
// bundle, unparseable .map) gets the metadata-only fallback.
function renderBundleDetails(entry, details) {
  const meta = html`<dl class="bundles-detail-meta">
    <dt>Name</dt><dd>${entry.name}</dd>
    <dt>Integrity</dt><dd class="mono">${entry.integrity}</dd>
    ${details && details.integrity === entry.integrity
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
  if (!details || details.integrity !== entry.integrity) {
    return html`<div class="bundles-overview">
      <div class="bundles-overview-summary">
        <div class="bundles-detail-meta-row">${meta}${exportsCol}</div>
      </div>
    </div>`
  }
  if (details.error) {
    return html`<div class="bundles-overview">
      <div class="bundles-overview-summary">
        <div class="bundles-detail-meta-row">${meta}${exportsCol}</div>
      </div>
      <div class="bundles-overview-placeholder is-error">Failed to parse: ${details.error}</div>
    </div>`
  }
  if (details.kind === 'sourcemap' && details.json) {
    const json = details.json
    const sources = json.sources ?? []
    const contents = json.sourcesContent ?? []
    const sizes = sources.map((_, i) => typeof contents[i] === 'string'
      ? new TextEncoder().encode(contents[i]).byteLength
      : null)
    const extras = html`
      <dt>Version</dt><dd>${String(json.version ?? '?')}</dd>
      ${json.file ? html`<dt>Output</dt><dd class="mono">${json.file}</dd>` : nothing}
      ${json.sourceRoot ? html`<dt>Source root</dt><dd class="mono">${json.sourceRoot}</dd>` : nothing}
      ${json.names ? html`<dt>Names</dt><dd>${json.names.length}</dd>` : nothing}
    `
    // Sourcemaps carry no package metadata — pass null so the panel
    // falls back to the path heuristic for bucketing.
    return renderBundleSourcesPanel(meta, extras, sources, sizes, null, exportsCol)
  }
  if (details.kind === 'stasis' && details.bundle) {
    const bundle = details.bundle
    const sourceMap = bundle.sources
    const sourceNames = [...sourceMap.keys()]
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
    const sizes = sourceNames.map((s) => {
      const content = sourceMap.get(s)
      return typeof content === 'string'
        ? new TextEncoder().encode(content).byteLength
        : null
    })
    const extras = html`
      <dt>Version</dt><dd>${String(bundle.version)}</dd>
      ${sortedKinds.length > 0
        ? html`<dt>Resolution kinds</dt><dd>${sortedKinds.join(', ')}</dd>`
        : nothing}
    `
    // Stasis records authoritative package boundaries — feed them in so
    // workspace packages bucket apart from their shared parent dir.
    return renderBundleSourcesPanel(meta, extras, sourceNames, sizes, bundlePackageDirs(details), exportsCol)
  }
  // Stasis without a parsed bundle — likely a brotli decompression
  // that failed silently (no error path filled in). Fall back to
  // the metadata block above plus a generic "not parsed" line,
  // wrapped in the same shell so layout is consistent.
  return html`<div class="bundles-overview">
    <div class="bundles-overview-summary">
      <div class="bundles-detail-meta-row">${meta}${exportsCol}</div>
    </div>
    <div class="bundles-overview-placeholder">Bundle contents not parsed.</div>
  </div>`
}
