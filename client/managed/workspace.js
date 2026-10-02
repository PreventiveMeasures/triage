// The active managed workspace is already filtered by the server. This index
// serves links/cards from those reports only; it never reads local storage.
import { isManagedUiMode, state } from '../state.ts'
import { collectDuplicates } from '../linked-findings.js'
import { findingTitle, inheritReportMeta, isAppFinding, reportEntries } from '@preventive/report'

let workspace = null
export function clearManagedWorkspace() { workspace = null }
export function managedWorkspace() {
  return isManagedUiMode() && workspace?.teamId === state.currentManagedTeam
    && workspace?.userId === state.managedSession?.id && workspace?.role === state.managedSession?.role ? workspace : null
}
export function setManagedWorkspace(teamId, reports) {
  const byId = new Map(), duplicates = new Map(), links = [], rows = []
  for (const report of reports) {
    const data = report.data
    if (data.source === 'links' && Array.isArray(data.links)) {
      links.push({ id: report.id, name: report.filename, groups: data.links, skipped: 0 })
      collectDuplicates(data.links, duplicates)
      continue
    }
    for (const [index, entry] of (reportEntries(data) ?? []).entries()) {
      const members = (Array.isArray(entry) ? entry : [entry]).filter(f => f && typeof f === 'object').map(f => {
        const finding = { ...f, _managedReportId: report.id, _reportName: report.filename,
          _repoFallback: report.repo.github, _repoDirectory: report.repo.directory,
          _source: f.source ?? data.source ?? null, _bundleHashes: data.bundleHashes ?? [] }
        inheritReportMeta(finding, data)
        finding._analyzer = finding._source ?? finding.type ?? null
        if (!('isApp' in finding)) finding.isApp = isAppFinding(finding, finding._source)
        return finding
      })
      const row = { report: report.filename, managedReportId: report.id, index, members }
      rows.push(row)
      for (const f of members) {
        if (!byId.has(f.id)) byId.set(f.id, [])
        byId.get(f.id).push(row)
      }
    }
  }
  workspace = { teamId, userId: state.managedSession?.id, role: state.managedSession?.role, links, rows, byId, duplicates }
  state.linksTick++
  state.findingIndexTick++
}
export function managedRowsForIds(ids) {
  const active = managedWorkspace()
  return [...new Set(ids.flatMap(id => active?.byId.get(id) ?? []))]
}
export function managedTitleForId(id) {
  for (const row of managedRowsForIds([id])) {
    const title = findingTitle(row.members.find(f => f.id === id))
    if (title) return title
  }
  return ''
}
