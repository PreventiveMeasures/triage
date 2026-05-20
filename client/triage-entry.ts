// Pure operations over the unified triage map — one
// `Map<findingId, TriageEntry>` that replaces the former parallel
// `state.markers` / `state.triageState` / `state.comments` /
// `state.fixes` Maps plus the `state.ignoredIds` Set. Shared by the
// live `client/` writers (operating on `state.triage`) and the sync
// projection (operating on `syncHost().state.triage`), so these take
// the map explicitly and hold no module state — safe to unit-test in
// isolation and free of any host coupling.
//
// REACTIVITY CONTRACT. `state` is an observer-util proxy that re-fires
// a render reaction when the value at a tracked `map.get(id)` changes,
// tracked at the (map, key) level. Every write here therefore goes
// through `Map.set` / `Map.delete` on the id key, replacing the WHOLE
// entry (immutable replace) — never an in-place `entry.color = …`,
// which would mutate a possibly-unproxied raw object and skip the
// re-render. The replace is also gated on a value change (see
// `entriesEqual`) so a no-op patch doesn't churn the proxy and
// re-render every reader of that id for nothing. Entries that lose
// their last field are deleted, keeping the map free of empty shells
// so iteration / persistence / GC only ever see meaningful ids.

import type { TriageBucket, TriageEntry } from './state.ts'

export type TriageMap = Map<string, TriageEntry>

// A partial entry where any field may be explicitly `undefined` to
// clear it (plain `Partial<TriageEntry>` forbids that under
// exactOptionalPropertyTypes).
export type TriagePatch = { [K in keyof TriageEntry]?: TriageEntry[K] | undefined }

function asBucket(v: unknown): TriageBucket | undefined {
  return v === 'fixed' || v === 'invalid' || v === 'deleted' ? v : undefined
}

// The effective triage bucket, honoring the legacy `deleted: true`
// form older peers / persisted blobs may still carry.
export function bucketOf(entry: TriageEntry | undefined): TriageBucket | undefined {
  if (!entry) return undefined
  return asBucket(entry.triage) ?? (entry.deleted ? 'deleted' : undefined)
}

export function entryIsEmpty(entry: TriageEntry | undefined): boolean {
  if (!entry) return true
  return !entry.color && !bucketOf(entry) && !entry.comment && !entry.fix
    && !(entry.ignoredReports && entry.ignoredReports.length > 0)
}

export function isReportIgnored(map: TriageMap, id: string, report: string): boolean {
  const list = map.get(id)?.ignoredReports
  return Array.isArray(list) && list.includes(report)
}

// Report names in which `id` is per-report ignored, as a fresh array
// (callers — snapshot / persist — must not alias the live entry).
export function ignoredReportsFor(map: TriageMap, id: string): string[] {
  const list = map.get(id)?.ignoredReports
  return Array.isArray(list) ? list.slice() : []
}

// Sanitize an arbitrary (possibly wire / legacy) entry into the clean
// in-memory shape: migrate `deleted` → `triage: 'deleted'`, coerce an
// invalid `triage` to absent, drop empty fields. Returns `undefined`
// when nothing meaningful remains. Does NOT enforce the triage⊻ignore
// mutex — that is action-specific (the UI clears only the current
// report's ignore; the sync apply drops all), so callers apply it.
export function normalizeEntry(src: unknown): TriageEntry | undefined {
  if (!src || typeof src !== 'object') return undefined
  const e = src as {
    color?: unknown, triage?: unknown, comment?: unknown,
    fix?: unknown, ignoredReports?: unknown, deleted?: unknown,
  }
  const out: TriageEntry = {}
  if (typeof e.color === 'string' && e.color) out.color = e.color
  const bucket = asBucket(e.triage) ?? (e.deleted ? 'deleted' : undefined)
  if (bucket) out.triage = bucket
  if (typeof e.comment === 'string' && e.comment) out.comment = e.comment
  if (typeof e.fix === 'string' && e.fix) out.fix = e.fix
  if (Array.isArray(e.ignoredReports)) {
    const reports = e.ignoredReports.filter((r): r is string => typeof r === 'string' && r.length > 0)
    if (reports.length > 0) out.ignoredReports = reports
  }
  return entryIsEmpty(out) ? undefined : out
}

function ignoredEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const la = a ?? [], lb = b ?? []
  if (la.length !== lb.length) return false
  if (la.length === 0) return true
  const seen = new Set(la)
  for (const r of lb) if (!seen.has(r)) return false
  return true
}

// Per-property equality used to suppress no-op replacements. Mirrors
// `triage-changeset.ts`'s `entriesEqual` (set-equal ignoredReports,
// legacy `deleted` folded into the bucket).
function entriesEqual(a: TriageEntry | undefined, b: TriageEntry | undefined): boolean {
  const ea = a ?? {}, eb = b ?? {}
  return (ea.color ?? '') === (eb.color ?? '')
    && (bucketOf(ea) ?? '') === (bucketOf(eb) ?? '')
    && (ea.comment ?? '') === (eb.comment ?? '')
    && (ea.fix ?? '') === (eb.fix ?? '')
    && ignoredEqual(ea.ignoredReports, eb.ignoredReports)
}

// Merge `patch` over id's current entry, normalize, and write back —
// deleting the id when the result is empty. Returns whether the map
// actually changed.
export function patchEntry(map: TriageMap, id: string, patch: TriagePatch): boolean {
  const cur = map.get(id)
  const merged = normalizeEntry({ ...cur, ...patch })
  if (merged === undefined) return map.delete(id)
  if (entriesEqual(cur, merged)) return false
  map.set(id, merged)
  return true
}

// Replace id's entry wholesale (sync apply path) after normalization,
// or delete the id when the entry is empty. Returns whether the map
// changed.
export function setEntry(map: TriageMap, id: string, entry: unknown): boolean {
  const next = normalizeEntry(entry)
  const cur = map.get(id)
  if (next === undefined) return map.delete(id)
  if (entriesEqual(cur, next)) return false
  map.set(id, next)
  return true
}

// Add / remove a single report from id's ignoredReports.
export function setReportIgnored(map: TriageMap, id: string, report: string, ignored: boolean): boolean {
  const set = new Set(map.get(id)?.ignoredReports ?? [])
  if (ignored) set.add(report)
  else set.delete(report)
  return patchEntry(map, id, { ignoredReports: set.size > 0 ? [...set] : undefined })
}

// Drop one report name from every entry's ignoredReports (report
// deletion / un-assignment). Snapshots the keys first since the loop
// mutates the map.
export function clearReportEverywhere(map: TriageMap, report: string): void {
  for (const [id, entry] of [...map]) {
    if (entry.ignoredReports?.includes(report)) setReportIgnored(map, id, report, false)
  }
}
