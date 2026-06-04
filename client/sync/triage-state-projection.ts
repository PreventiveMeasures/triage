// State projection + application split out of triage-sync.ts. Bridges
// the live reactive `state.triage` map (one TriageEntry per finding-id)
// and the sync triage representation, in both directions:
//   * read side — `effectiveLocalState` overlays the live entries onto
//     the full id→entry map the next save represents;
//   * write side — `hydrateStateFromBaseState` / `applyHydrationDecisions`
//     / `applyToReactiveState` apply an incoming baseState / changeset
//     (and the user's conflict choices) back into `state.triage`.
// `state` is reached through `syncHost().state` (the host's identity-
// shared object — the same reference the rest of the app holds), so
// reads and writes here hit live app state. No sync module state
// (sessions, transport, timers) is touched. Every write goes through
// `triage-entry.ts`'s immutable whole-entry replace, preserving the
// observer-util per-id re-render behavior the UI depends on.

import { syncHost } from './host.ts'
import { bucketOf, normalizeEntry, patchEntry, setEntry, setReportIgnored } from '../triage-entry.ts'
import type { Conflict, ConflictProperty, TriageStateMap } from './triage-changeset.ts'

// The session's "effective" local state — what the next save
// represents as the workspace's full triage. Starts from `baseState`
// (= the chain we've applied so far, including entries for finding-ids
// belonging to reports the user doesn't have loaded — a peer triaged
// them), then overlays the live `state.triage` entries for ids the
// workspace DOES know about. Without preserving the unknown-id half,
// the next save's changeset against `baseState` would emit
// `<unknown>: null` (delete), destroying the triage on the server for
// clients that DO have that report. Mirrors the keyframe-emit case as
// well: the full state we sign and ship under `compute({}, localState)`
// must carry every id we've ever seen in the chain, not just the ones
// in our current session.ids scope.
export function effectiveLocalState(baseState: TriageStateMap, ids: Set<string> | Iterable<string>): TriageStateMap {
  // `Object.create(null)` so a `__proto__` own key on baseState (via
  // prior `applyChangeset` of a peer-controlled changeset) doesn't
  // trigger the Object.prototype setter when spread into a normal `{}`
  // — that would re-pollute out's prototype chain and propagate
  // attacker entries into localState → computeChangeset's `target[id]`
  // lookups → emitted changesets. Audit round-12 H6.
  const out: TriageStateMap = Object.assign(Object.create(null), baseState)
  const state = syncHost().state
  const idsSet: Set<string> = ids instanceof Set ? ids : new Set(ids)
  for (const id of idsSet) {
    // `normalizeEntry` returns a fresh entry (own `ignoredReports`
    // array) so the snapshot never aliases live state, and prunes an
    // empty entry to `undefined` → the id is deleted from the overlay
    // (it carries no triage to ship).
    const entry = normalizeEntry(state.triage.get(id))
    if (entry) out[id] = entry
    else delete out[id]
  }
  return out
}

// Gap-only hydration: for each id in `ids`, fill missing `state.triage`
// fields from `baseState[id]`. Existing local values are NEVER
// overwritten (local-wins on conflict), so a finding the user already
// triaged in another open workspace (state.triage is global, chains are
// per-workspace) keeps its local value.
//
// Used when ids enter session scope (report attached mid-session — see
// the `onReportMembershipChanged` listener). Without it, the next
// `effectiveLocalState` would snapshot each newly-in-scope id, get an
// empty entry (state.triage unpopulated for OOS ids), and emit a delete
// wiping the chain's view for that id. The `ignoredReports`/triage mutex
// is honored — skipped when the entry already carries triage, mirroring
// `applyToReactiveState`.
//
// `cur` is captured ONCE up front: hydration only adds missing fields,
// so each property's pre-hydration value is the conflict baseline
// regardless of gap-fill order.
export function hydrateStateFromBaseState(baseState: TriageStateMap, ids: Iterable<string>): Conflict[] {
  const state = syncHost().state
  const conflicts: Conflict[] = []
  for (const id of ids) {
    const entry = baseState[id]
    if (!entry || typeof entry !== 'object') continue
    const cur = state.triage.get(id)

    if (entry.color) {
      const local = cur?.color
      if (local === undefined) patchEntry(state.triage, id, { color: entry.color })
      else if (local !== entry.color) conflicts.push({ id, property: 'color', local, imported: entry.color })
    }

    const triageNext = bucketOf(entry)
    if (triageNext) {
      const local = bucketOf(cur)
      if (local === undefined) patchEntry(state.triage, id, { triage: triageNext })
      else if (local !== triageNext) conflicts.push({ id, property: 'triage', local, imported: triageNext })
    }

    if (entry.comment) {
      const local = cur?.comment
      if (local === undefined) patchEntry(state.triage, id, { comment: entry.comment })
      else if (local !== entry.comment) conflicts.push({ id, property: 'comment', local, imported: entry.comment })
    }

    if (entry.fix) {
      const local = cur?.fix
      if (local === undefined) patchEntry(state.triage, id, { fix: entry.fix })
      else if (local !== entry.fix) conflicts.push({ id, property: 'fix', local, imported: entry.fix })
    }

    // Per-report ignore: skipped when triage is set (mutex), and when
    // the id already carries any ignoredReports (local-wins, like the
    // checks above). No conflict path for ignoredReports — the mutex
    // would make "user picks ignored over triage" require dropping
    // triage too, which the dialog doesn't model.
    const triageEffectivelySet = triageNext != null || bucketOf(cur) != null
    if (triageEffectivelySet || !Array.isArray(entry.ignoredReports)) continue
    if ((cur?.ignoredReports?.length ?? 0) > 0) continue
    for (const r of entry.ignoredReports) {
      if (typeof r === 'string') setReportIgnored(state.triage, id, r, true)
    }
  }
  return conflicts
}

// Apply the user's per-conflict decisions from the hydration resolver.
// `decisions` is keyed by `${id}:${property}` with `'local'` /
// `'imported'`. Triage's 'imported' branch also clears the id's
// per-report ignored entries (mutex).
//
// The resolver dialog is async (user time), so state.triage may have
// changed while open — a chain landing via `applyChainToBase` or a
// saveTriage from an action handler. Re-read each property's current
// local value at apply-time and SKIP any 'imported' decision whose
// `local` no longer matches: the user (or a peer's chain) effectively
// re-voted "local". Without this, the dialog's `imported` choice would
// silently overwrite fresh local edits made during the dialog. Audit M-2.
export function applyHydrationDecisions(
  conflicts: Conflict[],
  decisions: { [key: string]: 'local' | 'imported' },
): void {
  const state = syncHost().state
  for (const c of conflicts) {
    const key = `${c.id}:${c.property}`
    if (decisions[key] !== 'imported') continue
    if (currentLocalValue(c.id, c.property) !== c.local) continue
    if (c.property === 'color') {
      patchEntry(state.triage, c.id, { color: c.imported })
    } else if (c.property === 'comment') {
      patchEntry(state.triage, c.id, { comment: c.imported })
    } else if (c.property === 'fix') {
      patchEntry(state.triage, c.id, { fix: c.imported })
    } else if (c.property === 'triage') {
      if (c.imported === 'inprogress' || c.imported === 'fixed' || c.imported === 'invalid' || c.imported === 'deleted') {
        // Mutex — clear the id's per-report ignore alongside the bucket.
        patchEntry(state.triage, c.id, { triage: c.imported, ignoredReports: undefined })
      } else {
        patchEntry(state.triage, c.id, { triage: undefined })
      }
    }
  }
}

function currentLocalValue(id: string, property: ConflictProperty): string {
  const entry = syncHost().state.triage.get(id)
  if (property === 'color') return entry?.color ?? ''
  if (property === 'triage') return bucketOf(entry) ?? ''
  if (property === 'comment') return entry?.comment ?? ''
  if (property === 'fix') return entry?.fix ?? ''
  return ''
}

// Replace each in-scope id's live entry with `targetState`'s (deleting
// when empty). Triage mutex: if the wire entry carries triage we drop
// its ignoredReports — triage and ignore can't coexist on a tab, and a
// stale chain carrying both resolves in favor of triage (matching the
// action handler, which clears ignore when setting triage). Out-of-scope
// ids untouched. `setEntry` normalizes the rest (legacy `deleted` →
// bucket, prune empty fields, fresh arrays).
export function applyToReactiveState(targetState: TriageStateMap, ids: Set<string> | Iterable<string>): void {
  const state = syncHost().state
  const idsSet: Set<string> = ids instanceof Set ? ids : new Set(ids)
  for (const id of idsSet) {
    const entry = targetState[id]
    const ignoredReports = bucketOf(entry) ? undefined : entry?.ignoredReports
    setEntry(state.triage, id, { ...entry, ignoredReports })
  }
}
