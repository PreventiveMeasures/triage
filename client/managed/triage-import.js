import { normalizeEntry } from '../triage-entry.ts'
import { MAX_FINDING_ID, MAX_TRIAGE_BODY_BYTES, MAX_TRIAGE_ENTRIES, parseTriageEntryPatch } from '../../common/managed/triage.ts'

// Discover server-owned IDs first, then intersect locally. Unknown finding IDs
// and their annotations never leave this browser; every write names a report.
export async function runLocalTriageImport(raw, { session, ...options }) {
  if (session?.role !== 'admin' || !session.csrfToken) throw new Error('An administrator session is required.')
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error('Invalid local triage.')
  const triage = Object.create(null)
  for (const [id, value] of Object.entries(raw ?? {})) {
    const { ignoredReports: _, ...entry } = normalizeEntry(value) ?? {}
    if (Object.keys(entry).length === 0) continue
    triage[id] = entry
  }
  if (Object.keys(triage).length === 0) return 0
  options.signal?.throwIfAborted()
  const { reports } = await options.api.send('/api/admin/reports/finding-ids')
  options.signal?.throwIfAborted()
  const matches = reports.map(report => ({ id: report.id, ids: report.findingIds.filter(id => Object.hasOwn(triage, id)) }))
  const matchedIds = new Set(matches.flatMap(report => report.ids))
  // Validate only matching entries, before making any writes. An oversized
  // annotation for an unrelated local report must not block the import.
  for (const id of matchedIds) {
    if (!id || id.length > MAX_FINDING_ID) throw new Error(`Triage finding IDs must be between 1 and ${MAX_FINDING_ID} characters.`)
    if (parseTriageEntryPatch(triage[id]) === 'invalid') throw new Error(`Triage for ${id} exceeds the managed server limits.`)
  }
  const importedIds = options.importedIds ?? new Set()
  for (const report of matches) {
    await importTriageEntries(triage, { ...options, importedIds, ids: report.ids,
      path: `/api/admin/reports/${encodeURIComponent(report.id)}/import-triage` })
  }
  return matchedIds.size
}

// Preserve fields omitted by the export. Disagreements only concern fields
// actually offered; imported comments are appended, never attributed or erased.
export function mergeImportTriage(incoming, snapshots) {
  const conflicts = [], entries = Object.create(null)
  for (const [id, offered] of Object.entries(incoming)) {
    const snapshot = snapshots[id]
    if (!snapshot) throw new Error('The server did not return the requested triage snapshot.')
    const current = snapshot.entry ?? {}
    const entry = entries[id] = { ...current }
    delete entry.comment
    for (const [property, value] of Object.entries(offered)) {
      if (property === 'comment') {
        if (snapshot.comments.some(comment => comment.body === value)) continue
        if (snapshot.comments.length > 0) conflicts.push({ id, property, local: snapshot.comments.map(c => c.body).join('\n\n'), imported: value })
        else entry.comment = value
      } else if (current[property] !== undefined && current[property] !== value) {
        const display = v => property === 'flagged' ? v ? 'flagged' : 'not flagged' : v
        conflicts.push({ id, property, local: display(current[property]), imported: display(value) })
      } else entry[property] = value
    }
  }
  return { entries, conflicts }
}

async function resolveImportBatch(incoming, snapshots, lookup, resolveConflicts, signal) {
  signal?.throwIfAborted()
  const { entries, conflicts } = mergeImportTriage(incoming, snapshots)
  if (conflicts.length === 0) return entries
  const decisions = await resolveConflicts(conflicts, lookup, {
    title: 'Triage conflicts on import', intro: 'disagree with stored triage on',
    trailingNote: 'Imported comments are added alongside existing comments. Other choices apply to these finding IDs across all teams.',
    importedSideLabel: 'Apply imported',
  })
  signal?.throwIfAborted()
  if (!decisions) throw new Error('Triage conflict resolution was cancelled.')
  for (const conflict of conflicts) {
    const decision = decisions[`${conflict.id}:${conflict.property}`]
    if (!['local', 'imported'].includes(decision)) throw new Error('Resolve every triage conflict before importing.')
    if (decision === 'imported') entries[conflict.id][conflict.property] = incoming[conflict.id][conflict.property]
  }
  return entries
}

function writeBatches(entries, snapshots) {
  const batches = []
  let body = { entries: {}, expected: {} }
  for (const [id, value] of Object.entries(entries)) {
    const next = { entries: { ...body.entries, [id]: value }, expected: { ...body.expected, [id]: snapshots[id].version } }
    if (new TextEncoder().encode(JSON.stringify(next)).length <= MAX_TRIAGE_BODY_BYTES) { body = next; continue }
    if (Object.keys(body.entries).length === 0) throw new Error('This triage entry is too large to import.')
    batches.push(body)
    body = { entries: { [id]: value }, expected: { [id]: snapshots[id].version } }
  }
  if (Object.keys(body.entries).length > 0) batches.push(body)
  return batches
}

export async function importTriageEntries(triage, { api, path, ids = Object.keys(triage), importedIds = new Set(), lookup = new Map(), resolveConflicts, signal }) {
  ids = ids.filter(id => Object.hasOwn(triage, id) && !importedIds.has(id))
  for (let start = 0; start < ids.length; start += MAX_TRIAGE_ENTRIES) {
    let pending = ids.slice(start, start + MAX_TRIAGE_ENTRIES)
    for (let attempt = 0; attempt < 5 && pending.length > 0; attempt++) {
      signal?.throwIfAborted()
      const { snapshots } = await api.send(path, { findingIds: pending })
      const incoming = Object.fromEntries(pending.map(id => [id, triage[id]]))
      const entries = await resolveImportBatch(incoming, snapshots, lookup, resolveConflicts, signal)
      for (const body of writeBatches(entries, snapshots)) {
        signal?.throwIfAborted()
        if ((await api.send(path, body)).conflict) break
        Object.keys(body.entries).forEach(id => importedIds.add(id))
      }
      pending = pending.filter(id => !importedIds.has(id))
    }
    if (pending.length > 0) throw new Error('Stored triage keeps changing. Retry to resolve it against the latest values.')
  }
}
