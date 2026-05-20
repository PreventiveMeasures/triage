// State projection + application split out of triage-sync.ts. Bridges
// the live reactive `state.*` (markers / triage / comments / fixes /
// ignoredIds) and the sync triage representation, in both directions:
//   * read side — `effectiveLocalState` snapshots state.* into the full
//     id→entry map the next save represents;
//   * write side — `hydrateStateFromBaseState` / `applyHydrationDecisions`
//     / `applyToReactiveState` apply an incoming baseState / changeset
//     (and the user's conflict choices) back into state.*.
// `state` is reached through `syncHost().state` (the host's identity-
// shared object — the same reference the rest of the app holds), so
// reads and writes here hit live app state. No sync module state
// (sessions, transport, timers) is touched.

import { type TriageBucket, syncHost } from './host.ts'
import { makeIgnoredKey, splitIgnoredKey } from '../../common/ignored-key.js'
import type { Conflict, ConflictProperty, TriageEntry, TriageStateMap } from './triage-changeset.ts'

// Collect every per-report ignore key matching `id`, returned as
// the wire-shaped `[reportName, ...]` array. One-off callers
// (snapshotEntry without a pre-built index) pay O(|state.ignoredIds|)
// per call. Loop callers that snapshot many ids (effectiveLocalState)
// build a per-id bucket once via `bucketIgnoredByid` and pass it
// in via `ignoredByid` to drop the per-call cost to O(1) — closes
// the symmetric L1 round-4 perf gap that round-3 fixed for the
// apply side.
function snapshotEntry(id: string, ignoredByid: Map<string, string[]> | null = null): TriageEntry {
  const state = syncHost().state
  const entry: TriageEntry = {}
  const color = state.markers.get(id)
  if (color !== undefined) entry.color = color
  const triage = state.triageState.get(id)
  if (triage) entry.triage = triage
  const ignoredReports = ignoredByid == null
    ? ignoredReportsForId(id)
    : (ignoredByid.get(id) ?? [])
  if (ignoredReports.length > 0) entry.ignoredReports = ignoredReports
  const comment = state.comments.get(id)
  if (comment) entry.comment = comment
  const fix = state.fixes.get(id)
  if (fix) entry.fix = fix
  return entry
}

function ignoredReportsForId(id: string): string[] {
  const state = syncHost().state
  const out: string[] = []
  for (const key of state.ignoredIds) {
    const parts = splitIgnoredKey(key)
    if (!parts || parts.id !== id) continue
    out.push(parts.reportName)
  }
  return out
}

// Pre-bucket `state.ignoredIds` by id, optionally filtered to a set
// of ids of interest. Used by `effectiveLocalState` (and any future
// many-id snapshotter) so per-id `ignoredReports` lookup is O(1).
function bucketIgnoredByid(idsScope: Set<string> | null = null): Map<string, string[]> {
  const state = syncHost().state
  const map = new Map<string, string[]>()
  for (const key of state.ignoredIds) {
    const parts = splitIgnoredKey(key)
    if (!parts) continue
    const { reportName, id } = parts
    if (idsScope && !idsScope.has(id)) continue
    const list = map.get(id)
    if (list) list.push(reportName)
    else map.set(id, [reportName])
  }
  return map
}

// The session's "effective" local state — what the next save
// represents as the workspace's full triage. Starts from
// `baseState` (= the chain we've applied so far, including
// entries for finding-ids belonging to reports the user doesn't
// have loaded — a peer triaged them), then overlays the live
// state.* values for ids the workspace DOES know about. Without
// preserving the unknown-id half, the next save's changeset
// against `baseState` would emit `<unknown>: null` (delete),
// destroying the triage on the server for clients that DO have
// that report. Mirrors the keyframe-emit case as well: the full
// state we sign and ship under `compute({}, localState)` must
// carry every id we've ever seen in the chain, not just the ones
// in our current session.ids scope.
export function effectiveLocalState(baseState: TriageStateMap, ids: Set<string> | Iterable<string>): TriageStateMap {
  // `Object.create(null)` so a `__proto__` own key on the incoming
  // baseState (via prior `applyChangeset` of a peer-controlled
  // changeset) doesn't trigger the Object.prototype setter when
  // spread into a normal `{}` — that path would re-pollute out's
  // prototype chain and propagate attacker entries into localState
  // → computeChangeset's `target[id]` lookups → emitted changesets.
  // Audit round-12 H6.
  const out: TriageStateMap = Object.assign(Object.create(null), baseState)
  const idsSet: Set<string> = ids instanceof Set ? ids : new Set(ids)
  const ignoredByid = bucketIgnoredByid(idsSet)
  for (const id of idsSet) {
    const entry = snapshotEntry(id, ignoredByid)
    if (Object.keys(entry).length > 0) out[id] = entry
    else delete out[id]
  }
  return out
}

// Gap-only hydration: for each id in `ids`, fill missing state.*
// fields from `baseState[id]`. Existing state.* values are NEVER
// overwritten (local-wins on conflict), so a finding the user
// already triaged in another open workspace (state.* is global,
// chains are per-workspace) keeps its local value.
//
// Used when ids enter session scope (a report attached mid-session
// — see `onReportMembershipChanged` listener at module init). Without
// this, the next `effectiveLocalState` would call `snapshotEntry`
// on each newly-in-scope id, get an empty entry (state.* not
// populated for OOS ids), and emit a delete that wipes the chain's
// view for that id. The `ignoredReports` mutex with triage is
// honored — skipped when the entry already carries any triage
// state, mirroring `applyToReactiveState`'s rule.
export function hydrateStateFromBaseState(baseState: TriageStateMap, ids: Iterable<string>): Conflict[] {
  const state = syncHost().state
  const conflicts: Conflict[] = []
  for (const id of ids) {
    const entry = baseState[id]
    if (!entry || typeof entry !== 'object') continue

    if (entry.color) {
      const local = state.markers.get(id)
      if (local === undefined) state.markers.set(id, entry.color)
      else if (local !== entry.color) conflicts.push({ id, property: 'color', local, imported: entry.color })
    }

    let triageNext: TriageBucket | null = null
    if (entry.triage === 'fixed' || entry.triage === 'invalid' || entry.triage === 'deleted') triageNext = entry.triage
    else if (entry.deleted) triageNext = 'deleted'
    if (triageNext) {
      const local = state.triageState.get(id)
      if (local === undefined) state.triageState.set(id, triageNext)
      else if (local !== triageNext) conflicts.push({ id, property: 'triage', local, imported: triageNext })
    }

    if (entry.comment) {
      const local = state.comments.get(id)
      if (local === undefined) state.comments.set(id, entry.comment)
      else if (local !== entry.comment) conflicts.push({ id, property: 'comment', local, imported: entry.comment })
    }

    if (entry.fix) {
      const local = state.fixes.get(id)
      if (local === undefined) state.fixes.set(id, entry.fix)
      else if (local !== entry.fix) conflicts.push({ id, property: 'fix', local, imported: entry.fix })
    }

    // Per-report ignore: skipped when triage is set (mutex), and
    // when state.ignoredIds already has any entry for this id
    // (local-wins on conflict, same shape as the field-by-field
    // checks above). No conflict path for ignoredReports — the
    // mutex makes a "user picks ignored over triage" resolution
    // require dropping triage too, which the dialog doesn't model.
    const triageEffectivelySet = triageNext || state.triageState.has(id)
    if (triageEffectivelySet || !Array.isArray(entry.ignoredReports)) continue
    let alreadyHasAny = false
    for (const key of state.ignoredIds) {
      if (splitIgnoredKey(key)?.id === id) { alreadyHasAny = true; break }
    }
    if (alreadyHasAny) continue
    for (const r of entry.ignoredReports) {
      if (typeof r === 'string') state.ignoredIds.add(makeIgnoredKey(r, id))
    }
  }
  return conflicts
}

function dropIgnoredEntriesFor(id: string): void {
  const state = syncHost().state
  for (const k of [...state.ignoredIds]) {
    if (splitIgnoredKey(k)?.id === id) state.ignoredIds.delete(k)
  }
}

// Apply the user's per-conflict decisions returned by the hydration
// conflict resolver. `decisions` is a map keyed by `${id}:${property}`
// with `'local'` / `'imported'`. Triage's 'imported' branch also clears
// the per-report ignored entries for the id (mutex).
//
// The resolver dialog is async (user time) so state.* may have changed
// while it was open — a chain that landed via `applyChainToBase` or a
// saveTriage from an action handler. Re-read each property's current
// local value at apply-time and SKIP any 'imported' decision whose
// `local` no longer matches: the user (or another peer's chain) has
// effectively voted "local" again. Without this guard the dialog's
// `imported` choice would silently overwrite fresh local edits made
// during the dialog window. Audit M-2.
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
      if (c.imported) state.markers.set(c.id, c.imported)
      else state.markers.delete(c.id)
    } else if (c.property === 'comment') {
      if (c.imported) state.comments.set(c.id, c.imported)
      else state.comments.delete(c.id)
    } else if (c.property === 'fix') {
      if (c.imported) state.fixes.set(c.id, c.imported)
      else state.fixes.delete(c.id)
    } else if (c.property === 'triage') {
      if (c.imported === 'fixed' || c.imported === 'invalid' || c.imported === 'deleted') {
        state.triageState.set(c.id, c.imported)
        dropIgnoredEntriesFor(c.id)
      } else {
        state.triageState.delete(c.id)
      }
    }
  }
}

function currentLocalValue(id: string, property: ConflictProperty): string {
  const state = syncHost().state
  if (property === 'color') return state.markers.get(id) ?? ''
  if (property === 'triage') return state.triageState.get(id) ?? ''
  if (property === 'comment') return state.comments.get(id) ?? ''
  if (property === 'fix') return state.fixes.get(id) ?? ''
  return ''
}

// Per-report ignore is rebuilt scoped to `ids`. The naive form —
// a `[...state.ignoredIds]` scan inside the per-id loop — is
// O(|state.ignoredIds| · |ids|); pre-bucket once per call so the
// total cost is O(|state.ignoredIds| + |ids|). Audit M5 round-3.
export function applyToReactiveState(targetState: TriageStateMap, ids: Set<string> | Iterable<string>): void {
  const state = syncHost().state
  const idsSet: Set<string> = ids instanceof Set ? ids : new Set(ids)
  const existingIgnoredByid = new Map<string, string[]>()
  for (const key of state.ignoredIds) {
    const parts = splitIgnoredKey(key)
    if (!parts) continue
    const { id } = parts
    if (!idsSet.has(id)) continue
    const list = existingIgnoredByid.get(id)
    if (list) list.push(key)
    else existingIgnoredByid.set(id, [key])
  }
  for (const id of idsSet) {
    const entry: TriageEntry = targetState[id] ?? {}
    if (entry.color) state.markers.set(id, entry.color)
    else state.markers.delete(id)
    // Triage state — preferred form `triage: 'fixed'|'invalid'|'deleted'`.
    // Legacy `deleted: true` from older peers maps to 'deleted'.
    if (entry.triage === 'fixed' || entry.triage === 'invalid' || entry.triage === 'deleted') {
      state.triageState.set(id, entry.triage)
    } else if (entry.deleted) {
      state.triageState.set(id, 'deleted')
    } else {
      state.triageState.delete(id)
    }
    // Per-report ignore replaces the local set for this id with
    // whatever the wire entry carries. Drop existing keys for the
    // id first so a remote that cleared all reports for an id
    // resets us; then re-add from the entry. Mutual exclusion
    // with triage: if the wire entry carries a triage state we
    // skip its ignoredReports — the action-level invariant says
    // triage and ignore can't coexist on a tab, and a stale chain
    // that carries both should resolve in favor of triage (matches
    // the action handler, which clears ignore when setting triage).
    const oldKeys = existingIgnoredByid.get(id)
    if (oldKeys) {
      for (const k of oldKeys) state.ignoredIds.delete(k)
    }
    const triageWasSet = entry.triage === 'fixed' || entry.triage === 'invalid' || entry.triage === 'deleted' || entry.deleted
    if (!triageWasSet && Array.isArray(entry.ignoredReports)) {
      for (const r of entry.ignoredReports) {
        if (typeof r === 'string') state.ignoredIds.add(makeIgnoredKey(r, id))
      }
    }
    if (entry.comment) state.comments.set(id, entry.comment)
    else state.comments.delete(id)
    if (entry.fix) state.fixes.set(id, entry.fix)
    else state.fixes.delete(id)
  }
}
