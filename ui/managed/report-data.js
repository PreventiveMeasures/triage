import { fetchReport as requestReport, fetchReports as requestReports } from '../../client/managed/session.js'
import { managedAppState } from './state.js'

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
