// Compare the reports' own rows and ratings, before viewer deduplication,
// linking, filters or triage can combine them. Finding identity is the id
// written in the report; missing ids are counted and excluded explicitly.
import { effectiveSeverity, readReport, reportEntries, revalidateKindOf } from '@preventive/report'
import { parseLinkedFindings } from '../../client/linked-findings.js'

export function parseComparisonReport(content) {
  // A direct file or an uncached saved file can bypass the picker's kind
  // filter. Preserve the app's links/report distinction before wrapping:
  // arrays of arrays of { id } are links, even with extra member fields.
  if (parseLinkedFindings(content)) {
    throw new Error('This is a links file, not a report. Wrap report rows in a groups or findings object to compare them.')
  }
  // Other raw arrays are accepted by the local diff script. Wrap them so
  // the shared reader applies the same normalization as stored reports.
  let input = content
  try {
    const data = JSON.parse(content)
    if (Array.isArray(data)) input = JSON.stringify({ groups: data })
  } catch { /* The shared reader also recognizes markdown reports. */ }
  const { data, reason } = readReport(input)
  if (!data) throw new Error(reason)
  const rows = []
  const byId = new Map()
  let missingIds = 0
  for (const entry of reportEntries(data)) {
    const ids = new Set()
    for (const finding of Array.isArray(entry) ? entry : [entry]) {
      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) continue
      if (typeof finding.id !== 'string' || !finding.id) { missingIds++; continue }
      ids.add(finding.id)
      if (!byId.has(finding.id)) byId.set(finding.id, [])
      byId.get(finding.id).push(finding)
    }
    rows.push([...ids].toSorted())
  }
  return { rows, byId, missingIds }
}

// JSON encodes the pair unambiguously even when an id contains a tab.
export function reportPairs(rows) {
  const pairs = new Set()
  for (const row of rows) {
    const ids = [...new Set(row)].toSorted()
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) pairs.add(JSON.stringify([ids[i], ids[j]]))
    }
  }
  return pairs
}

export function reportClusters(pairs) {
  const roots = new Map()
  const find = id => {
    let current = id
    while (roots.get(current) !== current) {
      roots.set(current, roots.get(roots.get(current)))
      current = roots.get(current)
    }
    return current
  }
  for (const pair of pairs) {
    const [a, b] = JSON.parse(pair)
    for (const id of [a, b]) if (!roots.has(id)) roots.set(id, id)
    roots.set(find(a), find(b))
  }
  const groups = new Map()
  for (const id of [...roots.keys()].toSorted()) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(id)
  }
  return [...groups.values()].toSorted((a, b) => a[0].localeCompare(b[0]))
}

// A report can carry the same id more than once with different ratings.
// Compare sets of values, preserving disagreements instead of arbitrarily
// choosing the first occurrence. Null is the explicit "not supplied" value.
export function reportValues(report, id, field) {
  const values = (report.byId.get(id) ?? []).map(finding => {
    if (field === 'verdict') return revalidateKindOf(finding) || null
    if (field === 'severity') return effectiveSeverity(finding) ?? null
    if (field === 'originalSeverity') return finding.severity ?? null
    if (field === 'confidence') return Number.isFinite(finding.confidence) ? finding.confidence : null
    return null
  })
  return [...new Set(values)].toSorted((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
}

const equal = (a, b) => a.length === b.length && a.every((value, i) => value === b[i])
const only = (a, b) => [...a].filter(id => !b.has(id)).toSorted()

export function computeReportDiff(before, after) {
  const oldIds = new Set(before.byId.keys())
  const newIds = new Set(after.byId.keys())
  const shared = [...oldIds].filter(id => newIds.has(id)).toSorted()
  const common = new Set(shared)
  const heldPairs = report => reportPairs(report.rows.map(row => row.filter(id => common.has(id))))
  const was = heldPairs(before)
  const now = heldPairs(after)
  const changes = { confirmed: [], refuted: [], otherVerdicts: [], confidence: [], severity: [] }
  for (const id of shared) {
    for (const field of ['verdict', 'confidence', 'severity']) {
      const from = reportValues(before, id, field)
      const to = reportValues(after, id, field)
      const change = { id, before: from, after: to }
      if (field === 'severity') {
        change.originalBefore = reportValues(before, id, 'originalSeverity')
        change.originalAfter = reportValues(after, id, 'originalSeverity')
      }
      if (equal(from, to) && (field !== 'severity' || equal(change.originalBefore, change.originalAfter))) continue
      if (field !== 'verdict') { changes[field].push(change); continue }
      // Confirmed and refuted destinations stay separate; all other outcomes
      // (including a removed stamp or conflicting copies) stay visible too.
      const bucket = to.length === 1 && to[0] === 'confirmed' ? 'confirmed'
        : to.length === 1 && to[0] === 'refuted' ? 'refuted' : 'otherVerdicts'
      changes[bucket].push(change)
    }
  }
  const joined = reportClusters(only(now, was))
  const split = reportClusters(only(was, now))
  const added = only(newIds, oldIds)
  const removed = only(oldIds, newIds)
  return { before, after, added, removed, shared, joined, split, ...changes,
    unchanged: added.length === 0 && removed.length === 0 && joined.length === 0 && split.length === 0
      && Object.values(changes).every(rows => rows.length === 0) }
}
