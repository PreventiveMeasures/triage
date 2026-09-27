import type { TriageRow } from './db.ts'
import { type TriageEntryPatch, isTriageBucket } from '../common/managed/triage.ts'

// A stored triage row (current state or a trail event) → its wire entry: only
// set fields present, `false` kept for flagged (the explicit un-flag tombstone
// must round-trip), and null for the row of a cleared entry (every field
// null) — the reader adopts the clear.
export function triageWireEntry(row: Pick<TriageRow, 'color' | 'triage' | 'comment' | 'fix' | 'flagged'>, legacyHistory = false): TriageEntryPatch | null {
  const e: TriageEntryPatch = {}
  if (row.color != null) e.color = row.color
  if (isTriageBucket(row.triage)) e.triage = row.triage
  if (legacyHistory && row.comment != null) e.comment = row.comment
  if (row.fix != null) e.fix = row.fix
  if (row.flagged != null) e.flagged = row.flagged
  return Object.keys(e).length > 0 ? e : null
}
