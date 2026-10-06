import { normalizeEntry } from '../triage-entry.ts'
import { loadManagedFindings, readManagedReport } from '../../common/managed/report-content.ts'
import { MAX_FINDING_ID, MAX_TRIAGE_ENTRIES } from '../../common/managed/triage.ts'

const kind = (local, managed) => local === undefined ? 'managed-only' : managed === undefined ? 'local-only' : 'mismatch'

// Comments have one local body and a managed discussion. Match whole bodies,
// including multiplicity, so an extra managed comment never disappears behind
// an already-imported local comment. Order and attribution have no local peer.
function commentDifference(local, managed) {
  const remaining = managed.slice()
  const left = local.map(text => {
    const index = remaining.indexOf(text)
    if (index !== -1) remaining.splice(index, 1)
    return { text, different: index === -1 }
  })
  const unmatched = local.slice()
  const right = managed.map(text => {
    const index = unmatched.indexOf(text)
    if (index !== -1) unmatched.splice(index, 1)
    return { text, different: index === -1 }
  })
  if (!left.some(item => item.different) && !right.some(item => item.different)) return null
  return { property: 'comment', local: left, managed: right,
    kind: left.some(item => item.different) ? right.some(item => item.different) ? 'mismatch' : 'local-only' : 'managed-only' }
}

export function compareTriageEntries(raw, snapshot) {
  const local = normalizeEntry(raw) ?? {}, managed = normalizeEntry(snapshot.entry) ?? {}
  const differences = []
  for (const property of ['triage', 'color', 'fix', 'flagged']) {
    if (local[property] !== managed[property]) differences.push({ property, local: local[property], managed: managed[property], kind: kind(local[property], managed[property]) })
  }
  const comments = commentDifference(local.comment ? [local.comment] : [], snapshot.comments.map(comment => comment.body))
  if (comments) differences.push(comments)
  if (local.ignoredReports?.length) differences.push({ property: 'ignoredReports', local: [...new Set(local.ignoredReports)], managed: undefined, kind: 'local-only' })
  return differences
}

async function compareReport(report, { lookup, triage, matched, findings, api, signal }) {
  const ids = [...new Set(report.findingIds)].filter(id => lookup.has(id) && !matched.has(id))
  for (let start = 0; start < ids.length; start += MAX_TRIAGE_ENTRIES) {
    const batch = ids.slice(start, start + MAX_TRIAGE_ENTRIES)
    if (batch.some(id => id.length > MAX_FINDING_ID)) throw new Error('A shared finding ID exceeds the managed triage limit.')
    signal.throwIfAborted()
    const { snapshots } = await api.send(`/api/admin/reports/${encodeURIComponent(report.id)}/import-triage`, { findingIds: batch })
    signal.throwIfAborted()
    for (const id of batch) {
      if (!snapshots?.[id]) throw new Error('The server did not return the requested triage snapshot.')
      const differences = compareTriageEntries(triage[id], snapshots[id])
      if (differences.length > 0) findings.push({ id, finding: lookup.get(id), differences })
      matched.add(id)
    }
  }
}

export async function prepareLocalTriageComparison({ source, readTriage, api, signal, progress = () => {} }) {
  const lookup = new Map(), skipped = []
  for (const option of await source.list('report')) {
    signal.throwIfAborted()
    progress(`Reading ${option.label}…`)
    try {
      const findings = await source.importItem('report', option.value, async file => {
        const text = await file.text()
        const parsed = readManagedReport(text, file.name)
        if (!parsed.data) throw new Error(parsed.reason ?? 'Not a recognized report')
        return parsed.format === 'links' ? [] : (await loadManagedFindings(text, file.name))?.findings ?? []
      }, { signal })
      signal.throwIfAborted()
      for (const finding of findings) {
        if (typeof finding.id !== 'string' || !finding.id) continue
        if (!lookup.has(finding.id)) lookup.set(finding.id, { ...finding, reports: [] })
        lookup.get(finding.id).reports.push(option.label)
      }
    } catch (err) {
      signal.throwIfAborted()
      skipped.push({ name: option.label, reason: String(err?.message ?? err) })
    }
  }
  const triage = await readTriage() ?? {}
  signal.throwIfAborted()
  if (typeof triage !== 'object' || Array.isArray(triage)) throw new Error('Invalid local triage.')
  const findings = [], matched = new Set()
  if (lookup.size === 0) return { matched: 0, localFindings: 0, findings, skipped }
  let cursor
  do {
    signal.throwIfAborted()
    progress('Comparing local and managed triage…')
    // Discover managed membership first. Unknown IDs, report bytes and local
    // annotations stay in the browser; only shared IDs request read snapshots.
    const catalog = await api.send('/api/admin/reports/finding-ids' + (cursor ? `?after=${encodeURIComponent(cursor)}` : ''))
    signal.throwIfAborted()
    for (const report of catalog.reports) await compareReport(report, { lookup, triage, matched, findings, api, signal })
    cursor = catalog.nextCursor
  } while (cursor)
  signal.throwIfAborted()
  return { matched: matched.size, localFindings: lookup.size, findings, skipped }
}
