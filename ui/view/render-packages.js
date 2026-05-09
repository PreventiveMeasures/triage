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
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { state } from '../../client/state.js'
import { ensureBundleFindingsIndexed, getPackagesIndex } from '../../client/bundle-finding-index.js'
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
  const triageCounts = { fixed: 0, invalid: 0, deleted: 0 }
  const filtered = []
  for (const [pkg, bucket] of buckets) {
    const findings = []
    const files = new Map()
    for (const f of bucket.findings) {
      const t = state.triageState.get(tabKey(f)) ?? null
      if (t === 'fixed') triageCounts.fixed++
      else if (t === 'invalid') triageCounts.invalid++
      else if (t === 'deleted') triageCounts.deleted++
      if (t !== state.shownTriage) continue
      findings.push(f)
      if (!files.has(f.file)) files.set(f.file, [])
      files.get(f.file).push(f)
    }
    if (findings.length > 0) filtered.push([pkg, { findings, files, reports: bucket.reports }])
  }
  // Selection — clear stale picks when the currently-open package
  // dropped out of the filtered set (e.g. the user flipped triage
  // and the row no longer has any findings under the new filter).
  // Mirrors the bundles-view pattern: selectedBundle stays sticky
  // across re-renders unless the entry is gone.
  const selected = state.selectedPackage
  const selectedEntry = selected ? filtered.find(([pkg]) => pkg === selected) ?? null : null
  // Slide mode — the Issues view replaces the list + details with
  // a full-width back-button header + the shared per-file grouped
  // issue list. Mirrors the bundles slide pattern (Graph / Issues
  // / Code → renders edge-to-edge instead of the panel).
  if (selectedEntry && state.packageDetailsTab === 'issues') {
    return renderPackageSlide(selectedEntry[0], selectedEntry[1])
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
  return html`<div class=${`packages-view${selectedEntry ? ' with-details' : ''}`}>
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
            ${visible.map(([pkg, bucket]) => renderPackageRow(pkg, bucket, pkg === selected))}
          </ul>
          ${selectedEntry ? html`<aside class="packages-details" id="packages-details">
            <header class="packages-details-bar">
              <span class="packages-details-label">Details</span>
              <button type="button" class="packages-details-close" data-deselect-package title="Close details" aria-label="Close details">×</button>
            </header>
            <div class="packages-details-body">
              ${renderPackageDetails(selectedEntry[0], selectedEntry[1])}
            </div>
          </aside>` : nothing}
        </div>`}
  </div>`
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
      .value=${state.packagesSearchQuery}
    >
    <select id="packages-sort-select" class="packages-sort" aria-label="Sort packages" .value=${state.packagesSortBy}>
      <option value="findings-desc">Findings ↓</option>
      <option value="files-desc">Files ↓</option>
      <option value="reports-desc">Reports ↓</option>
      <option value="name-asc">Name A→Z</option>
    </select>
    ${packagesTriageSelectorTemplate(triageCounts)}
  </div>`
}

// Triage selector for the Packages page — same shape the bundle
// graph topbar uses (Fixed / Invalid / Deleted, no Ignored
// because ignore is per-report and treated as untriaged here).
// Hidden when every bucket is empty AND we're in the live view —
// nothing to switch to.
function packagesTriageSelectorTemplate(triageCounts) {
  const states = ['fixed', 'invalid', 'deleted']
  const total = states.reduce((n, s) => n + (triageCounts[s] ?? 0), 0)
  if (total === 0 && !state.shownTriage) return nothing
  return html`<div class="triage-selector packages-triage-selector" role="group" aria-label="Triage view">
    ${states.map((s) => {
      const n = triageCounts[s] ?? 0
      const active = state.shownTriage === s
      if (n === 0 && !active) return nothing
      return html`<button
        type="button"
        class=${`triage-state-btn triage-state-${s}${active ? ' active' : ''}`}
        data-triage-show=${s}
        title=${active ? `Exit ${s} view` : `Show ${s} (${n})`}
        aria-pressed=${String(active)}
      >${s.charAt(0).toUpperCase() + s.slice(1)} (${n})</button>`
    })}
  </div>`
}

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

// Full-width Issues slide for the open package — same chrome the
// bundle slide uses (back button + title + body) so the visual
// reads consistent across the two cross-report drill-ins. Body
// renders the shared per-file grouped finding list against the
// raw OPFS bucket so the issue inventory is independent of the
// page's triage selector. `bucket` is unused in slide mode (the
// raw bucket carries the live findings) but kept in the signature
// for the meta strip in the title bar (count summary).
function renderPackageSlide(pkg, bucket) {
  const rawBucket = getPackagesIndex().get(pkg)
  const issueFindingsByFile = rawBucket ? packageFindingsByFile(rawBucket) : new Map()
  const total = [...issueFindingsByFile.values()].reduce((n, fs) => n + fs.length, 0)
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
        <div class="bundles-slide-name">${pkg}</div>
        <div class="bundles-slide-integrity">${total} ${total === 1 ? 'issue' : 'issues'} · ${bucket.files.size} ${bucket.files.size === 1 ? 'file' : 'files'} · ${bucket.reports.size} ${bucket.reports.size === 1 ? 'report' : 'reports'}</div>
      </div>
    </header>
    <div class="bundles-slide-body">
      ${issueFindingsByFile.size === 0
        ? html`<div class="bundle-issues-empty">No live issues for this package.</div>`
        : renderIssuesGroupedByFile(issueFindingsByFile, { kind: 'package' })}
    </div>
  </div>`
}

// Single package row in the list — compact (one line + chip strip).
// Click-to-select via `data-select-package`; the details panel on
// the right paints the file/report breakdown for the open row.
function renderPackageRow(pkg, bucket, isSel) {
  const sevCounts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  for (const f of bucket.findings) {
    if (sevCounts[f.severity] !== undefined) sevCounts[f.severity]++
  }
  const chips = SEVERITIES.filter((s) => sevCounts[s] > 0)
  const dotColor = pkgColor(pkg)
  return html`<li
    class=${isSel ? 'selected' : ''}
    data-select-package=${pkg}
  >
    <span class="packages-dot" style=${`background:${dotColor}`}></span>
    <div class="packages-row-text">
      <span class="packages-name">${pkg}</span>
      <span class="packages-row-meta">${bucket.findings.length} ${bucket.findings.length === 1 ? 'finding' : 'findings'} · ${bucket.files.size} ${bucket.files.size === 1 ? 'file' : 'files'} · ${bucket.reports.size} ${bucket.reports.size === 1 ? 'report' : 'reports'}</span>
    </div>
    ${chips.length > 0 ? html`<div class="packages-row-chips">
      ${chips.map((s) => html`<span class=${`tree-count-chip ${s}`} title=${s.replace(/_/gu, ' ')}>${sevCounts[s]}</span>`)}
    </div>` : nothing}
  </li>`
}

// Right-panel details for the open package — tabbed body. Overview
// tab carries the meta dl + severity chip strip + per-file list +
// OPFS reports list (the bucket the user picked). Issues tab
// reuses the bundle Issues per-file grouped renderer against the
// raw (unfiltered) bucket from the OPFS index — so the per-file
// finding count there reflects every live (non invalid/deleted)
// finding for the package, independent of the page's triage
// selector. `bucket` is the triage-filtered slice from
// renderPackagesView.
function renderPackageDetails(pkg, bucket) {
  // Issue count for the action-tab label uses the same filter the
  // bundle Issues tab applies (`mode: 'issues'`): strip invalid +
  // deleted, keep everything else. Pulled from the raw OPFS bucket
  // so the count doesn't shrink to 0 when the page's triage
  // selector flips off the live findings.
  const rawBucket = getPackagesIndex().get(pkg)
  const issueFindingsByFile = rawBucket ? packageFindingsByFile(rawBucket) : new Map()
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
      title="Open the package's matched issues"
    >Issues (${issuesCount}) →</button>` : nothing}
  </div>
  ${renderPackageOverview(pkg, bucket)}`
}

// Per-file groupings for a package's Issues tab — same triage rule
// the bundle Issues tab uses (drop invalid + deleted, keep
// everything else). Operates on the RAW bucket from
// `getPackagesIndex()` so the issue list reflects the package's
// full live inventory, independent of the page's triage selector.
function packageFindingsByFile(rawBucket) {
  const result = new Map()
  for (const [file, findings] of rawBucket.files) {
    const live = findings.filter((f) => {
      const t = state.triageState.get(tabKey(f)) ?? null
      return t !== 'invalid' && t !== 'deleted'
    })
    if (live.length > 0) result.set(file, live)
  }
  return result
}

// Overview tab body — moved out of renderPackageDetails so the
// tab dispatch above stays compact. Same content as the previous
// (pre-tabs) detail body.
function renderPackageOverview(pkg, bucket) {
  const sevCounts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  for (const f of bucket.findings) {
    if (sevCounts[f.severity] !== undefined) sevCounts[f.severity]++
  }
  const chips = SEVERITIES.filter((s) => sevCounts[s] > 0)
  const sortedFiles = [...bucket.files.entries()].sort(([fa, a], [fb, b]) => {
    if (b.length !== a.length) return b.length - a.length
    return fa.localeCompare(fb)
  })
  const sortedReports = [...bucket.reports].sort((a, b) => a.localeCompare(b))
  return html`<dl class="packages-detail-meta">
    <dt>Package</dt><dd class="mono">${pkg}</dd>
    <dt>Findings</dt><dd>${bucket.findings.length}</dd>
    <dt>Files</dt><dd>${bucket.files.size}</dd>
    <dt>Reports</dt><dd>${bucket.reports.size}</dd>
  </dl>
  ${chips.length > 0 ? html`<div class="packages-detail-chips">
    ${chips.map((s) => html`<span class=${`tree-count-chip ${s}`}>${sevCounts[s]} ${s.replace(/_/gu, ' ')}</span>`)}
  </div>` : nothing}
  <h3 class="packages-detail-section">Files</h3>
  <ul class="packages-detail-files">
    ${sortedFiles.map(([file, findings]) => {
      const stripped = pkgRelativePath(pkg, file)
      return html`<li class="packages-detail-file">
        <span class="packages-detail-file-path mono" title=${file}>${stripped}</span>
        <span class="packages-detail-file-count">${findings.length}</span>
      </li>`
    })}
  </ul>
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
