import { inheritReportMeta, isAppFinding, reportEntries, revalidateKindOf } from '@preventive/report'
import { collectDuplicates } from '../../client/linked-findings.js'
import { dependencyDirectory, isDependencyFile } from '../../client/dependency-paths.js'
import { hasRevalidateStamp } from '../finding-filters.js'
import { workspaceApp, workspaceAppMetadata, workspaceAppRows } from '../workspace-app.js'
import { mergeReportGroups } from '../workspace-groups.js'

// The same classification as local workspaces, using only the complete,
// server-filtered published workspace: the reports of one team response and
// its `links`. The managed server classifies each team before sending its
// catalog, so the sidebar opens a team collapsed to its App findings at once.
// The server backfills finding IDs before building these envelopes.
export function managedTeamAppMetadata(workspace, options = {}) {
  const { reports, duplicates } = viewReports(workspace)
  return workspaceAppMetadata(reports, id => [...duplicates.get(id) ?? []], options)
}

// Whether copies of one finding in the workspace disagree on what the
// revalidation pass said, which takes the App lens off a view of it
// (ui/view/render.js configureReportRevalidation). Asked of all its rows, so
// that a view of any of its reports holds none either.
export function managedTeamRevalidationConflicted(workspace) {
  return mergeReportGroups(viewReports(workspace).reports).conflicts.size > 0
}

// The IDs of the findings the workspace's basic App view can show
// (common/workspace-app.js workspaceAppRows), or null.
export function managedTeamAppRows(workspace) {
  const { reports, duplicates } = viewReports(workspace)
  return workspaceAppRows(reports, id => [...duplicates.get(id) ?? []])
}

// What a view of the whole workspace offers beside the App view
// (ui/view/render.js), told by all its rows: whether the revalidation layer
// can come off (`drop`), whether its detail stop has rows to unfold
// (`detail`), and whether an upstream lens has ground (`upstream`).
export function managedTeamLens(workspace) {
  const { reports } = viewReports(workspace)
  return lensOf(reports, mergeReportGroups(reports).groups)
}

// One reading of a team's published workspace for all that is asked of it as
// its reports are built (server-managed/team-reports.ts), each worked out of
// the same rows: its classification (managedTeamAppMetadata, its findings
// counted, and of a team not App, how many of its reports open in App mode on
// their own), the rows its App view shows (managedTeamAppRows), and, asked
// only where wanted, whether copies contradict the pass
// (managedTeamRevalidationConflicted) and what its rows offer the toolbar
// (managedTeamLens).
export function managedTeamView(workspace) {
  const { reports, duplicates, linked } = viewReports(workspace)
  const { metadata, rows } = workspaceApp(reports, id => [...duplicates.get(id) ?? []], { countFindings: true })
  // Each report alone, with the links the workspace has, not its link reports'.
  const alone = id => [...linked.get(id) ?? []]
  const app = metadata.appMode ? metadata : { ...metadata, appReports: reports.filter(report => workspaceAppMetadata([report], alone).appMode).length }
  let merged = null
  const plain = () => merged ??= mergeReportGroups(reports)
  return { app, rows, conflicted: () => plain().conflicts.size > 0, lens: () => lensOf(reports, plain().groups) }
}

const RULED_OUT = new Set(['refuted', 'unreachable'])

function lensOf(reports, groups) {
  const rows = reports.flatMap(report => report.groups.flat())
  const directory = dependencyDirectory(reports)
  const detail = groups.some(group => {
    const kinds = group.map(revalidateKindOf)
    return kinds.includes('partial') || kinds.includes('revalidation') && kinds.some(kind => kind !== 'revalidation' && !RULED_OUT.has(kind))
  })
  return {
    drop: rows.some(hasRevalidateStamp),
    detail,
    upstream: rows.some(f => f.isUpstream === true || f.isApp === false && !('isUpstream' in f) && isDependencyFile(f.file, directory)),
  }
}

// The workspace's reports as a view holds them (ui/view/ingest.js), with the
// duplicates its links name, and those its own `links` name alone (`linked`).
function viewReports(workspace) {
  const duplicates = new Map(), linked = new Map(), reports = []
  collectDuplicates(workspace.links ?? [], duplicates)
  collectDuplicates(workspace.links ?? [], linked)
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
    reports.push({ fileName: filename, groups, treeDependencies: data.treeDependencies ?? null })
  }
  return { reports, duplicates, linked }
}
