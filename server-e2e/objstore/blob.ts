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
// Selected at boot in `server-e2e/index.ts` and passed to `openObjstore`
// / `openNeonObjstore`. The DB-plane code in ./store.ts, ./rest.ts,
// and ./reaper.ts goes through `handle.blob.*` and is backend-
// agnostic — no `if (vercel) … else` branching in consumers.
//
// Live blobs are CONTENT-ADDRESSED: a live blob lives at
// `${tag}/${contentHash}.bin`, where `contentHash` is the client-
// supplied, signed, server-opaque hash on the staging row. Because a
// hash names exactly one byte-string, the live blob is immutable —
// two racing commits write to DIFFERENT addresses, neither overwrites
// the other, and the DB row's `content_hash` literally NAMES its blob
// file (so "row says hash B, blob holds bytes A" is impossible). The
// hash is workspace-namespaced under `${tag}/`, so this is never a
// global content-addressed store. `unlinkLive` is therefore only ever
// called by the reaper's GC — commit + delete never unlink a live blob
// inline. Reclamation is deferred (not because a blob is shared — a
// random nonce per encrypt makes each PUT's hash unique) so it can't
// race a concurrent commit's promote→CAS window or an in-flight GET;
// see the grace-window rationale in reaper.ts.
//
// Crash-safety contract every backend MUST preserve, so the reaper's
// "stranded file, never row-points-at-nothing" guarantee holds:
//   PUT commit:  bytes durable in staging → promote → DB write
//   DELETE:      DB write (the reaper GCs the now-unreferenced blob)
// A crash at the worst moment leaves at most a stranded blob (the
// reaper cleans these on its periodic sweep, once the blob is both
// unreferenced and older than the GC grace window). The FS backend
// uses fsync + rename; the Vercel backend uses copy + delete (Vercel's
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

// A missing blob is always `unavailable` (→ HTTP 503), never a 404. The
// byte plane has NO view of the metadata row, so it can't decide whether
// a resource "doesn't exist" — only whether specific bytes are present
// right now. The authoritative "this resource/version is gone" 404 is the
// REST layer's call, made from the live row BEFORE it opens a reader
// (rest.ts openLiveSnapshot). By the time `openLiveReader` runs the row is
// already confirmed, so an absent blob means a transient bytes/metadata
// desync the reaper (or store propagation) reconciles — exactly the
// `unavailable`/503 contract, which the client retries. Both backends MUST
// map a missing blob to `unavailable` (FS: ENOENT; Vercel: BlobNotFoundError
// / null get()). No 404-mapping variant exists here so that bug can't recur.
//
// `detail` is a short, NON-SENSITIVE machine tag for the specific cause
// (e.g. 'vercel-get-not-found', 'fs-enoent', 'vercel-no-size'). Every
// byte-side failure collapses to the same 503 on the wire, so a permanent
// loss (reaper GC'd the bytes) and a transient read fault are otherwise
// indistinguishable — the REST layer logs `detail` so an operator can tell
// them apart. Purely diagnostic; the REST status is unchanged.
export type OpenLiveResult =
  | { ok: true; reader: LiveReader }
  | { ok: false; reason: 'unavailable'; detail?: string }

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
  // consumed; commitPut re-stats as a last line of defense against a
  // short/truncated upload before promotion (the staging slot is
  // single-writer — its stagingId is freshly random per begin).
  statStaging(tag: string, stagingId: string): Promise<number | null>

  // Promote staging → live at the CONTENT-ADDRESSED live path
  // `${tag}/${contentHash}.bin`. Returns true on success, false on
  // any I/O error. The caller (commitPut) has already validated size;
  // this method just performs the bytes-side transition. Because the
  // live address IS the content hash, any write to that path is
  // byte-identical by construction, so a retried or racing promote to
  // the same path is an idempotent rewrite, never a clobber. (Distinct
  // PUTs get distinct hashes — a random nonce per encrypt makes each
  // ciphertext unique — so they write distinct paths.)
  //
  // Crash safety: implementations MUST ensure that a crash mid-
  // promotion leaves at most a stranded staging blob (reaper-
  // cleanable), never a partial live blob. FS uses fsync+rename;
  // Vercel uses atomic-copy followed by best-effort staging delete.
  promoteStagingToLive(tag: string, stagingId: string, contentHash: string): Promise<boolean>

  // Open a streaming reader for the content-addressed live blob.
  // Called only after the REST layer has confirmed the live row, so a
  // missing blob is the transient "row present, bytes gone" state →
  // `unavailable` (HTTP 503), which the reaper reconciles and the client
  // retries. Never a 404 from here — see OpenLiveResult above.
  openLiveReader(tag: string, contentHash: string): Promise<OpenLiveResult>

  // Idempotent deletes. Backends MUST tolerate "already gone" as
  // success (FS: ENOENT; Vercel: BlobNotFoundError) — abortPut relies
  // on this for retry idempotence, and the reaper races against
  // concurrent operations on the same key. `unlinkLive` is called
  // ONLY by the reaper's GC (commit / delete never unlink a live blob
  // inline — reclamation is deferred to the grace-window GC so it can't
  // race a commit's promote→CAS window or an in-flight GET; not because
  // the blob is shared — hashes are unique per PUT).
  unlinkStaging(tag: string, stagingId: string): Promise<void>
  unlinkLive(tag: string, contentHash: string): Promise<void>

  // Reaper enumeration helpers. Implementations MAY paginate
  // internally; the reaper consumes the returned full list per
  // workspace.
  //
  // `listWorkspaceTags()` returns every tag with ANY trace of state
  // (live or staging). The reaper uses it to find dirs/prefixes the
  // live table no longer knows about (whole-workspace deletes leave
  // residue the per-tag sweep would otherwise miss).
  //
  // `listLiveBlobs(tag)` returns every live blob under the tag with
  // its `hash` (the `.bin`-stripped content hash) AND `modifiedMs`
  // (last-modified epoch-ms: FS mtime / Vercel `uploadedAt`). The GC
  // needs the timestamp for the age grace window — a blob is only
  // eligible for unlink once it's BOTH unreferenced by any live row
  // AND older than the grace, so a just-promoted but not-yet-
  // referenced blob isn't reaped out from under an in-flight commit.
  //
  // `listStagingIds(tag)` returns staging ids stripped of the `.bin`
  // suffix — the reaper compares them against the DB's `staging_id`.
  listWorkspaceTags(): Promise<string[]>
  listLiveBlobs(tag: string): Promise<Array<{ hash: string; modifiedMs: number }>>
  listStagingIds(tag: string): Promise<string[]>
}
