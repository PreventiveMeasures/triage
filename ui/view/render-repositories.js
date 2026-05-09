// Repositories view — cross-report aggregation of own-source
// findings (anything NOT in `node_modules/` / `dependencies/`)
// bucketed by their repo URL. Complements `render-packages.js`:
// most findings belong to either a package (third-party) or a
// repository (the user's own code); together the two views
// surface the full inventory without overlap.
//
// Pulls from `client/bundle-finding-index.js`'s `getRepositoriesIndex`
// (the OPFS-wide background scan) rather than `state.reports`,
// so the page reflects every report ever dropped — same
// shape the Packages view follows.
//
// `renderRepositoriesView()` is the single export — orchestrates
// the page's list / details / slide layout. The render()
// orchestrator in `render.js` calls it for `state.currentView
// === 'repositories'`; every other entry point is internal.
//
// `renderIssuesGroupedByFile` (the per-file grouped finding list)
// is shared with the bundle Issues tab + the Packages slide,
// imported from `render-bundle.js` so the chrome stays
// consistent across all three drill-ins.
import { html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { live } from 'lit/directives/live.js'
import { styleMap } from 'lit/directives/style-map.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { state } from '../../client/state.js'
import { ensureBundleFindingsIndexed, getRepositoriesIndex } from '../../client/bundle-finding-index.js'
import { tabKey } from './group.js'
import { SEVERITIES } from './format.js'
import { FILE_ICONS, displayName, groupOf } from './file-display.js'
import { pkgColor } from './graph/utils.js'
import { renderIssuesGroupedByFile } from './render-bundle.js'

// Strip protocol + host so a github URL renders as the bare
// `user/repo` slug — same shape the per-finding `repo.github`
// canonicalises into for analyzer-stamped findings, so a typed
// fallback URL and an analyzer slug surface as the same key.
// Falls back to the raw input when the URL isn't a github.com
// one. Mirrors `prettyRepoLabel` in `repo-chip.js`; not
// imported because the chip's helper isn't exported and the
// logic is one regex.
function prettyRepoLabel(s) {
  if (!s) return ''
  const m = s.match(/github\.com\/([^/?#]+\/[^/?#]+?)(?:\.git)?(?:[/?#]|$)/iu)
  return m ? m[1] : s
}

export function renderRepositoriesView() {
  // Pulls from the OPFS-wide finding index (populated by the
  // background scan in bundle-finding-index.js). The first call
  // kicks the scan if it hasn't run yet; the events.js subscriber
  // re-renders progressively as more reports finish indexing.
  ensureBundleFindingsIndexed().catch(() => {})
  const buckets = getRepositoriesIndex()
  const triageCounts = { fixed: 0, invalid: 0, deleted: 0 }
  const filtered = []
  for (const [repo, bucket] of buckets) {
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
    if (findings.length > 0) filtered.push([repo, { findings, files, reports: bucket.reports }])
  }
  const selected = state.selectedRepository
  const selectedEntry = selected ? filtered.find(([repo]) => repo === selected) ?? null : null
  if (selectedEntry && state.repositoryDetailsTab === 'issues') {
    return renderRepositorySlide(selectedEntry[0], selectedEntry[1])
  }
  const searchQuery = state.repositoriesSearchQuery.trim().toLowerCase()
  const visible = searchQuery
    ? filtered.filter(([repo]) => repo.toLowerCase().includes(searchQuery) || prettyRepoLabel(repo).toLowerCase().includes(searchQuery))
    : filtered.slice()
  sortRepositories(visible, state.repositoriesSortBy)
  const totalFindings = filtered.reduce((n, [, bucket]) => n + bucket.findings.length, 0)
  const totalReports = new Set()
  for (const [, bucket] of filtered) for (const r of bucket.reports) totalReports.add(r)
  const layoutClass = selectedEntry ? 'packages-layout open' : 'packages-layout'
  return html`<div class=${classMap({ 'packages-view': true, 'with-details': !!selectedEntry })}>
    <header class="page-head">
      <div class="page-title">
        <h1>Repositories</h1>
        <div class="meta-row">
          <span>${visible.length === filtered.length
            ? html`${filtered.length} ${filtered.length === 1 ? 'repository' : 'repositories'}`
            : html`${visible.length} of ${filtered.length} ${filtered.length === 1 ? 'repository' : 'repositories'}`}</span>
          ${totalFindings > 0 ? html`<span>${totalFindings} ${totalFindings === 1 ? 'finding' : 'findings'} across ${totalReports.size} ${totalReports.size === 1 ? 'report' : 'reports'}</span>` : nothing}
        </div>
      </div>
      ${repositoriesToolbarTemplate(triageCounts)}
    </header>
    ${filtered.length === 0
      ? html`<p style="color:var(--muted)">${buckets.size === 0
          ? 'Indexing reports… this view populates as the OPFS scan finishes.'
          : state.shownTriage
            ? `No ${state.shownTriage} findings in any repository.`
            : 'No untriaged findings in any repository.'}</p>`
      : visible.length === 0
        ? html`<p style="color:var(--muted)">No repositories match "${state.repositoriesSearchQuery}".</p>`
        : html`<div class=${layoutClass}>
          <ul class="packages-list">
            ${visible.map(([repo, bucket]) => renderRepositoryRow(repo, bucket, repo === selected))}
          </ul>
          ${selectedEntry ? html`<aside class="packages-details" id="repositories-details">
            <header class="packages-details-bar">
              <span class="packages-details-label">Details</span>
              <button type="button" class="packages-details-close" data-deselect-repository title="Close details" aria-label="Close details">×</button>
            </header>
            <div class="packages-details-body">
              ${renderRepositoryDetails(selectedEntry[0], selectedEntry[1])}
            </div>
          </aside>` : nothing}
        </div>`}
  </div>`
}

function repositoriesToolbarTemplate(triageCounts) {
  return html`<div class="packages-toolbar">
    <input
      type="search"
      id="repositories-search-input"
      class="packages-search"
      placeholder="Filter repositories…"
      aria-label="Filter repositories"
      .value=${live(state.repositoriesSearchQuery)}
    >
    <select id="repositories-sort-select" class="packages-sort" aria-label="Sort repositories" .value=${state.repositoriesSortBy}>
      <option value="findings-desc">Findings ↓</option>
      <option value="files-desc">Files ↓</option>
      <option value="reports-desc">Reports ↓</option>
      <option value="name-asc">Name A→Z</option>
    </select>
    ${repositoriesTriageSelectorTemplate(triageCounts)}
  </div>`
}

function repositoriesTriageSelectorTemplate(triageCounts) {
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
        class=${classMap({ 'triage-state-btn': true, [`triage-state-${s}`]: true, active })}
        data-triage-show=${s}
        title=${active ? `Exit ${s} view` : `Show ${s} (${n})`}
        aria-pressed=${String(active)}
      >${s.charAt(0).toUpperCase() + s.slice(1)} (${n})</button>`
    })}
  </div>`
}

function sortRepositories(arr, sortBy) {
  const cmp = sortBy === 'name-asc'
    ? (a, b) => prettyRepoLabel(a[0]).localeCompare(prettyRepoLabel(b[0]))
    : sortBy === 'files-desc'
      ? (a, b) => (b[1].files.size - a[1].files.size) || prettyRepoLabel(a[0]).localeCompare(prettyRepoLabel(b[0]))
      : sortBy === 'reports-desc'
        ? (a, b) => (b[1].reports.size - a[1].reports.size) || prettyRepoLabel(a[0]).localeCompare(prettyRepoLabel(b[0]))
        : (a, b) => (b[1].findings.length - a[1].findings.length) || prettyRepoLabel(a[0]).localeCompare(prettyRepoLabel(b[0]))
  arr.sort(cmp)
}

function repositoryBucketCounts(rawBucket) {
  const counts = { live: 0, invalid: 0, deleted: 0 }
  if (!rawBucket) return counts
  for (const findings of rawBucket.files.values()) {
    for (const f of findings) {
      const t = state.triageState.get(tabKey(f)) ?? null
      if (t === 'invalid') counts.invalid++
      else if (t === 'deleted') counts.deleted++
      else counts.live++
    }
  }
  return counts
}

function renderRepositorySlide(repo, bucket) {
  const rawBucket = getRepositoriesIndex().get(repo)
  const counts = repositoryBucketCounts(rawBucket)
  const mode = state.repositorySlideTriage ?? 'live'
  const issueFindingsByFile = rawBucket ? repositoryFindingsByFile(rawBucket, mode) : new Map()
  const total = [...issueFindingsByFile.values()].reduce((n, fs) => n + fs.length, 0)
  const noun = mode === 'live'
    ? (total === 1 ? 'issue' : 'issues')
    : (total === 1 ? `${mode} issue` : `${mode} issues`)
  const emptyMsg = mode === 'live'
    ? 'No live issues for this repository.'
    : `No ${mode} issues for this repository.`
  return html`<div class="packages-view packages-slide-view">
    <header class="bundles-slide-bar">
      <button
        type="button"
        class="bundles-slide-back"
        data-action="repository-slide-back"
        title="Back to repositories"
        aria-label="Back to repositories"
      >← Back</button>
      <div class="bundles-slide-title">
        <div class="bundles-slide-name">${prettyRepoLabel(repo)}</div>
        <div class="bundles-slide-integrity">${total} ${noun} · ${bucket.files.size} ${bucket.files.size === 1 ? 'file' : 'files'} · ${bucket.reports.size} ${bucket.reports.size === 1 ? 'report' : 'reports'}</div>
      </div>
      ${repositorySlideTriageTabsTemplate(counts)}
    </header>
    <div class="bundles-slide-body">
      ${issueFindingsByFile.size === 0
        ? html`<div class="bundle-issues-empty">${emptyMsg}</div>`
        : renderIssuesGroupedByFile(issueFindingsByFile, { kind: 'repository', repoUrl: repo })}
    </div>
  </div>`
}

function repositorySlideTriageTabsTemplate(counts) {
  const buckets = ['invalid', 'deleted']
  const visible = buckets.filter((b) => counts[b] > 0 || state.repositorySlideTriage === b)
  if (visible.length === 0) return nothing
  return html`<div class="triage-selector packages-slide-triage" role="group" aria-label="Triage view">
    ${visible.map((b) => {
      const active = state.repositorySlideTriage === b
      return html`<button
        type="button"
        class=${classMap({ 'triage-state-btn': true, [`triage-state-${b}`]: true, active })}
        data-repository-slide-triage=${b}
        title=${active ? `Exit ${b} view` : `Show ${b} (${counts[b]})`}
        aria-pressed=${String(active)}
      >${b.charAt(0).toUpperCase() + b.slice(1)} (${counts[b]})</button>`
    })}
  </div>`
}

function renderRepositoryRow(repo, bucket, isSel) {
  const sevCounts = { critical: 0, high: 0, medium: 0, low: 0, high_bug: 0, bug: 0, informational: 0 }
  for (const f of bucket.findings) {
    if (sevCounts[f.severity] !== undefined) sevCounts[f.severity]++
  }
  const chips = SEVERITIES.filter((s) => sevCounts[s] > 0)
  // Reuse the package palette so each repo lands on a stable
  // color across renders. Different keying namespace from
  // packages, but the same hash → hue function.
  const dotColor = pkgColor(repo)
  const label = prettyRepoLabel(repo)
  return html`<li
    class=${isSel ? 'selected' : ''}
    data-select-repository=${repo}
  >
    <span class="packages-dot" style=${styleMap({ background: dotColor })}></span>
    <div class="packages-row-text">
      <span class="packages-name" title=${repo}>${label}</span>
      <span class="packages-row-meta">${bucket.findings.length} ${bucket.findings.length === 1 ? 'finding' : 'findings'} · ${bucket.files.size} ${bucket.files.size === 1 ? 'file' : 'files'} · ${bucket.reports.size} ${bucket.reports.size === 1 ? 'report' : 'reports'}</span>
    </div>
    ${chips.length > 0 ? html`<div class="packages-row-chips">
      ${chips.map((s) => html`<span class=${`tree-count-chip ${s}`} title=${s.replace(/_/gu, ' ')}>${sevCounts[s]}</span>`)}
    </div>` : nothing}
    <button
      type="button"
      class="packages-row-issues"
      data-repository-row-issues=${repo}
      title="Open issues"
      aria-label=${`Open issues for ${label}`}
    >Issues →</button>
  </li>`
}

function renderRepositoryDetails(repo, bucket) {
  const rawBucket = getRepositoriesIndex().get(repo)
  const issueFindingsByFile = rawBucket ? repositoryFindingsByFile(rawBucket) : new Map()
  const issuesCount = [...issueFindingsByFile.values()].reduce((n, fs) => n + fs.length, 0)
  return html`<div class="bundles-tabs" role="tablist">
    <button
      type="button"
      class="bundles-tab active"
      data-repository-tab="overview"
      aria-selected="true"
      role="tab"
    >Overview</button>
    <span class="bundles-tabs-spacer"></span>
    ${issuesCount > 0 ? html`<button
      type="button"
      class="bundles-tab bundles-tab-action"
      data-repository-tab="issues"
      title="Open the repository's matched issues"
    >Issues (${issuesCount}) →</button>` : nothing}
  </div>
  ${renderRepositoryOverview(repo, bucket)}`
}

function repositoryFindingsByFile(rawBucket, mode = 'live') {
  const result = new Map()
  for (const [file, findings] of rawBucket.files) {
    const filtered = findings.filter((f) => {
      const t = state.triageState.get(tabKey(f)) ?? null
      if (mode === 'invalid') return t === 'invalid'
      if (mode === 'deleted') return t === 'deleted'
      return t !== 'invalid' && t !== 'deleted'
    })
    if (filtered.length > 0) result.set(file, filtered)
  }
  return result
}

function renderRepositoryOverview(repo, bucket) {
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
  const repoUrl = /^https?:/iu.test(repo) ? repo : `https://github.com/${repo}`
  return html`<dl class="packages-detail-meta">
    <dt>Repository</dt><dd class="mono"><a href=${repoUrl} target="_blank" rel="noopener">${prettyRepoLabel(repo)}</a></dd>
    <dt>Findings</dt><dd>${bucket.findings.length}</dd>
    <dt>Files</dt><dd>${bucket.files.size}</dd>
    <dt>Reports</dt><dd>${bucket.reports.size}</dd>
  </dl>
  ${chips.length > 0 ? html`<div class="packages-detail-chips">
    ${chips.map((s) => html`<span class=${`tree-count-chip ${s}`}>${sevCounts[s]} ${s.replace(/_/gu, ' ')}</span>`)}
  </div>` : nothing}
  <h3 class="packages-detail-section">Files</h3>
  <ul class="packages-detail-files">
    ${sortedFiles.map(([file, findings]) => html`<li class="packages-detail-file">
      <span class="packages-detail-file-path mono" title=${file}>${file}</span>
      <span class="packages-detail-file-count">${findings.length}</span>
    </li>`)}
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
