import { inheritReportMeta, isAppFinding, reportEntries } from '@preventive/report'
import { collectDuplicates } from '../../client/linked-findings.js'
import { hasRevalidateStamp } from './format.js'
import { workspaceAppMetadata } from './workspace-app.js'

// The same classification as local workspaces, using only the complete,
// server-filtered published workspace. The server backfills finding IDs before
// returning these envelopes. Never read or persist local reports.
export function managedTeamAppMetadata(workspace) {
  const duplicates = new Map(), reports = []
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

// Classify only workspaces already loaded for navigation. Sidebar rendering
// must never fetch report bodies; retain just catalog identity and metadata.
// An old catalog/account can never promote a new one.
export class ManagedTeamAppCache {
  entries = new Map()
  sync(session, teams) {
    const owner = JSON.stringify([session?.id, session?.role, session?.csrfToken])
    if (owner !== this.owner) { this.entries.clear(); this.owner = owner }
    const ids = new Set(teams.map(team => team.id))
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id)
    for (const team of teams) {
      const key = JSON.stringify([team.cacheKey, team.reports.map(r => [r.id, r.cacheKey, r.visible !== false]).toSorted()])
      if (this.entries.get(team.id)?.key !== key) {
        const published = new Set(team.reports.filter(r => r.visible !== false).map(r => r.id))
        this.entries.set(team.id, { key, published, metadata: null })
      }
    }
  }
  get(id) { return this.entries.get(id)?.metadata ?? null }
  token(id) { return this.entries.get(id) }
  record(id, token, workspace) {
    const entry = this.entries.get(id)
    if (!entry || entry !== token || entry.metadata || workspace === null) return
    const loaded = new Set(workspace.map(r => r.id))
    // Incomplete responses must not make an uncovered team appear covered.
    if ([...entry.published].some(reportId => !loaded.has(reportId))) return
    entry.metadata = managedTeamAppMetadata(workspace.filter(r => entry.published.has(r.id)))
  }
}

export const managedTeamAppCache = new ManagedTeamAppCache()
