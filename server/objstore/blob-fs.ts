// Local-filesystem BlobBackend. Wraps the low-level fs primitives
// in ./fs.ts behind the backend-agnostic interface so the v1.objstore
// consumers (./store.ts, ./rest.ts, ./reaper.ts) can call uniformly
// against either FS or Vercel Blob (./blob-vercel.ts).
//
// Layout under `dir` (passed to `openFsBlobBackend`):
//   ${dir}/${workspaceTag}/${resourceTag}.bin             — live
//   ${dir}/${workspaceTag}/.staging/${stagingId}.bin      — staging
//
// The same shape the previous monolithic implementation used; tests
// that import `liveFilePath` / `stagingFilePath` from ./fs.ts still
// compute the right paths.

import { createWriteStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobBackend, OpenLiveResult, StagingWriter } from './blob.ts'
import {
  durableRenameStagedToLive,
  ensureStagingDir,
  liveFilePath,
  stagingFilePath,
  unlinkIfExists,
} from './fs.ts'

// Internal: tolerant readdir for the reaper / list helpers — a
// missing dir (workspace never had any state, or whole-workspace
// delete already swept it) returns []. Anything else (EACCES, EIO,
// …) bubbles up so the reaper's wrapping catch logs it.
async function safeReaddir(dir: string): Promise<string[]> {
  try { return await readdir(dir) } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return []
    throw err
  }
}

export function openFsBlobBackend(dir: string): BlobBackend {
  return {
    ensureWorkspace: (tag) => ensureStagingDir(dir, tag),

    // eslint-disable-next-line require-await
    openStagingWriter: async (tag, stagingId): Promise<StagingWriter> => {
      const path = stagingFilePath(dir, tag, stagingId)
      // `flags: 'w'` truncates an existing file. Concurrent replay
      // protection (the DB commit-lock in rest.ts) prevents two
      // writers from opening the same staging path; if that gate
      // is bypassed (test fixture, future refactor), the second
      // write would clobber the first.
      const writable = createWriteStream(path, { flags: 'w' })
      return {
        writable,
        // No-op: callers pipeline(req, counter, writable) which
        // already awaits 'finish' on the WriteStream. The fd is
        // closed by Node's stream machinery on 'finish'.
        finalize: async () => {},
        // `destroy(err)` synchronously starts tearing the stream
        // down; the WriteStream emits 'close' on the next tick.
        // For the FS backend there's no remote upload to wait for,
        // so we resolve immediately — the REST layer awaits but
        // doesn't block on anything real here. eslint-disable for
        // the no-await-in-async — the function signature is
        // dictated by the BlobBackend contract.
        // eslint-disable-next-line require-await
        abort: async (err) => { writable.destroy(err as Error) },
      }
    },

    statStaging: async (tag, stagingId): Promise<number | null> => {
      try {
        const s = await stat(stagingFilePath(dir, tag, stagingId))
        return s.size
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT') return null
        throw err
      }
    },

    promoteStagingToLive: (tag, stagingId, resourceTag) =>
      durableRenameStagedToLive(
        stagingFilePath(dir, tag, stagingId),
        liveFilePath(dir, tag, resourceTag),
      ),

    openLiveReader: async (tag, resourceTag): Promise<OpenLiveResult> => {
      const path = liveFilePath(dir, tag, resourceTag)
      let fh
      // `open(path, 'r')` failing with ENOENT means the live file is
      // gone (could be a stranded row + missing file the reaper will
      // reconcile, or a racing delete that landed between the DB
      // row check and this open). Either way the REST GET surface
      // is 'unavailable' (503) — the row says it exists but the
      // bytes aren't there right now.
      try { fh = await open(path, 'r') } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT') return { ok: false, reason: 'unavailable' }
        throw err
      }
      // Wrap stat in its own try/catch so a throw between open and
      // close doesn't leak the fd to GC. Same pattern as the
      // original openLiveUnderLock in rest.ts (PR #4 review H8).
      let size: number
      try { size = (await fh.stat()).size } catch {
        await fh.close().catch(() => {})
        return { ok: false, reason: 'unavailable' }
      }
      // `fh.createReadStream()` (not `fs.createReadStream(path, { fd })`)
      // — the FileHandle's own method binds the stream lifecycle to
      // the FileHandle, so the underlying fd is closed exactly once.
      // Using the raw-fd form double-closes (stream's autoClose +
      // FileHandle's finalizer) and the second close trips an
      // uncaughtException with EBADF, taking the whole process
      // down. The inode is pinned by the fh; even if the path is
      // unlinked or overwritten after this point, the stream reads
      // the snapshot the open captured.
      const stream = fh.createReadStream()
      let closed = false
      return {
        ok: true,
        reader: {
          stream,
          size,
          // Caller error before/after pipe — destroy the stream to
          // release the fh (FileHandle's createReadStream auto-
          // closes the fh on end/error). Guard with `closed` so
          // double-close from caller + auto-close from stream end
          // is a no-op rather than throwing.
          // eslint-disable-next-line require-await
          close: async () => {
            if (closed) return
            closed = true
            stream.destroy()
          },
        },
      }
    },

    unlinkStaging: (tag, stagingId) => unlinkIfExists(stagingFilePath(dir, tag, stagingId)),
    unlinkLive: (tag, resourceTag) => unlinkIfExists(liveFilePath(dir, tag, resourceTag)),

    listWorkspaceTags: () => safeReaddir(dir),

    // Live resources are top-level `.bin` files under
    // `${dir}/${tag}/`. The `.staging` subdirectory is excluded —
    // it's the staging-id namespace, returned by listStagingIds.
    // Filtering by `.bin` suffix tolerates operator-seeded foreign
    // files (PR #4 review H2: reaper refuses to unlink anything we
    // didn't write).
    listLiveResourceTags: async (tag) => {
      const entries = await safeReaddir(join(dir, tag))
      const out: string[] = []
      for (const name of entries) {
        if (name === '.staging' || !name.endsWith('.bin')) continue
        out.push(name.slice(0, -4))
      }
      return out
    },

    listStagingIds: async (tag) => {
      const entries = await safeReaddir(join(dir, tag, '.staging'))
      const out: string[] = []
      for (const name of entries) {
        if (!name.endsWith('.bin')) continue
        out.push(name.slice(0, -4))
      }
      return out
    },
  }
}
