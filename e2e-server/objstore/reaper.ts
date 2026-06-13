// Orphan reaper / GC for the v1.objstore byte plane. Two passes:
//   1. Unreferenced live blobs. Live blobs are content-addressed
//      (`${tag}/${contentHash}.bin`). For each workspace, build the
//      set of content hashes the live table references, list the live
//      blobs, and GC any blob whose hash is in NO live row AND whose
//      age (now − last-modified) is past the grace window. The grace
//      window (one `STAGING_TTL_MS_DEFAULT`) is what makes the
//      reaper-vs-commit race safe without a lock: a just-promoted but
//      not-yet-referenced blob (commit between promote and CAS) is
//      younger than the grace, so it's never reaped out from under an
//      in-flight commit. Covers the "DELETE dropped the row" case
//      (the blob is now unreferenced) and the "commit crashed
//      mid-promotion" case (a stranded, unreferenced blob).
//   2. Stale staging. Rows in workspace_object_staging older than
//      `stagingTtlMs` → drop row + unlink blob. Staging blobs with no
//      row → unlink (catches a row drop that crashed before the
//      blob delete).
//
// Backend-agnostic: every storage operation goes through
// `handle.blob.*`. The FS backend (blob-fs.ts) implements list/
// unlink against the local filesystem; the Vercel backend (blob-
// vercel.ts) against the SDK's list / del. The reaper takes NO lock.
// Pass 1's blob GC is made race-safe by content-addressing + the age
// grace window + a live-reference re-read just before each unlink.
// Pass 2's stale-staging sweep is made race-safe by an atomic
// conditional delete (`deleteStagingIfStale`) whose `begun_at`
// predicate can't match a row a concurrent upload just refreshed.

import { type Handle, STAGING_TTL_MS_DEFAULT, isValidContentHash, isValidStagingId, isValidTag } from './store.ts'
import { debugId, debugTag } from '../util.ts'

type StagingRow = {
  workspace_tag: string
  resource_tag: string
  staging_id: string
  begun_at: number
}

// GC one workspace's live blobs against the set of hashes the live
// table references. A blob is unlinked IFF: its hash parses as a valid
// content hash (defense against operator-seeded / foreign files), it's
// older than the grace window (measured from the listing's
// last-modified time), AND — re-read immediately before the unlink —
// no live row references it. Shared by both GC passes
// (reapUnreferencedForTag's per-tag sweep and reapOrphans'
// whole-workspace straggler sweep).
//
// Two layers of race protection, neither of which is a lock:
//   - Age grace window. A blob a freshly-promoted-but-not-yet-CAS'd
//     commit just wrote is younger than the grace, so it survives this
//     sweep entirely (its listing mtime is recent). This is the
//     primary guard for the commit's promote→CAS window.
//   - Live-set re-read just before unlink. A commit whose CAS landed
//     after our initial per-tag snapshot but before this unlink is
//     caught here — its row now references the hash, so we skip. The
//     test is "no live row references this hash" (not "this resource")
//     because the blob path carries only the hash — the reaper lists
//     blobs by hash and can't know which resource wrote one. (Hashes
//     are effectively unique per PUT — a random nonce per encrypt makes
//     each ciphertext unique — so this is really "is this hash still
//     some current version's", not a dedup/sharing check.)
// A lock would not help here even if one existed: the commit path is
// keyed on the resourceTag while a blob is named by its content hash,
// so the two can't share a key. The grace window + re-read are the
// actual safety net. init.ts runs one sweep at a time per process,
// but a multi-replica deploy genuinely runs reapers concurrently;
// they stay safe via idempotent unlink + the per-blob grace window +
// live-set re-read, not via mutual exclusion.
async function gcBlobIfUnreferenced(
  handle: Handle, tag: string, hash: string, modifiedMs: number, now: number, grace: number,
): Promise<boolean> {
  if (!isValidContentHash(hash)) return false
  if (now - modifiedMs < grace) return false
  const refs = await liveHashSet(handle, tag)
  if (refs.has(hash)) return false
  await handle.blob.unlinkLive(tag, hash)
  // Log EVERY live-blob deletion unconditionally (not behind `debug`):
  // this is the only record that the GC removed bytes. A handful per
  // sweep is normal (superseded versions aging out); a burst across many
  // workspaces is the smoking gun for the "all uploaded data went
  // missing" failure — pair it with the sweep summary in `reapOrphans`.
  console.warn(`objstore-reaper: GC live blob ${debugTag(tag)}/${debugId(hash)} (unreferenced, age ${Math.round((now - modifiedMs) / 1000)}s ≥ grace ${Math.round(grace / 1000)}s)`)
  return true
}

// The set of content hashes referenced by the workspace's live rows.
async function liveHashSet(handle: Handle, tag: string): Promise<Set<string>> {
  const rows = await handle.selectLive.all(tag)
  return new Set(rows.map((r) => r.content_hash))
}

// Sweep one workspace's live-blob listing against the referenced-hash
// set. Anything unreferenced AND past the grace window → GC. The
// snapshot we read up front can race a concurrent commit; the
// reference re-read inside `gcBlobIfUnreferenced` (plus the grace
// window) ensures we never unlink a blob a live row names.
// Returns the number of live blobs GC'd for this tag, so `reapOrphans`
// can surface a sweep-wide total (the headline signal for mass loss).
async function reapUnreferencedForTag(handle: Handle, tag: string, now: number, grace: number): Promise<number> {
  if (!isValidTag(tag)) return 0
  const blobs = await handle.blob.listLiveBlobs(tag)
  if (blobs.length === 0) return 0
  const referenced = await liveHashSet(handle, tag)
  let gc = 0
  for (const { hash, modifiedMs } of blobs) {
    if (!isValidContentHash(hash)) continue
    // Referenced in our snapshot → skip the grace + re-read path
    // entirely; only unreferenced blobs need it.
    if (referenced.has(hash)) continue
    if (await gcBlobIfUnreferenced(handle, tag, hash, modifiedMs, now, grace)) gc++
  }
  return gc
}

// Drop staging rows older than the TTL and unlink their on-storage
// blobs. Every row field that flows into a backend call is re-
// validated — DB tampering / a future migration that introduces an
// unsanitised column shouldn't be able to trick the reaper into
// touching unintended keys. PR #4 review.
async function reapStaleStagingRows(handle: Handle, now: number, stagingTtlMs: number): Promise<void> {
  // Push the staleness filter into SQL so the
  // `workspace_object_staging_begun_at_idx` index handles the scan.
  // The snapshot is O(stale-rows) cluster-wide. DB-layout audit
  // `e2e-server/objstore/store.ts`.
  const staleBefore = now - stagingTtlMs
  const staging = await handle.listAllStaging.all(staleBefore) as StagingRow[]
  for (const s of staging) {
    if (!isValidTag(s.workspace_tag) || !isValidTag(s.resource_tag) || !isValidStagingId(s.staging_id)) {
      // Truncate fields — the full workspace_tag is an Ed25519 public
      // key and shouldn't land in operator logs verbatim. PR #4
      // review H3.
      console.warn(`reaper: skipping malformed staging row tag=${String(s.workspace_tag).slice(0, 12)}… res=${String(s.resource_tag).slice(0, 8)}… sid=${String(s.staging_id).slice(0, 8)}…`)
      continue
    }
    // ATOMIC conditional delete (replaces the old in-lock begun_at
    // re-read, PR #4 "F1"). The delete fires only if `begun_at` is
    // STILL older than the SAME `staleBefore` we snapshotted with — so
    // a concurrent REST PUT that finished its body and called
    // `refreshStagingBegunAt` (bumping begun_at to ~now, well after
    // `staleBefore`) makes the predicate fail: the row isn't deleted,
    // `deleteStagingIfStale` returns undefined, and we skip the unlink,
    // leaving the row for that PUT's commit. No lock, no TOCTOU window
    // between a read and a delete — the CAS is the whole check.
    const deleted = await handle.deleteStagingIfStale.get(s.workspace_tag, s.resource_tag, s.staging_id, staleBefore)
    if (!deleted) continue
    // The row was genuinely stale and we removed it; now drop its
    // bytes. Row-first, then unlink — symmetric with deleteObject in
    // store.ts. If a crash lands between them the bytes outlive the
    // row, and a later sweep's orphan-staging-file pass (or this
    // pass's idempotent unlink of an absent blob) self-heals.
    await handle.blob.unlinkStaging(s.workspace_tag, s.staging_id)
  }
}

// Sweep staging blobs whose row is missing — happens when a commit
// dropped the row but crashed before the unlink (Vercel: between
// the post-copy `del(staging)` and the DB delete; FS: not possible
// since rename removes the staging file), or after
// reapStaleStagingRows already nuked the row but the unlink failed.
// Per-blob row lookup (vs a snapshot at the caller) closes the race
// where a concurrent beginPut between snapshot-time and unlink-time
// would have its blob unlinked while the row was already in DB. The
// per-blob SELECT is sub-ms and sids are 16-byte random — a
// same-sid beginPut in the microsecond between our SELECT and
// unlink is 1/2^128. Also handles the malformed-row case: a row
// with valid (workspace_tag, staging_id) but malformed resource_tag
// still pins its blob. PR #4 review H1.
async function reapOrphanedStagingFiles(handle: Handle, tag: string): Promise<void> {
  if (!isValidTag(tag)) return
  const entries = await handle.blob.listStagingIds(tag)
  if (entries.length === 0) return
  for (const stagingId of entries) {
    // Same on-disk-foreign-file guard as reapUnreferencedForTag.
    if (!isValidStagingId(stagingId)) continue
    if (await handle.selectStagingByWsSid.get(tag, stagingId)) continue
    await handle.blob.unlinkStaging(tag, stagingId)
  }
}

export async function reapOrphans(handle: Handle, stagingTtlMs: number = STAGING_TTL_MS_DEFAULT): Promise<void> {
  const now = Date.now()
  // The GC grace window reuses the staging TTL: a live blob is only
  // eligible for unlink once it's unreferenced AND older than this.
  const grace = stagingTtlMs
  // Pass 1: tags the live table knows about — GC unreferenced live
  // blobs (past the grace window) against the referenced-hash set.
  let liveGc = 0
  const liveTagsRows = await handle.listLiveTags.all()
  const liveTags = liveTagsRows.map((r) => r.workspace_tag)
  for (const tag of liveTags) liveGc += await reapUnreferencedForTag(handle, tag, now, grace)
  // Whole-workspace deletes leave residue (dirs / blob-prefixes) the
  // live table no longer lists. Walk the backend's top-level workspace
  // listing to find them; for each straggler tag, GC its unreferenced
  // blobs the same way (the referenced-hash set for a fully-deleted
  // workspace is empty, so every past-grace blob is collected, while
  // the grace window + live-set re-read still protect a racing
  // put-begin → commit on a tag not in our `liveTags` snapshot).
  const topLevel = await handle.blob.listWorkspaceTags()
  const liveSet = new Set(liveTags)
  for (const tag of topLevel) {
    if (liveSet.has(tag) || !isValidTag(tag)) continue
    liveGc += await reapUnreferencedForTag(handle, tag, now, grace)
  }
  // Sweep-wide total. A nonzero count means the GC deleted live bytes
  // this pass — logged unconditionally so "all data went missing"
  // leaves an obvious server-side trail (a large count over a short
  // window is the signature). Per-blob lines above carry which/why.
  if (liveGc > 0) {
    console.warn(`objstore-reaper: swept ${liveTags.length} live + ${topLevel.length} store tag(s); GC'd ${liveGc} live blob(s)`)
  }
  // Pass 2: stale staging rows + orphan staging blobs. The orphan
  // sweep does per-blob row lookups (no caller-side snapshot), so a
  // beginPut that lands between our list and our unlink has its
  // row found by the fresh SELECT. PR #4 review H1.
  await reapStaleStagingRows(handle, now, stagingTtlMs)
  for (const tag of topLevel) {
    await reapOrphanedStagingFiles(handle, tag)
  }
}
