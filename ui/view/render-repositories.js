// Repositories view — cross-report aggregation of own-source findings
// (anything not under `node_modules/` / `dependencies/`) by repo URL, in
// the Packages view's chrome (render-packages.js). An own-source finding
// an analyzer stamped with a `package.npm.name` shows in both views: the
// path classifies it, the stamp only refines.
import { html } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { ensureBundleFindingsIndexed, getRepositoriesIndex, state } from '#client/index.js'
import { prettyRepoLabel } from './format.js'
import { entityDetails, entityPage, entityRow, entitySlide, newTriageCounts, repositoryMeta, shownFindings } from './render-packages.js'

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
  const files = (selectedEntry && buckets.get(selectedEntry[0])?.files) ?? new Map()
  if (selectedEntry && state.repositoryDetailsTab === 'issues') {
    const [repo, bucket] = selectedEntry
    return entitySlide('repository', { name: prettyRepoLabel(repo), key: repo, files, bucket })
  }
  return entityPage('repository', {
    indexing: buckets.size === 0, filtered, triageCounts, labelOf: prettyRepoLabel,
    rows: (visible) => repeat(visible, ([repo]) => repo, ([repo, bucket]) => renderRepositoryRow(repo, bucket, repo === selected)),
    details: selectedEntry && entityDetails('repository', { files, bucket: selectedEntry[1],
      meta: repositoryMeta(selectedEntry[0], prettyRepoLabel(selectedEntry[0])) }),
  })
}

// The package palette's hash → hue, so each repo keeps its color.
function renderRepositoryRow(repo, bucket, isSel) {
  const label = prettyRepoLabel(repo)
  return entityRow('repository', { classes: isSel ? 'selected' : '', key: repo, label, bucket,
    name: html`<span class="packages-name" data-tooltip-truncated data-tooltip=${label}>${label}</span>` })
}
