// Triage garbage collection + pre-deletion impact analysis. Lifted
// out of `client/triage.js` (which had grown past the 300-line
// max-lines lint) so the persistence + cross-tab-sync core stays
// focused on the load/save path; the report-delete flows reach
// here for the analyzer + the GC pass.
//
// Surface:
//   - analyzeTriageImpact(deletedReportNames) → { orphanedCount, sharedCount }
//     Pre-deletion question: of the persisted triage entries
//     attached to the to-be-deleted reports, how many won't be
//     reachable from any remaining report (orphaned) vs. would
//     survive via another report (shared). Drives the leave-
//     workspace / delete-report dialogs' triage section.
//   - pruneOrphanTriage() → void
//     GC pass: walks every OPFS report, builds the reachable
//     id set, drops any persisted triage entry (markers /
//     triageState / comments / fixes / per-report ignores)
//     whose id isn't in the set. Persists via saveTriage when
//     anything changed.
import { state } from './state.ts'
import { SESSION_ID_RE, saveTriage } from './triage.js'
import { listFiles, readFile } from './storage.js'
import { backfillFindingIds, flattenFindings, parseReport } from '../common/report-findings.js'
import { splitIgnoredKey } from '../common/ignored-key.js'

// Walk every OPFS-stored report in `names`, parse it, and return
// the union of finding ids reachable from those reports. Uses the
// shared report-findings helpers: `parseReport` (native JSON, with a
// DeepSec / markdown fallback), `flattenFindings` (dedup-group entries
// → member findings), and `backfillFindingIds` (findings without an
// exporter-stamped `id` get one derived from the same fingerprint the
// analyzer would compute, so triage stamped during a previous session
// keeps matching).
//
// A `readFile` failure is propagated rather than swallowed —
// `pruneOrphanTriage` keys its destructive decision on this set,
// and silently treating an unreadable file as "empty" would
// over-classify every triage id on that report as orphaned and
// wipe it on the next prune. Caller-side `try/catch` lets the
// dialog flow surface the error or skip the GC pass instead of
// committing a partial wipe.
//
// Exception: a "file not found" error is treated as a benign race
// (e.g., a sibling tab's `deleteFile` landing between our
// `listFiles` enumeration and the `readFile` for that entry).
// Skip the name and keep going — the missing file genuinely has
// no findings reachable from it, so dropping it from the
// reachable-id walk is correct. Other I/O errors (corrupt blob,
// decompression failure, permission issues) still propagate.
function isReadFileNotFound(err) {
  // OPFS path → DOMException with name 'NotFoundError'.
  // localStorage fallback → plain Error('File not found: <name>').
  return err?.name === 'NotFoundError'
    || (typeof err?.message === 'string' && err.message.startsWith('File not found:'))
}
async function collectReachableIds(names) {
  const ids = new Set()
  for (const name of names) {
    let content
    try {
      content = await readFile(name)
    } catch (err) {
      if (isReadFileNotFound(err)) continue
      throw new Error(`Failed to read ${name}: ${err.message}`, { cause: err })
    }
    if (content == null) continue
    const data = parseReport(content)
    if (!data?.findings) continue
    const findings = flattenFindings(data.findings)
    await backfillFindingIds(findings)
    for (const f of findings) if (f.id) ids.add(f.id)
  }
  return ids
}

// Snapshot the persisted ids carried by the in-memory state.
// "Persisted" here = anything that round-trips through
// localStorage on saveTriage (markers / triageState / comments /
// fixes / per-report ignores), keyed by the finding's stable
// uuid. Session-only numeric `_id`s are excluded because they
// don't survive a reload and shouldn't drive the analyze /
// prune decisions.
function collectPersistedTriageIds() {
  const ids = new Set()
  for (const k of state.markers.keys()) {
    if (!SESSION_ID_RE.test(k)) ids.add(k)
  }
  for (const k of state.triageState.keys()) {
    if (!SESSION_ID_RE.test(k)) ids.add(k)
  }
  for (const k of state.comments.keys()) {
    if (!SESSION_ID_RE.test(k)) ids.add(k)
  }
  for (const k of state.fixes.keys()) {
    if (!SESSION_ID_RE.test(k)) ids.add(k)
  }
  for (const key of state.ignoredIds) {
    const parts = splitIgnoredKey(key)
    if (!parts) continue
    const { id } = parts
    if (!SESSION_ID_RE.test(id)) ids.add(id)
  }
  return ids
}

// Pre-deletion impact analysis: count how many persisted triage
// entries are attached to the to-be-deleted reports AND categorize
// each as either "orphaned" (won't be reachable from any remaining
// report) or "shared" (also lives on a report we're keeping).
// Drives the leave-workspace / delete-report dialogs' triage
// section — "no triage attached" / "all shared" / "ask what to do
// with orphans".
//
// Optimization: short-circuits when there's no persisted triage at
// all, or when none of the persisted ids match the deleted reports
// — both common cases skip the (potentially large) kept-side parse.
//
// Throws on `listFiles` / `readFile` failure. Pre-fix, a transient
// OPFS error swallowed the kept-side parse and silently treated
// every overlapping id as orphaned — the dialog would then offer a
// "wipe N orphans" choice that didn't reflect reality, and a
// follow-up `pruneOrphanTriage` would commit a destructive wipe
// against an empty reachable set. Surface the failure so the
// sidebar handler can alert the user and refuse to open the
// dialog instead.
export async function analyzeTriageImpact(deletedReportNames) {
  const persisted = collectPersistedTriageIds()
  if (persisted.size === 0) return { orphanedCount: 0, sharedCount: 0 }
  const deletedIds = await collectReachableIds(deletedReportNames)
  const persistedInDeleted = new Set()
  for (const id of persisted) if (deletedIds.has(id)) persistedInDeleted.add(id)
  if (persistedInDeleted.size === 0) return { orphanedCount: 0, sharedCount: 0 }
  const allFiles = await listFiles()
  const deletedSet = new Set(deletedReportNames)
  const keptFiles = allFiles.filter((n) => !deletedSet.has(n))
  const keptIds = await collectReachableIds(keptFiles)
  let orphanedCount = 0
  let sharedCount = 0
  for (const id of persistedInDeleted) {
    if (keptIds.has(id)) sharedCount++
    else orphanedCount++
  }
  return { orphanedCount, sharedCount }
}

// GC the persisted triage blob: drop any entry whose finding-id no
// longer matches a finding in any OPFS-stored report (and any
// per-report ignore whose report file is gone OR whose id is
// otherwise unreachable). Called by the report-delete flows
// (`deleteCurrent` and `leaveWorkspace` in delete mode, only when
// the user picked "wipe") AFTER the OPFS removal lands so the
// union of remaining files reflects the post-deletion state.
//
// Session-only numeric ids are left alone in every collection —
// those belong to the currently-loaded report's id-less findings
// (which never round-trip to localStorage anyway) and the legacy
// pre-uuid migration path; touching them here would wipe the
// active tab's in-flight triage.
//
// Two correctness guards that the audit flagged (round-1 review):
//
//   * Throws on `listFiles` / `readFile` failure rather than
//     falling through to an empty `reachable` set. Pre-fix, a
//     transient OPFS error wiped every persisted triage entry and
//     propagated the loss to peers via `saveTriage`'s
//     `triageSync.notify()`. Surface the failure so the caller
//     can warn the user; orphans get to stay until the next clean
//     prune.
//
//   * Snapshots the persisted keys synchronously BEFORE any await,
//     and only deletes entries whose key was IN the snapshot.
//     Concurrent saveTriage calls (own-tab user actions, or
//     cross-tab `storage` events that hit `reloadTriageFromStorage`
//     → `applyTriageEntries`) can add fresh entries to `state.*`
//     during the OPFS walk; without the snapshot guard those new
//     entries would race the reachable-id set we computed seconds
//     earlier (their id may not be in `reachable`) and the prune
//     would wipe them. The snapshot pins what THIS prune saw and
//     leaves anything added since alone — that entry will be
//     re-evaluated by the next prune against a fresh reachable
//     set.
//
// No-op when nothing was orphaned; saveTriage is the single write
// point (notifies the cross-tab `storage` listener AND the sync
// layer, same as a user-driven triage edit).
export async function pruneOrphanTriage() {
  // Snapshot synchronously BEFORE the await. See doc-block above.
  const snapMarkers = new Set(state.markers.keys())
  const snapTriageState = new Set(state.triageState.keys())
  const snapComments = new Set(state.comments.keys())
  const snapFixes = new Set(state.fixes.keys())
  const snapIgnoredIds = new Set(state.ignoredIds)
  const names = await listFiles()
  const nameSet = new Set(names)
  const reachable = await collectReachableIds(names)
  let changed = false
  for (const k of snapMarkers) {
    if (SESSION_ID_RE.test(k)) continue
    if (reachable.has(k)) continue
    // `state.markers.has(k)` covers the case where a cross-tab
    // storage event already deleted the entry between our
    // snapshot and our mutation — `delete` would be a no-op
    // either way, but skipping keeps `changed` honest so a
    // pure-no-op prune doesn't pointlessly persist.
    if (!state.markers.has(k)) continue
    state.markers.delete(k)
    changed = true
  }
  for (const k of snapTriageState) {
    if (SESSION_ID_RE.test(k)) continue
    if (reachable.has(k)) continue
    if (!state.triageState.has(k)) continue
    state.triageState.delete(k)
    changed = true
  }
  for (const k of snapComments) {
    if (SESSION_ID_RE.test(k)) continue
    if (reachable.has(k)) continue
    if (!state.comments.has(k)) continue
    state.comments.delete(k)
    changed = true
  }
  for (const k of snapFixes) {
    if (SESSION_ID_RE.test(k)) continue
    if (reachable.has(k)) continue
    if (!state.fixes.has(k)) continue
    state.fixes.delete(k)
    changed = true
  }
  for (const key of snapIgnoredIds) {
    const parts = splitIgnoredKey(key)
    if (!parts) continue
    const { reportName, id } = parts
    if (SESSION_ID_RE.test(id)) continue
    if (reachable.has(id) && nameSet.has(reportName)) continue
    if (!state.ignoredIds.has(key)) continue
    state.ignoredIds.delete(key)
    changed = true
  }
  if (!changed) return
  await saveTriage()
}
