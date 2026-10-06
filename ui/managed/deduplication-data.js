import { reportEntries } from '@preventive/report'
import { managedFetch } from '../../client/managed/request.js'
import { fetchReport } from '../../client/managed/session.js'

async function read(path, signal) {
  const response = await managedFetch(path, { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(`Could not load link report (HTTP ${response.status})`)
  return response.json()
}

// Management can inspect unpublished and unassigned findings too. Read a bounded
// number of reports at once and retain only original rows named by this file.
export async function fetchManagedLinkWorkspace(id, { signal } = {}) {
  const link = await read(`/api/admin/deduplication/${encodeURIComponent(id)}`, signal)
  const catalog = await read('/api/admin/reports', signal)
  const ids = new Set(link.groups.flat()), reports = []
  let next = 0
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, catalog.reports.length) }, async () => {
    while (next < catalog.reports.length) {
      signal?.throwIfAborted()
      const index = next++, report = catalog.reports[index]
      const content = await fetchReport(report.id, { signal })
      if (!content) throw new Error(`Could not load ${report.filename}. Reopen this link report to try again.`)
      const entries = reportEntries(content.data) ?? []
      const matching = entries.filter(entry => (Array.isArray(entry) ? entry : [entry]).some(f => ids.has(f?.id)))
      if (matching.length > 0) {
        reports[index] = { id: report.id, filename: report.filename, repo: content.repo,
          data: { ...content.data, [Array.isArray(content.data.findings) ? 'findings' : 'groups']: matching } }
      }
    }
  }))
  for (const result of results) if (result.status === 'rejected') throw result.reason
  // Recheck the admin grant after asynchronous report reads, even for an empty
  // catalog. Viewing a disabled file does not enable or normalize its groups.
  await read(`/api/admin/deduplication/${encodeURIComponent(id)}`, signal)
  return [...reports.filter(Boolean), { id: link.id, filename: link.filename, repo: { github: null, directory: '' },
    data: { source: 'links', findings: [], links: link.groups } }]
}
