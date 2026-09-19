// Pure operations over the unified triage map — one
// `Map<findingId, TriageEntry>` consolidating markers, triage state,
// comments, fixes, and per-report ignores. Shared by the live
// `client/` writers (operating on `state.triage`) and the sync
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
import type { AppEntry, AppTriage, UpstreamEntry, UpstreamState } from './triage-tracks.ts'

export type TriageMap = Map<string, TriageEntry>

// A partial entry where any field may be explicitly `undefined` to
// clear it (plain `Partial<TriageEntry>` forbids that under
// exactOptionalPropertyTypes).
export type TriagePatch = { [K in keyof TriageEntry]?: TriageEntry[K] | undefined }
// The same "explicitly undefined clears it" shape for one app's slot.
export type AppPatch = { [K in keyof AppEntry]?: AppEntry[K] | undefined }

function asBucket(v: unknown): TriageBucket | undefined {
  return v === 'inprogress' || v === 'fixed' || v === 'invalid' || v === 'deleted' ? v : undefined
}

// The app track holds the WORK states only. 'invalid' and 'deleted'
// are claims about the finding itself — that it isn't a bug, that the
// record shouldn't be kept — and those are true of the code wherever
// it is shipped, so they stay on the entry as they always were. Only
// "we're on it" and "we dealt with it" are answers one app gives for
// itself.
function asAppTriage(v: unknown): AppTriage | undefined {
  return v === 'inprogress' || v === 'fixed' ? v : undefined
}

function asUpstreamState(v: unknown): UpstreamState | undefined {
  return v === 'reported' || v === 'fixed' || v === 'wontfix' ? v : undefined
}

function trimmedString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s.length > 0 ? s : undefined
}

// Sanitize the per-app map: known fields only, empty slots dropped,
// and every object rebuilt rather than reused — `normalizeEntry`'s
// callers (persist / export / sync apply) must not end up aliasing
// live state through a nested object the way a shallow copy would.
function normalizeApps(src: unknown): { [appKey: string]: AppEntry } | undefined {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return undefined
  // `Object.create(null)`, not `{}`, for the reason `applyChangeset`
  // uses it (audit round-12 H6): the keys are app names off a peer's
  // changeset or a persisted blob, and `out['__proto__'] = slot` on a
  // normal object literal runs Object.prototype's setter and repoints
  // this map's prototype at the slot instead of storing it. Null-proto
  // has no such setter; the key becomes an inert own property.
  const out: { [appKey: string]: AppEntry } = Object.create(null)
  let any = false
  for (const [app, value] of Object.entries(src as Record<string, unknown>)) {
    if (!app || !value || typeof value !== 'object') continue
    const v = value as { triage?: unknown, fix?: unknown }
    const slot: AppEntry = {}
    const triage = asAppTriage(v.triage)
    if (triage) slot.triage = triage
    const fix = trimmedString(v.fix)
    if (fix) slot.fix = fix
    if (!slot.triage && !slot.fix) continue
    out[app] = slot
    any = true
  }
  return any ? out : undefined
}

function normalizeUpstream(src: unknown): UpstreamEntry | undefined {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return undefined
  const v = src as { state?: unknown, link?: unknown, since?: unknown }
  const out: UpstreamEntry = {}
  const st = asUpstreamState(v.state)
  if (st) out.state = st
  const link = trimmedString(v.link)
  if (link) out.link = link
  const since = trimmedString(v.since)
  if (since) out.since = since
  // A bare link or version with no state is still a fact worth
  // keeping — someone pasted the upstream issue before deciding what
  // it meant — so the state isn't required for the entry to survive.
  return out.state || out.link || out.since ? out : undefined
}

// The entry's OWN triage bucket — the verdict that isn't scoped to an
// app — honoring the legacy `deleted: true` form older peers /
// persisted blobs may still carry. What one app sees is
// `bucketForApp` below; this is what it falls back to.
export function bucketOf(entry: TriageEntry | undefined): TriageBucket | undefined {
  if (!entry) return undefined
  return asBucket(entry.triage) ?? (entry.deleted ? 'deleted' : undefined)
}

export function entryIsEmpty(entry: TriageEntry | undefined): boolean {
  if (!entry) return true
  return !entry.color && !bucketOf(entry) && !entry.comment && !entry.fix
    && !(entry.ignoredReports && entry.ignoredReports.length > 0)
    && !(entry.apps && Object.keys(entry.apps).length > 0)
    && !(entry.upstream && (entry.upstream.state || entry.upstream.link || entry.upstream.since))
    && entry.flagged === undefined
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
    fix?: unknown, flagged?: unknown, ignoredReports?: unknown, deleted?: unknown,
    apps?: unknown, upstream?: unknown,
  }
  const out: TriageEntry = {}
  if (typeof e.color === 'string' && e.color) out.color = e.color
  const bucket = asBucket(e.triage) ?? (e.deleted ? 'deleted' : undefined)
  if (bucket) out.triage = bucket
  if (typeof e.comment === 'string' && e.comment) out.comment = e.comment
  if (typeof e.fix === 'string' && e.fix) out.fix = e.fix
  // Tri-state: keep BOTH `true` and `false` (false is a meaningful
  // "explicitly unflagged" tombstone); anything else is "unset".
  if (typeof e.flagged === 'boolean') out.flagged = e.flagged
  if (Array.isArray(e.ignoredReports)) {
    const reports = e.ignoredReports.filter((r): r is string => typeof r === 'string' && r.length > 0)
    if (reports.length > 0) out.ignoredReports = reports
  }
  const apps = normalizeApps(e.apps)
  if (apps) out.apps = apps
  const upstream = normalizeUpstream(e.upstream)
  if (upstream) out.upstream = upstream
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

// Per-app and upstream comparison, exported because the sync layer
// (client/sync/triage-changeset.ts) has to ask the same question of
// the same shapes. Two equality functions that disagree about a
// nested field would let a peer's edit read as "no change" and be
// dropped, so both sides call these rather than mirroring them.
export function appsEqual(
  a: { [appKey: string]: AppEntry } | undefined,
  b: { [appKey: string]: AppEntry } | undefined,
): boolean {
  const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {})
  if (ka.length !== kb.length) return false
  for (const app of ka) {
    const ea = a?.[app], eb = b?.[app]
    if (!eb) return false
    if ((ea?.triage ?? '') !== (eb.triage ?? '')) return false
    if ((ea?.fix ?? '') !== (eb.fix ?? '')) return false
  }
  return true
}

export function upstreamEqual(a: UpstreamEntry | undefined, b: UpstreamEntry | undefined): boolean {
  const ea = a ?? {}, eb = b ?? {}
  return (ea.state ?? '') === (eb.state ?? '')
    && (ea.link ?? '') === (eb.link ?? '')
    && (ea.since ?? '') === (eb.since ?? '')
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
    && ea.flagged === eb.flagged
    && ignoredEqual(ea.ignoredReports, eb.ignoredReports)
    && appsEqual(ea.apps, eb.apps)
    && upstreamEqual(ea.upstream, eb.upstream)
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

// ── the app track ──────────────────────────────────────────────────
//
// Entry-taking readers (not map-taking) because the render path has
// already read the entry by the time it asks — `tabTriage` resolves
// one entry per tab and hands it down, and a second `map.get` per tab
// would double the observable reads the reactivity layer tracks.

export function appTriageOf(entry: TriageEntry | undefined, app: string): AppTriage | undefined {
  return app ? entry?.apps?.[app]?.triage : undefined
}

export function appFixOf(entry: TriageEntry | undefined, app: string): string | undefined {
  return app ? entry?.apps?.[app]?.fix : undefined
}

// Every app whose slot carries `triage`, in key order. What the
// cross-app pages ask (Packages / Repositories / the bundle's Issues
// list): they aggregate over apps and so have no "own app" to leave
// out the way a finding card does.
export function appsWith(entry: TriageEntry | undefined, triage: AppTriage): string[] {
  const apps = entry?.apps
  if (!apps) return []
  return Object.keys(apps).filter((app) => apps[app]?.triage === triage)
}

// The bucket ONE app sees. 'invalid' and 'deleted' answer for every
// app — they say the finding isn't a bug or isn't worth keeping, which
// no single app's work changes — so they win outright. Below them the
// app's own answer wins over the entry's unscoped `triage`: a value
// written before the split (or by a peer that doesn't know about it)
// keeps showing until this app says something of its own, which is
// what makes the migration a no-op for existing blobs.
export function bucketForApp(entry: TriageEntry | undefined, app: string): TriageBucket | undefined {
  return bucketForApps(entry, app ? [app] : [])
}

// The same question asked of a card that stands for SEVERAL apps —
// what a workspace shows after deduplicating one dependency finding
// across two apps' reports (see `recordAppKey` in ui/view/ingest.js).
// It shows a bucket only where every app it speaks for agrees: one app
// fixed and another still open is not a fixed card, and collapsing
// that to "fixed" is the conflation this split exists to undo. The
// disagreement surfaces instead as the card's own per-app line.
//
// No apps (the app's own code, or a report with no identity to key on)
// falls through to the entry's unscoped verdict, which is what such a
// finding has always been answered by.
export function bucketForApps(entry: TriageEntry | undefined, apps: string[]): TriageBucket | undefined {
  const cause = bucketOf(entry)
  if (cause === 'invalid' || cause === 'deleted') return cause
  if (apps.length === 0) return cause
  let common: TriageBucket | undefined
  for (const [i, app] of apps.entries()) {
    const bucket = appTriageOf(entry, app) ?? cause
    if (i > 0 && bucket !== common) return undefined
    common = bucket
  }
  return common
}

// Write one app's slot. `triage: undefined` clears the state but keeps
// that app's fix link (dragging a card out of Fixed doesn't retract
// the PR that was linked from it); a slot with neither is dropped by
// `normalizeApps`, and an entry whose last slot goes with it is
// deleted by `patchEntry`.
export function setAppTriage(map: TriageMap, id: string, app: string, triage: AppTriage | undefined): boolean {
  return patchAppSlot(map, id, app, { triage })
}

export function setAppFix(map: TriageMap, id: string, app: string, fix: string | undefined): boolean {
  return patchAppSlot(map, id, app, { fix })
}

// `patchEntry` merges shallowly, so the whole `apps` object has to be
// rebuilt here — the same reason `setReportIgnored` rebuilds the whole
// array rather than pushing onto the live one.
function patchAppSlot(map: TriageMap, id: string, app: string, patch: AppPatch): boolean {
  if (!app) return false
  const cur = map.get(id)?.apps
  const slot: AppPatch = { ...cur?.[app], ...patch }
  // Null-prototype for the same reason `normalizeApps` builds one: an
  // app key of `__proto__` (a report file can be named anything) must
  // land as an own property, not as a prototype assignment.
  const apps: { [appKey: string]: AppEntry } = Object.assign(Object.create(null), cur)
  // The cast covers the cleared fields the spread leaves as explicit
  // `undefined`; `normalizeApps` (through `patchEntry`) drops them
  // before anything lands in the map, so the stored shape is strict.
  apps[app] = slot as AppEntry
  return patchEntry(map, id, { apps })
}

// Drop one app's slot from every entry — the app-track half of
// `clearReportEverywhere`, for a report leaving the workspace.
export function clearAppEverywhere(map: TriageMap, app: string): void {
  if (!app) return
  for (const [id, entry] of [...map]) {
    if (!entry.apps?.[app]) continue
    const apps = { ...entry.apps }
    delete apps[app]
    patchEntry(map, id, { apps: Object.keys(apps).length > 0 ? apps : undefined })
  }
}

// ── the cause track ────────────────────────────────────────────────

export function upstreamOf(entry: TriageEntry | undefined): UpstreamEntry | undefined {
  return entry?.upstream
}

// The cause track as one sentence — "fixed in 4.17.21 https://…".
// Every path that has to compare two upstream records, or show one
// where only a string fits (the sync conflict dialog, the workspace
// import's conflict list), reads it through here so they agree on
// what "the same upstream status" means.
export function upstreamText(entry: TriageEntry | null | undefined): string {
  const up = entry?.upstream
  if (!up) return ''
  return [up.state ?? '', up.since ? `in ${up.since}` : '', up.link ?? ''].filter(Boolean).join(' ')
}

// Replace (not merge) the upstream record: the editor hands over the
// whole thing, and a merge would make "clear the version" impossible
// to express. `undefined` retracts it.
export function setUpstream(map: TriageMap, id: string, upstream: UpstreamEntry | undefined): boolean {
  return patchEntry(map, id, { upstream: normalizeUpstream(upstream) })
}
