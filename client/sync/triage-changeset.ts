// Pure triage-changeset algebra, split out of triage-sync.ts. Holds the
// triage data model (a per-finding entry, the id→entry state map, and
// the changeset / conflict shapes) plus the side-effect-free operations
// over them: diff, apply, equality, and the three-way conflict scan. No
// module state, no `state.*`, no I/O — safe to unit-test in isolation.

import { appsEqual, normalizeEntry, upstreamEqual, upstreamText } from '../triage-entry.ts'
import type { AppEntry, UpstreamEntry } from '../triage-tracks.ts'
import type { TriageEntry } from './host.ts'

export type ConflictProperty = 'color' | 'triage' | 'comment' | 'fix' | 'flagged' | 'upstream'

export type Conflict = {
  id: string
  property: ConflictProperty
  local: string
  imported: string
  // The imported side of an `upstream` conflict as the record it
  // actually is. `local` / `imported` are the sentences the dialog
  // shows, and "fixed in 4.17.21 https://…" can't be parsed back into
  // its three fields — so the applier reads this instead of trying.
  importedUpstream?: UpstreamEntry
}

// `TriageEntry` (the per-finding-id triage value carried on the wire
// and in baseState) is defined in `../state.ts` — the same shape
// `state.triage` stores live — and re-exported through `host.ts`.
export { upstreamText }

export type TriageStateMap = { [id: string]: TriageEntry | undefined }
export type Changeset = { [id: string]: TriageEntry | null | undefined }

// Per-property normalisers — collapse "no value" of any shape (missing
// entry, empty string, legacy `deleted: true` for triage) to '' so the
// three-way conflict compare (oldBase / local / chain) doesn't report
// `'red'` vs `undefined` as a conflict when one side just doesn't carry
// the property.
function normColor(entry: TriageEntry | null | undefined): string {
  return typeof entry?.color === 'string' ? entry.color : ''
}
function normTriage(entry: TriageEntry | null | undefined): string {
  if (entry?.triage === 'inprogress' || entry?.triage === 'fixed' || entry?.triage === 'invalid' || entry?.triage === 'deleted') return entry.triage
  if (entry?.deleted) return 'deleted'
  return ''
}
function normComment(entry: TriageEntry | null | undefined): string {
  return typeof entry?.comment === 'string' ? entry.comment : ''
}
function normFix(entry: TriageEntry | null | undefined): string {
  return typeof entry?.fix === 'string' ? entry.fix : ''
}
// Tri-state flag → a stable conflict string. `false` ("explicitly
// unflagged") maps to a NON-empty token so it reads as a real value
// the three-way compare can disagree with a stale `true` over —
// `''` is reserved for the absent/"unset" side only.
function normFlagged(entry: TriageEntry | null | undefined): string {
  return entry?.flagged === true ? 'flagged' : entry?.flagged === false ? 'not flagged' : ''
}
// The cause track, flattened to the sentence the conflict dialog shows
// — it is one statement about the dependency ("fixed upstream in
// 4.17.21"), and two peers who recorded different versions have
// disagreed about that one statement, not about three fields.

// `apps` is deliberately NOT a conflict property. Each key is one
// app's own answer, so two peers editing DIFFERENT apps aren't
// disagreeing about anything — and two peers editing the same app's
// slot resolve the way the entry does, last write wins, which is what
// the per-report `ignoredReports` field has always done.

// Per-property comparison between the user's pre-rebase overlay
// (= unsynced state.* edits captured before the chain landed) and the
// chain's new baseState. Surfaced to the resolver so neither side
// silently flips: a peer's chained change doesn't overwrite the user,
// and (symmetrically) the joining client's local-wins overlay doesn't
// overwrite an already-agreed chain value. Mirrors the per-property
// semantics `hydrateStateFromBaseState` uses on the report-attach path.
//
// Three-way compare against `oldBaseState` so an "unset" intent
// (overlay = null OR its entry omits a property the user previously
// had) conflicts with a chain that re-assigned that property — and vice
// versa. Both silent-loss directions need it: e.g. we disconnect, peer
// sets color, we unset, reconnect → overlay `{X: null}`, chain `{X:
// {color: blue}}`; a two-way (overlay vs chain) sees no disagreement,
// applyChangeset replays the delete, peer's blue is lost (symmetrically
// the user's set overwrites a peer's delete). The three-way says "both
// sides changed FROM oldBase and disagree → conflict". `local` /
// `imported` are '' for the unset side; the dialog renders `<em>none</em>`.
export function collectChainConflicts(
  overlay: Changeset,
  oldBaseState: TriageStateMap,
  newBaseState: TriageStateMap,
  preserveKnownIds?: ReadonlySet<string>,
): Conflict[] {
  const conflicts: Conflict[] = []
  // Only check ids the user touched (= ids in overlay). Chain-only
  // changes are gap-fills handled by `applyChangeset(newBaseState,
  // overlay)` — ids missing from the overlay get the chain's value.
  for (const id of Object.keys(overlay)) {
    const overlayValue = overlay[id]
    const oldEntry = oldBaseState[id]
    const chainEntry = newBaseState[id]
    // `overlay[id] === null` is the explicit "user deleted" signal;
    // the effective local entry is then null (every property reads
    // as ''). Otherwise the overlay's entry IS the user's view.
    const localEntry = overlayValue ?? null

    const props = [
      { name: 'color' as const, norm: normColor },
      { name: 'triage' as const, norm: normTriage },
      { name: 'comment' as const, norm: normComment },
      { name: 'fix' as const, norm: normFix },
      { name: 'flagged' as const, norm: normFlagged },
      { name: 'upstream' as const, norm: upstreamText },
    ]
    for (const { name, norm } of props) {
      const oldVal = norm(oldEntry)
      const localVal = norm(localEntry)
      const chainVal = norm(chainEntry)
      const localChanged = localVal !== oldVal || preserveKnownIds?.has(id)
      const chainChanged = chainVal !== oldVal
      if (localChanged && chainChanged && localVal !== chainVal) {
        const conflict: Conflict = { id, property: name, local: localVal, imported: chainVal }
        if (name === 'upstream' && chainEntry?.upstream) conflict.importedUpstream = chainEntry.upstream
        conflicts.push(conflict)
      }
    }
  }
  return conflicts
}

// Set-equal comparison for `ignoredReports`: an unordered collection of
// report names. A peer's snapshot iterates state.ignoredIds in insertion
// order, an applied chain may order them differently, so a positional
// compare would falsely report changes and produce empty-but-nonzero
// changesets.
function ignoredReportsEqual(a: unknown, b: unknown): boolean {
  const la: string[] = Array.isArray(a) ? a : []
  const lb: string[] = Array.isArray(b) ? b : []
  if (la.length !== lb.length) return false
  if (la.length === 0) return true
  const seen = new Set(la)
  for (const r of lb) if (!seen.has(r)) return false
  return true
}

function entriesEqual(a: TriageEntry, b: TriageEntry): boolean {
  // `triage` is the current shape (`'inprogress' | 'fixed' | 'invalid' | 'deleted'` or
  // absent). Legacy `deleted: true` from older peers / stored chains
  // compares as 'deleted' — the receive-side migrates on apply, but a
  // local state still carrying the legacy boolean shouldn't false-equal
  // a remote entry that already moved to the new field.
  const triageA = a.triage ?? (a.deleted ? 'deleted' : '')
  const triageB = b.triage ?? (b.deleted ? 'deleted' : '')
  return a.color === b.color
    && triageA === triageB
    && (a.comment ?? '') === (b.comment ?? '')
    && (a.fix ?? '') === (b.fix ?? '')
    && a.flagged === b.flagged
    && ignoredReportsEqual(a.ignoredReports, b.ignoredReports)
    // Shared with `client/triage-entry.ts` rather than mirrored: an
    // equality here that disagreed with the one the live map uses
    // would let a peer's edit read as "no change" and be dropped.
    && appsEqual(a.apps, b.apps)
    && upstreamEqual(a.upstream, b.upstream)
}

export function statesEqual(a: TriageStateMap, b: TriageStateMap): boolean {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const id of ids) {
    if (!entriesEqual(a[id] ?? {}, b[id] ?? {})) return false
  }
  return true
}

function rebaseIgnoredReports(base: string[] = [], local: string[] = [], remote: string[] = []): string[] {
  const before = new Set(base)
  const current = new Set(local)
  const merged = new Set(remote)
  for (const report of before) if (!current.has(report)) merged.delete(report)
  for (const report of current) if (!before.has(report)) merged.add(report)
  return [...merged]
}

function slotsEqual(a: AppEntry | undefined, b: AppEntry | undefined): boolean {
  return (a?.triage ?? '') === (b?.triage ?? '') && (a?.fix ?? '') === (b?.fix ?? '')
}

// The app track rebases per KEY, not as one value, because its keys are
// separate apps' separate answers. Replaying the local entry whole would
// delete a chain entry's app A while carrying this client's edit to app
// B — work a peer did, that this client never had a view on, silently
// gone and then propagated as a deletion on the retry.
//
// So: three-way per key against the base. A key this client changed
// keeps its value (local-wins, as every other field does here), a key it
// didn't takes the chain's — including one the chain added that this
// client never saw — and a key it cleared stays cleared.
//
// `preserve` holds the local map whole instead, absences included: an
// anchor reset leaves the snapshot unable to prove it is newer than what
// we know, so a key we don't have reads as our own clear rather than
// news we missed — the rule triage-sync.ts states for every other field
// ("known values or absences").
function rebaseApps(
  base: { [appKey: string]: AppEntry } | undefined,
  local: { [appKey: string]: AppEntry } | undefined,
  remote: { [appKey: string]: AppEntry } | undefined,
  preserve: boolean,
): { [appKey: string]: AppEntry } | undefined {
  if (!local && !remote) return undefined
  // Null-prototype for the reason `normalizeApps` uses one: the keys are
  // app names off a peer's changeset.
  const out: { [appKey: string]: AppEntry } = Object.create(null)
  for (const app of new Set([...Object.keys(local ?? {}), ...Object.keys(remote ?? {})])) {
    const mine = local?.[app]
    const keepMine = preserve || !slotsEqual(mine, base?.[app])
    const slot = keepMine ? mine : remote?.[app]
    if (slot) out[app] = slot
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// Replay only fields the local user changed. Wire changesets replace whole
// entries, but using that replacement as a local overlay erases independent
// peer edits to other fields of the same finding.
// After an anchor reset, a valid signature alone cannot prove a snapshot
// is newer than the state we already knew. Keep known values as local
// intent until conflicts are explicitly resolved; also retain local clears.
export function rebaseLocalState(base: TriageStateMap, local: TriageStateMap, remote: TriageStateMap, preserveKnownIds?: ReadonlySet<string>): TriageStateMap {
  const out: TriageStateMap = Object.assign(Object.create(null), remote)
  for (const id of new Set([...Object.keys(base), ...Object.keys(local), ...(preserveKnownIds ?? [])])) {
    const preserveEntry = preserveKnownIds?.has(id) ?? false
    const before = normalizeEntry(base[id]) ?? {}
    const current = normalizeEntry(local[id]) ?? {}
    const merged = { ...normalizeEntry(remote[id]) }
    for (const field of ['color', 'comment', 'fix', 'flagged'] as const) {
      if (before[field] !== current[field] || preserveEntry) {
        // Assign through a patch so TS retains each field's value type.
        Object.assign(merged, { [field]: current[field] })
      }
    }
    // Triage and ignoredReports are mutually exclusive. A conflicting
    // bucket/ignore choice keeps the local choice, but when both sides
    // remain untriaged, merge ignores per report so independent additions
    // and removals survive.
    if (preserveEntry || before.triage !== current.triage || !ignoredReportsEqual(before.ignoredReports, current.ignoredReports)) {
      const reports = !preserveEntry && current.triage === undefined && merged.triage === undefined
        ? rebaseIgnoredReports(before.ignoredReports, current.ignoredReports, merged.ignoredReports)
        : current.ignoredReports ?? []
      if (current.triage === undefined) delete merged.triage
      else merged.triage = current.triage
      if (reports.length === 0) delete merged.ignoredReports
      else merged.ignoredReports = reports
    }
    // The two triage tracks the entry-level fields above don't cover.
    // `apps` merges per key (see `rebaseApps`); `upstream` is one record
    // about the code itself, so it replays whole, like a scalar.
    const apps = rebaseApps(before.apps, current.apps, merged.apps, preserveEntry)
    if (apps) merged.apps = apps
    else delete merged.apps
    if (preserveEntry || !upstreamEqual(before.upstream, current.upstream)) {
      if (current.upstream === undefined) delete merged.upstream
      else merged.upstream = current.upstream
    }
    const entry = normalizeEntry(merged)
    if (entry) out[id] = entry
    else delete out[id]
  }
  return out
}

// Walk a state through a changeset, producing a new state. `null` in
// the changeset deletes the id. Exported for unit-test access (round-12
// H6 prototype-pollution regression). Pure — no module state/side effects.
export function applyChangeset(baseState: TriageStateMap, changeset: Changeset): TriageStateMap {
  // `Object.create(null)`, not `{}`, so a peer-controlled changeset
  // can't pollute the prototype chain. JSON.parse turns `{"__proto__":
  // …}` into an OWN property; `out['__proto__'] = entry` on a normal
  // `{}` triggers Object.prototype's `__proto__` setter and mutates
  // out's prototype to the attacker entry — every later `baseState[id]`
  // lookup (hydrateStateFromBaseState, statesEqual, …) then walks the
  // polluted chain and returns attacker-controlled triage. Null-prototype
  // out has no setter; the key becomes an inert own property. Audit
  // round-12 H6.
  const out: TriageStateMap = Object.assign(Object.create(null), baseState)
  for (const [id, entry] of Object.entries(changeset)) {
    if (entry === null) delete out[id]
    else if (entry !== undefined) out[id] = entry
  }
  return out
}

// Compute the changeset that turns `base` into `target`. Mirrors
// `applyChangeset` — `null` entries clear, present entries overwrite.
export function computeChangeset(base: TriageStateMap, target: TriageStateMap): Changeset {
  // `Object.create(null)` mirrors `applyChangeset` / `effectiveLocalState`.
  // Otherwise `changeset['__proto__'] = entry` (when `__proto__` shows up
  // in base/target keys) triggers the Object.prototype setter and
  // pollutes the outbound payload's prototype chain. Audit round-12 H6.
  const changeset: Changeset = Object.create(null)
  const ids = new Set([...Object.keys(base), ...Object.keys(target)])
  for (const id of ids) {
    const b = base[id] ?? {}
    const t = target[id] ?? {}
    if (!entriesEqual(b, t)) changeset[id] = target[id] ?? null
  }
  return changeset
}

export function changesetEmpty(cs: Changeset): boolean {
  for (const _ in cs) return false
  return true
}
