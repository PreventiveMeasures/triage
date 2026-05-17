// Byte-plane abstraction for the v1.objstore module. The DB plane
// (Handle's statement set in ./store.ts) holds the metadata
// (workspace_object + workspace_object_staging); this interface
// holds the bytes those rows point at.
//
// Two implementations:
//   - ./blob-fs.ts        local filesystem (default; the only option
//                         for the single-process SQLite-backed DB
//                         plane)
//   - ./blob-vercel.ts    Vercel Blob Private Storage (paired with
//                         the Neon DB plane for multi-replica
//                         deployments)
//
// Selected at boot in `server/index.ts` and passed to `openObjstore`
// / `openNeonObjstore`. The DB-plane code in ./store.ts, ./rest.ts,
// and ./reaper.ts goes through `handle.blob.*` and is backend-
// agnostic — no `if (vercel) … else` branching in consumers.
//
// Crash-safety contract every backend MUST preserve, so the reaper's
// "stranded file, never row-points-at-nothing" guarantee holds:
//   PUT commit:  bytes durable in staging → promote → DB write
//   DELETE:      DB write → unlink (best-effort; not-found ok)
// A crash at the worst moment leaves at most a stranded blob (the
// reaper cleans these on its periodic sweep). The FS backend uses
// fsync + rename; the Vercel backend uses copy + delete (Vercel's
// copy is atomic per-blob, so the cross-blob staging→live transition
// can produce a stranded staging blob if del fails, but never a
// half-written live blob).

import type { Readable, Writable } from 'node:stream'

// Streaming writer for a staging slot. The REST PUT handler pipes
// the request body through `writable`, then awaits `finalize()` to
// confirm the upload landed. `abort(err)` is the cancel path the
// REST layer invokes on body error / overrun / length mismatch;
// implementations propagate the cancel to the underlying upload
// (createWriteStream.destroy for FS, AbortController.abort for
// fetch-based remote stores).
//
// `abort` returns a Promise that resolves once the underlying
// upload has actually torn down — for the FS backend this is
// immediate, but for fetch-based stores the SDK's in-flight HTTP
// request may take several seconds to register the abort. The REST
// layer MUST await `abort()` before running cleanup (e.g. blob
// del) so a late-arriving upload chunk can't recreate the staging
// blob after we've cleaned it up.
//
// The writable is NOT auto-flushed on return — the caller is
// responsible for either ending it through pipeline() (which awaits
// 'finish' on Writables / 'end' on Transforms) or calling
// writable.end() manually before finalize().
export type StagingWriter = {
  writable: Writable
  finalize(): Promise<void>
  abort(err: unknown): Promise<void>
}

// Readable handle for a live blob. `size` is the byte length the
// backend confirmed on open (used to set Content-Length on the GET
// response and to validate against the live row's content_length
// before piping). `close()` releases backend-side resources
// (file descriptor for FS, fetch reader for remote stores) and is
// called by the REST GET handler on error before pipelining.
export type LiveReader = {
  stream: Readable
  size: number
  close(): Promise<void>
}

// `not-found` maps to HTTP 404 (the live blob is gone or never
// existed); `unavailable` maps to HTTP 503 (transient backend issue
// the reaper will eventually sort out). The REST layer uses this
// discrimination to set the right status code.
export type OpenLiveResult =
  | { ok: true; reader: LiveReader }
  | { ok: false; reason: 'not-found' | 'unavailable' }

export type BlobBackend = {
  // Per-workspace setup. FS creates the on-disk staging directory;
  // blob stores have no real folder concept (the pathname's slashes
  // are presentational) so this is a no-op there.
  ensureWorkspace(tag: string): Promise<void>

  // Open a streaming writer to the staging slot identified by
  // (tag, stagingId). The returned `writable` can absorb up to
  // MAX_CONTENT_LENGTH bytes; the REST layer's counter enforces the
  // declared length upstream.
  openStagingWriter(tag: string, stagingId: string): Promise<StagingWriter>

  // Return the storage-side byte count of the staging slot, or null
  // if it's missing. The REST PUT layer uses this as the belt-and-
  // braces size verification after the request body has been fully
  // consumed; commitPut re-stats under the per-resource lock as a
  // last line of defense before promotion.
  statStaging(tag: string, stagingId: string): Promise<number | null>

  // Promote staging → live. Returns true on success, false on any
  // I/O error. The caller (commitPut) has already validated size and
  // re-checked the version precondition under the per-resource lock;
  // this method just performs the bytes-side transition.
  //
  // Crash safety: implementations MUST ensure that a crash mid-
  // promotion leaves at most a stranded staging blob (reaper-
  // cleanable), never a partial live blob. FS uses fsync+rename;
  // Vercel uses atomic-copy followed by best-effort staging delete.
  promoteStagingToLive(tag: string, stagingId: string, resourceTag: string): Promise<boolean>

  // Open a streaming reader for the live blob. `not-found` lets the
  // REST layer return 404; `unavailable` returns 503 for a transient
  // state (file/blob missing while the row still exists — reaper
  // will reconcile on the next sweep).
  openLiveReader(tag: string, resourceTag: string): Promise<OpenLiveResult>

  // Idempotent deletes. Backends MUST tolerate "already gone" as
  // success (FS: ENOENT; Vercel: BlobNotFoundError) — abortPut and
  // deleteObject rely on this for retry idempotence, and the reaper
  // races against concurrent operations on the same key.
  unlinkStaging(tag: string, stagingId: string): Promise<void>
  unlinkLive(tag: string, resourceTag: string): Promise<void>

  // Reaper enumeration helpers. Each returns identifiers stripped of
  // any backend-specific suffix (`.bin` etc.) — the reaper compares
  // them against the DB's `resource_tag` / `staging_id` strings.
  // Implementations MAY paginate internally; the reaper consumes the
  // returned full list per workspace.
  //
  // `listWorkspaceTags()` returns every tag with ANY trace of state
  // (live or staging). The reaper uses it to find dirs/prefixes the
  // live table no longer knows about (whole-workspace deletes leave
  // residue the per-tag sweep would otherwise miss).
  listWorkspaceTags(): Promise<string[]>
  listLiveResourceTags(tag: string): Promise<string[]>
  listStagingIds(tag: string): Promise<string[]>
}
