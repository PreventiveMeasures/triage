import { inheritReportMeta, isAppFinding, reportEntries } from '@preventive/report'
import { collectDuplicates } from '../../client/linked-findings.js'
import { hasRevalidateStamp } from '../finding-filters.js'
import { workspaceAppMetadata } from '../workspace-app.js'

// The same classification as local workspaces, using only the complete,
// server-filtered published workspace: the reports of one team response and
// its `links`. The managed server classifies each team before sending its
// catalog, so the sidebar opens a team collapsed to its App findings at once.
// The server backfills finding IDs before building these envelopes.
export function managedTeamAppMetadata(workspace) {
  const duplicates = new Map(), reports = []
  collectDuplicates(workspace.links ?? [], duplicates)
  for (const { filename, data } of workspace) {
    if (data.source === 'links' && Array.isArray(data.links)) {
      collectDuplicates(data.links, duplicates)
      continue
    }
    const entries = (reportEntries(data) ?? []).map(entry => Array.isArray(entry) ? entry : [entry])
    const judged = new Set(entries.flat().filter(hasRevalidateStamp).map(f => f.source ?? data.source ?? null))
    const groups = entries.map(group => group.map(f => {
      const finding = { ...f, _source: f.source ?? data.source ?? null }
      inheritReportMeta(finding, data)
      if (!('isApp' in finding)) finding.isApp = isAppFinding(finding, finding._source)
      finding._sourcePass = judged.has(finding._source)
      return finding
    }))
    reports.push({ fileName: filename, groups })
  }
  return workspaceAppMetadata(reports, id => [...duplicates.get(id) ?? []])
}
