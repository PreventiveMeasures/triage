import { fetchReport as requestReport, fetchReports as requestReports, fetchTeamReports as requestTeamReports } from '../../client/managed/session.js'
import { fetchTeamTrees as requestTeamTrees } from '../../client/managed/team-trees.js'
import { managedAppState } from './state.js'
import { readLiteReportData } from '../../common/managed/lite-name.js'

const keyFor = id => `reports:content:${id}`

// Parsed reports are immutable. Keep successful responses in session-owned
// memory across navigation; report mutations invalidate the reports family.
// Failures are retryable, and reset/invalidation rejects late responses.
async function cachedReport(id, request) {
  const key = keyFor(id)
  const cached = managedAppState.read(key)
  if (cached !== undefined) return cached
  try {
    return await managedAppState.load(key, 'report', async signal => {
      const data = await request(signal)
      if (data === null) throw new Error('Could not load report')
      return data
    })
  } catch { return null }
}

export function fetchReport(id) {
  return cachedReport(id, signal => requestReport(id, { signal }))
}

// Reserve each missing report in the same cache as individual clicks. A
// second workspace/report click joins pending reads instead of duplicating
// them; reports already in memory do not ride the batch request again.
export async function fetchReports(ids) {
  const missing = [...new Set(ids)].filter(id => {
    const entry = managedAppState.resources.get(keyFor(id))
    return entry?.data === undefined && !entry?.pending
  }).toSorted()
  let batch
  const result = await Promise.all(ids.map(id => cachedReport(id, async signal => {
    batch ??= requestReports(missing, { signal })
    return (await batch)?.[missing.indexOf(id)] ?? null
  })))
  return result.some(data => data === null) ? null : result
}

// The same report may have different findings in different teams. Keep the
// entire response together, including links, in a team-specific memory entry.
export function fetchTeamReports(teamId, { reportId = null, lite = false } = {}) {
  const suffix = `${reportId === null ? '' : `:${reportId}`}${lite ? ':lite' : ''}`
  return cachedReport(`team:${teamId}${suffix}`, async signal => {
    const reports = await requestTeamReports(teamId, { signal, reportId, lite })
    if (lite) for (const report of reports ?? []) readLiteReportData(report.data)
    return reports
  })
}

// Their file trees, kept as their reports are: under the team, which a
// catalog change invalidates them with (state.js setReportCatalog).
export function fetchTeamTrees(teamId, { reportId = null } = {}) {
  const suffix = reportId === null ? '' : `:${reportId}`
  return cachedReport(`team:${teamId}${suffix}:trees`, signal => requestTeamTrees(teamId, { signal, reportId }))
}
