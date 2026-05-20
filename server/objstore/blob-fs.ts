// Local-filesystem BlobBackend. Wraps the low-level fs primitives
// in ./fs.ts behind the backend-agnostic interface so the v1.objstore
// consumers (./store.ts, ./rest.ts, ./reaper.ts) can call uniformly
// against either FS or Vercel Blob (./blob-vercel.ts).
//
// Layout under `dir` (passed to `openFsBlobBackend`):
//   ${dir}/${workspaceTag}/${contentHash}.bin            — live
//   ${dir}/${workspaceTag}/.staging/${stagingId}.bin     — staging
//
// Live blobs are content-addressed (the filename is the content hash,
// not the resourceTag) so a hash names exactly one immutable byte-
// string; tests that import `liveFilePath` / `stagingFilePath` from
// ./fs.ts compute the right paths.

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

// Open the content-addressed live blob for reading. ENOENT → the row
// references a hash whose blob is gone right now (racing delete/GC, or a
// stranded row) → `unavailable` (503). `fh.createReadStream()` (not the
// raw-fd form) binds the stream lifecycle to the FileHandle so the fd
// closes exactly once; the inode is pinned, so even if the path is
// unlinked/overwritten after open the stream reads the captured
// snapshot. The stat is wrapped so a throw between open and close
// doesn't leak the fd (PR #4 review H8).
async function fsOpenLiveReader(dir: string, tag: string, contentHash: string): Promise<OpenLiveResult> {
  const path = liveFilePath(dir, tag, contentHash)
  let fh
  try { fh = await open(path, 'r') } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: false, reason: 'unavailable' }
    throw err
  }
  let size: number
  try { size = (await fh.stat()).size } catch {
    await fh.close().catch(() => {})
    return { ok: false, reason: 'unavailable' }
  }
  const stream = fh.createReadStream()
  let closed = false
  return {
    ok: true,
    reader: {
      stream,
      size,
      // Guard double-close (caller close + stream-end auto-close).
      // eslint-disable-next-line require-await
      close: async () => { if (closed) return; closed = true; stream.destroy() },
    },
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

    promoteStagingToLive: (tag, stagingId, contentHash) =>
      durableRenameStagedToLive(
        stagingFilePath(dir, tag, stagingId),
        liveFilePath(dir, tag, contentHash),
      ),

    openLiveReader: (tag, contentHash) => fsOpenLiveReader(dir, tag, contentHash),

    unlinkStaging: (tag, stagingId) => unlinkIfExists(stagingFilePath(dir, tag, stagingId)),
    unlinkLive: (tag, contentHash) => unlinkIfExists(liveFilePath(dir, tag, contentHash)),

    listWorkspaceTags: () => safeReaddir(dir),

    // Live blobs are top-level `.bin` files under `${dir}/${tag}/`,
    // named by their content hash. The `.staging` subdirectory is
    // excluded — it's the staging-id namespace, returned by
    // listStagingIds. Filtering by `.bin` suffix tolerates operator-
    // seeded foreign files (PR #4 review H2: reaper refuses to unlink
    // anything we didn't write). Each entry carries its `mtimeMs` so
    // the reaper's GC grace window can skip blobs younger than the
    // grace (a just-promoted blob whose live row hasn't been read
    // into the GC's reference set yet). A blob that vanishes between
    // readdir and stat (a racing reaper/abort) is dropped from the
    // result — it's already gone, nothing to GC.
    listLiveBlobs: async (tag) => {
      const entries = await safeReaddir(join(dir, tag))
      const out: Array<{ hash: string; modifiedMs: number }> = []
      for (const name of entries) {
        if (name === '.staging' || !name.endsWith('.bin')) continue
        let modifiedMs: number
        try { modifiedMs = (await stat(join(dir, tag, name))).mtimeMs } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
          throw err
        }
        out.push({ hash: name.slice(0, -4), modifiedMs })
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
