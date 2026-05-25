// Packages view — cross-report aggregation of findings by package
// name (`node_modules/<pkg>/` or `dependencies/<pkg>/` prefix).
// Pulls from `client/bundle-finding-index.js` (the OPFS-wide
// background scan) rather than `state.reports`, so the page
// reflects every report the user has ever dropped — not just the
// one currently loaded. Lifted out of `render.js` because it
// touches no findings-tab state and reads cleaner as a coherent
// neighbor.
//
// `renderPackagesView()` is the single export — orchestrates the
// page's list / details / slide layout. The render() orchestrator
// in `render.js` calls it for `state.currentView === 'packages'`;
// every other entry point is internal.
//
// `renderIssuesGroupedByFile` (the per-file grouped finding list)
// is shared with the bundle Issues tab; imported from `render.js`
// so the chrome stays consistent across the two cross-report
// drill-ins (same `bundle-issues-*` class names, same row shape).
import { html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { live } from 'lit/directives/live.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from 'lit/directives/style-map.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { compareVersionsDesc, ensureBundleFindingsIndexed, getPackagesIndex, state } from '#client/index.js'
import { tabKey } from './group.js'
import { SEVERITIES } from './format.js'
import { FILE_ICONS, displayName, groupOf } from './file-display.js'
import { pkgColor } from './graph/utils.js'
import { renderIssuesGroupedByFile } from './render-bundle.js'

export function renderPackagesView() {
  // Pulls from the OPFS-wide finding index (populated by the
  // background scan in bundle-finding-index.js), not state.reports
  // — so the page reflects every report the user has ever
  // dropped, not just the one currently loaded. The first call
  // kicks the scan if it hasn't run yet; the events.js subscriber
  // re-renders progressively as more reports finish indexing.
  //
  // Triage filter: state.shownTriage gates which findings count
  // (null = untriaged, 'fixed' / 'invalid' / 'deleted' = those
  // buckets). Ignore is per-report and intentionally NOT
  // considered here — a finding ignored in some report still
  // counts against its package because the package itself isn't
  // ignored. Same rule the bundle paths follow.
  ensureBundleFindingsIndexed().catch(() => {})
  const buckets = getPackagesIndex()
  // Per-package filtered view + cross-bucket triage counts.
  // `triageCounts` drives the segmented selector visibility +
  // count chips; the filter stays unchanged when shownTriage flips
  // so the user can pivot through the buckets without the page
  // collapsing.
  //
  // Each entry's `versions` is the array of per-version slices
  // sorted latest-first (`compareVersionsDesc`), filtered by the
  // active triage bucket. Multi-version packages render the
  // latest version's row inline + an expand chevron that reveals
  // the older versions underneath; single-slot packages collapse
  // back to the original one-row shape (no chevron).
  const triageCounts = { fixed: 0, invalid: 0, deleted: 0 }
  const filtered = []
  for (const [pkg, bucket] of buckets) {
    const versions = []
    const aggFindings = []
    const aggFiles = new Map()
    const aggReports = new Set()
    for (const [version, sub] of bucket.byVersion) {
      const findings = []
      const files = new Map()
      for (const f of sub.findings) {
        const t = state.triage.get(tabKey(f))?.triage ?? null
        if (t === 'fixed') triageCounts.fixed++
        else if (t === 'invalid') triageCounts.invalid++
        else if (t === 'deleted') triageCounts.deleted++
        if (t !== state.shownTriage) continue
        findings.push(f)
        if (!files.has(f.file)) files.set(f.file, [])
        files.get(f.file).push(f)
      }
      if (findings.length === 0) continue
      versions.push([version, { findings, files, reports: sub.reports }])
      for (const f of findings) {
        aggFindings.push(f)
        if (!aggFiles.has(f.file)) aggFiles.set(f.file, [])
        aggFiles.get(f.file).push(f)
      }
      for (const r of sub.reports) aggReports.add(r)
    }
    if (versions.length === 0) continue
    versions.sort(([va], [vb]) => compareVersionsDesc(va, vb))
    filtered.push([pkg, {
      findings: aggFindings,
      files: aggFiles,
      reports: aggReports,
      versions,
    }])
  }
  // Selection — clear stale picks when the currently-open package
  // dropped out of the filtered set (e.g. the user flipped triage
  // and the row no longer has any findings under the new filter).
  // Mirrors the bundles-view pattern: selectedBundle stays sticky
  // across re-renders unless the entry is gone.
  //
  // Version pin: look up the user's pinned slot in the package's
  // version list — `null` is a valid key (the "unknown version"
  // slot for findings under plain `node_modules/<pkg>/` paths
  // alongside `.pnpm/<pkg>@<v>/...` siblings), so we don't gate
  // the lookup on `pinned !== null`. When the lookup misses (the
  // pinned slot dropped out under the active triage filter) but
  // exactly one version slot remains, fall back to that slot so
  // the user lands on a populated detail panel; otherwise the
  // details panel covers the whole package aggregate.
  const selected = state.selectedPackage
  const selectedEntry = selected ? filtered.find(([pkg]) => pkg === selected) ?? null : null
  let selectedVersionEntry = null
  if (selectedEntry) {
    const versionList = selectedEntry[1].versions
    const pinned = state.selectedPackageVersion
    selectedVersionEntry = versionList.find(([v]) => v === pinned) ?? null
    if (!selectedVersionEntry && versionList.length === 1) {
      selectedVersionEntry = versionList[0]
    }
  }
  // Bucket fed into the details panel / Issues slide. When a
  // specific version is pinned (multi-version package or single-
  // version package whose lone slot has a known version), the
  // per-version slice surfaces; otherwise the aggregate row
  // covers the whole package.
  const selectedBucket = selectedVersionEntry
    ? selectedVersionEntry[1]
    : (selectedEntry ? selectedEntry[1] : null)
  // Slide mode — the Issues view replaces the list + details with
  // a full-width back-button header + the shared per-file grouped
  // issue list. Mirrors the bundles slide pattern (Graph / Issues
  // / Code → renders edge-to-edge instead of the panel).
  if (selectedEntry && state.packageDetailsTab === 'issues') {
    return renderPackageSlide(
      selectedEntry[0],
      selectedBucket,
      selectedVersionEntry ? selectedVersionEntry[0] : undefined,
    )
  }
  // Apply the user-typed search filter + sort to the visible list
  // (selection lookup above runs against the unfiltered set so
  // typing into the search doesn't collapse the open details
  // panel — the row stays "selected" even when the search hides
  // every other row).
  const searchQuery = state.packagesSearchQuery.trim().toLowerCase()
  const visible = searchQuery
    ? filtered.filter(([pkg]) => pkg.toLowerCase().includes(searchQuery))
    : filtered.slice()
  sortPackages(visible, state.packagesSortBy)
  const totalFindings = filtered.reduce((n, [, bucket]) => n + bucket.findings.length, 0)
  const totalReports = new Set()
  for (const [, bucket] of filtered) for (const r of bucket.reports) totalReports.add(r)
  const layoutClass = selectedEntry ? 'packages-layout open' : 'packages-layout'
  return html`<div class=${classMap({ 'packages-view': true, 'with-details': !!selectedEntry })}>
    <header class="page-head">
      <div class="page-title">
        <h1>Packages</h1>
        <div class="meta-row">
          <span>${visible.length === filtered.length
            ? html`${filtered.length} ${filtered.length === 1 ? 'package' : 'packages'}`
            : html`${visible.length} of ${filtered.length} ${filtered.length === 1 ? 'package' : 'packages'}`}</span>
          ${totalFindings > 0 ? html`<span>${totalFindings} ${totalFindings === 1 ? 'finding' : 'findings'} across ${totalReports.size} ${totalReports.size === 1 ? 'report' : 'reports'}</span>` : nothing}
        </div>
      </div>
      ${packagesToolbarTemplate(triageCounts)}
    </header>
    ${filtered.length === 0
      ? html`<p style="color:var(--muted)">${buckets.size === 0
          ? 'Indexing reports… this view populates as the OPFS scan finishes.'
          : state.shownTriage
            ? `No ${state.shownTriage} findings in any package.`
            : 'No untriaged findings in any package.'}</p>`
      : visible.length === 0
        ? html`<p style="color:var(--muted)">No packages match "${state.packagesSearchQuery}".</p>`
        : html`<div class=${layoutClass}>
          <ul class="packages-list">
            ${repeat(buildVisibleRows(visible), keyForVisibleRow, (row) => renderPackageRow(row, selected, state.selectedPackageVersion))}
          </ul>
          ${selectedEntry ? html`<aside class="packages-details" id="packages-details">
            <header class="packages-details-bar">
              <span class="packages-details-label">Details</span>
              <button type="button" class="packages-details-close" data-deselect-package title="Close details" aria-label="Close details">×</button>
            </header>
            <div class="packages-details-body">
              ${renderPackageDetails(selectedEntry[0], selectedBucket, selectedVersionEntry ? selectedVersionEntry[0] : undefined)}
            </div>
          </aside>` : nothing}
        </div>`}
  </div>`
}

// Flatten the `visible` package list into the row sequence the
// `<ul>` actually renders. Single-version packages collapse to one
// row with no chevron. Multi-version packages emit the latest
// version as the headline row (chevron attached) and, when the
// package is in `state.expandedPackages`, emit the remaining
// versions as `kind: 'other'` rows underneath.
function buildVisibleRows(visible) {
  const rows = []
  for (const [pkg, bucket] of visible) {
    const versions = bucket.versions
    if (versions.length <= 1) {
      const [v, sub] = versions[0]
      rows.push({ kind: 'single', pkg, version: v, bucket: sub, totalVersions: 1 })
      continue
    }
    const [latestV, latestSub] = versions[0]
    const expanded = state.expandedPackages.has(pkg)
    rows.push({
      kind: 'latest',
      pkg,
      version: latestV,
      bucket: latestSub,
      totalVersions: versions.length,
      expanded,
    })
    if (expanded) {
      for (let i = 1; i < versions.length; i++) {
        const [v, sub] = versions[i]
        rows.push({ kind: 'other', pkg, version: v, bucket: sub, totalVersions: versions.length })
      }
    }
  }
  return rows
}

// Stable key for lit's `repeat()` — distinguishes per-version rows
// so the same package's `latest` and `other` rows don't collide
// when expansion flips.
function keyForVisibleRow(row) {
  return row.version === null ? `${row.kind}:${row.pkg}` : `${row.kind}:${row.pkg}@${row.version}`
}

// Toolbar at the top-right of the Packages page header — search
// input + sort dropdown + the existing triage segmented selector.
// Search is a case-insensitive substring match on the package name;
// sort options key off finding / file / report counts plus a
// name-asc fallback. The triage selector is unchanged from before
// (same Fixed / Invalid / Deleted chips); it stays grouped here
// so the page header reads as a single horizontal control row.
function packagesToolbarTemplate(triageCounts) {
  return html`<div class="packages-toolbar">
    <input
      type="search"
      id="packages-search-input"
      class="packages-search"
      placeholder="Filter packages…"
      aria-label="Filter packages"
      .value=${live(state.packagesSearchQuery)}
    >
    <entity-sort kind="packages"></entity-sort>
    <triage-selector variant="packages" .counts=${triageCounts} .states=${PACKAGES_TRIAGE_STATES}></triage-selector>
  </div>`
}

// Packages page triage selector now lives in `<triage-selector
// variant="packages">` (see view/triage-selector.js). The 3-bucket
// state list (no `ignored` — that's per-report and treated as
// untriaged in this view) is the only thing the call site has to
// pass; everything else is handled by the component.
const PACKAGES_TRIAGE_STATES = ['fixed', 'invalid', 'deleted']

// In-place sort by the user-selected key. Every option falls back
// to alphabetical name ordering on ties so the list stays stable
// across re-renders.
function sortPackages(arr, sortBy) {
  const cmp = sortBy === 'name-asc'
    ? (a, b) => a[0].localeCompare(b[0])
    : sortBy === 'files-desc'
      ? (a, b) => (b[1].files.size - a[1].files.size) || a[0].localeCompare(b[0])
      : sortBy === 'reports-desc'
        ? (a, b) => (b[1].reports.size - a[1].reports.size) || a[0].localeCompare(b[0])
        : (a, b) => (b[1].findings.length - a[1].findings.length) || a[0].localeCompare(b[0])
  arr.sort(cmp)
}

// Per-bucket counts for the slide's Invalid / Deleted tabs.
// Keys: 'live' (untriaged + fixed — the default body), 'invalid',
// 'deleted'. Walks the raw OPFS bucket once; the slide uses the
// counts to decide which tabs to render (non-zero only) and
// passes the active mode to packageFindingsByFile for the body.
//
// `version` scopes the counts to a single per-version slot when
// it's non-undefined (null is a valid slot — the "unknown"
// version for plain `node_modules/<pkg>/` installs); pass
// `undefined` to count across every version slot the package
// has.
function packageBucketCounts(rawBucket, version) {
  const counts = { live: 0, invalid: 0, deleted: 0 }
  if (!rawBucket) return counts
  const fileSources = version === undefined
    ? rawBucket.files.values()
    : (rawBucket.byVersion.get(version)?.files.values() ?? [].values())
  for (const findings of fileSources) {
    for (const f of findings) {
      const t = state.triage.get(tabKey(f))?.triage ?? null
      if (t === 'invalid') counts.invalid++
      else if (t === 'deleted') counts.deleted++
      else counts.live++
    }
  }
  return counts
}

// Full-width Issues slide for the open package — same chrome the
// bundle slide uses (back button + title + body) so the visual
// reads consistent across the two cross-report drill-ins. Body
// renders the shared per-file grouped finding list against the
// raw OPFS bucket; the active sub-view is selected by
// `state.packageSlideTriage` (null = live, 'invalid' / 'deleted'
// = those buckets). The `[Invalid | Deleted]` tabs in the header
// surface only when the corresponding bucket is non-empty —
// nothing to switch to otherwise. `bucket` carries the
// page-filtered slice from renderPackagesView; the title bar's
// `bucket.files`/`bucket.reports` counts come from there.
//
// `version` is the per-version slot the slide is scoped to, or
// null for an aggregate (unversioned package). Forwarded into
// `packageFindingsByFile` so the body only renders findings from
// the picked version slot — clicking an older version's row and
// drilling into Issues should not surface findings from the
// latest version.
function renderPackageSlide(pkg, bucket, version) {
  const rawBucket = getPackagesIndex().get(pkg)
  const counts = packageBucketCounts(rawBucket, version)
  const mode = state.packageSlideTriage ?? 'live'
  const issueFindingsByFile = rawBucket ? packageFindingsByFile(rawBucket, pkg, mode, version) : new Map()
  const total = [...issueFindingsByFile.values()].reduce((n, fs) => n + fs.length, 0)
  const noun = mode === 'live'
    ? (total === 1 ? 'issue' : 'issues')
    : (total === 1 ? `${mode} issue` : `${mode} issues`)
  const emptyMsg = mode === 'live'
    ? 'No live issues for this package.'
    : `No ${mode} issues for this package.`
  const titleSuffix = typeof version === 'string' ? ` @ ${version}` : ''
  return html`<div class="packages-view packages-slide-view">
    <header class="bundles-slide-bar">
      <button
        type="button"
        class="bundles-slide-back"
        data-action="package-slide-back"
        title="Back to packages"
        aria-label="Back to packages"
      >← Back</button>
      <div class="bundles-slide-title">
        <div class="bundles-slide-name">${pkg}${titleSuffix}</div>
        <div class="bundles-slide-integrity">${total} ${noun} · ${bucket.files.size} ${bucket.files.size === 1 ? 'file' : 'files'} · ${bucket.reports.size} ${bucket.reports.size === 1 ? 'report' : 'reports'}</div>
      </div>
      <slide-triage-tabs kind="package" .counts=${counts}></slide-triage-tabs>
    </header>
    <div class="bundles-slide-body">
      ${issueFindingsByFile.size === 0
        ? html`<div class="bundle-issues-empty">${emptyMsg}</div>`
        : renderIssuesGroupedByFile(issueFindingsByFile, { kind: 'package', bucketKey: pkg })}
    </div>
  </div>`
}

// Package slide Invalid / Deleted bucket tabs now live in
// `<slide-triage-tabs kind="package">` (see view/slide-triage-tabs.js).
// The component reads `state.packageSlideTriage` directly via
// StateElement and decides its own visibility.

// Single package row in the list — compact (one line + chip strip
// + Issues shortcut). Click-to-select via `data-select-package`;
// the details panel on the right paints the file/report
// breakdown for the open row. The `[Issues →]` button at the
// far right opens the same full-width Issues slide the details
// panel's tab opens — same shape as bundles' `[Code →]` row
// shortcut, no need to drill in to the details panel first.
//
// Row shape branches on `row.kind`:
//   * `'single'` — package has exactly one detected version
//     (often null = unknown for plain `node_modules/<pkg>/`
//     installs). Renders the original single-row chrome; the
//     version chip surfaces only when it's a known string.
//   * `'latest'` — package has 2+ detected versions; this is the
//     headline row pinned to the latest version, with an expand
//     chevron summarising the older versions.
//   * `'other'` — older-version sub-row revealed by the
//     headline's chevron. Indented (`packages-row-other` CSS) so
//     the parent / child relationship reads visually.
function renderPackageRow(row, selectedPkg, selectedVer) {
  const { kind, pkg, version, bucket } = row
  const sevCounts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  for (const f of bucket.findings) {
    if (sevCounts[f.severity] !== undefined) sevCounts[f.severity]++
  }
  const chips = SEVERITIES.filter((s) => sevCounts[s] > 0)
  const dotColor = pkgColor(pkg)
  const isSel = pkg === selectedPkg && versionMatchesSelection(row, selectedVer)
  const classes = {
    selected: isSel,
    'packages-row-latest': kind === 'latest',
    'packages-row-other': kind === 'other',
  }
  const versionAttr = version === null ? '' : version
  const ariaLabel = version === null
    ? `Open issues for ${pkg}`
    : `Open issues for ${pkg}@${version}`
  return html`<li
    class=${classMap(classes)}
    data-select-package=${pkg}
    data-select-package-version=${versionAttr}
  >
    <span class="packages-dot" style=${styleMap({ background: dotColor })}></span>
    <div class="packages-row-text">
      <div class="packages-name-line">
        <span class="packages-name">
          ${pkg}${version === null ? nothing : html`<span class="packages-version">@${version}</span>`}
        </span>
        ${kind === 'latest' ? renderExpandButton(pkg, row.expanded, row.totalVersions - 1) : nothing}
      </div>
      <span class="packages-row-meta">${bucket.findings.length} ${bucket.findings.length === 1 ? 'finding' : 'findings'} · ${bucket.files.size} ${bucket.files.size === 1 ? 'file' : 'files'} · ${bucket.reports.size} ${bucket.reports.size === 1 ? 'report' : 'reports'}</span>
    </div>
    ${chips.length > 0 ? html`<div class="packages-row-chips">
      ${chips.map((s) => html`<span class=${`tree-count-chip ${s}`} title=${s.replaceAll('_', ' ')}>${sevCounts[s]}</span>`)}
    </div>` : nothing}
    <button
      type="button"
      class="packages-row-issues"
      data-package-row-issues=${pkg}
      data-package-row-issues-version=${versionAttr}
      aria-label=${ariaLabel}
    >Issues →</button>
  </li>`
}

// Does the rendered row match the selected (pkg, version) pin?
// The caller already gated on package name equality; this check
// only decides which version slot inside that package matches.
// Single-row packages always match — the row IS the only slot
// for the package, regardless of whether the pin is null or
// happens to be that single slot's version. Multi-version rows
// match strictly on the version pin so clicking a non-latest row
// moves the highlight there instead of clinging to the latest.
function versionMatchesSelection(row, selectedVer) {
  if (row.kind === 'single') return true
  return row.version === selectedVer
}

// Expand / collapse chevron pinned to the right of the headline
// row of a multi-version package. The numeric label ("+3 versions")
// communicates the count of HIDDEN entries; expanded rows show
// "Hide" so the affordance reads as a toggle rather than a
// directional control. The click handler in events.js flips
// `state.expandedPackages` membership on this package.
function renderExpandButton(pkg, expanded, otherCount) {
  const label = expanded
    ? 'Hide'
    : `+${otherCount} ${otherCount === 1 ? 'version' : 'versions'}`
  return html`<button
    type="button"
    class=${classMap({ 'packages-row-expand': true, expanded })}
    data-package-expand=${pkg}
    aria-expanded=${String(expanded)}
    aria-label=${expanded ? `Hide older versions of ${pkg}` : `Show older versions of ${pkg}`}
    title=${expanded ? 'Hide older versions' : `Show older versions (${otherCount})`}
  >
    <span class="packages-row-expand-chevron" aria-hidden="true"></span>
    <span class="packages-row-expand-label">${label}</span>
  </button>`
}

// Right-panel details for the open package — tabbed body. Overview
// tab carries the meta dl + severity chip strip + per-file list +
// OPFS reports list (the bucket the user picked). Issues tab
// reuses the bundle Issues per-file grouped renderer against the
// raw (unfiltered) bucket from the OPFS index — so the per-file
// finding count there reflects every live (non invalid/deleted)
// finding for the package, independent of the page's triage
// selector. `bucket` is the triage-filtered slice from
// renderPackagesView. `version` is the per-version slot the
// detail panel is scoped to: a known string for `.pnpm/<pkg>@<v>/...`
// findings, `null` for findings under plain `node_modules/<pkg>/`
// paths (the "unknown version" slot — still a real slot, not
// the aggregate), or `undefined` for the package-wide aggregate
// when no specific slot is pinned.
function renderPackageDetails(pkg, bucket, version) {
  // Issue count for the action-tab label uses the same filter the
  // bundle Issues tab applies (`mode: 'issues'`): strip invalid +
  // deleted, keep everything else. Pulled from the raw OPFS bucket
  // so the count doesn't shrink to 0 when the page's triage
  // selector flips off the live findings.
  //
  // `version` passes straight through: `packageFindingsByFile`
  // already distinguishes `undefined` (aggregate) from `null`
  // (the unknown-version slot — a real key in `byVersion`).
  const rawBucket = getPackagesIndex().get(pkg)
  const issueFindingsByFile = rawBucket ? packageFindingsByFile(rawBucket, pkg, 'live', version) : new Map()
  const issuesCount = [...issueFindingsByFile.values()].reduce((n, fs) => n + fs.length, 0)
  return html`<div class="bundles-tabs" role="tablist">
    <button
      type="button"
      class="bundles-tab active"
      data-package-tab="overview"
      aria-selected="true"
      role="tab"
    >Overview</button>
    <span class="bundles-tabs-spacer"></span>
    ${issuesCount > 0 ? html`<button
      type="button"
      class="bundles-tab bundles-tab-action"
      data-package-tab="issues"
    >Issues (${issuesCount}) →</button>` : nothing}
  </div>
  ${renderPackageOverview(pkg, bucket, version)}`
}

// Per-file groupings for a package's Issues tab. Three modes:
//
//   * `'live'` (default) — untriaged + fixed. Same set the bundle
//     Issues tab shows; matches the package-row issue count.
//   * `'invalid'` — only findings triaged as invalid.
//   * `'deleted'` — only findings triaged as deleted.
//
// Operates on the RAW bucket from `getPackagesIndex()` so the
// list reflects the package's full inventory, independent of the
// page's triage selector. The slide's [Invalid | Deleted] tabs
// switch the mode via `state.packageSlideTriage`. Returned Map
// is keyed by `pkgRelativePath(pkg, file)` so duplicate file
// paths from different installations of the same package
// (`node_modules/ws/lib/x.js` vs
// `node_modules/.pnpm/ws@.../node_modules/ws/lib/x.js`) merge
// into a single file group instead of rendering as separate
// rows.
//
// `version` scopes the walk to a single per-version slot when
// it's non-undefined (null is a valid slot — see
// `packageBucketCounts`). Without it the function aggregates
// across every version slot the package has.
function packageFindingsByFile(rawBucket, pkg, mode = 'live', version) {
  const result = new Map()
  const fileSource = version === undefined
    ? rawBucket.files
    : (rawBucket.byVersion.get(version)?.files ?? new Map())
  for (const [file, findings] of fileSource) {
    const filtered = findings.filter((f) => {
      const t = state.triage.get(tabKey(f))?.triage ?? null
      if (mode === 'invalid') return t === 'invalid'
      if (mode === 'deleted') return t === 'deleted'
      return t !== 'invalid' && t !== 'deleted'
    })
    if (filtered.length === 0) continue
    const rel = pkgRelativePath(pkg, file)
    if (!result.has(rel)) result.set(rel, [])
    const arr = result.get(rel)
    for (const f of filtered) arr.push(f)
  }
  return result
}

// Overview tab body — moved out of renderPackageDetails so the
// tab dispatch above stays compact. Same content as the previous
// (pre-tabs) detail body. `version` is the per-version slot the
// detail panel is scoped to, surfaced as an extra `Version` row in
// the meta dl when it's a known string.
function renderPackageOverview(pkg, bucket, version) {
  const sevCounts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  for (const f of bucket.findings) {
    if (sevCounts[f.severity] !== undefined) sevCounts[f.severity]++
  }
  const chips = SEVERITIES.filter((s) => sevCounts[s] > 0)
  const sortedFiles = [...bucket.files.entries()].toSorted(([fa, a], [fb, b]) => {
    if (b.length !== a.length) return b.length - a.length
    return fa.localeCompare(fb)
  })
  const sortedReports = [...bucket.reports].toSorted((a, b) => a.localeCompare(b))
  // `repos` lives on the RAW bucket (the page-filtered slice
  // doesn't propagate it — the field is per-package metadata,
  // not triage-filterable). Surface the upstream URL only when
  // every analyzer that stamped a `f.repo.github` agreed on the
  // same value; multiple entries mean we don't have a single
  // canonical link to point at, so the row is omitted entirely
  // rather than guessing.
  const rawBucket = getPackagesIndex().get(pkg)
  const repoSet = rawBucket?.repos
  const repoSlug = repoSet && repoSet.size === 1 ? [...repoSet][0] : null
  const repoUrl = repoSlug
    ? (/^https?:/iu.test(repoSlug) ? repoSlug : `https://github.com/${repoSlug}`)
    : null
  return html`<dl class="packages-detail-meta">
    <dt>Package</dt><dd class="mono">${pkg}</dd>
    ${version ? html`<dt>Version</dt><dd class="mono">${version}</dd>` : nothing}
    ${repoUrl ? html`<dt>Repository</dt><dd class="mono"><a href=${repoUrl} target="_blank" rel="noopener">${repoSlug}</a></dd>` : nothing}
    <dt>Findings</dt><dd>${bucket.findings.length}</dd>
    <dt>Files</dt><dd>${bucket.files.size}</dd>
    <dt>Reports</dt><dd>${bucket.reports.size}</dd>
  </dl>
  ${chips.length > 0 ? html`<div class="packages-detail-chips">
    ${chips.map((s) => html`<span class=${`tree-count-chip ${s}`}>${sevCounts[s]} ${s.replaceAll('_', ' ')}</span>`)}
  </div>` : nothing}
  <h3 class="packages-detail-section">Reports</h3>
  <ul class="packages-detail-reports">
    ${sortedReports.map((r) => {
      const iconHtml = FILE_ICONS[groupOf(r)] ?? FILE_ICONS.default
      return html`<li>
        <button type="button" class="packages-detail-report" title=${r} data-package-report=${r}>
          ${unsafeHTML(iconHtml)}<span class="packages-detail-report-label">${displayName(r)}</span>
        </button>
      </li>`
    })}
  </ul>
  <h3 class="packages-detail-section">Files</h3>
  <ul class="packages-detail-files">
    ${sortedFiles.map(([file, findings]) => {
      const stripped = pkgRelativePath(pkg, file)
      return html`<li class="packages-detail-file">
        <span class="packages-detail-file-path mono" title=${file}>${stripped}</span>
        <span class="packages-detail-file-count">${findings.length}</span>
      </li>`
    })}
  </ul>`
}

// Strip the package's `node_modules/<pkg>/` (or `dependencies/<pkg>/`)
// prefix from a file so the row reads as the relative path inside
// the package (e.g. `lib/index.js` rather than
// `node_modules/foo/lib/index.js`). For own-source packages the
// top-level dir + trailing slash gets stripped; for the repo-root
// bucket ('/') the file is shown as-is.
function pkgRelativePath(pkg, file) {
  for (const dep of ['node_modules', 'dependencies']) {
    const anchor = `${dep}/${pkg}/`
    const idx = file.indexOf(anchor)
    if (idx >= 0) return file.slice(idx + anchor.length)
  }
  if (file.startsWith(`${pkg}/`)) return file.slice(pkg.length + 1)
  return file
}
