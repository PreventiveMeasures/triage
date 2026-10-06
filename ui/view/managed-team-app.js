import { inheritReportMeta, isAppFinding, reportEntries } from '@preventive/report'
import { collectDuplicates } from '../../client/linked-findings.js'
import { hasRevalidateStamp } from './format.js'
import { workspaceAppMetadata } from './workspace-app.js'

// The same classification as local workspaces, using only the complete,
// server-filtered published workspace. Never read or persist local reports.
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

// Background promotion is bounded and session-owned. Navigation shares the
// underlying report cache; an old catalog/account can never promote a new one.
export class ManagedTeamAppCache {
  constructor(load, changed) {
    this.load = load
    this.changed = changed
    this.entries = new Map()
    this.running = 0
  }
  sync(session, teams) {
    const owner = JSON.stringify([session?.id, session?.role, session?.csrfToken])
    if (owner !== this.owner) { this.entries.clear(); this.owner = owner }
    const ids = new Set(teams.map(team => team.id))
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id)
    for (const team of teams) {
      const key = JSON.stringify([team.cacheKey, team.reports.map(r => [r.id, r.cacheKey, r.visible !== false]).toSorted()])
      if (this.entries.get(team.id)?.key !== key) this.entries.set(team.id, { key, team, metadata: null })
      else if (!this.entries.get(team.id).metadata) this.entries.get(team.id).done = false
    }
    this.pump()
  }
  get(id) { return this.entries.get(id)?.metadata ?? null }
  pump() {
    for (const [id, entry] of this.entries) {
      if (this.running >= 2) return
      if (entry.loading || entry.done) continue
      entry.loading = true
      this.running++
      void this.load(id).then(workspace => {
        if (this.entries.get(id) !== entry || workspace === null) return
        const published = new Set(entry.team.reports.filter(r => r.visible !== false).map(r => r.id))
        // Incomplete responses must not make an uncovered team appear covered.
        if ([...published].some(reportId => !workspace.some(r => r.id === reportId))) return
        entry.metadata = managedTeamAppMetadata(workspace.filter(r => published.has(r.id)))
        return this.changed()
      }).catch(() => {}).finally(() => {
        entry.loading = false
        entry.done = true
        this.running--
        this.pump()
      })
    }
  }
}
