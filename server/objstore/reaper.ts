// Orphan reaper for the v1.objstore byte plane. Two passes:
//   1. Stranded committed blobs. Walk every workspace's live-blob
//      listing, cross-check against the live table. Blobs with no
//      row → unlink. Covers the "DELETE crashed between row-drop
//      and unlink" gap and the "commit crashed mid-promotion" dual-
//      blob case.
//   2. Stale staging. Rows in workspace_object_staging older than
//      `stagingTtlMs` → unlink + drop row. Staging blobs with no
//      row → unlink (catches a row drop that crashed before the
//      blob delete).
//
// Backend-agnostic: every storage operation goes through
// `handle.blob.*`. The FS backend (blob-fs.ts) implements list/
// unlink against the local filesystem; the Vercel backend (blob-
// vercel.ts) against the SDK's list / del. The reaper's race-
// handling discipline — re-check live row / staging row under the
// per-resource lock before unlinking — is identical for both.

import { type Handle, STAGING_TTL_MS_DEFAULT, isValidStagingId, isValidTag, lockKey } from './store.ts'
import { tryAcquireCommitLock } from './commit-lock.ts'

type StagingRow = {
  workspace_tag: string
  resource_tag: string
  staging_id: string
  begun_at: number
}

// Sweep one workspace's live-blob listing against the live-row set.
// Anything with no row → unlink. The live snapshot we read up front
// can race a concurrent commit (delete drops the row → put-begin →
// commit lands a fresh row + blob between our snapshot and the
// unlink). Re-check `selectLiveOne` under the per-resource lock so
// we never unlink a blob the live row points at. PR #4 review.
async function reapCommittedForTag(handle: Handle, tag: string): Promise<void> {
  if (!isValidTag(tag)) return
  const entries = await handle.blob.listLiveResourceTags(tag)
  if (entries.length === 0) return
  const liveRows = await handle.selectLive.all(tag)
  const live = new Set(liveRows.map((r) => r.resource_tag))
  for (const resourceTag of entries) {
    // Refuse to act on a foreign / malformed name — defense against
    // an operator-seeded blob, an SDK return shape regression, or a
    // future migration that introduces an unsanitised input. The
    // production write paths only ever produce base64url-shaped
    // resource tags.
    if (!isValidTag(resourceTag)) continue
    if (live.has(resourceTag)) continue
    // Try-acquire the DB commit lock (cross-replica gate). If
    // contended, another replica is mid-commit on this same key —
    // skip and let it land; we'll re-scan on the next sweep. This
    // closes the multi-replica race where replica A's reaper would
    // delete the live blob that replica B is about to commit, but
    // replica B's `upsertLive` hasn't landed yet. Without the DB
    // lock, replica A's in-process lock is uncontested (B's lock
    // is on a different process) and we'd unlink the in-flight
    // commit's bytes.
    const acquired = await tryAcquireCommitLock(handle, tag, resourceTag)
    if (!acquired.ok) continue
    try {
      await handle.lock.run(lockKey(tag, resourceTag), async () => {
        // Recheck under the lock — a commit that raced past our snapshot
        // landed a fresh row + blob; the blob we're about to unlink IS
        // that fresh commit's live blob. Skip.
        if (await handle.selectLiveOne.get(tag, resourceTag)) return
        await handle.blob.unlinkLive(tag, resourceTag)
      })
    } finally { await acquired.lock.release() }
  }
}

// Drop staging rows older than the TTL and unlink their on-storage
// blobs. Every row field that flows into a backend call is re-
// validated — DB tampering / a future migration that introduces an
// unsanitised column shouldn't be able to trick the reaper into
// touching unintended keys. PR #4 review.
async function reapStaleStagingRows(handle: Handle, now: number, stagingTtlMs: number): Promise<void> {
  // Push the staleness filter into SQL so the
  // `workspace_object_staging_begun_at_idx` index handles the scan.
  // The pre-lock-snapshot is now O(stale-rows) cluster-wide; the
  // per-lock fresh-read inside the loop still re-validates with the
  // current begun_at to catch a refresh that landed between
  // snapshot-time and lock-acquire-time. DB-layout audit
  // `server/objstore/store.ts:312`.
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
    // Re-check freshness INSIDE the lock against the row's current
    // begun_at, not the pre-lock snapshot. A concurrent REST PUT
    // calls `refreshStagingBegunAt` right after the body finishes
    // (and before queuing on this same lock for commit). If our
    // snapshot saw the row as stale but the refresh landed before
    // we acquired the lock, the freshness re-check here lets the
    // commit proceed. Without this, the reaper deletes a row whose
    // upload completed but whose commit hasn't acquired the lock
    // yet → client gets 410 after streaming the whole body. PR #4
    // review F1.
    await handle.lock.run(lockKey(s.workspace_tag, s.resource_tag), async () => {
      const fresh = await handle.selectStaging.get(s.workspace_tag, s.resource_tag, s.staging_id)
      if (!fresh) return
      if (Date.now() - fresh.begun_at < stagingTtlMs) return
      // DB row first, then unlink — symmetric with deleteObject in
      // store.ts. Inverting from the previous unlink-first order
      // closes a narrow crash window where the bytes are gone but
      // the row points at a missing path; the next reaper sweep's
      // unlink of an absent blob is a no-op, so the inverted
      // ordering self-heals via the reaper's idempotent re-sweep.
      // Concurrency audit `server/objstore/reaper.ts:94`.
      await handle.deleteStaging.run(s.workspace_tag, s.resource_tag, s.staging_id)
      await handle.blob.unlinkStaging(s.workspace_tag, s.staging_id)
    })
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
    // Same on-disk-foreign-file guard as reapCommittedForTag.
    if (!isValidStagingId(stagingId)) continue
    if (await handle.selectStagingByWsSid.get(tag, stagingId)) continue
    await handle.blob.unlinkStaging(tag, stagingId)
  }
}

export async function reapOrphans(handle: Handle, stagingTtlMs: number = STAGING_TTL_MS_DEFAULT): Promise<void> {
  const now = Date.now()
  // Pass 1: tags the live table knows about — cross-check committed
  // blobs against live rows.
  const liveTagsRows = await handle.listLiveTags.all()
  const liveTags = liveTagsRows.map((r) => r.workspace_tag)
  for (const tag of liveTags) await reapCommittedForTag(handle, tag)
  // Whole-workspace deletes leave residue (dirs / blob-prefixes)
  // that the live table doesn't list. Walk the backend's top-level
  // workspace listing to find them; the same per-resource lock +
  // re-check protects against racing put-begin → commit on a tag
  // not in our `liveTags` snapshot.
  const topLevel = await handle.blob.listWorkspaceTags()
  const liveSet = new Set(liveTags)
  for (const tag of topLevel) {
    if (liveSet.has(tag) || !isValidTag(tag)) continue
    const stragglers = await handle.blob.listLiveResourceTags(tag)
    for (const resourceTag of stragglers) {
      if (!isValidTag(resourceTag)) continue
      // Same cross-replica gate as reapCommittedForTag — skip on
      // contention so an in-flight commit's bytes aren't deleted.
      const acquired = await tryAcquireCommitLock(handle, tag, resourceTag)
      if (!acquired.ok) continue
      try {
        await handle.lock.run(lockKey(tag, resourceTag), async () => {
          if (await handle.selectLiveOne.get(tag, resourceTag)) return
          await handle.blob.unlinkLive(tag, resourceTag)
        })
      } finally { await acquired.lock.release() }
    }
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
