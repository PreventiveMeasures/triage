import { teamQuery } from '../../client/managed/session.js'
import { managedFetch } from '../../client/managed/request.js'
import { managedAppState } from './state.js'

export function readReportSources(id, teamId) { return managedAppState.resources.get(`report-sources:${teamId ?? ""}:${id}`) }
export function clearReportSources() { managedAppState.invalidate(['report-sources']) }

// Session-owned memory only: logout, mode/role changes and report reloads
// abort and discard these responses alongside the other managed data.
export async function fetchReportSources(id, teamId) {
  const key = `report-sources:${teamId ?? ""}:${id}`
  const cached = readReportSources(id, teamId)
  if (cached?.data !== undefined) return cached.data
  if (cached?.error) return null
  const loading = managedAppState.load(key, 'report sources', async signal => {
    const response = await managedFetch(`/api/reports/${encodeURIComponent(id)}/sources${teamQuery(teamId)}`, { credentials: 'same-origin', signal })
    if (response.status === 204 || response.status === 404) return null
    if (!response.ok) throw new Error(`Sources request failed (${response.status})`)
    const data = await response.json()
    return {
      integrity: data.integrity, sources: new Map(data.files), paths: new Map(data.paths),
      imports: new Map((data.imports ?? []).map(([parent, targets]) => [parent, new Map(targets)])),
    }
  })
  const owner = readReportSources(id, teamId)
  try {
    return await loading
  } catch (error) {
    // Retry failures on a report reload, not on every render. Abort does not
    // poison a new resource created after a session/view reset.
    if (error.name !== 'AbortError') {
      const entry = readReportSources(id, teamId)
      if (entry === owner) entry.error = error
    }
    throw error
  }
}
