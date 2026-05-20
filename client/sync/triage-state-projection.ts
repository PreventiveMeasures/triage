// State-projection helpers split out of triage-sync.ts. They read the
// live reactive `state.*` (markers / triage / comments / fixes /
// ignoredIds) and project a workspace's "effective local triage state"
// — the full id→entry map the next save represents. Read-only over
// `state`; no sync module state is touched. `state` is reached through
// `syncHost().state` (the host's identity-shared object — the same
// reference the rest of the app holds), so reads here see live edits.

import { syncHost } from './host.ts'
import { splitIgnoredKey } from '../../common/ignored-key.js'
import type { TriageEntry, TriageStateMap } from './triage-changeset.ts'

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
