import { isAppFinding, readReport, reportEntries, reportRepoGithub } from '../../report/index.js'
import { formatBytes } from './metrics.js'

// Saved reports and raw scan results are different catalogues. Never infer
// a Merge result from a saved report's bundle reference.
export function linkableReport(content) {
  const { data } = readReport(content)
  return data && appFindingCount(data) > 0 ? data : null
}

export function appFindingCount(data) {
  // A deduplicated group is one finding, including when only one of its
  // members is in the application layer, just as in the findings view.
  return (reportEntries(data) ?? []).filter(entry => (Array.isArray(entry) ? entry : [entry])
    .some(finding => finding && typeof finding === 'object' && isAppFinding(finding, finding.source ?? data.source))).length
}

export function localReportSources(entries, workspaces) {
  const reports = []
  const repositories = new Map()
  for (const { name, content, fallbackRepo } of entries) {
    if (typeof content !== 'string') continue
    const data = linkableReport(content)
    if (!data) continue // Link requires at least one application-layer finding.
    const findings = reportEntries(data)
    const declared = reportRepoGithub(data) ?? reportRepoGithub({ repo: { github: fallbackRepo } })
    const repoIds = new Set(declared ? [declared] : [])
    if (!declared) {
      for (const finding of findings.flat()) {
        if (/(?:^|\/)(?:node_modules|dependencies)\//u.test(finding?.file ?? '')) continue
        const repo = reportRepoGithub(finding)
        if (repo) repoIds.add(repo)
      }
    }
    for (const id of repoIds) repositories.set(id, { id, label: id })
    reports.push({ id: name, filename: name, repoIds: [...repoIds], analyzer: data.source, appFindings: appFindingCount(data) })
  }
  const ids = new Set(reports.map(report => report.id))
  return {
    merge: { bundles: [], results: [] },
    link: {
      reports, repositories: [...repositories.values()],
      workspaces: workspaces.map(workspace => ({ id: workspace.id, label: workspace.name,
        reports: workspace.reports.filter(id => ids.has(id)) })).filter(workspace => workspace.reports.length > 0),
    },
  }
}

export function managedReportSources(catalogue, scanResults) {
  const reports = (catalogue.reports ?? []).filter(report => report.visible && report.repoId != null).flatMap(report => {
    const data = linkableReport(report.content ?? '')
    return data ? [{ id: report.id, filename: report.filename, repoIds: [report.repoId],
      repo: report.repoFullName, directory: report.repoDirectory, analyzer: report.analyzer,
      appFindings: appFindingCount(data) }] : []
  })
  const repos = new Map((catalogue.repos ?? []).map(repo => [repo.repoId, { id: repo.repoId, label: repo.fullName }]))
  for (const report of reports) {
    if (!repos.has(report.repoIds[0])) repos.set(report.repoIds[0], { id: report.repoIds[0], label: report.repo ?? String(report.repoIds[0]) })
  }
  const results = scanResults.results ?? []
  const bundleIds = new Set(results.map(result => result.bundleId))
  return {
    merge: {
      bundles: (scanResults.bundles ?? []).filter(bundle => bundleIds.has(bundle.id))
        .map(bundle => ({ ...bundle, size: formatBytes(bundle.byteSize) })),
      results,
    },
    // No workspaces field: managed mode only supports repository scopes.
    link: { repositories: [...repos.values()].filter(repo => reports.some(report => report.repoIds.includes(repo.id))), reports },
  }
}
