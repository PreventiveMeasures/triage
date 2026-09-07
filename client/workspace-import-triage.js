// Merging an imported triage map into `state.triage` — the triage
// half of a workspace-bundle import, split out of
// `workspace-import.js` so that file stays about the bundle (its
// shape, its reports, its bundles, its keys) and this one about the
// annotations riding inside it.
//
// Shares its conflict vocabulary with the sync hydration path
// (client/sync/triage-state-projection.ts): the same per-property
// shape, the same "re-read local at apply time" staleness guard, and
// the same rule that per-scope collections — the per-report ignores
// and the per-app work slots — merge by key instead of conflicting.

import { state } from './state.ts'
import { bucketOf, patchEntry, setAppFix, setAppTriage, setReportIgnored, setUpstream, upstreamText } from './triage-entry.ts'
import { saveTriage } from './triage.js'

// Read an imported triage entry's bucket. Preferred form is the new
// `triage: 'inprogress'|'fixed'|'invalid'|'deleted'` field; legacy bundles carry
// only `deleted: true`, treated as 'deleted'. Null when the entry has
// no bucket annotation.
export function readImportedTriageBucket(entry) {
  return bucketOf(entry) ?? null
}

// Merge the imported triage into `state.triage`. Non-conflicting
// changes apply immediately. A property-scoped conflict (id+property
// where both sides have a value and they differ) is queued and handed
// to `conflictResolver` — when omitted (or it returns null), local
// wins on every conflict.
export async function mergeTriage(triage, conflictResolver, findingLookup) {
  // Reject arrays: `typeof [] === 'object'` passes the lone-typeof
  // guard, and `Object.entries([])` then yields stringified indices
  // persisted as bogus finding ids in `state.triage`. Audit round-14
  // WI-1.
  if (!triage || typeof triage !== 'object' || Array.isArray(triage)) return
  const map = state.triage
  const conflicts = []
  for (const [id, entry] of Object.entries(triage)) {
    if (!entry || typeof entry !== 'object') continue

    // Skip writes when imported equals local — the reactive observers
    // (sidebar / table re-render, M-2 hydration listeners, triage-
    // sync.js subscribers) all fire on every entry mutation, so a
    // bundle re-importing the user's own state would spam them all.
    // `patchEntry` also no-ops unchanged values, but the explicit
    // guards here are needed for conflict detection anyway. Audit
    // round-14 WI-3.
    const localColor = map.get(id)?.color
    const importedColor = typeof entry.color === 'string' ? entry.color : undefined
    if (importedColor && localColor && localColor !== importedColor) {
      conflicts.push({ id, property: 'color', local: localColor, imported: importedColor })
    } else if (importedColor && importedColor !== localColor) {
      patchEntry(map, id, { color: importedColor })
    }

    const localComment = map.get(id)?.comment ?? ''
    const importedComment = typeof entry.comment === 'string' ? entry.comment : ''
    if (importedComment && localComment && localComment !== importedComment) {
      conflicts.push({ id, property: 'comment', local: localComment, imported: importedComment })
    } else if (importedComment && importedComment !== localComment) {
      patchEntry(map, id, { comment: importedComment })
    }

    const localFix = map.get(id)?.fix ?? ''
    const importedFix = typeof entry.fix === 'string' ? entry.fix : ''
    if (importedFix && localFix && localFix !== importedFix) {
      conflicts.push({ id, property: 'fix', local: localFix, imported: importedFix })
    } else if (importedFix && importedFix !== localFix) {
      patchEntry(map, id, { fix: importedFix })
    }

    const importedTriage = readImportedTriageBucket(entry)
    const localTriage = bucketOf(map.get(id)) ?? null
    if (importedTriage && localTriage && localTriage !== importedTriage) {
      conflicts.push({ id, property: 'triage', local: localTriage, imported: importedTriage })
    } else if (importedTriage && !localTriage) {
      // Clear any pre-existing local per-report ignore on this id —
      // triage and ignoredReports are mutually exclusive (same mutex
      // applyConflictDecisions enforces via `ignoredReports:
      // undefined`). Without it, patchEntry's {...cur, ...patch} merge
      // leaves an entry carrying BOTH a triage bucket and a stale
      // ignoredReports set.
      patchEntry(map, id, { triage: importedTriage, ignoredReports: undefined })
    }

    // Tri-state attention flag — gap-fill when local is unset, surface a
    // conflict (as 'flagged' / 'not flagged' tokens, matching the sync
    // hydration path) when both sides set it and disagree. Adopting the
    // imported value covers the explicit `false` tombstone too, so an
    // imported un-flag isn't silently dropped.
    const localFlag = map.get(id)?.flagged
    const importedFlag = typeof entry.flagged === 'boolean' ? entry.flagged : undefined
    if (importedFlag !== undefined && localFlag !== undefined && localFlag !== importedFlag) {
      conflicts.push({
        id, property: 'flagged',
        local: localFlag ? 'flagged' : 'not flagged',
        imported: importedFlag ? 'flagged' : 'not flagged',
      })
    } else if (importedFlag !== undefined && importedFlag !== localFlag) {
      patchEntry(map, id, { flagged: importedFlag })
    }

    // The per-app work track — additive per key, for the same reason
    // the ignored reports below are: each app key is one app's own
    // answer about its own code, so an imported slot for app B is
    // news rather than a disagreement with the local slot for app A.
    // Local wins within a key (the bundle can't know this profile
    // changed its mind), and there is no conflict path — nothing for
    // the dialog to ask.
    if (entry.apps && typeof entry.apps === 'object') {
      for (const [app, slot] of Object.entries(entry.apps)) {
        if (!app || !slot || typeof slot !== 'object') continue
        const cur = map.get(id)?.apps?.[app]
        if (slot.triage && cur?.triage === undefined) setAppTriage(map, id, app, slot.triage)
        if (slot.fix && cur?.fix === undefined) setAppFix(map, id, app, slot.fix)
      }
    }

    // The cause track — one statement about the dependency, so it
    // gap-fills and conflicts whole, the way the sync hydration path
    // treats it.
    const localUpstream = upstreamText(map.get(id))
    const importedUpstream = upstreamText(entry)
    if (importedUpstream && localUpstream && localUpstream !== importedUpstream) {
      conflicts.push({
        id, property: 'upstream', local: localUpstream, imported: importedUpstream,
        importedUpstream: entry.upstream,
      })
    } else if (importedUpstream && !localUpstream) {
      setUpstream(map, id, entry.upstream)
    }

    // Per-report ignore — additive merge. Each (reportName, id) is an
    // independent slot; union the imported list into local. No
    // conflict path since keys don't collide between sides (both
    // setting "ignored in this report" is identical). Mutual-exclusion
    // guard: if the id has a triage state locally now (pre-existing or
    // just-imported above), skip the ignored merge to honor the per-
    // tab invariant.
    const ignoredReports = Array.isArray(entry.ignoredReports) ? entry.ignoredReports : []
    if (!bucketOf(map.get(id))) {
      for (const r of ignoredReports) {
        if (typeof r === 'string') setReportIgnored(map, id, r, true)
      }
    }
  }
  if (conflicts.length > 0 && conflictResolver) {
    const decisions = await conflictResolver(conflicts, findingLookup ?? new Map())
    if (decisions) applyConflictDecisions(conflicts, decisions)
  }
  await saveTriage()
}

// Apply per-conflict decisions from `conflictResolver`. The 'triage'
// branch also drops any local `ignoredIds` for the same id — mutex
// with triage that triage-sync.js / triage.js already enforce. Audit
// M8.
//
// The dialog is async (user time), so state.* may have changed while
// it was open (a chain via `applyToReactiveState`, or a saveTriage
// from an action handler). Re-read each property's current local
// value at apply-time and SKIP any 'imported' decision whose `local`
// no longer matches — the user (or another peer's chain) effectively
// re-voted "local". Mirrors the hydration dialog's M-2 round-4 guard.
// Audit H1 round-5.
function applyConflictDecisions(conflicts, decisions) {
  for (const c of conflicts) {
    const key = `${c.id}:${c.property}`
    if (decisions[key] !== 'imported') continue
    if (currentLocalValue(c.id, c.property) !== c.local) continue
    if (c.property === 'color') patchEntry(state.triage, c.id, { color: c.imported })
    else if (c.property === 'comment') patchEntry(state.triage, c.id, { comment: c.imported })
    else if (c.property === 'fix') patchEntry(state.triage, c.id, { fix: c.imported })
    else if (c.property === 'triage') {
      // Clear the per-report ignore on the same id — mutex with triage.
      patchEntry(state.triage, c.id, { triage: c.imported, ignoredReports: undefined })
    }
    else if (c.property === 'flagged') {
      // 'not flagged' resolves to the explicit `false` tombstone, never
      // undefined, so adopting the imported un-flag still propagates.
      patchEntry(state.triage, c.id, { flagged: c.imported === 'flagged' ? true : c.imported === 'not flagged' ? false : undefined })
    }
    else if (c.property === 'upstream') {
      // Written from the record the conflict carried, not from the
      // sentence shown: "fixed in 4.17.21 https://…" can't be parsed
      // back into its three fields.
      setUpstream(state.triage, c.id, c.importedUpstream)
    }
  }
}

// Mirror the comparison shape `mergeTriage` used at conflict-
// collection time so the M-2 stale-check is meaningful: comment / fix
// normalised via `?? ''`, color / triage raw.
function currentLocalValue(id, property) {
  if (property === 'color') return state.triage.get(id)?.color
  if (property === 'triage') return bucketOf(state.triage.get(id)) ?? null
  if (property === 'comment') return state.triage.get(id)?.comment ?? ''
  if (property === 'fix') return state.triage.get(id)?.fix ?? ''
  if (property === 'flagged') {
    const f = state.triage.get(id)?.flagged
    return f === true ? 'flagged' : f === false ? 'not flagged' : ''
  }
  // The same formatter the conflict was collected with, so the
  // stale-check compares like for like.
  if (property === 'upstream') return upstreamText(state.triage.get(id))
  return undefined
}
