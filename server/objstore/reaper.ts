// Orphan reaper for the v1.objstore filesystem. Two passes:
//   1. Stranded committed files. Walk every workspace dir under
//      OBJSTORE_DIR, list `.bin` at the top level, cross-check
//      against the live table. Files with no row → unlink. Covers
//      the "DELETE crashed between row-drop and unlink" gap and
//      the "commit crashed mid-rename" dual-file case.
//   2. Stale staging. Files in `.staging/` whose row is missing OR
//      whose row is older than `stagingTtlMs` → unlink + drop row.
//
// Async (fs/promises) so a periodic sweep over a large filesystem
// doesn't block the event loop. DB queries stay sync (node:sqlite)
// and are sub-ms; the readdir / unlink costs are what scale.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type Handle, STAGING_TTL_MS_DEFAULT, isValidStagingId, isValidTag, lockKey } from './store.ts'
import { stagingFilePath, unlinkIfExists } from './fs.ts'

type StagingRow = {
  workspace_tag: string
  resource_tag: string
  staging_id: string
  begun_at: number
}

async function safeReaddir(dir: string): Promise<string[]> {
  try { return await readdir(dir) } catch { return [] }
}

// Sweep `.bin` files at the top level of one workspace dir against
// the set of live resource_tags. Anything with no row → unlink. The
// live snapshot we read up front can race a concurrent commit (delete
// drops the row → put-begin → commit lands a fresh row + file between
// our snapshot and the unlink). Re-check `selectLiveOne` under the
// per-resource lock so we never unlink a file the live row points at.
// PR #4 review.
async function reapCommittedForTag(handle: Handle, tag: string): Promise<void> {
  if (!isValidTag(tag)) return
  const wsDir = join(handle.dir, tag)
  const entries = await safeReaddir(wsDir)
  if (entries.length === 0) return
  const live = new Set(
    (handle.selectLive.all(tag) as Array<{ resource_tag: string }>).map((r) => r.resource_tag),
  )
  for (const name of entries) {
    if (name === '.staging' || !name.endsWith('.bin')) continue
    const resourceTag = name.slice(0, -4)
    // Skip a non-base64url filename — refuse to unlink anything we
    // didn't write ourselves, in case the dir was operator-seeded
    // with foreign files.
    if (!isValidTag(resourceTag)) continue
    if (live.has(resourceTag)) continue
    await handle.lock.run(lockKey(tag, resourceTag), async () => {
      // Recheck under the lock — a commit that raced past our snapshot
      // landed a fresh row + file; the file we're about to unlink IS
      // that fresh commit's live file. Skip.
      if (handle.selectLiveOne.get(tag, resourceTag)) return
      await unlinkIfExists(join(wsDir, name))
    })
  }
}

// Drop staging rows older than the TTL and unlink their on-disk
// files. Every row field that flows into a path is re-validated — DB
// tampering / a future migration that introduces an unsanitised
// column shouldn't be able to trick the reaper into unlinking
// outside `handle.dir`. PR #4 review.
async function reapStaleStagingRows(handle: Handle, now: number, stagingTtlMs: number): Promise<void> {
  const staging = handle.listAllStaging.all() as StagingRow[]
  for (const s of staging) {
    if (!isValidTag(s.workspace_tag) || !isValidTag(s.resource_tag) || !isValidStagingId(s.staging_id)) {
      // Truncate fields — the full workspace_tag is an Ed25519 public
      // key and shouldn't land in operator logs verbatim. PR #4
      // review H3.
      console.warn(`reaper: skipping malformed staging row tag=${String(s.workspace_tag).slice(0, 12)}… res=${String(s.resource_tag).slice(0, 8)}… sid=${String(s.staging_id).slice(0, 8)}…`)
      continue
    }
    if (now - s.begun_at < stagingTtlMs) continue
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
      const fresh = handle.selectStaging.get(s.workspace_tag, s.resource_tag, s.staging_id) as { begun_at: number } | undefined
      if (!fresh) return
      if (Date.now() - fresh.begun_at < stagingTtlMs) return
      await unlinkIfExists(stagingFilePath(handle.dir, s.workspace_tag, s.staging_id))
      handle.deleteStaging.run(s.workspace_tag, s.resource_tag, s.staging_id)
    })
  }
}

// Sweep `.staging/*.bin` files whose row is missing — happens when
// a commit dropped the row but crashed before the rename, or after
// reapStaleStagingRows already nuked the row but the file lingered.
// Row lookup per-file (vs a snapshot at the caller) closes the race
// where a concurrent beginPut between snapshot-time and unlink-time
// would have its file unlinked while the row was already in DB. The
// per-file SELECT is sub-ms and sids are 16-byte random — a
// same-sid beginPut in the microsecond between our SELECT and
// unlinkIfExists is 1/2^128. Also handles the malformed-row case:
// a row with valid (workspace_tag, staging_id) but malformed
// resource_tag still pins its file. PR #4 review H1.
async function reapOrphanedStagingFiles(handle: Handle, tag: string): Promise<void> {
  if (!isValidTag(tag)) return
  const stagingDir = join(handle.dir, tag, '.staging')
  const entries = await safeReaddir(stagingDir)
  if (entries.length === 0) return
  for (const name of entries) {
    if (!name.endsWith('.bin')) continue
    const stagingId = name.slice(0, -4)
    // Same on-disk-foreign-file guard as reapCommittedForTag.
    if (!isValidStagingId(stagingId)) continue
    if (handle.selectStagingByWsSid.get(tag, stagingId)) continue
    await unlinkIfExists(join(stagingDir, name))
  }
}

export async function reapOrphans(handle: Handle, stagingTtlMs: number = STAGING_TTL_MS_DEFAULT): Promise<void> {
  const now = Date.now()
  // Pass 1: tags the live table knows about — cross-check committed
  // files against live rows.
  const liveTags = (handle.listLiveTags.all() as Array<{ workspace_tag: string }>).map((r) => r.workspace_tag)
  for (const tag of liveTags) await reapCommittedForTag(handle, tag)
  // Whole-workspace deletes leave dirs that the live table doesn't
  // list. Walk the top-level dir to find them; unlink any orphaned
  // `.bin` files there too. Same race as `reapCommittedForTag`: a
  // concurrent put-begin → commit on a tag that wasn't in our
  // `liveTags` snapshot could land between safeReaddir and unlink.
  // Re-check `selectLiveOne` under the per-resource lock.
  const topLevel = await safeReaddir(handle.dir)
  const liveSet = new Set(liveTags)
  for (const tag of topLevel) {
    if (liveSet.has(tag) || !isValidTag(tag)) continue
    const wsDir = join(handle.dir, tag)
    for (const name of await safeReaddir(wsDir)) {
      if (name === '.staging' || !name.endsWith('.bin')) continue
      const resourceTag = name.slice(0, -4)
      if (!isValidTag(resourceTag)) continue
      await handle.lock.run(lockKey(tag, resourceTag), async () => {
        if (handle.selectLiveOne.get(tag, resourceTag)) return
        await unlinkIfExists(join(wsDir, name))
      })
    }
  }
  // Pass 2: stale staging rows + orphan staging files. The orphan
  // sweep does per-file row lookups (no caller-side snapshot), so a
  // beginPut that lands between our readdir and our unlink has its
  // row found by the fresh SELECT. PR #4 review H1.
  await reapStaleStagingRows(handle, now, stagingTtlMs)
  for (const tag of topLevel) {
    await reapOrphanedStagingFiles(handle, tag)
  }
}
