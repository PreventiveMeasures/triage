// Packages view — cross-report aggregation of findings by package name
// (`node_modules/<pkg>/` or `dependencies/<pkg>/` prefix), and the page
// chrome it shares with the Repositories view (render-repositories.js):
// header, list and details panel, the full-width Issues slide, the row's
// chips and the Overview. Both read the OPFS-wide finding index
// (client/bundle-finding-index.js) rather than `state.reports`, so they
// cover every report ever dropped; the first call kicks the background
// scan, and its events.js subscriber re-renders as reports are indexed.
//
// The slide's per-file list is the bundle Issues tab's
// (render-bundle.js renderIssuesGroupedByFile), same chrome and classes.
import { html, nothing } from 'lit'
import { literal, html as staticHtml } from 'lit/static-html.js'
import { classMap } from 'lit/directives/class-map.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from './style-map.js'
import { appMarkup } from './markup.js'
import { compareVersionsDesc, ensureBundleFindingsIndexed, getPackagesIndex, state } from '#client/index.js'
import { sharedFindingTriage } from '../../client/ignored-triage.js'
import { tabKey } from './group.js'
import { SEVERITIES, displayedSeverity } from './format.js'
import { FILE_ICONS, displayName, groupOf } from './file-display.js'
import { pkgColor } from './graph/utils.js'
import { renderIssuesGroupedByFile } from './render-bundle.js'

// Each view's words and the stems of its event-delegate attributes
// (events.js `data-deselect-<kind>`, `data-<kind>-tab`), which a template
// can only vary as static parts.
const KINDS = {
  package: { title: 'Packages', one: 'package', many: 'packages', stem: literal`package` },
  repository: { title: 'Repositories', one: 'repository', many: 'repositories', stem: literal`repository` },
}

// Shared App/own-code ignores count; per-report dependency ignores stay live.
const TRIAGE_STATES = ['inprogress', 'fixed', 'invalid', 'deleted', 'ignored']

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const triageOf = (f) => sharedFindingTriage(f, state.triage.get(tabKey(f))) ?? null
const pushTo = (map, key, value) => {
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(value)
}

export const newTriageCounts = () => ({ inprogress: 0, fixed: 0, invalid: 0, deleted: 0, ignored: 0 })

// Tally each finding's triage bucket into `counts`, and return those in the
// bucket on screen (`state.shownTriage`), with their files.
export function shownFindings(findings, counts) {
  const shown = []
  const files = new Map()
  for (const f of findings) {
    const t = triageOf(f)
    if (Object.hasOwn(counts, t)) counts[t]++
    if (t !== state.shownTriage) continue
    shown.push(f)
    pushTo(files, f.file, f)
  }
  return { findings: shown, files }
}

// The slide's sub-views: `invalid` / `deleted`, and `live` for the rest.
const slideBucket = (f) => {
  const t = triageOf(f)
  return t === 'invalid' || t === 'deleted' ? t : 'live'
}

// Each of a raw index bucket's `files` with the findings of slide `mode`,
// grouped under `keyOf(file)` (several install paths can name one file).
function findingsByFile(files, mode, keyOf = (file) => file) {
  const result = new Map()
  for (const [file, findings] of files) for (const f of findings) if (slideBucket(f) === mode) pushTo(result, keyOf(file), f)
  return result
}

const countOf = (byFile) => [...byFile.values()].reduce((n, fs) => n + fs.length, 0)
const countsLine = (bucket) => `${plural(bucket.files.size, 'file')} · ${plural(bucket.reports.size, 'report')}`
const githubUrl = (slug) => /^https?:/iu.test(slug) ? slug : `https://github.com/${slug}`

function severityCounts(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  for (const f of findings) {
    const sev = displayedSeverity(f, state.severityMode)
    if (counts[sev] !== undefined) counts[sev]++
  }
  return { counts, present: SEVERITIES.filter((s) => counts[s] > 0) }
}

// One list row: a click selects it (`data-select-<kind>`), `Issues →`
// opens the slide directly. `name` is its name line, `label` what the
// button names, and a package's `version` (`''` for the unknown one) the
// attributes saying which; under the name, the findings · files · reports
// line, and the severity chips beside it.
export function entityRow(kind, { classes, key, version = nothing, name, label, bucket }) {
  const { stem } = KINDS[kind]
  const { counts, present } = severityCounts(bucket.findings)
  return staticHtml`<li
    class=${classes}
    data-select-${stem}=${key}
    data-select-${stem}-version=${version}
  >
    <span class="packages-dot" style=${styleMap({ background: pkgColor(key) })}></span>
    <div class="packages-row-text">
      ${name}${kind === 'repository' ? ' ' : nothing}<span class="packages-row-meta">${plural(bucket.findings.length, 'finding')} · ${countsLine(bucket)}</span>
    </div>
    ${present.length > 0 ? html`<div class="packages-row-chips">
      ${present.map((s) => html`<span class=${`tree-count-chip ${s}`} data-tooltip=${s.replaceAll('_', ' ')}>${counts[s]}</span>`)}
    </div>` : nothing}
    <button
      type="button"
      class="packages-row-issues"
      data-${stem}-row-issues=${key}
      data-${stem}-row-issues-version=${version}
      aria-label=${`Open issues for ${label}`}
    >Issues →</button>
  </li>`
}

// The Overview's row linking a repository on GitHub.
export const repositoryMeta = (slug, label = slug) =>
  html`<dt>Repository</dt><dd class="mono"><a href=${githubUrl(slug)} target="_blank" rel="noopener">${label}</a></dd>`

// The page: header with its counts and toolbar, then the list and, for the
// open row, its details. `filtered` is every row in the triage bucket on
// screen; `rows(visible)` draws those the search leaves (by key, or by
// `labelOf` it), in the order picked, which ties by `labelOf` too.
export function entityPage(kind, { indexing, filtered, triageCounts, rows, details, labelOf = (key) => key }) {
  const { title, one, many, stem } = KINDS[kind]
  const query = state[`${many}SearchQuery`].trim().toLowerCase()
  const visible = query ? filtered.filter(([key]) => key.toLowerCase().includes(query) || labelOf(key).toLowerCase().includes(query)) : filtered.slice()
  sortEntities(visible, state[`${many}SortBy`], labelOf)
  const totalFindings = filtered.reduce((n, [, bucket]) => n + bucket.findings.length, 0)
  const totalReports = new Set(filtered.flatMap(([, bucket]) => [...bucket.reports]))
  const count = plural(filtered.length, one, many)
  const empty = (text) => html`<p style=${styleMap({ color: 'var(--muted)' })}>${text}</p>`
  return html`<div class=${classMap({ 'packages-view': true, 'with-details': !!details })}>
    <header class="page-head">
      <div class="page-title">
        <h1>${title}</h1>
        <div class="meta-row">
          <span>${visible.length === filtered.length ? count : `${visible.length} of ${count}`}</span>
          ${totalFindings > 0 ? html`<span>${plural(totalFindings, 'finding')} across ${plural(totalReports.size, 'report')}</span>` : nothing}
        </div>
      </div>
      <div class="packages-toolbar">
        <entity-search kind=${many}></entity-search>
        <entity-sort kind=${many}></entity-sort>
        <triage-selector variant="packages" .counts=${triageCounts} .states=${TRIAGE_STATES}></triage-selector>
      </div>
    </header>
    ${filtered.length === 0
      ? empty(indexing ? 'Indexing reports… this view populates as the OPFS scan finishes.'
        : `No ${state.shownTriage || 'untriaged'} findings in any ${one}.`)
      : visible.length === 0
        ? empty(`No ${many} match "${state[`${many}SearchQuery`]}".`)
        : html`<div class=${details ? 'packages-layout open' : 'packages-layout'}>
          <ul class="packages-list">
            ${rows(visible)}
          </ul>
          ${details ? staticHtml`<aside class="packages-details" id=${`${many}-details`}>
            <header class="packages-details-bar">
              <span class="packages-details-label">Details</span>
              <button type="button" class="packages-details-close" data-deselect-${stem} aria-label="Close details">×</button>
            </header>
            <div class="packages-details-body">
              ${details}
            </div>
          </aside>` : nothing}
        </div>`}
  </div>`
}

// The details panel: an Overview tab, and a shortcut to the Issues slide
// counting the live findings of the raw bucket (`files`, untouched by the
// page's triage selector), then the Overview: `meta` (the view's own rows
// of the meta list) over `bucket`, the page-filtered slice, its files
// listed by `fileLabel`.
export function entityDetails(kind, { files, meta, bucket, fileLabel = (file) => file }) {
  const issuesCount = countOf(findingsByFile(files, 'live'))
  const { stem } = KINDS[kind]
  const { counts, present } = severityCounts(bucket.findings)
  const sortedFiles = [...bucket.files.entries()].toSorted(([fa, a], [fb, b]) => b.length - a.length || fa.localeCompare(fb))
  return staticHtml`<div class="bundles-tabs" role="tablist">
    <button
      type="button"
      class="bundles-tab active"
      data-${stem}-tab="overview"
      aria-selected="true"
      role="tab"
    >Overview</button>
    <span class="bundles-tabs-spacer"></span>
    ${issuesCount > 0 ? staticHtml`<button
      type="button"
      class="bundles-tab bundles-tab-action"
      data-${stem}-tab="issues"
    >Issues (${issuesCount}) →</button>` : nothing}
  </div>
  <dl class="packages-detail-meta">
    ${meta}
    <dt>Findings</dt><dd>${bucket.findings.length}</dd>
    <dt>Files</dt><dd>${bucket.files.size}</dd>
    <dt>Reports</dt><dd>${bucket.reports.size}</dd>
  </dl>
  ${present.length > 0 ? html`<div class="packages-detail-chips">
    ${present.map((s) => html`<span class=${`tree-count-chip ${s}`}>${counts[s]} ${s.replaceAll('_', ' ')}</span>`)}
  </div>` : nothing}
  <h3 class="packages-detail-section">Reports</h3>
  <ul class="packages-detail-reports">
    ${[...bucket.reports].toSorted((a, b) => a.localeCompare(b)).map((r) => html`<li>
        <button type="button" class="packages-detail-report" data-package-report=${r}>
          ${appMarkup(FILE_ICONS[groupOf(r)] ?? FILE_ICONS.default)}<span class="packages-detail-report-label" data-tooltip-truncated data-tooltip=${r}>${displayName(r)}</span>
        </button>
      </li>`)}
  </ul>
  <h3 class="packages-detail-section">Files</h3>
  <ul class="packages-detail-files">
    ${sortedFiles.map(([file, findings]) => html`<li class="packages-detail-file">
        <span class="packages-detail-file-path mono" data-tooltip-truncated data-tooltip=${file}>${fileLabel(file)}</span>
        <span class="packages-detail-file-count">${findings.length}</span>
      </li>`)}
  </ul>`
}

// The full-width Issues slide for the open row — the bundle slide's chrome
// (back button, title, body). `files` is the raw index bucket's, filtered
// by the slide's own `state.<kind>SlideTriage` (null = live; its
// `[Invalid | Deleted]` tabs show only where those hold findings), and
// grouped by `keyOf`; `bucket` is the page-filtered slice the title line
// counts files and reports of.
export function entitySlide(kind, { name, key, files, bucket, keyOf }) {
  const counts = { live: 0, invalid: 0, deleted: 0 }
  for (const findings of files.values()) for (const f of findings) counts[slideBucket(f)]++
  const mode = state[`${kind}SlideTriage`] ?? 'live'
  const issueFindingsByFile = findingsByFile(files, mode, keyOf)
  const total = countOf(issueFindingsByFile)
  return html`<div class="packages-view packages-slide-view">
    <header class="bundles-slide-bar">
      <button
        type="button"
        class="bundles-slide-back"
        data-action=${`${kind}-slide-back`}
        aria-label=${`Back to ${KINDS[kind].many}`}
      >← Back</button>
      <div class="bundles-slide-title">
        <div class="bundles-slide-name" data-tooltip-truncated data-tooltip=${name}>${name}</div>
        <div class="bundles-slide-integrity">${plural(total, mode === 'live' ? 'issue' : `${mode} issue`)} · ${countsLine(bucket)}</div>
      </div>
      <slide-triage-tabs kind=${kind} .counts=${counts}></slide-triage-tabs>
    </header>
    <div class="bundles-slide-body">
      ${issueFindingsByFile.size === 0
        ? html`<div class="bundle-issues-empty">No ${mode} issues for this ${kind}.</div>`
        : renderIssuesGroupedByFile(issueFindingsByFile, { kind, bucketKey: key })}
    </div>
  </div>`
}

// In-place sort by the user-selected key, ties by `labelOf` so the list
// stays stable across renders.
function sortEntities(arr, sortBy, labelOf) {
  const size = sortBy === 'files-desc' ? (b) => b.files.size
    : sortBy === 'reports-desc' ? (b) => b.reports.size
    : sortBy === 'name-asc' ? () => 0
    : (b) => b.findings.length
  arr.sort((a, b) => (size(b[1]) - size(a[1])) || labelOf(a[0]).localeCompare(labelOf(b[0])))
}

export function renderPackagesView() {
  ensureBundleFindingsIndexed().catch(() => {})
  const buckets = getPackagesIndex()
  // Each package's per-version slices in the bucket on screen, latest first
  // (`compareVersionsDesc`), and their aggregate. A multi-version package
  // lists its latest version with a chevron revealing the older ones.
  const triageCounts = newTriageCounts()
  const filtered = []
  for (const [pkg, bucket] of buckets) {
    const versions = []
    const agg = { findings: [], files: new Map(), reports: new Set() }
    for (const [version, sub] of bucket.byVersion) {
      const { findings, files } = shownFindings(sub.findings, triageCounts)
      if (findings.length === 0) continue
      versions.push([version, { findings, files, reports: sub.reports }])
      for (const f of findings) {
        agg.findings.push(f)
        pushTo(agg.files, f.file, f)
      }
      for (const r of sub.reports) agg.reports.add(r)
    }
    if (versions.length === 0) continue
    versions.sort(([va], [vb]) => compareVersionsDesc(va, vb))
    filtered.push([pkg, { ...agg, versions }])
  }
  // The open package, while it is still in the filtered set. Its pinned
  // version slot (`null` is one: the unknown version of plain
  // `node_modules/<pkg>/` paths) where that slot survives the filter, else
  // a lone remaining slot; otherwise the details cover the whole package.
  const selected = state.selectedPackage
  const selectedEntry = selected ? filtered.find(([pkg]) => pkg === selected) ?? null : null
  const versionList = selectedEntry?.[1].versions ?? []
  const selectedVersionEntry = versionList.find(([v]) => v === state.selectedPackageVersion) ?? (versionList.length === 1 ? versionList[0] : null)
  const selectedBucket = selectedVersionEntry?.[1] ?? selectedEntry?.[1] ?? null
  // `undefined` for the package-wide aggregate, unlike `null`'s slot.
  const version = selectedVersionEntry ? selectedVersionEntry[0] : undefined
  const rawBucket = selectedEntry ? buckets.get(selectedEntry[0]) : null
  const rawFiles = (version === undefined ? rawBucket?.files : rawBucket?.byVersion.get(version)?.files) ?? new Map()
  if (selectedEntry && state.packageDetailsTab === 'issues') {
    const pkg = selectedEntry[0]
    return entitySlide('package', { name: `${pkg}${typeof version === 'string' ? ` @ ${version}` : ''}`, key: pkg,
      files: rawFiles, bucket: selectedBucket, keyOf: (file) => pkgRelativePath(pkg, file) })
  }
  // The search narrows the list only: the open row stays open.
  return entityPage('package', {
    indexing: buckets.size === 0, filtered, triageCounts,
    rows: (visible) => repeat(buildVisibleRows(visible), keyForVisibleRow, (row) => renderPackageRow(row, selected, state.selectedPackageVersion)),
    details: selectedEntry && entityDetails('package', { files: rawFiles, bucket: selectedBucket,
      meta: packageMeta(selectedEntry[0], version, rawBucket), fileLabel: (file) => pkgRelativePath(selectedEntry[0], file) }),
  })
}

// The `<ul>`'s rows: a single-version package as one row; a multi-version
// one as its latest version (`latest`, with the chevron counting the
// `others`) and, expanded (`state.expandedPackages`), the older ones under
// it (`other`).
function buildVisibleRows(visible) {
  return visible.flatMap(([pkg, { versions }]) => {
    if (versions.length === 1) return [{ kind: 'single', pkg, version: versions[0][0], bucket: versions[0][1] }]
    const expanded = state.expandedPackages.has(pkg)
    return (expanded ? versions : versions.slice(0, 1)).map(([version, bucket], i) =>
      ({ kind: i === 0 ? 'latest' : 'other', pkg, version, bucket, others: versions.length - 1, expanded }))
  })
}

// Keyed per version, so a package's `latest` and `other` rows don't
// collide when expansion flips.
const keyForVisibleRow = (row) => row.version === null ? `${row.kind}:${row.pkg}` : `${row.kind}:${row.pkg}@${row.version}`

// One package row. A `single` row (often the unknown `null` version)
// always matches the selection; a multi-version row matches on its pinned
// version. `other` rows indent under their `latest` (CSS).
function renderPackageRow({ kind, pkg, version, bucket, others, expanded }, selectedPkg, selectedVer) {
  const label = version === null ? pkg : `${pkg}@${version}`
  const classes = classMap({
    selected: pkg === selectedPkg && (kind === 'single' || version === selectedVer),
    'packages-row-latest': kind === 'latest',
    'packages-row-other': kind === 'other',
  })
  return entityRow('package', { classes, key: pkg, version: version ?? '', label, bucket, name: html`<div class="packages-name-line">
        <span class="packages-name" data-tooltip-truncated data-tooltip=${label}>
          ${pkg}${version === null ? nothing : html`<span class="packages-version">@${version}</span>`}
        </span>
        ${kind === 'latest' ? renderExpandButton(pkg, expanded, others) : nothing}
      </div>` })
}

// The headline row's chevron: "+N versions" counts the hidden ones, "Hide"
// reads as the toggle; events.js flips `state.expandedPackages`.
function renderExpandButton(pkg, expanded, otherCount) {
  return html`<button
    type="button"
    class=${classMap({ 'packages-row-expand': true, expanded })}
    data-package-expand=${pkg}
    aria-expanded=${String(expanded)}
    aria-label=${expanded ? `Hide older versions of ${pkg}` : `Show older versions of ${pkg}`}
    data-tooltip=${expanded ? 'Hide older versions' : `Show older versions (${otherCount})`}
  >
    <span class="packages-row-expand-chevron" aria-hidden="true"></span>
    <span class="packages-row-expand-label">${expanded ? 'Hide' : `+${plural(otherCount, 'version')}`}</span>
  </button>`
}

// The Overview's package rows: its version where one is known, and its
// upstream repository where every analyzer stamping `f.repo.github` agreed
// on one (the raw bucket's `repos`, untouched by triage).
function packageMeta(pkg, version, rawBucket) {
  const repoSet = rawBucket?.repos
  const repoSlug = repoSet && repoSet.size === 1 ? [...repoSet][0] : null
  return html`<dt>Package</dt><dd class="mono">${pkg}</dd>
    ${version ? html`<dt>Version</dt><dd class="mono">${version}</dd>` : nothing}
    ${repoSlug ? repositoryMeta(repoSlug) : nothing}`
}

// A file as the path inside its package (`lib/index.js`, not
// `node_modules/foo/lib/index.js`); for own-source packages the top-level
// dir goes, and the repo-root bucket ('/') shows the file as-is.
function pkgRelativePath(pkg, file) {
  for (const dep of ['node_modules', 'dependencies']) {
    const anchor = `${dep}/${pkg}/`
    const idx = file.indexOf(anchor)
    if (idx >= 0) return file.slice(idx + anchor.length)
  }
  if (file.startsWith(`${pkg}/`)) return file.slice(pkg.length + 1)
  return file
}
