// Per-finding triage annotations on a managed team report — shared by the
// managed server (which stores one row per (report, finding) and validates the
// wire shape) and the managed client (which mirrors entries into its local
// triage map). A wire entry carries the five server-persisted fields below;
// the client's `ignoredReports` deliberately does NOT ride this wire — the
// per-report ignore is a client-local, multi-report concept keyed by report
// name, meaningless to a single server-stored report.
export type TriageBucket = 'inprogress' | 'fixed' | 'invalid' | 'deleted'

export const TRIAGE_BUCKETS: readonly TriageBucket[] = ['inprogress', 'fixed', 'invalid', 'deleted']

// One finding's server-side triage entry (also the write shape — writes
// replace the whole entry). Absent fields are unset; `flagged` is tri-state:
// absent = never set, `true` = flagged, `false` = an explicit un-flag
// tombstone that must round-trip (see client/state.ts TriageEntry).
export type TriageEntryPatch = {
  color?: string
  triage?: TriageBucket
  comment?: string
  fix?: string
  flagged?: boolean
}

// Length caps enforced at the write endpoint so one entry can't balloon a row.
export const MAX_TRIAGE_TEXT = 10_000
export const MAX_TRIAGE_COLOR = 50

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
