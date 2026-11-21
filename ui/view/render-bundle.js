import { sharedFindingTriage, usesReportIgnore } from '../../client/ignored-triage.js'
// The bundle view: graph data prep, the bundle slide and its tabs, the source
// viewer modal, and `renderIssuesGroupedByFile` (shared with the package and
// repository Issues slides). render.js keeps the `bundles` view dispatch.
import { html, nothing } from 'lit'
import { store } from '@rray/frontend/state-management'
import { getPublicShare } from '../../client/managed/public-share.js'
import { loadManagedBundle } from './client-managed.js'
import { managedBundleRoute, managedCodeLocation } from './managed-bundle-navigation.js'
import { managedHistory } from './managed-history.js'
import { choose } from 'lit/directives/choose.js'
import { classMap } from 'lit/directives/class-map.js'
import { guard } from 'lit/directives/guard.js'
import { live } from 'lit/directives/live.js'
import { ref } from 'lit/directives/ref.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from './style-map.js'
import { appMarkup } from './markup.js'
import { FILE_ICONS, REPORT_LOGOS, displayName, groupOf } from './file-display.js'
import { fileIconFormat, sourcePackageIcon as packageIconFor, sourceFileIcon } from './source-file-icon.js'
import { LONG_LINE, TEXT_NODE_MAX, sourceText } from './source-text.js'
import { controlMarkup, hasControls } from './control-chars.js'
import { bundleFileGithub, githubFileLink } from './bundle-file-github.js'
import { bundlePackageSourceStats } from './bundle-source-package.js'
import { VENDORED_ECOSYSTEMS, buildBundleSourceTree, bundleSourceTreePrefix, compactSourceDirectory, compareDirectoryOrder, defaultOpenDirectories, filterBundleSourceTree, navigateBundleSourceTree, shallowestNamed } from './bundle-source-tree.js'
import { bundleSourceLinkResolver } from '../../common/bundle-source-links.js'
import { watchSourceWrap } from './source-wrap.js'
import { PRETTY_ICON, prettyCopy, prettyFolded, prettyPrintable, prettyTooltip } from './pretty-source.js'
import { jsonPrinted } from '../../common/pretty-json.js'
import { bundleFileHistory } from './bundle-code-history.js'
import { BUNDLE_ICON_SVG, COMMIT_ICON_SVG, DEPENDENCIES_ICON_SVG, GITHUB_ICON_SVG, NPM_ICON_SVG, REPO_ICON_SVG, SCAN_ICON_SVG, TAG_ICON_SVG } from './icons.js'
import { lockfileFormat, lockfileTooltip, viewedLockfile } from './lockfile-view.js'
import './lockfile-graph.js'
import { overviewColumn } from './bundle-overview-column.js'
import { navigateToNpm, npmDependenciesColumn, npmOverviewExtras, npmOverviewMeta, npmPackageInput, npmPackageRoute, npmVersionList } from './npm-package.js'
import { NPM_LICENSE_FILE } from './npm-entries.js'
import { NPM_TABS, REPOSITORY_CODE_TABS, REPOSITORY_FILELESS_TABS } from '../../common/managed/routes.js'
import { activityTab } from './repository-activity.js'
import { browsableRepositories, openRepositoryCodeTab, repositoryCodeListing, repositoryCodeName, repositoryCodePending, repositoryCodeRoute, repositoryFullName,
  repositoryRefs } from './repository-code.js'
import './repository-treemap.js'
import { prefetchActivityView, withRepositoryActivity } from './activity-load.js'
import { npmAdvisoriesColumn, npmAlerts, npmBinaryColumn, npmContents, npmFileFlags, npmFileTags, npmFilesFilter, npmFilesRead, npmGithubFigures, npmOverviewBadges, npmPackageLinks, npmProvenanceFact, npmProvenanceNamesBuilder, npmReadabilityWarning, npmSocketFileAlerts, npmSocketFileTags, npmStatsRow } from './npm-overview.js'
import { byFlags } from './file-flags.js'
import { npmComparisonSource } from './npm-compare-source.js'
import { repositoryCompareSource } from './repository-compare.js'
import { npmSized } from './npm-size-class.js'
import { canScanBundle, openScan } from './scan-navigation.js'
import { withCompare } from './compare-load.js'
import { bundleComparisonCandidates } from './bundle-comparison-candidates.js'
import { isManagedUiMode, findingsForFileHash as localFindingsForFileHash, indexedHashFindingCount as localIndexedHashFindingCount, reportsForFinding, reportsForFindingByPackage, reportsForFindingByRepo, state } from '#client/index.js'
const findingsForFileHash = hash => isManagedUiMode() ? [] : localFindingsForFileHash(hash)
const indexedHashFindingCount = () => isManagedUiMode() ? 0 : localIndexedHashFindingCount()

import { SEVERITIES, SEVERITY_ORDER, formatRunMeta, stripCommonPathPrefix, titledDescription } from './format.js'
import { formatBytes } from '../scan/metrics.js'
import { utf8ByteLength } from '../../common/utf8.js'
import { bundleFileKinds, bundleFileSizes, bundlePackageDirs, bundleSourceLines, bundleSourceOrder, bundleSourceSizes, bundleSourcesAsMap } from '../../common/bundle-sources.js'
import { bundleCodeStats } from '../../common/bundle-stats.js'
import { bundleCommitTooltip, bundleOriginLinks } from './bundle-origin-links.js'
import { bundleLineCounts, bundleNeedsSources } from '../../common/bundle-metadata.js'
import { bundleHasSbomComponents } from './sbom.js'
import { SEARCH_MAX_TOTAL_HITS, buildSearchMatcher, runBundleSearch } from './bundle-search-scan.js'
import { railHitText, renderSearchMarks, sliceSearchLine } from './search-marks.js'
import { bundlePkgOf, ownSourceFirst, pkgLabel } from '../../common/bundle-pkg-of.js'
import { bundleWhyQuery } from './bundle-why.js'
import { openWhyDialog } from './lazy-dialogs.js'
import { renderBundleCodeImporters } from './bundle-code-importers.js'
import { bundleEntryPackages, bundleFlowEntries, bundleImportsAsMap, bundleLayerRoots, bundleOwnSourcePackages, filterBundleGraphReason } from './bundle-graph-inputs.js'
import { bundleScopes, scopeOptions } from '../../common/bundle-reasons.js'
import { tabKey } from './group.js'
import { langForPath, highlight as prismHighlight } from './prism-highlight.js'
import { computeTransitiveCounts } from './file-counts.js'
import { pkgColor } from './graph/utils.js'
import { graph2 } from './graph/state.js'
import { loadedGraphMod } from './graph-attach.js'
import { hideTooltip, showTooltip } from './tooltip.js'
import { ensureBundleAdvisories, renderBundleAdvisoriesTab, showAdvisoriesTab } from './render-bundle-advisories.js'
import { bundleDependencyReviewFact } from './bundle-dependency-review.js'
import { bundleValidationFact } from './bundle-validation.js'
// Circular imports (render-finding → render → this module): safe, as only
// hoisted functions are used, and only after init.
import { renderHighlighted } from './render-finding.js'
import { render } from './render.js'
import { COLLAPSE_DIRS_ICON, COPY_ICON, NEXT_ICON, PREV_ICON, TERMINAL_ICON, WRAP_ICON } from './lit-icons.js'
import { focusTerminal } from './terminal-attach.js'
import { openAdminPage } from '../managed/navigation.js'

// The bundle Graph tab's prep (buildBundleGraphData), which the refresh
// helpers below hand lazy ui/graph.js again on each chip click.
let _currentBundlePrep = null

const triageOf = f => sharedFindingTriage(f, state.triage.get(tabKey(f)))
// `n` and the noun it counts, `many` its plural.
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
// `cache`'s value for `key`, made by `make` the first time it is asked for.
const keep = (cache, key, make) => {
  if (!cache.has(key)) cache.set(key, make())
  return cache.get(key)
}

// The bundle as buildGraph (graph/data.js) takes an analyzer's tree dump:
// keyed by paths with their shared prefix stripped, so graph nodes and the
// package buckets drawn from them are compact, sized by UTF-8 bytes, imports
// out of the bundle dropped. `origToStripped` maps each original path to its
// key. Kept a bundle.
const bundleTrees = new WeakMap()
const buildBundleTree = details => keep(bundleTrees, details, () => {
  const sizes = bundleSourceSizes(details)
  const imports = bundleImportsAsMap(details)
  const origFiles = [...sizes.keys()]
  const { stripped } = stripCommonPathPrefix(origFiles)
  const origToStripped = new Map(origFiles.map((f, i) => [f, stripped[i]]))
  const tree = {}
  origFiles.forEach((orig, i) => {
    tree[stripped[i]] = { imports: [...imports.get(orig) ?? []].map((target) => origToStripped.get(target)).filter(Boolean), size: sizes.get(orig) }
  })
  return { tree, origToStripped }
})

// Bundle-matched findings by triage bucket, for the graph topbar's selector.
export function countBundleTriageBuckets(details, sourcePaths = null) {
  const counts = { inprogress: 0, fixed: 0, invalid: 0, deleted: 0, ignored: 0 }
  const seen = new Set()
  for (const [file, hash] of details?.fileHashes ?? []) {
    if ((sourcePaths && !sourcePaths.has(file)) || seen.has(hash)) continue
    seen.add(hash)
    for (const t of findingsForFileHash(hash).map(triageOf)) {
      if (t && counts[t] !== undefined) counts[t]++
    }
  }
  return counts
}

// Every indexed finding matched to a bundle file by its hash, Map<file,
// Finding[]>: from the OPFS-wide bundle-finding-index as cached now, so a
// bundle matches every report ever dropped, not just the one open. 'graph'
// keeps those in state.shownTriage's bucket; 'issues' (the Issues list, the
// source viewer) all but invalid and deleted ones, as a bundle built before a
// fix, or under a per-report ignore, is still affected.
function bundleFindingsByFile(fileHashes, mode = 'graph') {
  const result = new Map()
  for (const [file, hash] of fileHashes ?? []) {
    const found = findingsForFileHash(hash).filter((f) => {
      const t = triageOf(f) ?? null
      return mode === 'issues' ? t !== 'invalid' && t !== 'deleted' : t === state.shownTriage
    })
    if (found.length > 0) result.set(file, found)
  }
  return result
}

// The bundle's graph as lazy ui/graph.js builds it (buildGraphFromPrep): the
// files of the chosen scope, a reason's or an entry point's (bundleScopes),
// keyed as buildBundleTree keys them, with the findings their hashes match
// (none until the hashes are computed: every node is clean). The files are
// kept for the scope (bundleGraphScope) and for a focused package, so a
// render changing neither hands the canvas the same array, which keeps its
// layout for it (graph/canvas.js).
export function buildBundleGraphData(details) {
  const full = buildBundleTree(details)
  const reasons = bundleScopes(details, full.origToStripped.keys())
  if (graph2.bundleReasonFor !== details.integrity) {
    graph2.bundleReasonFor = details.integrity
    graph2.dependencyPackagesView = false
    graph2.bundleReason = null
  }
  const scope = bundleGraphScope(full, reasons, graph2.bundleReason)
  const { tree, origToStripped, selected } = scope
  graph2.bundleReason = selected
  const allFiles = scope.files
  if (allFiles.length === 0) return null
  const strippedHashes = details.fileHashes?.size > 0
    ? new Map([...details.fileHashes].flatMap(([orig, hash]) => origToStripped.has(orig) ? [[origToStripped.get(orig), hash]] : []))
    : null
  const findingsByFile = bundleFindingsByFile(strippedHashes)
  // The topbar's Issues switch decides whether findings reach the graph. It
  // is offered for matches anywhere in the bundle, not just the scope, and
  // in any triage bucket: its row carries the status filter, the only way to
  // a bundle whose findings are all triaged.
  const hasIssues = findingsByFile.size > 0
    || [...(details.fileHashes ?? [])].some(([orig, hash]) => full.origToStripped.has(orig) && findingsForFileHash(hash).length > 0)
  const issuesShown = hasIssues && graph2.bundleIssues
  const ownCounts = new Map()
  const severitySets = new Map()
  const colorSets = new Map()
  const fileFindings = new Map()
  for (const [file, findings] of issuesShown ? findingsByFile : []) {
    const counts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
    const ff = findings.map((f) => ({ severity: f.severity, color: state.triage.get(tabKey(f))?.color ?? 'none' }))
    for (const { severity } of ff) counts[severity] = (counts[severity] || 0) + 1
    ownCounts.set(file, counts)
    severitySets.set(file, new Set(ff.map((f) => f.severity)))
    colorSets.set(file, new Set(ff.map((f) => f.color)))
    fileFindings.set(file, ff)
  }
  // Matrix and the flows highlight direct findings alone.
  const flowLayout = ['flow', 'package-flow'].includes(graph2.bundleLayout)
  const transitiveCounts = graph2.bundleLayout === 'matrix' || flowLayout || ownCounts.size === 0
    ? null : computeTransitiveCounts(tree, ownCounts)
  // Each node's original path, which the selection card's View source opens.
  const strippedToOrig = new Map([...origToStripped].map(([orig, stripped]) => [stripped, orig]))
  // Packages are told by original paths and recorded Stasis module
  // directories, so stripping can't make a dependency own source; equal
  // versions in different directories are separate copies.
  const origPackageDirs = bundlePackageDirs(details)
  const packageInfo = new Map(origPackageDirs ? [...details.bundle.modules].map(([directory, info]) =>
    [directory, { directory, version: typeof info.version === 'string' ? info.version : undefined }]) : [])
  const pkgOf = (p) => {
    const orig = strippedToOrig.get(p) ?? p
    return bundlePkgOf(orig, { packageDir: origPackageDirs?.get(orig) })
  }
  // The Packages toggle wants 3+ packages (with 2 it's a dumbbell), counted
  // over the scope, not a focused package, so it stays while drilled in.
  const pkgSet = new Set()
  for (const f of allFiles) {
    pkgSet.add(pkgOf(f))
    if (pkgSet.size >= 3) break
  }
  // A focused package left from another bundle matches nothing: dropped, as
  // is a selection of a file this tree doesn't have, which at package
  // altitude would put a "not in view" card over the canvas.
  let files = allFiles
  if (graph2.focusedPkg) {
    const focusFiles = keep(scope.focused, graph2.focusedPkg, () => allFiles.filter((f) => pkgOf(f) === graph2.focusedPkg))
    if (focusFiles.length > 0) files = focusFiles
    else graph2.focusedPkg = null
  }
  if (graph2.selected && !Object.hasOwn(tree, graph2.selected)) graph2.selected = null
  return {
    treeData: tree, files, ownCounts, transitiveCounts,
    severitySets, colorSets, fileFindings,
    options: { pkgOf, packageInfoOf: file => packageInfo.get(origPackageDirs?.get(strippedToOrig.get(file) ?? file)) },
    strippedToOrig,
    canPackagesView: pkgSet.size >= 3,
    hasIssues,
    issuesShown,
    viewId: details.integrity ?? null,
    supportsLayers: true,
    layerRoots: bundleLayerRoots(details, origToStripped, pkgOf, origPackageDirs, full.origToStripped),
    flowEntries: flowLayout ? bundleFlowEntries(details, origToStripped, full.origToStripped, origPackageDirs) : undefined,
    // Entry packages are traversal roots too, but are not necessarily own source.
    ownSourcePackages: bundleOwnSourcePackages(origToStripped, pkgOf, origPackageDirs),
    entryPackages: bundleEntryPackages(details, origToStripped, pkgOf),
    // Recorded file ownership, for dependency-cycle classification.
    ownSourceFiles: new Set(allFiles.filter((p) => pkgOf(p) === '__own__')),
    reasons: scopeOptions(reasons),
  }
}

// The bundle's tree for a scope (null for every file), its files, and each
// focused package's of them, kept by the full tree (one a bundle).
const bundleGraphScopes = new WeakMap()
function bundleGraphScope(full, reasons, requested) {
  const selected = reasons.has(requested) ? requested : null
  return keep(keep(bundleGraphScopes, full, () => new Map()), selected, () => {
    const scope = filterBundleGraphReason(full.tree, full.origToStripped, new Map(selected === null ? [] : [[selected, reasons.files(selected)]]), selected)
    return { ...scope, files: Object.keys(scope.tree), focused: new Map() }
  })
}

// The bundle Graph tab's sidebar and top packages, drawn by lazy ui/graph.js.
const graphMod = () => _currentBundlePrep && loadedGraphMod()
export function refreshBundleGraphSidebar() {
  graphMod()?.refreshSidebar(_currentBundlePrep, { isBundleContext: true, findingsJump: !isManagedUiMode() })
}

export function refreshBundleGraphTopPkgs() {
  graphMod()?.refreshTopPkgs(_currentBundlePrep)
}

export function setCurrentBundleGraphPrep(prep) {
  _currentBundlePrep = prep
}
// The Overview's Packages column: a stacked bar of each package's share of
// the bytes, then a row for each, in `pkgColor`'s hues, so a package reads
// the same here as on the graph's canvas. `dist` the packages' sizes
// (overviewFiles), sorted here by `sort` once for each.
function renderBundleSizeDistribution(dist, sort, details) {
  const { totalByPkg, whyQueries, total } = dist
  if (total === 0) return nothing
  const sorted = keep(dist.sorted, sort, () => [...totalByPkg.entries()].toSorted((a, b) => Number(b[0] === '__own__') - Number(a[0] === '__own__')
    || (sort === 'size' ? b[1] - a[1] : 0)
    || pkgLabel(a[0]).localeCompare(pkgLabel(b[0])) || a[0].localeCompare(b[0])))
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

// What the Overview makes of its files: their shared prefix and their paths
// without it, their packages (by original paths and recorded Stasis package
// directories, so workspace packages bucket apart from their parent), their
// orders by name and by size, and `dist`: each package's size where known
// (0 or null is not), the query naming it for the why dialog (bundleWhyQuery),
// and its orders as asked for (renderBundleSizeDistribution). Made once, not
// on every render (an npm answer arriving renders the Overview again): kept
// by the files' array, which its details keep, with the sizes, package
// directories and details made of.
const _overviewFiles = new WeakMap()
function overviewFiles(sources, sizes, packageDirs, details) {
  const kept = _overviewFiles.get(sources)
  if (kept && kept.packageDirs === packageDirs && kept.details === details && kept.sizes.length === sizes.length && kept.sizes.every((size, i) => size === sizes[i])) return kept
  const { prefix, stripped } = stripCommonPathPrefix(sources)
  const pkgs = sources.map((path) => bundlePkgOf(path, { packageDir: packageDirs?.get(path) }))
  const byName = stripped.map((_, i) => i).toSorted((a, b) => stripped[a].localeCompare(stripped[b]))
  const bySize = stripped.map((_, i) => i).toSorted((a, b) => (sizes[b] ?? -1) - (sizes[a] ?? -1) || stripped[a].localeCompare(stripped[b]))
  const dist = { totalByPkg: new Map(), whyQueries: new Map(), total: 0, sorted: new Map() }
  sources.forEach((path, i) => {
    if (typeof sizes[i] !== 'number' || sizes[i] <= 0) return
    dist.totalByPkg.set(pkgs[i], (dist.totalByPkg.get(pkgs[i]) ?? 0) + sizes[i])
    if (!dist.whyQueries.has(pkgs[i])) dist.whyQueries.set(pkgs[i], bundleWhyQuery(details, packageDirs?.get(path)))
    dist.total += sizes[i]
  })
  const facts = { sizes: [...sizes], packageDirs, details, prefix, stripped, packages: new Set(pkgs), byName, bySize, dist }
  _overviewFiles.set(sources, facts)
  return facts
}

// A report's chip, opening it (`data-bundle-issue-report`, events.js), with
// its group's sticker from `icons`; `after` follows its label.
const reportChip = (name, className, icons = REPORT_LOGOS, after = nothing) => html`<button type="button" class="${className}" data-bundle-issue-report=${name}>${appMarkup(icons[groupOf(name)] ?? icons.default)}<span class="report-chip-label" data-tooltip-truncated data-tooltip=${name}>${displayName(name)}</span>${after}</button>`

// An Overview column's empty state.
const columnEmpty = text => html`<p class="bundles-overview-col-empty">${text}</p>`

// An Overview column head's order buttons, `[value, label]` each, `value`
// the one pressed, `pick` choosing another.
const orderButtons = (label, options, value, pick) => html`<span class="bundles-overview-sort" role="group" aria-label="${label}">
  ${options.map(([option, text]) => html`<button type="button" aria-pressed=${String(value === option)} @click=${() => { pick(option); render() }}>${text}</button>`)}
</span>`

// The Overview of a bundle's sources or an npm version's files: its facts
// (`renderMeta(prefix)`, then `extras` and the build's), the exports column
// (`exportsCol`), the matched findings by severity, and Packages / Files /
// Reports columns, Reports only where some OPFS report matches. `sources`
// and `sizes` are parallel, a size null where unknown. `resources` (Stasis
// assets, an npm version's binaries) weigh in Packages and list among Files,
// but count apart from Sources and open no viewer. Unpacked is what every
// file of a known size adds up to, `lines` their lines of code. `leadColumn`
// replaces Packages, `trailColumns` follow Files, `summaryExtra` follows the
// facts, `overviewClass` names the layout; `fileIcon` and `fileTag` render
// around each Files row's path, `fileFlags` gives a file's flags as its tags
// show them (file-flags.js), and `fileFilter`, `{ label, keeps, clear }`,
// narrows the Files list alone, its label in the column's head with a way
// back to every file.
function renderBundleSourcesPanel(renderMeta, extras, sources, sizes, packageDirs, exportsCol, {
  bundleSize = null, resources = null, details = null, leadColumn = null, trailColumns = nothing, summaryExtra = nothing,
  fileTag = null, fileIcon = null, fileFlags = null, overviewClass = '', fileFilter = null, lines = null, sized = (measure, value, text) => text,
} = {}) {
  const facts = overviewFiles(sources, sizes, packageDirs, details)
  const { prefix, stripped, packages } = facts
  const known = sizes.filter((size) => typeof size === 'number')
  const unpackedSize = known.length > 0 ? known.reduce((sum, size) => sum + size, 0) : null
  // Files by name, or by size, largest first and unknown last, name breaking
  // ties; by flags too where any file listed is flagged (file-flags.js byFlags).
  const shown = stripped.map((_, i) => i).filter((i) => !fileFilter || fileFilter.keeps(sources[i]))
  const flagsOf = (i) => fileFlags?.(sources[i]) ?? []
  const flagged = shown.some((i) => flagsOf(i).length > 0)
  const filesSort = state.bundleOverviewFilesSort === 'flags' && !flagged ? 'name' : state.bundleOverviewFilesSort
  const order = filesSort === 'size' ? facts.bySize : facts.byName
  const listed = filesSort === 'flags' ? byFlags(shown, flagsOf, (i) => stripped[i])
    : fileFilter ? order.filter((i) => fileFilter.keeps(sources[i])) : order
  const packagesSort = state.bundleOverviewPackagesSort
  const distContent = renderBundleSizeDistribution(facts.dist, packagesSort, details)
  // The matched findings by severity, and by the OPFS report each came from,
  // a finding counting toward every report it appears in.
  const issueSummary = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  const matched = [...bundleFindingsByFile(state.bundleDetails?.fileHashes, 'issues').values()].flat()
  const reportCounts = new Map()
  for (const f of matched) {
    if (issueSummary[f.severity] !== undefined) issueSummary[f.severity]++
    for (const name of reportsForFinding(f.fileHash, f)) reportCounts.set(name, (reportCounts.get(name) ?? 0) + 1)
  }
  const reports = [...reportCounts.keys()].toSorted()
  const issueChips = SEVERITIES
    .filter((s) => issueSummary[s] > 0)
    .map((s) => html`<span class=${`tree-count-chip ${s}`}>${issueSummary[s]} ${s.replaceAll('_', ' ')}</span>`)
  // A source's row opens the source viewer on its full path, which shows a
  // placeholder where the bundle carries no content; a resource's, with no
  // source to show, is plain.
  const filesTpl = sources.length > 0 ? html`<ul class="bundles-sources-list">
    ${listed.map((i) => {
      const src = sources[i]
      const size = sizes[i]
      const row = html`${fileIcon ? fileIcon(src) : nothing}<span class="bundles-source-path" data-tooltip-truncated data-tooltip=${src}>${stripped[i]}</span>
        ${fileTag ? fileTag(src) : nothing}
        ${size == null ? nothing : html`<span class="bundles-source-size">${formatBytes(size)}</span>`}`
      return html`<li>${resources?.has(src)
        ? html`<div class="bundles-source-row is-resource">${row}</div>`
        : html`<button type="button" class="bundles-source-row" data-bundle-view-source=${src}>${row}</button>`}</li>`
    })}
  </ul>` : columnEmpty('No source files in this bundle.')
  const reportsTpl = html`<ul class="bundles-reports-list">
    ${reports.map((name) => html`<li>
      ${reportChip(name, 'report-chip bundles-report-chip', FILE_ICONS, html`<span class="bundles-report-count">${plural(reportCounts.get(name) ?? 0, 'issue')}</span>`)}
    </li>`)}
  </ul>`
  // Facts over the columns, each scrolling on its own, so a 2000-file bundle
  // doesn't push the facts off-screen.
  const textCount = sources.length - (resources?.size ?? 0)
  return html`<div class="bundles-overview ${overviewClass}">
    <div class="bundles-overview-summary">
      <div class="bundles-detail-meta-row">
        ${renderMeta(prefix)}
        <dl class="bundles-detail-meta is-build">
          ${extras}
          <dt>Sources</dt><dd>${lines == null ? sized('files', textCount, textCount)
            : html`${sized('files', textCount, plural(textCount, 'file'))} · ${sized('lines', lines, `${lines.toLocaleString('en')} LoC`)}`}</dd>
          ${bundleSize == null ? nothing : html`<dt>Size</dt><dd>${formatBytes(bundleSize)}</dd>`}
          ${unpackedSize == null ? nothing : html`<dt>Unpacked</dt><dd>${sized('unpacked', unpackedSize, formatBytes(unpackedSize))}</dd>`}
          ${resources?.size ? html`<dt>Resources</dt><dd>${resources.size}</dd>` : nothing}
        </dl>
        ${exportsCol ?? nothing}
      </div>
      ${matched.length > 0 ? html`<div class="bundles-issue-summary tree-count-chips">${issueChips}</div>` : nothing}
      ${summaryExtra}
    </div>
    <div class="bundles-overview-columns">
      ${leadColumn ?? overviewColumn({ title: 'Packages', count: packages.size,
        body: distContent === nothing ? columnEmpty('No size information for this bundle\'s sources.') : distContent,
        tools: orderButtons('Package order', [['name', 'Name'], ['size', 'Size']], packagesSort, value => { state.bundleOverviewPackagesSort = value }) })}
      ${overviewColumn({ title: 'Files', count: fileFilter ? `${listed.length} of ${sources.length}` : sources.length, body: filesTpl, list: true,
        extra: fileFilter ? html` <button type="button" class="bundles-overview-filter" aria-label=${`Show every file, not only ${fileFilter.label}`} @click=${fileFilter.clear}>${fileFilter.label}<span aria-hidden="true">×</span></button>` : nothing,
        tools: orderButtons('File order', [['name', 'Name'], ['size', 'Size'], ...flagged ? [['flags', 'Flags']] : []], filesSort, value => { state.bundleOverviewFilesSort = value }) })}
      ${reports.length > 0 ? overviewColumn({ title: 'Reports', count: reports.length, body: reportsTpl, list: true }) : nothing}
      ${trailColumns}
    </div>
  </div>`
}

// Highlighted sources, by integrity, path and whether pretty-printed: their
// HTML, or null where prism has no language for one or failed. The files
// opened last, BUNDLE_HIGHLIGHTS_KEPT of them, so reopening one is instant; a
// viewer shows one at a time, and each is several times its source's size.
const BUNDLE_HIGHLIGHTS_KEPT = 16
const _bundleHighlightCache = new Map()
const _bundleHighlightPending = new Set()

// Whether a source viewer shows `path`: the open bundle's file, or a dropped
// lockfile, open alone (lockfile-drop.js). Its read or highlight, once ended,
// re-renders only while it does.
const shownSource = path => state.bundleSourceFile === path
  || state.currentView === 'lockfile' && state.droppedLockfile?.name === path

// Wrap toggle for a source viewer's bar. Hidden until source-wrap.js finds
// wrapping makes a difference to the open file at the viewer's width.
const renderSourceWrapToggle = () => html`<button type="button" class="bundle-source-wrap-toggle" data-bundle-source-wrap hidden
  aria-pressed=${state.bundleSourceWrap ? 'true' : 'false'} aria-label="Wrap lines" data-tooltip="Wrap lines">${WRAP_ICON}</button>`

// Pretty-print toggle for a source viewer's bar, on a minified file the
// server can format, or JSON (pretty-source.js): busy while its copy is asked
// for, and saying why where it failed. After the wrap toggle, which pressing
// it can hide; in the Code tab's bar, before the file's stats, which keep
// room for its copy's (renderBundleCodeMain).
function renderPrettyToggle(copy, json) {
  const status = copy?.status
  return html`<button type="button" class=${classMap({ 'bundle-source-pretty-toggle': true, 'is-loading': status === 'loading', 'is-error': status === 'error',
    'is-folded': prettyFolded(json) })}
    data-bundle-source-pretty=${json ? 'json' : ''} aria-pressed=${state.bundleSourcePretty ? 'true' : 'false'} aria-busy=${status === 'loading' ? 'true' : nothing}
    aria-label="Pretty-print" data-tooltip=${prettyTooltip(copy, json)}>${PRETTY_ICON}</button>`
}

// The open file as a source viewer shows it, with its findings
// (bundleViewerFindings, `byFile` passed on): a pretty-printed copy, once it
// has come, in the file's place, with none of the file's findings, marks or
// line links, which are on the file's lines; `toggle` the pretty-print button
// where the file can be formatted. `entry` the managed bundle or npm version
// the file is of.
function viewedSource(details, entry, path, content, byFile = null) {
  const { fileFindings, lineFindings } = bundleViewerFindings(details, path, content, byFile)
  const printable = prettyPrintable(details, entry, path, content)
  const copy = printable ? prettyCopy(details, entry, path, content, () => { if (state.bundleSourceFile === path) render() }) : null
  const pretty = copy?.status === 'ready'
  return { pretty, toggle: printable ? renderPrettyToggle(copy, jsonPrinted(path)) : nothing, content: pretty ? copy.text : content,
    fileFindings: pretty ? [] : fileFindings, lineFindings: pretty ? new Map() : lineFindings }
}

// The Code tab's View lockfile toggle, on a lockfile the lockfile viewer
// reads, busy while its read runs and red where that failed (lockfile-view.js).
function renderLockfileToggle(read) {
  const status = read?.status
  return html`<button type="button" class=${classMap({ 'bundle-source-lockfile-toggle': true, 'is-loading': status === 'loading', 'is-error': status === 'error' })}
    data-bundle-source-lockfile aria-pressed=${state.bundleSourceLockfile ? 'true' : 'false'} aria-busy=${status === 'loading' ? 'true' : nothing}
    aria-label="View lockfile" data-tooltip=${lockfileTooltip(read)}>${appMarkup(DEPENDENCIES_ICON_SVG)}</button>`
}

// Bring the Code rail's selected file row into view once Lit has committed
// the render under way; `nearest` keeps the rail still where it shows already
// (tree links carry a scroll-margin for breathing room). events.js's too.
export function revealBundleCodeCurrent() {
  queueMicrotask(() => {
    document.querySelector('.bundle-code-rail-body .bundle-code-tree-link.current')
      ?.scrollIntoView({ block: 'nearest' })
  })
}

// Bring a line a link marks into the middle of the Code pane, two frames on:
// once its source has laid out, and wrapped lines have resized their rows.
function revealBundleSourceLine(line) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelector(`.bundle-code-main .bundle-source-lineno-row[data-line="${line}"]`)
      ?.scrollIntoView({ block: 'center' })
  }))
}

// The worst severity among `findings`, as a line's or a file's one chip shows.
function _topSeverityOf(findings) {
  return SEVERITIES.find((sev) => findings.some((f) => f.severity === sev)) ?? findings[0]?.severity ?? null
}

// Plain text for the source viewer, as Chromium can show it (see
// source-text.js): text nodes of at most TEXT_NODE_MAX, one line still where
// it spans several, and a line over LONG_LINE wrapped whether the viewer
// wraps lines or not, in a block of its own (see `.bundle-source-long-line`).
// Highlighted sources, 1 MiB at most, have no line that long. Control
// characters show as boxes (control-chars.js). Kept for the next render of
// the same file: looking for them takes a while over a large one.
let _plainSource = { content: '', parts: '' }
function plainSource(content) {
  if (_plainSource.content === content) return _plainSource.parts
  let parts = content
  if (content.length > TEXT_NODE_MAX || hasControls(content)) {
    const text = slice => [sourceText(slice)].flat()
    parts = []
    let plain = 0
    for (let from = 0; from < content.length;) {
      const at = content.indexOf('\n', from)
      const end = at === -1 ? content.length : at + 1
      if ((at === -1 ? end : at) - from > LONG_LINE) {
        parts.push(...text(content.slice(plain, from)), html`<span class="bundle-source-long-line">${text(content.slice(from, end))}</span>`)
        plain = end
      }
      from = end
    }
    parts.push(...text(content.slice(plain)))
  }
  _plainSource = { content, parts }
  return parts
}

// The source viewer's lines: a gutter, a row a line, beside one `<pre>` of
// the whole source, so prism's highlighted HTML, whose tokens may span lines,
// goes in as it is; the two share a line height to stay level. A line's
// findings (`lineFindings`, Map<line, { f, idx }[]>) put a dot in its row;
// the lines a clicked result opened (state.bundleSourceTargetLine) get a band
// (`.is-target`), except in a `pretty` copy (pretty-source.js), whose lines
// are its own.
function renderBundleSourceLines(content, path, details, lineFindings, matchLines, lineLinks, pretty) {
  const lineCount = bundleSourceLines(content)
  const target = state.bundleSourceTargetLine
  const targetLine = !pretty && target && target.path === path && target.bundle === (details?.integrity ?? null) ? target.line : null
  const targetEnd = targetLine == null ? null : Math.max(target.end ?? targetLine, targetLine)
  const digits = String(lineCount).length
  const lang = langForPath(path, details?.kind === 'stasis' ? details.bundle?.formats?.get(path) : undefined, content)
  const cacheKey = `${details?.integrity ?? ''}\0${path}${pretty ? '\0pretty' : ''}`
  // Highlighted in the background on first sight, rendered again once done.
  if (lang && !_bundleHighlightCache.has(cacheKey) && !_bundleHighlightPending.has(cacheKey)) {
    _bundleHighlightPending.add(cacheKey)
    ;(async () => {
      const highlightedHtml = await prismHighlight(content, lang, bundleSourceLinkResolver(details, path))
      _bundleHighlightCache.set(cacheKey, typeof highlightedHtml === 'string' ? controlMarkup(highlightedHtml) : null)
      if (_bundleHighlightCache.size > BUNDLE_HIGHLIGHTS_KEPT) _bundleHighlightCache.delete(_bundleHighlightCache.keys().next().value)
      _bundleHighlightPending.delete(cacheKey)
      if (shownSource(path)) render()
    })()
  }
  const highlighted = _bundleHighlightCache.get(cacheKey)
  // Read again last, as the files opened last are kept.
  if (_bundleHighlightCache.has(cacheKey)) {
    _bundleHighlightCache.delete(cacheKey)
    _bundleHighlightCache.set(cacheKey, highlighted)
  }
  // The gutter is drawn again only where anything a row shows changed
  // (`guard`), each line's dot told by its severity and findings: a large
  // file has a row for each of many thousand lines.
  const findingIdx = state.bundleSourceFindingIdx
  const dots = [...lineFindings].map(([ln, entries]) => `${ln}:${_topSeverityOf(entries.map((e) => e.f))}:${entries.map((e) => e.idx).join(',')}`).join(' ')
  return html`<div class=${classMap({ 'bundle-source-lines': true, 'is-wrapped': state.bundleSourceWrap })} style=${styleMap({ '--lineno-width': `${digits}ch` })} ${ref(watchSourceWrap)}>
    <aside class="bundle-source-lineno-col" aria-hidden="true">
      ${guard([lineCount, dots, findingIdx, matchLines, lineLinks, targetLine, targetEnd], () => Array.from({ length: lineCount }, (_, i) => {
        const ln = i + 1
        const entries = lineFindings.get(ln)
        const sev = entries ? _topSeverityOf(entries.map((e) => e.f)) : null
        const isActive = entries && findingIdx != null
          && entries.some((e) => e.idx === findingIdx)
        return html`<div class=${classMap({ 'bundle-source-lineno-row': true, 'is-match': matchLines?.has(ln) ?? false, 'is-target': targetLine != null && ln >= targetLine && ln <= targetEnd })} data-line=${ln}>
          ${entries
            ? html`<button
                type="button"
                class=${classMap({ 'bundle-source-dot': true, [`sev-${sev}`]: true, active: isActive })}
                data-bundle-source-finding=${entries[0].idx}
                data-tooltip=${`${entries.length} ${entries.length === 1 ? 'issue' : 'issues'} on line ${ln}`}
                aria-label=${`${entries.length} issues on line ${ln}`}
              ></button>`
            : html`<span class="bundle-source-dot-placeholder"></span>`}
          <span class="bundle-source-lineno-num" data-bundle-source-line=${lineLinks ? ln : nothing}>${ln}</span>
        </div>`
      }))}
    </aside>
    <pre class="bundle-source-code" tabindex="-1" aria-label=${path}><code class=${lang ? `language-${lang}` : ''}>${typeof highlighted === 'string'
      ? appMarkup(highlighted)
      : plainSource(content)}</code></pre>
  </div>`
}

// The triage badge of the source viewer's finding panel; invalid and deleted
// findings are not shown there.
const PANEL_TRIAGE = { fixed: 'Fixed', inprogress: 'In progress', ignored: 'Ignored' }

// The source viewer's finding panel, for the file's finding at
// state.bundleSourceFindingIdx: its severity, shared triage (a dependency's
// per-report ignore has no aggregate badge), lines, run (formatRunMeta, as
// the finding card's), description and the reports it came from.
function renderBundleSourceFindingPanel(findings) {
  const idx = state.bundleSourceFindingIdx
  const f = idx == null ? null : findings[idx]
  if (!f) return nothing
  const reports = f.fileHash ? reportsForFinding(f.fileHash, f) : []
  const triage = triageOf(f)
  const triageLabel = PANEL_TRIAGE[triage] ?? null
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
        ${reports.map((name) => reportChip(name, 'report-chip bundle-source-panel-report'))}
      </div>` : nothing}
    </div>
  </aside>`
}

// A file's findings in a source viewer: the list the finding panel indexes,
// and each line's (renderBundleSourceLines). None until the hashes are
// computed. `byFile` the bundle's matched findings, where the caller has them.
function bundleViewerFindings(details, path, content, byFile = null) {
  const fileFindings = typeof content === 'string' && details?.fileHashes
    ? [...(byFile ?? bundleFindingsByFile(details.fileHashes, 'issues')).get(path) ?? []] : []
  const lineFindings = new Map()
  fileFindings.forEach((f, idx) => {
    const ln = parseInt(f.line, 10)
    if (Number.isFinite(ln) && ln > 0) keep(lineFindings, ln, () => []).push({ f, idx })
  })
  return { fileFindings, lineFindings }
}

// The title bar of the source viewer modal and the Search tab's sidebar.
function renderBundleSourceBar(path, history = null, prettyToggle = nothing) {
  return html`<header class="bundle-source-bar">
      <div class="bundle-source-title mono" data-tooltip-truncated data-tooltip=${path}>${path}</div>
      ${history?.files.length > 1 ? renderBundleCodeFileNav(history) : nothing}
      ${renderSourceWrapToggle()}
      ${prettyToggle}
      <button
        type="button"
        class="bundle-source-close"
        data-action="bundle-source-close"
        aria-label="Close source viewer"
      >×</button>
    </header>`
}

// Every source viewer's body: its lines, and the finding panel; `viewed` the
// file as viewedSource shows it.
function renderBundleSourceCodeWrap(path, details, { content, fileFindings, lineFindings, pretty }, matchLines = null, lineLinks = false) {
  return html`<div class="bundle-source-code-wrap">
        ${typeof content === 'string'
          ? renderBundleSourceLines(content, path, details, lineFindings, matchLines, lineLinks, pretty)
          : html`<div class="bundle-source-empty">Source content not bundled.</div>`}
      </div>
      ${renderBundleSourceFindingPanel(fileFindings)}`
}

// The source viewer modal, over any view (render.js mounts it in
// `#bundle-source-overlay-slot`: a finding card's Code opens it from the
// findings), but the Code and Search tabs, which show the file in place.
export function renderBundleSourceModal() {
  const path = state.bundleSourceFile
  if (!path || state.bundleDetailsTab === 'code' || state.bundleDetailsTab === 'search') return nothing
  const details = state.bundleDetails
  const error = details?.sourceError || details?.error
  // A cold open has no details yet; a metadata-only open is still fetching
  // the bodies. Neither tells us whether this file's content was bundled.
  const loading = !error && (!details || details.metadataOnly === true)
  // The bundle it is of, among those listed, or the npm version open.
  const entry = state.bundles?.find(bundle => bundle.integrity === details?.integrity) ?? (details?.npm ? { npm: details.npm } : null)
  const viewed = loading || error ? null : viewedSource(details, entry, path, bundleSourcesAsMap(details).get(path))
  return html`<div class="bundle-source-overlay">
    <div class=${classMap({ 'bundle-source-modal': true, 'with-panel': state.bundleSourceFindingIdx != null })}>
      ${renderBundleSourceBar(path, bundleFileHistory(state.bundleCodeHistory, details?.integrity ?? null, path), viewed?.toggle)}
      <div class="bundle-source-body" aria-busy=${String(loading)}>
        ${error ? html`<div class="bundles-slide-placeholder is-error" role="status">Failed to load source: ${error}</div>`
          : loading ? html`<div class="bundles-slide-placeholder" role="status">Loading source…</div>`
          : renderBundleSourceCodeWrap(path, details, viewed)}
      </div>
    </div>
  </div>`
}

// The Code rail's directories opened or closed by hand, kept apart from a
// search's, which opens what matches without losing them; keyed by the first
// directory of a compact row, so the chain the row shows can change.
const _bundleTreeUserOpen = new Map()
let _bundleTreeMapBundle = null
let _bundleTreeCurrentPath = null
// Counts directories opened or closed other than by a click on one, which
// the browser has toggled already: the tree is drawn again for them
// (renderBundleCodeFilesPanel).
let _bundleTreeOpenings = 0

function openBundleTreeAncestors(path, prefix) {
  const parts = stripPathPrefix(path ?? '', prefix).split('/')
  for (let i = 1; i < parts.length; i++) _bundleTreeUserOpen.set(parts.slice(0, i).join('/'), true)
  _bundleTreeOpenings++
}

function revealBundleTreeFile(path, prefix) {
  state.bundleCodeSearchMode = 'files'
  state.bundleCodeSearchQuery = ''
  openBundleTreeAncestors(path, prefix)
  render()
  revealBundleCodeCurrent()
}

function closeBundleTreeDirs(node) {
  for (const child of node.dirs.values()) {
    _bundleTreeUserOpen.set(child.path, false)
    closeBundleTreeDirs(child)
  }
}

// The rail's terminal toggle, and the pane's close. Opening puts the caret
// on the terminal's command line; closing hands focus back to the toggle,
// as the close button that had it goes with the pane.
function showBundleCodeTerminal(open) {
  state.bundleCodeTerminal = open
  render()
  if (open) void focusTerminal()
  else document.querySelector('[data-bundle-code-terminal-toggle]')?.focus()
}

// The Code tab's terminal pane, under the code panel and a handle resizing
// it: the Terminal tab's own terminal, attached into the slot by render.js,
// so one session carries between the two.
function renderBundleCodeTerminal() {
  return html`<bundle-code-terminal-splitter role="separator" tabindex="0" aria-orientation="horizontal"
      aria-label="Resize terminal" data-tooltip="Drag to resize · double-click to reset"
    ></bundle-code-terminal-splitter>
    <section class="bundle-code-terminal" aria-label="Terminal">
    <header class="bundle-code-terminal-bar">
      <span class="bundle-code-rail-label">Terminal</span>
      <button type="button" class="bundle-code-rail-action" aria-label="Close terminal"
        @click=${() => showBundleCodeTerminal(false)}>×</button>
    </header>
    <div id="bundle-terminal-slot" class="bundle-code-terminal-slot"></div>
  </section>`
}

// What a directory's row tells of the files under it: their findings and
// the worst severity, for its chip, so issues show while it is collapsed
// (`issueIndex` is keyed by the original paths the tree's files hold), and
// whether the file open (`currentPath`) is one of them.
function dirStats(node, issueIndex, currentPath) {
  let count = 0
  let worst = null
  let current = false
  const walk = (n) => {
    for (const full of n.files.values()) {
      if (full === currentPath) current = true
      const findings = issueIndex?.get(full)
      if (!findings?.length) continue
      count += findings.length
      const sev = _topSeverityOf(findings)
      if (worst === null || (SEVERITY_ORDER[sev] ?? 0) > (SEVERITY_ORDER[worst] ?? 0)) worst = sev
    }
    for (const d of n.dirs.values()) walk(d)
  }
  walk(node)
  return { count, worst, current }
}

// A tree row's chip: its findings' count, in the worst one's color.
const countChip = (count, sev, tooltip) => html`<span class=${`bundle-code-tree-count sev-${sev}`} data-tooltip=${tooltip}>${count}</span>`

// The Code rail's tree. A directory opens as the user left it, else where it
// is one of the levels that keep the rail short (`opened`,
// defaultOpenDirectories) or holds the selected file; every one opens while
// a search filters it (`expandAll`). Files open in the viewer through the
// `data-bundle-view-source` delegate.
function renderBundleSourceTree(node, currentPath, depth = 0, issueIndex = null, expandAll = false, formats = null, sources = null, opened = null) {
  const dirs = [...node.dirs.entries()].toSorted(compareDirectoryOrder)
  const files = [...node.files.entries()].toSorted(([a], [b]) => a.localeCompare(b))
  return html`<ul class=${classMap({ 'bundle-code-tree': true, root: depth === 0 })}
    aria-label=${depth === 0 ? 'Source files' : nothing}
    @keydown=${depth === 0 ? navigateBundleSourceTree : nothing}
  >
    ${repeat(dirs, ([, child]) => child.path, ([name, child]) => {
      const childPath = child.path
      const compact = compactSourceDirectory(name, child, depth)
      const pkg = child.package
      const vendored = VENDORED_ECOSYSTEMS.has(pkg?.ecosystem)
      // A package's ecosystem, or the one a dependency root holds (node_modules).
      const packageIcon = pkg || child.dependencyRoot ? packageIconFor(pkg?.ecosystem ?? child.dependencyRoot) : nothing
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
      const stats = dirStats(child, issueIndex, currentPath)
      // live(.open) reconciles a native toggle on the next render.
      const open = expandAll || (_bundleTreeUserOpen.has(childPath) ? _bundleTreeUserOpen.get(childPath)
        : Boolean(opened?.has(childPath)) || stats.current)
      // Click precedes the browser's native toggle, including Enter/Space.
      // Listening to toggle would also record programmatic search expansion.
      return html`<li class="bundle-code-tree-dir">
        <details .open=${live(open)}>
          <summary @click=${(e) => { _bundleTreeUserOpen.set(childPath, !e.currentTarget.parentElement.open) }} .prepareTooltip=${weigh}
            data-tooltip-package=${info?.name ?? nothing}
            data-tooltip-ecosystem=${info?.ecosystem ?? nothing}
            data-tooltip-version=${info?.version ?? nothing}
            data-tooltip-files=${info?.fileCount ?? nothing}
            data-tooltip-repo=${info?.github ? info.github + (info.directory ? `/${info.directory}` : '') : nothing}
            data-tooltip-commit=${info?.commit ?? nothing}
            data-tooltip=${hasDetails ? tooltip : nothing}
            data-tooltip-placement=${hasDetails ? 'right-start' : nothing}>
            <span class="bundle-code-tree-chevron" aria-hidden="true"></span>
            ${packageIcon}
            <span class=${classMap({ 'bundle-code-tree-dirname': true, 'bundle-code-tree-package': !!pkg, 'bundle-code-tree-package-vendored': vendored })}
              data-tooltip-truncated data-tooltip=${hasDetails ? nothing : tooltip}>
              ${pkg ? html`<span class="bundle-code-tree-package-name">${pkg.name}</span>${pkg.version ? html`<span class="bundle-code-tree-package-version">${vendored ? '- ' : '@'}${pkg.version}</span>` : nothing}` : compact.names.map((part, index) => html`${index > 0 ? html`<span class="bundle-code-tree-separator">/</span>` : nothing}${part}`)}
            </span>
            ${pkg?.variant ? html`<span class="bundle-code-tree-variant">variant ${pkg.variant}</span>` : nothing}
            ${stats.count > 0 ? countChip(stats.count, stats.worst, `${plural(stats.count, 'issue')} inside`) : nothing}
          </summary>
          ${renderBundleSourceTree(compact.node, currentPath, depth + 1, issueIndex, expandAll, formats, sources, opened)}
        </details>
      </li>`
    })}
    ${repeat(files, ([, full]) => full, ([name, full]) => {
      const findings = issueIndex?.get(full) ?? []
      return html`<li class="bundle-code-tree-file">
        <button
          type="button"
          class=${classMap({ 'bundle-code-tree-link': true, current: full === currentPath })}
          data-bundle-view-source=${full}
          aria-current=${full === currentPath ? 'true' : nothing}
        >
          ${sourceFileIcon(full, formats?.get(full))}<span class="bundle-code-tree-name" data-tooltip-truncated data-tooltip=${full}>${name}</span>
          ${findings.length > 0 ? countChip(findings.length, _topSeverityOf(findings), plural(findings.length, 'issue')) : nothing}
        </button>
      </li>`
    })}
  </ul>`
}

// A bundle path as the rail and its lists show it, without the shared
// `prefix` shown once above them.
function stripPathPrefix(p, prefix) {
  return prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p
}

// The rail's Files mode: the tree, or the tree a query filters (package
// boundaries and variant labels stay put; paths and package names are both
// searched), kept for the query. Drawn again only where anything it shows
// changed (`guard`): the file open, the findings on its files
// (bundleIssuesKey), a directory opened or closed other than by a click on
// it. A large bundle's has a row for each of thousands of files, its closed
// directories' too, which find in page looks through.
let _filteredSourceTree = { tree: null, query: '', prefix: '', filtered: null }
function renderBundleCodeFilesPanel(tree, currentPath, query, issueIndex, prefix = '', formats = null, sources = null) {
  const kept = _filteredSourceTree
  if (query && !(kept.tree === tree && kept.query === query && kept.prefix === prefix)) {
    _filteredSourceTree = { tree, query, prefix, filtered: filterBundleSourceTree(tree, query, prefix) }
  }
  const shown = query ? _filteredSourceTree.filtered : tree
  return guard([shown, currentPath, bundleIssuesKey(issueIndex), formats, sources, _bundleTreeOpenings], () => shown
    // A filtered tree holds matches alone, each directory for one inside:
    // all open, so every hit shows at once.
    ? renderBundleSourceTree(shown, currentPath, 0, issueIndex, Boolean(query), formats, sources, query ? null : defaultOpenDirectories(tree))
    : railEmpty('No files match.'))
}

// The rail's results in a mode other than its tree: what they are over them,
// or why there are none.
const railEmpty = text => html`<div class="bundle-code-search-empty">${text}</div>`
const railResults = (summary, results) => html`<div class="bundle-code-search-results">
    <div class="bundle-code-search-summary">${summary}</div>
    ${results}
  </div>`

// What the tree's rows show of a bundle's matched findings
// (bundleFindingsByFile): each file's count and worst severity.
function bundleIssuesKey(issueIndex) {
  return [...issueIndex].map(([file, findings]) => `${file}\0${findings.length}\0${_topSeverityOf(findings)}`).join('\n')
}

// Scan order shared by the Code rail's code search and the Search tab:
// own source first, then dependencies, each in path order. Cached per
// sources map, which bundleSourcesAsMap itself caches per bundle.
const searchOrderCache = new WeakMap()
const bundleSearchOrder = (details, sources) => keep(searchOrderCache, sources, () => ownSourceFirst([...sources.keys()].toSorted(), bundlePackageDirs(details)))

// The rail's Largest mode: its sources largest first, sized as the Overview
// sizes them and filtered by path as Files is. Sorted once a bundle; capped,
// as rows past the first thousand stop being "largest".
const LARGEST_FILES_LIMIT = 1000
const _largestFiles = new WeakMap()
function renderBundleCodeLargestResults(details, sources, query, currentPath, prefix = '') {
  const sizes = bundleSourceSizes(details)
  const ranked = keep(_largestFiles, sources, () => [...sources.keys()].filter(p => sizes.get(p) != null)
    .toSorted((a, b) => sizes.get(b) - sizes.get(a) || a.localeCompare(b)))
  const q = query.toLowerCase()
  const files = q ? ranked.filter(p => stripPathPrefix(p, prefix).toLowerCase().includes(q)) : ranked
  if (files.length === 0) return railEmpty('No files match.')
  const shown = files.length > LARGEST_FILES_LIMIT ? files.slice(0, LARGEST_FILES_LIMIT) : files
  return railResults(shown.length < files.length
    ? `${shown.length.toLocaleString()} largest of ${files.length.toLocaleString()} files`
    : `${files.length.toLocaleString()} ${files.length === 1 ? 'file' : 'files'} by size`, html`<ul class="bundle-code-largest">
      ${repeat(shown, p => p, p => html`<li><button
        type="button"
        class=${classMap({ 'bundle-code-largest-file': true, current: p === currentPath })}
        data-bundle-view-source=${p}
        aria-current=${p === currentPath ? 'true' : nothing}
      ><span class="bundle-code-largest-path" data-tooltip-truncated data-tooltip=${p}>${stripPathPrefix(p, prefix)}</span><span class="bundle-code-largest-size">${formatBytes(sizes.get(p))}</span></button></li>`)}
    </ul>`)
}

const MAX_RAIL_HITS_PER_FILE = 20
const MAX_RAIL_FILES = 100

// The rail's hits for a query: the first MAX_RAIL_FILES files in scan order
// with a match, the first MAX_RAIL_HITS_PER_FILE of each one's. Read from the
// Search tab's scan (runBundleSearch), which keeps its recent results and
// refines one typed on, where that has every hit the rail shows: all it
// found, or MAX_RAIL_FILES files of them before the last, which it may have
// stopped in. Else scanned here, to the rail's own caps, kept for the query.
let _railHits = { sources: null, query: '', hits: null }
function bundleCodeRailHits(details, sources, query) {
  const found = runBundleSearch(details.integrity ?? '', sources, query, false, false, bundleSearchOrder(details, sources))
  const complete = found.fileResults.length > MAX_RAIL_FILES || !found.truncated || found.totalHits < SEARCH_MAX_TOTAL_HITS
    || (found.fileResults.length === MAX_RAIL_FILES && found.fileResults.at(-1).hits.length >= MAX_RAIL_HITS_PER_FILE)
  const counted = results => ({ results, totalHits: results.reduce((sum, { hits }) => sum + hits.length, 0) })
  if (complete) {
    return counted(found.fileResults.slice(0, MAX_RAIL_FILES).map(({ path, lines, hits }) => ({ path,
      hits: hits.slice(0, MAX_RAIL_HITS_PER_FILE).map(({ ln, ranges }) => ({ ln, text: lines[ln - 1], ranges })) })))
  }
  if (_railHits.sources === sources && _railHits.query === query) return _railHits.hits
  const matcher = buildSearchMatcher(query, false, false)
  const results = []
  for (const path of bundleSearchOrder(details, sources)) {
    const content = sources.get(path)
    if (typeof content !== 'string') continue
    const hits = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length && hits.length < MAX_RAIL_HITS_PER_FILE; i++) {
      const ranges = matcher.ranges(lines[i])
      if (ranges.length > 0) hits.push({ ln: i + 1, text: lines[i], ranges })
    }
    if (hits.length > 0) results.push({ path, hits })
    if (results.length >= MAX_RAIL_FILES) break
  }
  _railHits = { sources, query, hits: counted(results) }
  return _railHits.hits
}

// The rail's Code mode: the files matching the query as a case-insensitive
// substring (the Search tab's matcher with both toggles off), own source
// first, each with its first matching lines, truncated, the matches marked as
// the Search tab marks them; each hit opens its file on its line.
function renderBundleCodeContentResults(details, sources, query, currentPath, prefix = '') {
  if (!query) {
    return html`<div class="bundle-code-search-hint">Type to search across every source in this bundle.</div>`
  }
  const { results, totalHits } = bundleCodeRailHits(details, sources, query)
  if (results.length === 0) {
    return railEmpty('No matches.')
  }
  return railResults(html`${plural(totalHits, 'hit')} in ${plural(results.length, 'file')}`, results.map(({ path: p, hits }) => html`<div class=${classMap({ 'bundle-code-search-file': true, current: p === currentPath })}>
      <button
        type="button"
        class="bundle-code-search-file-name"
        data-bundle-view-source=${p}
        data-tooltip-truncated data-tooltip=${p}
      >${stripPathPrefix(p, prefix)}</button>
      <ul class="bundle-code-search-hits">
        ${hits.map((h) => html`<li class="bundle-code-search-hit">
          <button
            type="button"
            class="bundle-code-search-hit-link"
            data-bundle-view-source=${p}
            data-bundle-view-line=${h.ln}
            data-bundle-view-scroll-block="start"
          >
            <span class="bundle-code-search-hit-ln">${h.ln}</span>
            <span class="bundle-code-search-hit-text mono">${railHitText(h.text, h.ranges)}</span>
          </button>
        </li>`)}
      </ul>
    </div>`))
}

// The rail's Issues mode, offered only where the bundle has matched findings
// (`issueIndex`): those whose path, severity (as stored or as shown, "high
// bug") or description holds the query, worst first. Each opens its file on
// its line with the panel on it, by its index in the file's findings.
function renderBundleCodeIssuesResults(issueIndex, query, currentPath, prefix = '') {
  const q = query.toLowerCase()
  const flat = [...issueIndex].flatMap(([file, findings]) => findings.map((finding, fileIdx) => ({ file, finding, fileIdx })))
    .filter(({ file, finding: f }) => !q || file.toLowerCase().includes(q) || f.severity.includes(q)
      || f.severity.replaceAll('_', ' ').includes(q) || (f.description ?? '').toLowerCase().includes(q))
    .toSorted((a, b) => (SEVERITY_ORDER[b.finding.severity] ?? 0) - (SEVERITY_ORDER[a.finding.severity] ?? 0) || a.file.localeCompare(b.file))
  if (flat.length === 0) {
    return railEmpty('No matches.')
  }
  return railResults(plural(flat.length, 'issue'), html`<ul class="bundle-code-search-issues">
      ${flat.map(({ file, finding, fileIdx }) => {
        const sev = finding.severity
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
              <span class="bundle-code-search-issue-path mono" data-tooltip-truncated data-tooltip=${file}>${stripPathPrefix(file, prefix)}${finding.line ? `:${finding.line}` : ''}</span>
            </div>
            <div class="bundle-code-search-issue-desc">${renderHighlighted(titledDescription(finding), { paragraphs: false })}</div>
          </button>
        </li>`
      })}
    </ul>`)
}

// The sources the Code tab picks its default file from: a Stasis bundle's
// own, where it has any. A named app or workspace module is still own source
// (package grouping is not dependency ownership); node_modules paths are
// dependencies even in a flat capture, other dependency directories by
// recorded module boundaries, so an app's own dependencies/ folder stays own.
// Kept by the sources (bundleSourcesAsMap keeps one map a bundle).
const _bundleCodeDefaults = new WeakMap()
function bundleCodeDefaultSources(details, sources) {
  if (details.kind !== 'stasis') return sources
  return keep(_bundleCodeDefaults, sources, () => {
    const packageDirs = bundlePackageDirs(details)
    const ownSources = new Map([...sources].filter(([file]) =>
      !/(?:^|\/)node_modules(?:\/|$)/u.test(file)
        && !/(?:^|\/)(?:node_modules|dependencies|vendor)(?:\/|$)/u.test(packageDirs?.get(file) ?? file)))
    return ownSources.size > 0 ? ownSources : sources
  })
}

// The Code tab's tree of a bundle's sources, built from paths without the
// prefix its rail shows over it, the files keeping their full paths; built
// once a bundle, kept by the sources as the defaults are.
const _bundleCodeTrees = new WeakMap()
const bundleCodeTree = (details, sources, allPaths) => keep(_bundleCodeTrees, sources, () => {
  const packageModules = details.kind === 'stasis' ? details.bundle.modules : null
  const prefix = bundleSourceTreePrefix(stripCommonPathPrefix(allPaths).prefix, packageModules, allPaths)
  return { prefix, tree: buildBundleSourceTree(allPaths.map(p => stripPathPrefix(p, prefix)), allPaths, packageModules) }
})

// The file the Code tab opens on where none is picked, of those with text:
//   1. an npm version's `main`, a repository directory's readme,
//      package.json or file nearest its top (`npmEntries`: npmPackageEntries,
//      repositoryCodeEntries);
//   2. a Stasis bundle's entry point;
//   3. a bundle's top-most package.json outside node_modules, else its
//      top-most index.ts, index.js, main.ts or main.js, in that order where
//      several are as high (shallowestNamed);
//   4. the largest source, as the main chunk is the most telling left.
// Findings play no part, so the file doesn't change as they arrive. Null
// where no file has text.
function pickDefaultBundleCodeFile(details, sources) {
  const entry = [...details.npmEntries ?? [], ...details.kind === 'stasis' && details.bundle ? details.bundle.entries : []]
    .find(file => typeof sources.get(file) === 'string')
  if (entry !== undefined) return entry
  if (!details.npmEntries) {
    const texts = [...sources].flatMap(([file, content]) => typeof content === 'string' ? [file] : [])
    const named = shallowestNamed(texts, ['package.json']) ?? shallowestNamed(texts, ['index.ts', 'index.js', 'main.ts', 'main.js'])
    if (named) return named
  }
  let largest = null, largestLen = -1
  for (const [file, content] of sources) {
    if (typeof content === 'string' && content.length > largestLen) [largest, largestLen] = [file, content.length]
  }
  return largest
}

// The Code tab: the rail (a tree, or a search's results) beside the open
// file (state.bundleSourceFile) in the source viewer's body, its finding
// panel in place rather than over it. A visit opens on a managed link's file,
// the file carried from another bundle, or pickDefaultBundleCodeFile's.
function renderBundleCodeView(details, entry = null) {
  const sources = bundleSourcesAsMap(details)
  if (sources.size === 0) {
    return html`<div class="bundle-code-empty">This bundle doesn't carry any source content.</div>`
  }
  // Directories opened in one bundle mean nothing in another.
  if (_bundleTreeMapBundle !== state.selectedBundle) {
    _bundleTreeUserOpen.clear()
    _bundleTreeOpenings++
    _bundleTreeMapBundle = state.selectedBundle
    _bundleTreeCurrentPath = null
  }
  const allPaths = bundleSourceOrder(sources).paths
  const { prefix, tree } = bundleCodeTree(details, sources, allPaths)
  // The tree's chips, the open file's dots and whether Issues mode is offered.
  const issueIndex = details.fileHashes ? bundleFindingsByFile(details.fileHashes, 'issues') : new Map()
  let path = state.bundleSourceFile
  // A managed link's file and lines, now that the sources it numbers have
  // loaded, or the file open in the bundle before. A number past the last
  // file, or a path this bundle doesn't have, falls back to the usual pick;
  // lines past the file's last mark none.
  const request = state.bundleCodeFileRequest
  if (request?.bundle === state.selectedBundle) {
    state.bundleCodeFileRequest = null
    const linked = request.path == null ? allPaths[request.file - 1] : sources.has(request.path) ? request.path : null
    if (linked) {
      path = linked
      state.bundleSourceFile = linked
      revealBundleCodeCurrent()
      const end = request.endLine ?? request.line
      state.bundleSourceTargetLine = request.line && end <= bundleSourceLines(sources.get(linked))
        ? { bundle: details.integrity, path: linked, line: request.line, ...(end > request.line ? { end } : {}) }
        : null
      if (state.bundleSourceTargetLine) revealBundleSourceLine(request.line)
    }
  }
  // Picked as the tab renders, once a visit (a tab switch clears the file),
  // revealed with the pick, as a boot straight into the tab clicks no tab.
  if (!path) {
    path = pickDefaultBundleCodeFile(details, bundleCodeDefaultSources(details, sources))
    if (path) {
      state.bundleSourceFile = path
      revealBundleCodeCurrent()
    }
  }
  if (path !== _bundleTreeCurrentPath) {
    openBundleTreeAncestors(path, prefix)
    _bundleTreeCurrentPath = path
  }
  // Keep a managed bundle's URL on the file shown, however it was picked,
  // and the lines marked in it. Its other writers use the same location.
  const codeRoute = entry?.managedId ? location => managedBundleRoute(state.managedTeams, entry, state.currentManagedTeam, 'code', location)
    : entry?.npm ? location => npmPackageRoute(entry, 'code', location)
    : entry?.repository ? location => repositoryCodeRoute(entry, 'code', location) : null
  if (path && codeRoute && isManagedUiMode()) managedHistory?.replaceCodeRoute(codeRoute(managedCodeLocation(state)))
  // Files, Code, Issues and Largest share the query field, Issues offered
  // only where findings match; a mode not offered falls back to Files.
  const searchModes = ['files', 'code', ...issueIndex.size > 0 ? ['issues'] : [], 'largest']
  const searchMode = searchModes.includes(state.bundleCodeSearchMode) ? state.bundleCodeSearchMode : 'files'
  const query = state.bundleCodeSearchQuery
  // Files and Largest find a file by its path, which a copy can bring with
  // spaces at either end; Code and Issues search the query as typed.
  const pathQuery = query.trim()
  return html`<div class="bundle-code-view">
    <aside class="bundle-code-rail">
      <div class="bundle-code-rail-head">
        <span class="bundle-code-rail-label">Files</span>
        <span class="bundle-code-rail-count">${allPaths.length}</span>
        <span class="bundle-code-rail-actions">
          <button type="button" class="bundle-code-rail-action" aria-label="Terminal" data-tooltip="Terminal" data-bundle-code-terminal-toggle
            aria-pressed=${state.bundleCodeTerminal ? 'true' : 'false'} @click=${() => showBundleCodeTerminal(!state.bundleCodeTerminal)}>
            ${TERMINAL_ICON}
          </button>
          <button type="button" class="bundle-code-rail-action" aria-label="Reveal current file" data-tooltip="Reveal current file"
            ?disabled=${!path} @click=${() => revealBundleTreeFile(path, prefix)}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1.5"/><path d="M8 0v3m0 10v3M0 8h3m10 0h3"/></svg>
          </button>
          <button type="button" class="bundle-code-rail-action" aria-label="Collapse directories" data-tooltip="Collapse directories"
            ?disabled=${searchMode !== 'files' || !!pathQuery || tree.dirs.size === 0} @click=${() => { closeBundleTreeDirs(tree); _bundleTreeOpenings++; render() }}>
            ${COLLAPSE_DIRS_ICON}
          </button>
        </span>
      </div>
      ${prefix ? html`<div class="bundle-code-rail-prefix mono" data-tooltip-truncated data-tooltip=${prefix}>${prefix}</div>` : nothing}
      <bundle-code-search .modes=${searchModes}></bundle-code-search>
      <div class="bundle-code-rail-body">
        ${choose(searchMode, [
          ['files', () => renderBundleCodeFilesPanel(tree, path, pathQuery, issueIndex, prefix, details.kind === 'stasis' ? details.bundle.formats : null, sources)],
          ['code', () => renderBundleCodeContentResults(details, sources, query, path, prefix)],
          ['issues', () => renderBundleCodeIssuesResults(issueIndex, query, path, prefix)],
          ['largest', () => renderBundleCodeLargestResults(details, sources, pathQuery, path, prefix)],
        ])}
      </div>
    </aside>
    <bundle-code-splitter role="separator" tabindex="0" aria-orientation="vertical"
      aria-label="Resize file tree" data-tooltip="Drag to resize · double-click to reset"
    ></bundle-code-splitter>
    <div class=${classMap({ 'bundle-code-main': true, 'with-panel': state.bundleSourceFindingIdx != null })}>
      ${path
        ? renderBundleCodeMain(details, path, sources.get(path), entry, issueIndex)
        : html`<div class="bundle-code-placeholder">Pick a file from the tree to view its source.</div>`}
      ${state.bundleCodeTerminal ? renderBundleCodeTerminal() : nothing}
    </div>
  </div>`
}

function renderBundleCodeFileNav(history) {
  return html`<span class="bundle-code-file-nav">
    <button type="button" class="focus-code-nav-btn" data-bundle-code-history="back"
      aria-label="Back to the previously shown file" ?disabled=${history.at === 0}>
      ${PREV_ICON}
    </button>
    <button type="button" class="focus-code-nav-btn" data-bundle-code-history="forward"
      aria-label="Forward to the next shown file" ?disabled=${history.at >= history.files.length - 1}>
      ${NEXT_ICON}
    </button>
  </span>`
}

// A text's lines and size, as the Code tab's bar tells a file's. Kept for
// the last two told, the file and its pretty-printed copy, as the bar tells
// them on every render and counting a large one takes a while.
const _textStats = []
function textStats(text) {
  const kept = _textStats.find(entry => entry.text === text)
  if (kept) return kept.stats
  const lines = bundleSourceLines(text)
  const stats = `${lines.toLocaleString()} ${lines === 1 ? 'line' : 'lines'} · ${formatBytes(utf8ByteLength(text))}`
  _textStats.unshift({ text, stats })
  _textStats.length = Math.min(_textStats.length, 2)
  return stats
}

// The Code tab's file pane: its bar (history, path, copy, GitHub link where
// its location is known, Imported by where the bundle records imports, the
// issue stepper, the wrap, pretty-print and View lockfile toggles, and its
// stats) over the source viewer's body. The stepper's (idx, line) pairs, in
// line order, ride in a JSON attribute, so events.js steps the panel without
// working out the findings again. Where the file can be pretty-printed, its
// stats keep room for the file's own and three characters more
// (`.bundle-code-main-stats-room`), right-aligned, so pressing the toggle,
// whose copy has more lines and bytes, moves neither toggle. A lockfile read
// (View lockfile) shows in the lockfile viewer in place of its text, with
// the file's stats and none of the text's toggles and stepper. `single`: the
// file open alone (renderDroppedLockfile), with no history and a close.
function renderBundleCodeMain(details, path, sourceContent, entry = null, byFile = null, { single = false } = {}) {
  const lockfile = typeof sourceContent === 'string' && lockfileFormat(path) !== null
  const read = lockfile ? viewedLockfile(details, path, sourceContent, bundleSourcesAsMap(details), () => { if (shownSource(path)) render() }) : null
  const graphed = read?.status === 'ready'
  const viewed = graphed
    ? { pretty: false, toggle: nothing, content: sourceContent, fileFindings: [], lineFindings: new Map() }
    : viewedSource(details, entry, path, sourceContent, byFile)
  const { toggle, content, fileFindings } = viewed
  const issueOrder = fileFindings
    .map((f, idx) => ({ idx, line: parseInt(f.line, 10) || 0 }))
    .toSorted((a, b) => a.line - b.line || a.idx - b.idx)
  // A managed bundle's stored repository fills in what its own stamp leaves out.
  const github = bundleFileGithub(details, path, entry?.managedId && entry.repoId != null ? { github: entry.repoFullName, directory: entry.repoDirectory } : null)
  return html`<header class="bundle-code-main-bar">
      ${single ? nothing : renderBundleCodeFileNav(bundleFileHistory(state.bundleCodeHistory, details.integrity, path))}
      ${sourceFileIcon(path, fileIconFormat(details, path))}
      <span class="bundle-code-main-path mono" data-tooltip-truncated data-tooltip=${path}>${path}</span>
      <button
        type="button"
        class="bundle-code-copy-path"
        data-copy-path=${path}
        aria-label="Copy file path"
      >${COPY_ICON}</button>
      ${github ? githubFileLink(github, entry?.commitInfo) : nothing}
      ${renderBundleCodeImporters(details, path)}
      <span class="bundle-code-main-spacer"></span>
      ${fileFindings.length > 0 ? html`<span
        class="bundle-code-main-issues"
        data-bundle-code-issue-order=${JSON.stringify(issueOrder)}
      >
        ${countChip(fileFindings.length, _topSeverityOf(fileFindings), `${plural(fileFindings.length, 'issue')} in this file`)}
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
      ${graphed ? nothing : renderSourceWrapToggle()}
      ${toggle}
      ${lockfile ? renderLockfileToggle(read) : nothing}
      ${typeof content === 'string' ? html`<span class="bundle-code-main-stats">${toggle === nothing ? nothing
        : html`<span class="bundle-code-main-stats-room" aria-hidden="true">${textStats(sourceContent)}</span>`}<span>${textStats(content)}</span></span>` : nothing}
      ${single ? html`<button type="button" class="bundle-code-close" data-dropped-lockfile-close aria-label="Close" data-tooltip="Close">×</button>` : nothing}
    </header>
    <div class="bundle-code-main-body">
      ${graphed ? html`<lockfile-graph .lockfile=${read.lockfile}></lockfile-graph>`
        : renderBundleSourceCodeWrap(path, details, viewed, null,
          !viewed.pretty && Boolean(entry?.managedId || entry?.npm) && isManagedUiMode() && !getPublicShare())}
    </div>`
}

// A lockfile dropped in local or e2e mode (lockfile-drop.js): an editor of
// it alone, the Code tab's pane with no file tree. It opens on its packages,
// as View lockfile shows them, and its text is a toggle away.
export function renderDroppedLockfile({ name, details }) {
  const content = bundleSourcesAsMap(details).get(name)
  return html`<div class="bundle-code-view is-single-file">
    <div class="bundle-code-main">${renderBundleCodeMain(details, name, content, null, null, { single: true })}</div>
  </div>`
}

// ── Search tab: a full-width search over every source, each match shown
// with the lines around it, where the Code rail shows one truncated line a
// hit. Plain queries match as a case-insensitive substring, `.*`
// (state.bundleSearchRegex) as a regular expression per line. The scan, its
// caps and the history refining a query typed on are bundle-search-scan.js's.

// Rendered lines clip to SEARCH_MAX_LINE characters: minified bundles ship
// single 100k-char lines.
const SEARCH_MAX_LINE = 400

// Lines of context around each match: fewer the more matches, down to
// github's ±2, so a flood stays scannable.
function searchContextRadius(totalHits) {
  return [[5, 8], [15, 6], [40, 4], [120, 3]].find(([most]) => totalHits <= most)?.[1] ?? 2
}

// Each hit line (`hits`, by line) widened by `radius`, windows that touch
// or overlap merged: with context a lone line between two is absorbed;
// without (radius 0) only adjacent hit lines merge. Inclusive 1-based
// `{ start, end }`.
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

// A long line clipped to `max` characters, the window slid to keep its first
// match in view (minified sources put the only one thousands in): its text,
// the ranges shifted into it, and whether its head was cut.
function clipSearchLine(text, ranges, max) {
  if (text.length <= max) return { text, ranges, clipped: false }
  const firstStart = ranges.length > 0 ? ranges[0][0] : 0
  const from = firstStart > max - 60 ? Math.max(0, firstStart - 60) : 0
  return sliceSearchLine(text, ranges, from, max)
}

// A snippet's line, its matches marked (`ranges`), or plain for context.
function renderSearchRow(text, ln, ranges) {
  const clip = clipSearchLine(text, ranges ?? [], SEARCH_MAX_LINE)
  return html`<div class=${classMap({ 'bundle-search-line': true, 'is-match': ranges != null })}>
    <span class="bundle-search-lineno">${ln}</span>
    <span class="bundle-search-code">${clip.clipped
      ? html`<span class="bundle-search-clip">…</span>`
      : nothing}${renderSearchMarks(clip.text, clip.ranges)}</span>
  </div>`
}

// A context snippet, opening the source on its first matched line;
// `hitRanges` the matched lines' spans, by line.
function renderSearchSnippet(path, lines, win, hitRanges, showGap) {
  const { start, end } = win
  const lns = Array.from({ length: end - start + 1 }, (_, i) => start + i)
  return html`${showGap ? html`<div class="bundle-search-gap" aria-hidden="true"></div>` : nothing}
    <button
      type="button"
      class="bundle-search-snippet"
      style=${styleMap({ '--bundle-search-lineno-w': `${String(end).length}ch` })}
      data-bundle-view-source=${path}
      data-bundle-view-line=${lns.find((ln) => hitRanges.has(ln)) ?? start}
      data-bundle-view-scroll-block="center"
    >${lns.map((ln) => renderSearchRow(lines[ln - 1] ?? '', ln, hitRanges.get(ln) ?? null))}</button>`
}

// A file's matches: its header, opening it at its first, over its snippets,
// highlighted while its source is open in the sidebar.
function renderSearchFile(fileResult, prefix, radius) {
  const { path, lines, hits } = fileResult
  const windows = buildSearchWindows(hits, lines.length, radius)
  const hitRanges = new Map(hits.map((h) => [h.ln, h.ranges]))
  return html`<section class=${classMap({ 'bundle-search-file': true, current: path === state.bundleSourceFile })}>
    <header class="bundle-search-file-head">
      <button
        type="button"
        class="bundle-search-file-name mono"
        data-bundle-view-source=${path}
        data-bundle-view-line=${hits[0].ln}
        data-bundle-view-scroll-block="center"
        data-tooltip-truncated data-tooltip=${path}
      >${stripPathPrefix(path, prefix)}</button>
      <span class="bundle-search-file-count">${plural(hits.length, 'match', 'matches')}</span>
    </header>
    <div class="bundle-search-snippets">
      ${windows.map((w, i) => renderSearchSnippet(path, lines, w, hitRanges, i > 0))}
    </div>
  </section>`
}

// The Search tab's results for the query, scanned through the refinement
// history (bundle-search-scan.js, by the bundle's integrity), grouped by file.
const searchResults = content => html`<div class="bundle-search-results">
      ${content}
    </div>`
function renderBundleSearchResults(details, sources, query, useRegex, caseSensitive, showContext) {
  if (!query) {
    return searchResults(html`<div class="bundle-search-hint">
        Search across every ${details.npm ? 'file of this version' : details.repository ? 'file of this directory' : 'source in this bundle'}. Each match shows the surrounding
        lines for context — fewer matches get more context. Toggle
        <span class="bundle-search-hint-kbd">Aa</span> for case-sensitive and
        <span class="bundle-search-hint-kbd">.*</span> for regular-expression matching.
      </div>`)
  }
  const result = runBundleSearch(details.integrity ?? '', sources, query, useRegex, caseSensitive, bundleSearchOrder(details, sources))
  if (result.error) {
    return searchResults(html`<div class="bundle-search-error">
        <span class="bundle-search-error-label">Invalid regular expression</span>
        <span class="bundle-search-error-msg mono">${result.error}</span>
      </div>`)
  }
  const { fileResults, totalHits, truncated } = result
  if (fileResults.length === 0) {
    return searchResults(html`<div class="bundle-search-empty">No matches.</div>`)
  }
  // The prefix of every source, not just those matching, so it holds still
  // between keystrokes.
  const prefix = bundleSearchPrefix(sources)
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

// The common prefix of every source's path, kept by the sources, as the
// scan order is (bundleSearchOrder).
const searchPrefixCache = new WeakMap()
const bundleSearchPrefix = sources => keep(searchPrefixCache, sources, () => stripCommonPathPrefix([...sources.keys()].toSorted()).prefix)

// The lines (1-based) of `path` the search matches, which its gutter in the
// sidebar marks: null where the query can't say (empty, no content, a regex
// that doesn't compile), an empty Set where the file has none. Read from the
// scan's result where it has every match, else scanned here; kept for the
// file and the search, so the gutter gets the same lines while neither
// changes (renderBundleSourceLines).
let _searchMatchLines = { content: null, path: null, query: '', useRegex: false, caseSensitive: false, lines: null }
function searchMatchLines(details, sources, path, query, useRegex, caseSensitive) {
  const content = sources.get(path)
  if (!query || typeof content !== 'string') return null
  const kept = _searchMatchLines
  if (kept.content === content && kept.path === path && kept.query === query && kept.useRegex === useRegex && kept.caseSensitive === caseSensitive) return kept.lines
  const result = runBundleSearch(details.integrity ?? '', sources, query, useRegex, caseSensitive, bundleSearchOrder(details, sources))
  if (result.error) return null
  const matcher = result.truncated ? buildSearchMatcher(query, useRegex, caseSensitive) : null
  const out = new Set(matcher ? content.split('\n').flatMap((line, i) => matcher.ranges(line).length > 0 ? [i + 1] : [])
    : result.fileResults.find(file => file.path === path)?.hits.map(({ ln }) => ln))
  _searchMatchLines = { content, path, query, useRegex, caseSensitive, lines: out }
  return out
}

// The Search tab's sidebar: the clicked result's source (state.bundleSourceFile)
// in the modal's chrome, its matched lines marked in the gutter (`matchLines`).
function renderBundleSearchSide(details, sources, matchLines, entry) {
  const path = state.bundleSourceFile
  if (!path) return nothing
  // A pretty-printed copy's lines aren't the file's, nor its matches.
  const viewed = viewedSource(details, entry, path, sources.get(path))
  return html`<aside class="bundle-search-side">
    ${renderBundleSourceBar(path, null, viewed.toggle)}
    <div class="bundle-source-body">
      ${renderBundleSourceCodeWrap(path, details, viewed, viewed.pretty ? null : matchLines)}
    </div>
  </aside>`
}

// The Search tab: its bar, with the Context switch beside it, over the
// results and the sidebar. Its query (state.bundleSearchQuery, ...Regex,
// ...Case) is its own, apart from the Code rail's.
function renderBundleSearchView(details, entry = null) {
  const sources = bundleSourcesAsMap(details)
  if (sources.size === 0) {
    return html`<div class="bundle-search-view">
      <div class="bundle-code-empty">${details.npm ? 'This version has no text files to search.' : details.repository ? 'This directory has no text files to search.' : 'This bundle doesn\'t carry any source content.'}</div>
    </div>`
  }
  const query = state.bundleSearchQuery
  const useRegex = state.bundleSearchRegex
  const caseSensitive = state.bundleSearchCase
  // The sidebar closes once its file has dropped out of the results: on a
  // valid query matching nothing in it, not on an empty one or a regex not
  // compiling yet (`merge(`), which keep it open, unmarked, rather than lose
  // the user's place on a passing keystroke.
  const openMatchLines = state.bundleSourceFile ? searchMatchLines(details, sources, state.bundleSourceFile, query, useRegex, caseSensitive) : null
  if (openMatchLines?.size === 0) {
    state.bundleSourceFile = null
    state.bundleSourceFindingIdx = null
  }
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
      ${renderBundleSearchSide(details, sources, openMatchLines, entry)}
    </div>
  </div>`
}

// One button of the bundle slide's tab strip, inert while an npm version
// opens; `onTab` opening its tab where no bundle is shown to switch.
const bundleTab = (key, label, tab, opening = false, onTab = null) => html`<button type="button" class=${classMap({ 'bundles-tab': true, active: tab === key })}
  data-bundle-tab="${onTab ? nothing : key}" aria-selected=${String(tab === key)} role="tab" ?disabled=${!onTab && opening}
  @click=${onTab ? () => { if (key !== tab) onTab(key) } : nothing}>${label}</button>`

// The tabs an npm version shows, each `[key, label]`: Review where the reader
// publishes dependency reviews to some team, as their session says (an
// admin's to any), or as one of their teams does, read since.
const npmTabs = () => [['treemap', 'Treemap'], ['code', 'Code'], ['search', 'Search'], ['compare', 'Compare'],
  ...state.managedSession && !state.managedSession.publicShare
    && (state.managedSession.dependencyReview === true || state.managedTeams?.some(team => team.dependencyReview === true)) ? [['review', 'Review']] : [],
  ['overview', 'Overview']]

// The tabs a repository's directory shows (repository-code.js), `tab` the
// one open: its Activity one, opening on the view of it last shown.
const repositoryCodeTabs = tab => [['treemap', 'Treemap'], ['code', 'Code'], ['search', 'Search'], ['compare', 'Compare'], [activityTab(tab), 'Activity']]

// The body of a tab of a repository's directory reading none of its files
// (REPOSITORY_FILELESS_TABS): its Commits, Issues, Pull requests, Agents,
// Pulse or Replay, once their bundle is here (activity-load.js), the view's
// first read asked for meanwhile, however the view came to show.
function repositoryFilelessTab(repository, tab) {
  prefetchActivityView(repository.repoId, tab)
  return withRepositoryActivity(() => tab === 'commits' ? html`<repository-history .repository=${repository} .repo=${repositoryFullName(repository)}
    .refs=${repositoryRefs(repository.repoId)}></repository-history>`
    : tab === 'agents' ? html`<repository-agents .repository=${repository} .repo=${repositoryFullName(repository)}></repository-agents>`
    : tab === 'pulse' ? html`<repository-pulse .repository=${repository} .repo=${repositoryFullName(repository)}></repository-pulse>`
    : tab === 'replay' ? html`<repository-replay .repository=${repository} .repo=${repositoryFullName(repository)}></repository-replay>`
    : html`<repository-issues .repository=${repository} .repo=${repositoryFullName(repository)} .kind=${tab}></repository-issues>`)
}

// A crumb of the slide's header, back to where the bundle was listed.
const breadcrumb = (label, onClick) => html`<span class="bundles-slide-breadcrumb">
  <button type="button" @click=${onClick}>${label}</button>
  <span aria-hidden="true">&gt;</span>
</span>`

// The bundle slide: its header, with the bundle's name, or an npm version's
// with the package's versions to switch to, and its `tabs`, `tab` the one
// open; that tab's `body` under it. An npm version opening (`opening`)
// shows the header it will have, its versions and tabs waiting for it.
// Both render through here, so the header stays put as the version opens.
function bundleSlideView(entry, tab, tabs, body, { overview = false, opening = false, onTab = null } = {}) {
  const { npm } = entry
  // A repository's directory opening in place of the one shown names it in the
  // header, its bar running, the one shown dimmed under it until it opens.
  const pending = entry.repository && !opening ? repositoryCodePending(entry) : null
  const repository = pending ?? entry.repository
  const loading = Boolean(pending) || (opening && Boolean(repository) && !state.repositoryCodeOpening?.error)
  // Where tabs open by `onTab`, a tab picked in the body (an Activity view's
  // picker, repository-activity.js) opens by it too, not as a bundle's.
  const pickInBody = onTab ? event => {
    const picked = event.target.closest?.('[data-bundle-tab]')?.dataset.bundleTab
    if (!picked) return
    event.stopPropagation()
    if (picked !== tab) onTab(picked)
  } : nothing
  return html`<div class="bundles-view bundles-slide-view">
    <bundle-slide-header class="bundles-slide-header"><header class="bundles-slide-bar">
      ${isManagedUiMode() && entry.managedId && entry.repoId == null ? breadcrumb('Bundles', () => openAdminPage('manage-bundles')) : nothing}
      ${npm ? breadcrumb('npm', () => navigateToNpm()) : nothing}
      <span class="bundles-slide-icon" aria-hidden="true">${appMarkup(npm ? NPM_ICON_SVG : repository ? REPO_ICON_SVG : BUNDLE_ICON_SVG)}</span>
      <div class=${classMap({ 'bundles-slide-title': true, 'bundles-slide-repository': Boolean(repository) })}>
        ${npm ? html`<div class="bundles-slide-name" data-tooltip-truncated data-tooltip=${npm.name}>${npm.name}</div>
          <npm-version-select .name=${npm.name} .version=${npm.version} .tab=${tab} .list=${opening ? null : npmVersionList(npm.name)}></npm-version-select>`
          : repository ? html`<repository-code-source .repository=${repository} .tab=${tab} .repos=${browsableRepositories()} .refs=${repositoryRefs(repository.repoId)}></repository-code-source>`
          : html`<div class="bundles-slide-name" data-tooltip-truncated data-tooltip=${entry.name}>${entry.name}</div>`}
      </div>
      <button type="button" class="bundles-download-btn bundles-scan-button" ?hidden=${!canScanBundle(entry)} @click=${() => void openScan(entry)}>${appMarkup(SCAN_ICON_SVG)}<span>Scan</span></button>
      <div class="bundles-slide-tabs" role="tablist">${tabs.map(([key, label]) => bundleTab(key, label, tab, opening || Boolean(pending), onTab))}</div>
      ${loading ? html`<span class="bundles-slide-progress" role="progressbar" aria-label=${`Opening ${repository.repo ? repositoryCodeName(repository) : 'the repository'}`}></span>` : nothing}
    </header></bundle-slide-header>
    <div class=${classMap({ 'bundles-slide-body': true, 'bundles-slide-body-overview': overview, 'is-pending': Boolean(pending) })}
      ?inert=${Boolean(pending)} aria-busy=${pending ? 'true' : nothing} @click=${pickInBody}>${body}</div>
  </div>`
}

// An npm version opening (npm-package.js openNpmRoute), `spec` its version
// or dist-tag as its route names it, `tab` the tab it opens on: its header,
// and in its body what opens.
export function renderNpmOpening({ name, spec, tab }) {
  return bundleSlideView({ npm: { name, version: spec ?? 'latest' } }, tab, npmTabs(),
    html`<div class="bundles-slide-placeholder" role="status">Opening ${npmPackageInput(name, spec)}…</div>`, { opening: true })
}

// A repository's directory opening (repository-code.js
// openRepositoryCodeRoute), `tab` the tab it opens on: its header, and in its
// body what opens, or why it didn't, with the directories it lists to open
// instead where it has any. Its Commits, which read none of its files,
// shows at its commit alone (`historyOnly`), or where its files failed to
// open, its tabs then opening each; and its Treemap, while its files are read
// or where they are too many to open, drawn from their sizes as its tree
// lists them (repository-treemap.js).
export function renderRepositoryCodeOpening(opening) {
  const { repoId, commit, path, tab, repo, revision, error, code, historyOnly = false } = opening
  const what = repo ? repositoryCodeName({ repo, path }) : path || 'the repository'
  const at = commit ? ` at ${commit.slice(0, 7)}` : ''
  const repository = { repoId, repo, commit, path, revision }
  const tabsOpen = Boolean(commit && (historyOnly || error))
  return bundleSlideView({ repository }, tab, repositoryCodeTabs(tab), tabsOpen && REPOSITORY_FILELESS_TABS.has(tab)
    ? repositoryFilelessTab(repository, tab)
    : tab === 'treemap' && commit && (!error || code === 'directory-too-large')
      ? html`<repository-treemap .repository=${repository}></repository-treemap>`
      : error
        ? html`<div class="bundles-slide-placeholder is-error repository-code-failed"><p role="alert">Couldn't open ${what}${at}: ${error}</p>${repositoryCodeListing(opening)}</div>`
        : html`<div class="bundles-slide-placeholder" role="status">Opening ${what}${at}…</div>`,
  { opening: !historyOnly, onTab: tabsOpen ? key => openRepositoryCodeTab(opening, key) : null })
}

// The bundles view: the selected bundle's slide (`state.selectedBundle`, set
// from the sidebar's list; bundleSlideView), or a pointer back to that list.
// The slide's body is the active tab's (state.bundleDetailsTab), coerced
// where the bundle doesn't offer it: an npm version shows NPM_TABS, a
// repository's directory REPOSITORY_CODE_TABS.
export function renderBundlesList(bundles) {
  const selected = state.selectedBundle
  const entry = selected ? bundles.find((b) => b.integrity === selected) : null
  if (!entry) {
    return html`<div class="bundles-view bundles-view-empty">
      <p class="bundles-empty-hint">Pick a bundle from the sidebar to open it.</p>
    </div>`
  }
  const npm = Boolean(entry.npm)
  if (npm && !NPM_TABS.has(state.bundleDetailsTab)) state.bundleDetailsTab = 'overview'
  const repository = Boolean(entry.repository)
  if (repository && !REPOSITORY_CODE_TABS.has(state.bundleDetailsTab)) state.bundleDetailsTab = 'code'
  // Advisories shows while a Stasis bundle parses, so switching between two
  // doesn't flicker it away, and stays the open tab across a switch or a
  // link (showAdvisoriesTab); it leads the strip, so its stamping in after a
  // parse pushes the other tabs right rather than landing under a click.
  const showAdvisories = !npm && !repository && showAdvisoriesTab(entry, state.bundleDetails, state.bundleDetailsTab === 'advisories')
  if (state.bundleDetailsTab === 'advisories' && !showAdvisories) state.bundleDetailsTab = 'overview'
  // Compare wants another bundle to pick (the same repository's, in managed
  // mode), but stays the open tab, its body saying there is none.
  const canCompare = npm || state.bundleDetailsTab === 'compare'
    || bundleComparisonCandidates(state.bundles ?? [], state.selectedBundle).length > 0
  // Managed bundles have no Issues tab (Code shows each file's issues); a
  // repository's Issues are its GitHub issues, another tab of the name.
  // Elsewhere Issues always shows, so it neither stamps in as hashes come
  // nor leaves a persisted selection without its button.
  const showIssues = !isManagedUiMode()
  if (state.bundleDetailsTab === 'issues' && !showIssues && !repository) state.bundleDetailsTab = 'overview'
  const tab = state.bundleDetailsTab
  const overviewActive = tab === 'overview'
  // Every tab but Overview waits for the bundle parsed (`bundleDetails` null
  // or still the previous bundle's), its sources where it needs them, and
  // says why where the parse failed.
  const details = state.bundleDetails
  const detailsReady = Boolean(details && details.integrity === entry.integrity)
  const detailsParsed = detailsReady && !details.error && Boolean(details.json || details.bundle)
    && !(details.metadataOnly && bundleNeedsSources(tab))
  // Advisories are asked for once their tab is open, consent given, and the
  // bundle parsed, so a switch can't ask for the previous bundle's modules;
  // a sourcemap has none to audit.
  if (tab === 'advisories' && showAdvisories && detailsParsed && details.kind === 'stasis') {
    ensureBundleAdvisories(details, render).catch(() => {})
  }
  const tabs = npm ? npmTabs() : repository ? repositoryCodeTabs(state.bundleDetailsTab) : [
    ...showAdvisories ? [['advisories', 'Advisories']] : [],
    ...showIssues ? [['issues', 'Issues']] : [],
    ['terminal', 'Terminal'], ['treemap', 'Treemap'], ['graph', 'Graph'], ['code', 'Code'], ['search', 'Search'],
    ...canCompare ? [['compare', 'Compare']] : [],
    ['overview', 'Overview'],
  ]
  const body = overviewActive
    ? renderBundleDetails(entry, details)
    : detailsParsed
      ? choose(tab, [
          ['terminal', () => html`<div id="bundle-terminal-slot" class="bundle-terminal-slot"></div>`],
          ['graph', () => html`<div id="bundle-graph-slot" class="bundle-graph-slot"></div>`],
          ['treemap', () => html`<bundle-treemap .details=${details}></bundle-treemap>`],
          ['code', () => renderBundleCodeView(details, entry)],
          ['search', () => renderBundleSearchView(details, entry)],
          ...['commits', 'pulls', 'agents', 'pulse', 'replay'].map((key) => [key, () => repositoryFilelessTab(entry.repository, key)]),
          ['review', () => withCompare(() => html`<npm-review .entry=${entry} .details=${details} .request=${state.npmReview} .session=${state.managedSession}
            .source=${npmComparisonSource(entry)}></npm-review>`)],
          ['compare', () => withCompare(() => html`<bundle-compare .details=${details} .integrity=${entry.integrity} .request=${state.bundleCompare}
            .source=${npm ? npmComparisonSource(entry) : repository ? repositoryCompareSource(entry) : null}></bundle-compare>`)],
          ['issues', () => repository ? repositoryFilelessTab(entry.repository, 'issues') : renderBundleIssuesList(details)],
          ['advisories', () => renderBundleAdvisoriesTab(details, render,
            canScanBundle(entry) ? () => void openScan(entry, { mode: 'dependencies' }) : null)],
        ])
      : detailsReady && details.sourceError
        ? html`<div class="bundles-slide-placeholder is-error">${details.sourceError} <button type="button" data-bundle-retry-sources>Retry</button></div>`
      : detailsReady && !details.metadataOnly
        ? html`<div class=${classMap({ 'bundles-slide-placeholder': true, 'is-error': Boolean(details.error) })}>
            ${details.error ? `Failed to parse: ${details.error}` : 'Bundle contents not parsed.'}
          </div>`
        : html`<div class="bundles-slide-placeholder">Loading bundle…</div>`
  return bundleSlideView(entry, tab, tabs, body, { overview: overviewActive })
}

// The OPFS reports a finding showed up in, as chips opening them: two, then
// ", and N more…". A finding with a `fileHash` finds them by it; one
// without (a markdown report's: Codex, Claude Security) by the bucket a
// package or repository slide renders (`ctx.kind`, `ctx.bucketKey`), through
// its index's `_keyReports` (client/bundle-finding-index.js).
function bundleIssueReportsTemplate(finding, { kind, bucketKey }) {
  let reports = finding.fileHash ? reportsForFinding(finding.fileHash, finding) : []
  const byBucket = kind === 'package' ? reportsForFindingByPackage : kind === 'repository' ? reportsForFindingByRepo : null
  if (reports.length === 0 && bucketKey && byBucket) reports = byBucket(bucketKey, finding)
  if (reports.length === 0) return nothing
  const extra = reports.length - 2
  return html`<div class="bundle-issue-reports">
    ${reports.slice(0, 2).map((name) => reportChip(name, 'report-chip'))}
    ${extra > 0 ? html`<span class="bundle-issue-reports-more">, and ${extra} more…</span>` : nothing}
  </div>`
}

// A finding's line, "10" or 10, or range, "10-15", as "Line 10" or
// "Lines 10-15"; a range ending before it starts as its first line, and ''
// for none.
function formatFindingLine(line) {
  const s = String(line ?? '')
  const dash = s.indexOf('-')
  const a = parseInt(dash > 0 ? s.slice(0, dash) : s, 10)
  const b = dash > 0 ? parseInt(s.slice(dash + 1), 10) : NaN
  return Number.isFinite(b) && b > a ? `Lines ${a}-${b}` : Number.isFinite(a) ? `Line ${a}` : ''
}

// The Issues tab's empty state: a headline, and why.
function renderBundleIssuesEmpty(primary, hint) {
  return html`<div class="bundle-issues-empty">
    <p class="bundle-issues-empty-primary">${primary}</p>
    ${hint ? html`<p class="bundle-issues-empty-hint">${hint}</p>` : nothing}
  </div>`
}

// The Issues tab: the findings matched to the bundle's files by SHA-512
// hash, grouped by file (renderIssuesGroupedByFile); else why there are
// none, rendered again as background indexing lands (events.js's finding-
// index subscription).
function renderBundleIssuesList(details) {
  if (details.managedId) return renderBundleIssuesEmpty('Open a report to review its findings.', 'Bundle metadata includes source hashes; reports are available through your teams.')
  if (!details.fileHashes) {
    return renderBundleIssuesEmpty(
      'Computing file hashes…',
      'Hashing this bundle\'s sources so findings from your reports can be matched against them.',
    )
  }
  // No sources hash to nothing, whatever the index holds.
  if (details.fileHashes.size === 0) {
    return renderBundleIssuesEmpty(
      'This bundle doesn\'t carry any source content.',
      'Issues are matched by source-file hash, so a bundle without inline sources has nothing to match findings against.',
    )
  }
  const findingsByFile = bundleFindingsByFile(details.fileHashes, 'issues')
  if (findingsByFile.size > 0) return renderIssuesGroupedByFile(findingsByFile, { kind: 'bundle' })
  const indexedCount = indexedHashFindingCount()
  // Markdown reports (DeepSec, Claude Security, Codex) index no hashes, so
  // "no findings indexed" would ask a user who dropped those to do it again.
  if (indexedCount === 0) {
    return renderBundleIssuesEmpty(
      'No issues match this bundle\'s files.',
      'Issues are analyzer findings matched to this bundle by source-file hash. No hash-carrying findings are indexed yet — hash matching needs the analyzer\'s native JSON reports; drop one and any matches will appear here automatically.',
    )
  }
  // Matches before the triage filter: every one is invalid or deleted.
  const matchedAll = [...details.fileHashes.values()].reduce((sum, hash) => sum + findingsForFileHash(hash).length, 0)
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

// A finding's triage badge in the grouped list: a shared App/own-code
// ignore gives a dependency occurrence none, as the aggregate filters have it.
const LIST_TRIAGE = { fixed: 'FIXED', invalid: 'INVALID', deleted: 'DELETED', inprogress: 'In progress', ignored: 'Ignored' }

// Findings grouped by file, worst file first, then by path, each file's
// worst first, then by line: the bundle Issues tab's, and the package and
// repository slides'. A bundle's (`kind` 'bundle') open the source viewer on
// their file and line; a repository's file heads link to it on GitHub at
// HEAD (`bucketKey` its URL or slug); a package's are plain, the report chips
// navigating. `bucketKey` also finds the reports of findings without a
// `fileHash` (bundleIssueReportsTemplate).
export function renderIssuesGroupedByFile(findingsByFile, { kind, bucketKey } = {}) {
  // The shared root shows once, in the summary line.
  const allFiles = [...findingsByFile.keys()]
  const { prefix, stripped } = stripCommonPathPrefix(allFiles)
  const fileToBare = new Map(allFiles.map((f, i) => [f, stripped[i]]))
  const fileEntries = [...findingsByFile.entries()].toSorted(([fa, ga], [fb, gb]) =>
    (SEVERITY_ORDER[_topSeverityOf(gb)] ?? 0) - (SEVERITY_ORDER[_topSeverityOf(ga)] ?? 0)
    || (fileToBare.get(fa) ?? fa).localeCompare(fileToBare.get(fb) ?? fb))
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
        const sortedFindings = findings.toSorted((a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0)
          || (parseInt(a.line, 10) || 0) - (parseInt(b.line, 10) || 0))
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
            <span class="bundle-issues-file-count">${plural(findings.length, 'issue')}</span>
          </header>
          <ul class="bundle-issues-findings">
            ${repeat(sortedFindings, (finding) => JSON.stringify([finding.id ?? `${file}\0${finding.line ?? ''}\0${finding.severity ?? ''}\0${finding.description ?? ''}`, usesReportIgnore(finding)]), (finding) => {
              const sev = finding.severity
              const lineLabel = formatFindingLine(finding.line)
              const triage = triageOf(finding)
              const triageLabel = LIST_TRIAGE[triage] ?? null
              const inner = html`<div class="bundle-issues-finding-head">
                <span class=${`bundle-issue-sev sev-${sev}`}>${sev.replaceAll('_', ' ')}</span>
                ${lineLabel ? html`<span class="bundle-issues-finding-line">${lineLabel}</span>` : nothing}
                ${triageLabel ? html`<span class=${`bundle-issues-finding-triage triage-${triage}`}>${triageLabel}</span>` : nothing}
                <span class="bundle-issues-finding-spacer"></span>
                ${bundleIssueReportsTemplate(finding, { kind, bucketKey })}
              </div>
              <div class="bundle-issues-finding-desc">${renderHighlighted(titledDescription(finding), { paragraphs: false })}</div>`
              // Its index in the file's findings as matched, which the source
              // viewer's panel goes by, whatever order they show in.
              return html`<li class="bundle-issues-finding">
                ${kind === 'bundle'
                  ? html`<button
                      type="button"
                      class="bundle-issues-finding-link"
                      data-bundle-view-source=${file}
                      data-bundle-view-finding-idx=${findings.indexOf(finding)}
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

// A tray with a down arrow, in the text's color.
const DOWNLOAD_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M8 2v8"/>
  <path d="m4.5 7 3.5 3.5L11.5 7"/>
  <path d="M2.5 13h11"/>
</svg>`

// SPDX's mark, monochrome, from the CC0 Simple Icons set. CycloneDX's stays
// text alone: its logo is CC BY-ND, so no monochrome variant can ship.
const SPDX_ICON = html`<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
  <path d="M0 0v24H8.222l2.089-2.373 2.09-2.374V13.2H18.978l2.51-2.488L24 8.223V0H12zm5.2 5.2h13.791L12.2 12c-3.735 3.74-6.838 6.8-6.896 6.8-.057 0-.104-3.06-.104-6.8zm8.4 8.8v10H24V14h-5.2z"/>
</svg>`

// A GitHub-style language bar: lines of source by language, so it tells of
// the code to read rather than the artifact's bytes; resources have none.
// Unknown languages get a segment too, named in the bar's tooltip alone.
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

// The whole bar owns its tooltip: moving between segments only changes its
// text, without the hide/show hand-off between adjacent elements.
function languageBarPointerOver(e) {
  const bar = e.currentTarget
  const segment = e.target.closest?.('.bundles-languages-segment')
  if (!segment || !bar.contains(segment)) return
  bar.dataset.tooltip = segment.dataset.languageTooltip ?? ''
  showTooltip(bar)
}

function languageBarPointerLeave(e) {
  delete e.currentTarget.dataset.tooltip
  hideTooltip()
}

// Its sources' lines, in all and by language: the index's where it has
// them, else counted once and kept with them.
const bundleDetailsCodeStats = details => details.codeStats ??= bundleCodeStats(details.npm
  ? new Map([...bundleLineCounts(details)].filter(([path]) => !NPM_LICENSE_FILE.test(path.slice(path.lastIndexOf('/') + 1))))
  : bundleLineCounts(details), bundleFileSizes(details))

function renderBundleLanguagesBar(details, { legend = false } = {}) {
  if (!(details?.kind === 'stasis' && details.bundle) && !(details?.npm && details.json)) return nothing
  const stats = bundleDetailsCodeStats(details)
  const total = stats.lines
  const segments = stats.languages.filter(language => language.lines > 0)
  if (total <= 0 || segments.length === 0) return nothing
  const share = lineCount => {
    const pct = lineCount / total * 100
    return pct < .1 ? '<0.1' : pct < 1 ? pct.toFixed(1) : pct.toFixed(0)
  }
  // With `legend`, the largest few name themselves beside it, the rest
  // left to the bar's tooltips.
  const named = legend ? html`<ul class="bundles-languages-legend">${segments.slice(0, 4).map(({ key, label, lines: lineCount }) => html`<li>
    <span class="bundles-languages-swatch" style=${styleMap({ background: bundleLanguageColor(key) })}></span>${label}<span class="bundles-languages-share">${share(lineCount)}%</span>
  </li>`)}</ul>` : nothing
  return html`<div
    class="bundles-languages-bar"
    data-tooltip-managed
    aria-label="Languages in this bundle"
    @pointerover=${languageBarPointerOver}
    @pointerleave=${languageBarPointerLeave}
  >
    ${segments.map(({ key, label, lines: lineCount }) => html`<span
      class="bundles-languages-segment"
      style=${styleMap({ flexGrow: lineCount, background: bundleLanguageColor(key) })}
      data-language-tooltip=${`${label} · ${share(lineCount)}% · ${lineCount.toLocaleString()} LoC`}
    ></span>`)}
  </div>${named}`
}

async function downloadPublicBundle(entry) {
  try { await (await loadManagedBundle()).downloadManagedBundle(entry.managedId, entry.filename ?? entry.name ?? 'bundle') }
  catch (error) { alert(error.message) }
}

// The Overview's exports column, beside its facts: Download bundle, the raw
// artifact (a local one through events.js's `data-bundle-download`, which
// asks before an unencrypted download), on every branch, parsed or not; and
// the SPDX / CycloneDX SBOMs where a parsed Stasis module inventory has a
// named, versioned component. Its row is wrapped so the column can be a size
// container (CSS): right-aligned while narrow, left once on a line of its own.
function bundleExportsColumn(entry, details) {
  const download = html`${DOWNLOAD_ICON}<span>Download bundle</span>`
  return html`<div class="bundles-overview-exports">
    <div class="bundles-overview-exports-row">
      ${entry.managedId ? getPublicShare()
        ? html`<button type="button" class="bundles-download-btn" @click=${() => void downloadPublicBundle(entry)}>${download}</button>`
        : html`<a class="bundles-download-btn" href=${`/api/bundles/${encodeURIComponent(entry.managedId)}/download`}>${download}</a>`
        : html`<button type="button" class="bundles-download-btn" data-bundle-download=${entry.integrity}>${download}</button>`}
      ${bundleHasSbomComponents(details) ? html`<div class="bundles-export-pair">
        <button type="button" class="bundles-download-btn" data-bundle-export-sbom="cyclonedx" data-tooltip="Export a CycloneDX SBOM (.cdx.json)">CycloneDX</button>
        <button type="button" class="bundles-download-btn" data-bundle-export-sbom="spdx" data-tooltip="Export an SPDX SBOM (.spdx.json)">${SPDX_ICON}<span>SPDX</span></button>
      </div>` : nothing}
    </div>
    ${renderBundleLanguagesBar(details)}
  </div>`
}

// The Overview without sources to show (loading, failed, not parsed) in the
// same `.bundles-overview` shell, so its layout and padding apply: the facts,
// and a `placeholder` line under them.
function renderBundleOverviewFallback(meta, exportsCol, { placeholder = nothing, overviewClass = '' } = {}) {
  return html`<div class="bundles-overview ${overviewClass}">
    <div class="bundles-overview-summary">
      <div class="bundles-detail-meta-row">${meta}${exportsCol}</div>
    </div>
    ${placeholder}
  </div>`
}

// The Overview tab: the bundle's facts, known before it parses (until
// bundle-load.js has read it, `details` is null or a previous bundle's), and
// once parsed a sourcemap's (version, output, source root, names) or a
// Stasis bundle's (version, resolution kinds) with its sources
// (renderBundleSourcesPanel). A managed bundle's facts tell its dependency
// review where its repository's is in effect (bundle-dependency-review.js),
// and its validation (bundle-validation.js).
function renderBundleDetails(entry, details) {
  if (entry.npm) return renderNpmPackageOverview(entry, details)
  const loaded = details?.integrity === entry.integrity
  // Until a managed bundle's metadata arrives, its catalogue entry stands in
  // for the stamp: a summary records a commit only from a stamped repository.
  const commit = entry.summary?.commit
  const origin = loaded ? !details.error && details.kind === 'stasis' ? details.bundle : null
    : entry.managedId && entry.repoFullName && commit ? { repo: { github: entry.repoFullName, directory: entry.repoDirectory ?? '', commit } } : null
  const size = loaded ? details.size : entry.managedId ? entry.size : null
  const meta = (prefix = '', includeSize = false) => html`<dl class="bundles-detail-meta">
    <dt>Name</dt><dd>${entry.name}</dd>
    ${entry.managedId ? html`<dt>Repository</dt><dd>${entry.repoFullName || 'Unattached'}</dd>${entry.repoId == null ? nothing : html`<dt>Directory</dt><dd class="mono">/${entry.repoDirectory ?? ''}</dd>`}` : nothing}
    ${bundleOriginLinks(origin, prefix, entry.commitInfo).map(link => html`<dt>${link.label}</dt><dd class="bundle-origin-row">
      <a class="bundle-origin-link" href=${link.href} target="_blank" rel="noopener noreferrer">${link.label === 'GitHub' ? appMarkup(GITHUB_ICON_SVG) : nothing}<span>${link.text}</span></a>
      ${link.commit ? html`<a class="bundle-origin-link bundle-commit-link" href=${link.commit.href} data-tooltip=${link.commit.hash} data-tooltip-icon="commit" data-tooltip-commit-info=${bundleCommitTooltip(entry.commitInfo, link.commit.hash) ?? nothing} target="_blank" rel="noopener noreferrer">${appMarkup(COMMIT_ICON_SVG)}<span>${link.commit.text}</span></a>` : nothing}
      ${link.commit?.tags ? html`<span class="bundle-origin-tags">${link.commit.tags.map(tag => html`<a class="bundle-origin-link bundle-tag-link" href=${tag.href} target="_blank" rel="noopener noreferrer">${appMarkup(TAG_ICON_SVG)}<span>${tag.name}</span></a>`)}</span>` : nothing}
    </dd>`)}
    ${bundleDependencyReviewFact(entry, render)}
    ${bundleValidationFact(entry, render)}
    <dt>Integrity</dt><dd class="mono bundle-integrity">${entry.integrity}</dd>
    ${prefix ? html`<dt>Prefix</dt><dd class="mono">${prefix}</dd>` : nothing}
    ${origin?.entries?.size > 0 ? html`<dt>${origin.entries.size === 1 ? 'Entry' : 'Entries'}</dt><dd class="mono"><ul class="bundles-entry-points">
      ${[...origin.entries].map(file => html`<li><button type="button" class="bundle-entry-point" data-bundle-view-source=${file}>${stripPathPrefix(file, prefix)}</button></li>`)}
    </ul></dd>` : nothing}
    ${includeSize && Number.isSafeInteger(size) ? html`<dt>Size</dt><dd>${formatBytes(size)}</dd>` : nothing}
  </dl>`
  // `details` gates the SBOM exports: parsed Stasis bundles' alone.
  const exportsCol = bundleExportsColumn(entry, details)
  const parsed = loaded && !details.error
  if (parsed && details.kind === 'sourcemap' && details.json) {
    const json = details.json
    // A map read whole lists its files, each once, in place of `sources`.
    const sizeMap = bundleFileSizes(details)
    const sources = json.sources ?? [...sizeMap.keys()]
    const sizes = details.sourceSizes ?? (sizeMap.size === sources.length
      ? sources.map((path) => sizeMap.get(path) ?? null)
      : sources.map((_, i) => typeof json.sourcesContent?.[i] === 'string' ? utf8ByteLength(json.sourcesContent[i]) : null))
    const extras = html`
      <dt>Version</dt><dd>${String(json.version ?? '?')}</dd>
      ${json.file ? html`<dt>Output</dt><dd class="mono">${json.file}</dd>` : nothing}
      ${json.sourceRoot ? html`<dt>Source root</dt><dd class="mono">${json.sourceRoot}</dd>` : nothing}
      ${json.names || details.namesCount != null ? html`<dt>Names</dt><dd>${json.names?.length ?? details.namesCount}</dd>` : nothing}
    `
    // No package metadata: packages bucket by the path heuristic.
    return renderBundleSourcesPanel(meta, extras, sources, sizes, null, exportsCol, { bundleSize: details.size })
  }
  if (parsed && details.kind === 'stasis' && details.bundle) {
    const bundle = details.bundle
    // Every file, weighed by its bytes, images and fonts too, so Packages
    // adds up to what `du` says of the mounted tree; a directory capture
    // sits at a path its real directory holds, and is no file to list.
    const sizeMap = bundleFileSizes(details)
    const { sourceNames, resources } = stasisOverviewFiles(bundleFileKinds(details))
    // The conditions of the `bundle.imports` keys (`*`, or a `, `-joined set:
    // State#conditionsKey in @exodus/stasis-core), each once, an import
    // attributes suffix ` (with: {...})` folded into its condition.
    const sortedKinds = [...new Set([...bundle.imports.keys()].flatMap((key) => key.replace(/\s*\(with: .*\)\s*$/u, '').split(', ')))].toSorted()
    const sizes = sourceNames.map((s) => sizeMap.get(s))
    const extras = html`
      <dt>Version</dt><dd>${String(bundle.version)}</dd>
      ${sortedKinds.length > 0
        ? html`<dt>Resolution kinds</dt><dd>${sortedKinds.join(', ')}</dd>`
        : nothing}
    `
    return renderBundleSourcesPanel(meta, extras, sourceNames, sizes, bundlePackageDirs(details), exportsCol, { bundleSize: details.size, resources, details })
  }
  // Loading shows the facts alone: a "Loading…" line flickered too briefly to
  // help, and pushed the columns down on every open. A Stasis bundle with no
  // parsed `bundle` is likely a brotli failure that filled in no error.
  const placeholder = details?.error ? html`<div class="bundles-overview-placeholder is-error">Failed to parse: ${details.error}</div>`
    : html`<div class="bundles-overview-placeholder">Bundle contents not parsed.</div>`
  return renderBundleOverviewFallback(meta('', true), exportsCol, { placeholder: loaded ? placeholder : nothing })
}

// A stasis bundle's files as its Overview lists them, and those that are
// resources: kept by its files' kinds (bundleFileKinds keeps those a
// bundle), so the Overview's facts are kept by them (overviewFiles).
const _stasisOverviewFiles = new WeakMap()
const stasisOverviewFiles = kinds => keep(_stasisOverviewFiles, kinds, () => {
  const sourceNames = [...kinds.keys()]
  return { sourceNames, resources: new Set(sourceNames.filter((path) => kinds.get(path) === 'resource')) }
})
// An npm package version's Overview: its manifest beside the files its
// tarball holds, with the tarball to download. Its details arrive with it,
// whole, so there is no loading state to show. The summary lays out as the
// package's facts, its build's beside them with the download, its figures in
// a card of their own, and what its files hold under the facts, labelled as
// they are (report.css .npm-overview).
function renderNpmPackageOverview(entry, details) {
  const download = `/api/npm/download?${new URLSearchParams({ name: entry.npm.name, version: entry.npm.version })}`
  const downloadButton = html`<a class="bundles-download-btn" href=${download}>${DOWNLOAD_ICON}<span>Tarball</span></a>`
  // Under the downloads chart once the version is read; beside the facts
  // until then.
  const exportsCol = html`<div class="bundles-overview-exports">
    <div class="bundles-overview-exports-row">${npmPackageLinks(entry)}${downloadButton}</div>
  </div>`
  const meta = (prefix, files) => npmOverviewMeta(entry, { prefix, githubFigures: npmGithubFigures(entry), provenance: npmProvenanceFact(entry),
    provenanceNamesBuilder: npmProvenanceNamesBuilder(entry.npm), files })
  if (details?.integrity !== entry.integrity || !details.json) {
    return renderBundleOverviewFallback(meta(), exportsCol, { overviewClass: 'npm-overview' })
  }
  // Files lists every file, tagged by what its bytes hold; the binary ones,
  // which have no text to show, are listed again in a column of their own.
  const { sources } = details.json
  const sizeMap = bundleFileSizes(details)
  const sizes = sources.map(path => sizeMap.get(path) ?? null)
  const { paths, binaries, content } = npmFilesRead(details)
  // Socket's alerts on the files they name, beside each one's tag.
  const alerts = npmSocketFileAlerts(entry.npm)
  return renderBundleSourcesPanel(prefix => meta(prefix, paths), npmOverviewExtras(entry, paths, details), sources, sizes, null, nothing, {
    bundleSize: details.size, resources: binaries,
    leadColumn: html`${npmDependenciesColumn(entry)}${npmAdvisoriesColumn(entry)}`, trailColumns: npmBinaryColumn(binaries, sizeMap),
    summaryExtra: html`${npmAlerts(entry, paths)}${npmReadabilityWarning(entry, details)}${npmContents(entry, renderBundleLanguagesBar(details, { legend: true }), details)}${npmStatsRow(entry, downloadButton, npmOverviewBadges(entry))}`,
    // Sized by what the package holds beyond the files every package has.
    overviewClass: 'npm-overview', lines: bundleDetailsCodeStats(details).lines, sized: (measure, value, text) => npmSized(measure, content[measure], text),
    fileTag: path => html`${npmSocketFileTags(alerts.get(path))}${npmFileTags(details, path, true)}`, fileFlags: path => npmFileFlags(details, path, alerts.get(path)),
    fileIcon: path => sourceFileIcon(path, binaries.has(path) ? 'binary' : undefined), fileFilter: npmFilesFilter(entry),
  })
}
