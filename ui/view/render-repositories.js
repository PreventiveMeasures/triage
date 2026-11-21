// Repositories view — cross-report aggregation of own-source findings
// (anything not under `node_modules/` / `dependencies/`) by repo URL, in
// the Packages view's chrome (render-packages.js). An own-source finding
// an analyzer stamped with a `package.npm.name` shows in both views: the
// path classifies it, the stamp only refines.
import { html } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from './style-map.js'
import { ensureBundleFindingsIndexed, getRepositoriesIndex, state } from '#client/index.js'
import { prettyRepoLabel } from './format.js'
import { pkgColor } from './graph/utils.js'
import { entityDetails, entityPage, entitySlide, githubUrl, newTriageCounts, rowChips, rowMeta, shownFindings, sortEntities } from './render-packages.js'

export function renderRepositoriesView() {
  ensureBundleFindingsIndexed().catch(() => {})
  const buckets = getRepositoriesIndex()
  const triageCounts = newTriageCounts()
  const filtered = []
  for (const [repo, bucket] of buckets) {
    const { findings, files } = shownFindings(bucket.findings, triageCounts)
    if (findings.length > 0) filtered.push([repo, { findings, files, reports: bucket.reports }])
  }
  const selected = state.selectedRepository
  const selectedEntry = selected ? filtered.find(([repo]) => repo === selected) ?? null : null
  const files = (selectedEntry && getRepositoriesIndex().get(selectedEntry[0])?.files) ?? new Map()
  if (selectedEntry && state.repositoryDetailsTab === 'issues') {
    const [repo, bucket] = selectedEntry
    return entitySlide('repository', { name: prettyRepoLabel(repo), key: repo, files, bucket })
  }
  const searchQuery = state.repositoriesSearchQuery.trim().toLowerCase()
  const visible = searchQuery
    ? filtered.filter(([repo]) => repo.toLowerCase().includes(searchQuery) || prettyRepoLabel(repo).toLowerCase().includes(searchQuery))
    : filtered.slice()
  sortEntities(visible, state.repositoriesSortBy, prettyRepoLabel)
  return entityPage('repository', {
    indexing: buckets.size === 0, filtered, visible, triageCounts,
    rows: repeat(visible, ([repo]) => repo, ([repo, bucket]) => renderRepositoryRow(repo, bucket, repo === selected)),
    details: selectedEntry && entityDetails('repository', { files, bucket: selectedEntry[1],
      meta: html`<dt>Repository</dt><dd class="mono"><a href=${githubUrl(selectedEntry[0])} target="_blank" rel="noopener">${prettyRepoLabel(selectedEntry[0])}</a></dd>` }),
  })
}

// The package palette's hash → hue, so each repo keeps its color.
function renderRepositoryRow(repo, bucket, isSel) {
  const label = prettyRepoLabel(repo)
  return html`<li
    class=${isSel ? 'selected' : ''}
    data-select-repository=${repo}
  >
    <span class="packages-dot" style=${styleMap({ background: pkgColor(repo) })}></span>
    <div class="packages-row-text">
      <span class="packages-name" data-tooltip-truncated data-tooltip=${label}>${label}</span>
      ${rowMeta(bucket)}
    </div>
    ${rowChips(bucket)}
    <button
      type="button"
      class="packages-row-issues"
      data-repository-row-issues=${repo}
      aria-label=${`Open issues for ${label}`}
    >Issues →</button>
  </li>`
}
