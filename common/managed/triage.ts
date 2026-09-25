// Per-finding triage annotations on a managed server — shared by the server
// (which stores one row per finding id, validates the wire shape, and decides
// per report which ids a viewer may read or write) and the managed client
// (which mirrors entries into its local triage map). Keyed by finding id
// alone, like that map: reports mostly repeat one another (a re-scan of the
// same code carries the same finding ids), and a finding's triage is shared by
// every report that carries it. A wire entry carries the four server-persisted
// fields below, or is null for a cleared entry (the server's tombstone); the
// client's `ignoredReports` deliberately does NOT ride this wire — the
// per-report ignore is a client-local concept keyed by report name.
export type TriageBucket = 'inprogress' | 'fixed' | 'invalid' | 'deleted'

export const TRIAGE_BUCKETS: readonly TriageBucket[] = ['inprogress', 'fixed', 'invalid', 'deleted']

// One finding's server-side triage entry (also the write shape — writes
// replace the whole entry). Absent fields are unset; `flagged` is tri-state:
// absent = never set, `true` = flagged, `false` = an explicit un-flag
// tombstone that must round-trip (see client/state.ts TriageEntry).
export type TriageEntryPatch = {
  color?: string
  triage?: TriageBucket
  // Legacy triage history/migration only. New comments use separate records;
  // the managed triage write endpoint rejects this field.
  comment?: string
  fix?: string
  flagged?: boolean
}

// Length caps enforced at the write endpoint so one entry can't balloon a row.
export const MAX_TRIAGE_TEXT = 10_000
export const MAX_TRIAGE_COLOR = 50

// Caps on one write request as a whole — shared with the client, which batches
// within them: entries per request, the finding-id length (real ids are 36-char
// uuids), and the JSON body (the server's small default is too small for entry
// batches, which carry free text).
export const MAX_TRIAGE_ENTRIES = 200
export const MAX_FINDING_ID = 100
export const MAX_TRIAGE_BODY_BYTES = 262_144

// The most trail events one history read returns (newest first). Retention is
// the server's: everything is kept unless its TRIAGE_HISTORY_LIMIT says
// otherwise.
export const MAX_TRIAGE_HISTORY = 200

export function isTriageBucket(x: unknown): x is TriageBucket {
  return typeof x === 'string' && (TRIAGE_BUCKETS as readonly string[]).includes(x)
}

// Coerce one wire entry (a request-body value) into a clean patch. `null`
// means "clear the entry"; a malformed value (wrong type, unknown bucket,
// over-cap string, non-boolean flagged) is 'invalid' so the endpoint 400s
// rather than store garbage. Null/empty-string fields count as absent (an
// absent field is cleared anyway under whole-entry replace); unknown keys are
// ignored.
export function parseTriageEntryPatch(x: unknown): TriageEntryPatch | null | 'invalid' {
  if (x === null) return null
  if (typeof x !== 'object' || Array.isArray(x)) return 'invalid'
  const o = x as Record<string, unknown>
  const out: TriageEntryPatch = {}
  const color = o['color']
  if (color != null) {
    if (typeof color !== 'string' || color.length > MAX_TRIAGE_COLOR) return 'invalid'
    if (color !== '') out.color = color
  }
  const triage = o['triage']
  if (triage != null) {
    if (!isTriageBucket(triage)) return 'invalid'
    out.triage = triage
  }
  for (const key of ['comment', 'fix'] as const) {
    const v = o[key]
    if (v == null) continue
    if (typeof v !== 'string' || v.length > MAX_TRIAGE_TEXT) return 'invalid'
    if (v !== '') out[key] = v
  }
  const flagged = o['flagged']
  if (flagged != null) {
    if (typeof flagged !== 'boolean') return 'invalid'
    out.flagged = flagged
  }
  return out
}
