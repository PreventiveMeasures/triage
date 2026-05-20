// Filesystem operations for the v1.objstore module — paths +
// async durable-write primitives. Post-startup callers go through
// `fs/promises` so a slow disk doesn't block the event loop and
// stall unrelated requests (WS heartbeats, other workspaces).
//
// `liveFilePath` / `stagingFilePath` are the canonical layout —
// the reaper derives the same shape. The base64url alphabet for
// tag / resourceTag / stagingId means no `..` traversal is
// reachable; validators in store.ts gate inputs at the wire
// boundary.

import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { errMsg } from '../util.ts'

export function liveFilePath(dir: string, tag: string, resourceTag: string): string {
  return join(dir, tag, `${resourceTag}.bin`)
}

export function stagingFilePath(dir: string, tag: string, stagingId: string): string {
  return join(dir, tag, '.staging', `${stagingId}.bin`)
}

export async function ensureStagingDir(root: string, tag: string): Promise<void> {
  await mkdir(join(root, tag, '.staging'), { recursive: true })
}

// fsync(staging) → rename(staging → live) → fsync(parent dir).
// Order matters: a crash post-rename pre-DB-write leaves a stranded
// committed-name file (reaper-cleaned), never the inverse. Any
// failure along the way (ENOENT on the staging file after a racing
// abort, EACCES, ENOSPC, EIO) → `false`, caller routes through
// abortPut. Directory fsync isn't supported on every filesystem;
// the inner catch silently no-ops there. PR #4 review.
export async function durableRenameStagedToLive(stagingPath: string, livePath: string): Promise<boolean> {
  try {
    let fh = await open(stagingPath, 'r')
    try { await fh.sync() } finally { await fh.close() }
    await rename(stagingPath, livePath)
    try {
      fh = await open(dirname(livePath), 'r')
      try { await fh.sync() } finally { await fh.close() }
    } catch { /* not all FS layers support directory fsync */ }
    return true
  } catch {
    return false
  }
}

// Tolerate ENOENT (expected race against the reaper / abort) but
// log everything else (EACCES/EROFS/EBUSY/EIO) — silently dropping
// those would let deletes "succeed" while files pile up on disk.
// Don't propagate: the DB-side row drop already committed by the
// time callers reach here, and the reaper picks up the stranded
// file on its next sweep. PR #4 review.
export async function unlinkIfExists(filePath: string): Promise<void> {
  try { await unlink(filePath) } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return
    // Log the basename only — the full path contains the workspace
    // tag (Ed25519 public key) and shouldn't go to operator logs
    // verbatim. PR #4 review H3.
    console.warn(`unlink …/${basename(filePath)} failed: ${code ?? errMsg(err)}`)
  }
}
