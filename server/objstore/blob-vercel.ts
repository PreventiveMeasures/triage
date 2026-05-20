// Vercel Blob Private Storage BlobBackend. Paired with the Neon DB
// plane in `server/index.ts` when `BLOB_READ_WRITE_TOKEN` is set;
// the combination is the supported multi-replica deployment shape
// (Neon for metadata, Vercel Blob for bytes — both serverless, both
// HTTP-backed, no shared filesystem required).
//
// `@vercel/blob` is an OPTIONAL peer dep — loaded lazily inside
// `openVercelBlobBackend` below so a SQLite/FS deployment never
// reaches the import. Same dynamic-import pattern as db-neon.ts.
//
// Pathname layout (mirrors the FS backend's directory layout so the
// reaper logic stays identical):
//   ${tag}/${resourceTag}.bin               — live
//   ${tag}/.staging/${stagingId}.bin        — staging
//
// All blobs are created with `access: 'private'` so the URL alone
// is not sufficient to fetch them; every read/write goes through the
// token. The downstream REST GET layer pipes the SDK's `get()`
// stream straight to the response without ever materialising the
// public URL.
//
// Crash-safety contract (mirrors blob-fs.ts but via copy+del instead
// of fsync+rename):
//   PUT commit:  put(staging) → copy(staging → live) → del(staging)
//                → DB write
//   DELETE:      DB write → del(live)  (best-effort; not-found ok)
// A crash mid-`copy` leaves NO live blob (Vercel's copy is atomic
// per-blob). A crash between `copy` and `del(staging)` leaves a
// stranded staging blob; the reaper's stale-staging TTL sweep picks
// it up. A crash between `copy+del` and DB write leaves a live blob
// whose DB row hasn't been bumped — the reaper's
// reapCommittedForTag pass sees a live blob with no live row → del.

import { PassThrough, type Readable } from 'node:stream'
import { Buffer } from 'node:buffer'
import type { BlobBackend, OpenLiveResult, StagingWriter } from './blob.ts'
import { errMsg } from '../util.ts'

// Minimal structural shape of the bits of `@vercel/blob` we use.
// Kept local so the optional peer dep doesn't have to type-resolve
// for SQLite-only deployments. Real type details live in the
// installed package; the fields/parameters we touch here are stable
// per the SDK v2 public surface.
//
// `put` accepts the SDK's full `PutBody` union (string | Readable |
// Buffer | Blob | ArrayBuffer | ReadableStream | File). We only ever
// pass a Node `PassThrough` (a Readable), but the wider type lets
// callers reuse this signature for future buffer/blob bodies without
// type gymnastics. `copy` accepts `allowOverwrite` — REQUIRED for
// version bumps since the live pathname is reused on re-upload.
type VercelBlobBody = Readable | Buffer | string | Blob | ArrayBuffer | ReadableStream<Uint8Array>
type VercelBlobSdk = {
  put: (
    pathname: string,
    body: VercelBlobBody,
    options: {
      access: 'private' | 'public'
      allowOverwrite?: boolean
      contentType?: string
      token?: string
      multipart?: boolean
      abortSignal?: AbortSignal
      cacheControlMaxAge?: number
    },
  ) => Promise<{ url: string; pathname: string }>
  head: (
    pathname: string,
    options?: { token?: string; abortSignal?: AbortSignal },
  ) => Promise<{ size: number; pathname: string; url: string }>
  get: (
    pathname: string,
    options: {
      access: 'private' | 'public'
      token?: string
      useCache?: boolean
      abortSignal?: AbortSignal
    },
  ) => Promise<{
    statusCode: 200 | 304
    stream: ReadableStream<Uint8Array> | null
    blob: { size: number | null }
  } | null>
  copy: (
    fromPathname: string,
    toPathname: string,
    options: {
      access: 'private' | 'public'
      allowOverwrite?: boolean
      token?: string
      contentType?: string
      cacheControlMaxAge?: number
    },
  ) => Promise<{ url: string; pathname: string }>
  del: (
    urlOrPathname: string | string[],
    options?: { token?: string; abortSignal?: AbortSignal },
  ) => Promise<void>
  list: (options: {
    prefix?: string
    cursor?: string
    limit?: number
    mode?: 'expanded' | 'folded'
    token?: string
  }) => Promise<{
    blobs: Array<{ pathname: string; size: number }>
    folders?: string[]
    cursor?: string
    hasMore: boolean
  }>
}

// Recognise "blob is gone" errors uniformly across read/write/delete
// paths so callers can treat them as success (delete) or
// not-found (read). The SDK exposes BlobNotFoundError as a class
// with `.name === 'BlobNotFoundError'`; checking the name string
// avoids importing the class at the top level (which would force
// the optional peer dep to resolve).
//
// Class-name check ONLY. The SDK's internal mapper translates every
// API `not_found` code into BlobNotFoundError-by-name; a bare-404
// transport leak doesn't reach here. A prior version of this
// function had a `/does not exist|\b404\b/` fallback that
// DANGEROUSLY matched BlobStoreNotFoundError's message "This store
// does not exist." — a config fault (revoked token, deleted store)
// would silently surface as every-blob-missing across reads and
// unlinks, masking the fatal misconfiguration. The tight name check
// lets BlobStoreNotFoundError / other classes propagate as real
// exceptions.
function isNotFound(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const name = (err as { name?: unknown }).name
  return typeof name === 'string' && name === 'BlobNotFoundError'
}

function liveBlobPath(tag: string, resourceTag: string): string {
  return `${tag}/${resourceTag}.bin`
}
function stagingBlobPath(tag: string, stagingId: string): string {
  return `${tag}/.staging/${stagingId}.bin`
}

// Strip a `.bin` suffix and reject anything else. Same defensive
// shape the FS backend uses (the reaper refuses to touch foreign
// files). The validator in store.ts rejects malformed tags at the
// wire boundary; this is belt-and-braces for the listing path.
function stripBinSuffix(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix) || !pathname.endsWith('.bin')) return null
  return pathname.slice(prefix.length, -4)
}

// Exhaust a paginated list() call. Vercel returns a cursor when
// hasMore is true; we walk it to completion so the reaper gets every
// blob. The 1000-per-page default limit means a workspace with N
// resources costs ceil(N/1000) round-trips — acceptable for the
// periodic sweep cadence (10 minutes by default).
async function listAll(
  sdk: VercelBlobSdk,
  opts: { prefix?: string; mode?: 'expanded' | 'folded'; token: string },
): Promise<{ blobs: Array<{ pathname: string }>; folders: string[] }> {
  const blobs: Array<{ pathname: string }> = []
  const folders: string[] = []
  let cursor: string | undefined
  // Bounded loop to defend against a misbehaving driver that returns
  // `hasMore: true` with no cursor (would infinite-loop otherwise).
  // 10k pages × 1000 entries = 10M entries — far past the 100-
  // resource per-workspace cap. Hitting this is a server-side bug;
  // log and stop rather than spinning.
  for (let i = 0; i < 10_000; i++) {
    const callOpts: Parameters<VercelBlobSdk['list']>[0] = { token: opts.token }
    if (opts.prefix !== undefined) callOpts.prefix = opts.prefix
    if (opts.mode !== undefined) callOpts.mode = opts.mode
    if (cursor !== undefined) callOpts.cursor = cursor
    const page = await sdk.list(callOpts)
    for (const b of page.blobs) blobs.push({ pathname: b.pathname })
    if (page.folders) for (const f of page.folders) folders.push(f)
    if (!page.hasMore) return { blobs, folders }
    if (!page.cursor) {
      console.warn('vercel-blob list: hasMore=true with no cursor; stopping')
      return { blobs, folders }
    }
    cursor = page.cursor
  }
  console.warn('vercel-blob list: exceeded 10k pages; returning partial result')
  return { blobs, folders }
}

// Per-method builders — extracted so `openVercelBlobBackend` stays
// within the max-lines-per-function budget. Each closes over the
// SDK instance + token. Same shape as the per-statement builders
// in store-neon.ts.

function buildOpenStagingWriter(sdk: VercelBlobSdk, token: string): BlobBackend['openStagingWriter'] {
  // eslint-disable-next-line require-await
  return async (tag, stagingId): Promise<StagingWriter> => {
    // PassThrough is the bridge — the REST PUT pipeline writes
    // into it (Node-stream side), and the SDK's `put` reads from
    // it (web-stream-or-Node-stream, the SDK supports both). When
    // the pipeline ends the PT, `put` sees EOF and finalises its
    // upload.
    const pt = new PassThrough()
    const ac = new AbortController()
    const putPromise = sdk.put(stagingBlobPath(tag, stagingId), pt, {
      access: 'private',
      // Staging keys are 16-byte random base64url; a collision is
      // 1/2^128. `allowOverwrite: true` keeps a retry of the same
      // stagingId from failing with the SDK's default "exists"
      // error — the REST layer's `inFlightSids` set already
      // prevents concurrent writes to the same sid.
      allowOverwrite: true,
      contentType: 'application/octet-stream',
      token,
      // Multipart for streaming uploads with unknown / large size.
      // Required so the SDK doesn't try to buffer the whole body
      // before initiating the upload — we cap at 100 MiB but the
      // SDK shouldn't hold that in memory either.
      multipart: true,
      abortSignal: ac.signal,
    })
    // Defuse a possible unhandled-rejection if abort() is called
    // BEFORE finalize() (the REST layer's error path). Attach a
    // detached `.catch` on the original promise so an early
    // rejection has a handler; finalize() awaits `putPromise`
    // directly, which still re-throws the original rejection
    // (the .catch returns a separate chain that doesn't replace
    // putPromise's state).
    putPromise.catch(() => {})
    return {
      writable: pt,
      // Await the upload's completion. After pipeline(req, counter,
      // pt) resolves, pt has emitted 'end' on the read side and
      // `put` is finalising the last multipart part. Awaiting here
      // gives us the same "bytes durable" guarantee that
      // pipeline-to-WriteStream gives the FS backend.
      finalize: async () => { await putPromise },
      // Await the SDK's put-promise settlement (rejected via the
      // AbortController). Without this await, a slow upload that
      // the REST layer thinks it canceled can KEEP UPLOADING in
      // the background for several seconds, racing the post-abort
      // staging-blob deletion and silently recreating it. The
      // putPromise.catch() above swallows the abort rejection so
      // awaiting the .catch chain here doesn't re-throw.
      abort: async (err) => {
        // Order: tear down the source FIRST so the SDK sees an
        // immediate end of body, then signal AbortController so
        // the SDK can cancel in-flight HTTP requests. Destroying
        // the PassThrough alone isn't enough on every SDK version
        // — the AbortSignal is the documented cancel surface.
        pt.destroy(err as Error)
        try { ac.abort(err) } catch {}
        // Wait for the SDK to actually settle. Expected rejection
        // is BlobRequestAbortedError from the SDK's internal abort
        // wiring. Anything ELSE — e.g. BlobServiceNotAvailable or
        // a multipart upload that hit a quota before abort fired —
        // is operationally interesting and would otherwise be lost
        // since the caller already routed to its catch block on
        // the original pipeline error. Log it (truncated) instead
        // of silently swallowing.
        try { await putPromise }
        catch (settle: unknown) {
          const settleErr = settle as { name?: unknown; message?: unknown }
          if (settleErr?.name !== 'BlobRequestAbortedError') {
            console.warn(`vercel-blob put settled with non-abort error after cancel: ${String(settleErr?.name ?? '<unknown>')} ${String(settleErr?.message ?? '').slice(0, 200)}`)
          }
        }
      },
    }
  }
}

function buildStatStaging(sdk: VercelBlobSdk, token: string): BlobBackend['statStaging'] {
  return async (tag, stagingId): Promise<number | null> => {
    try {
      const h = await sdk.head(stagingBlobPath(tag, stagingId), { token })
      return h.size
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }
}

function buildPromoteStagingToLive(sdk: VercelBlobSdk, token: string): BlobBackend['promoteStagingToLive'] {
  return async (tag, stagingId, resourceTag): Promise<boolean> => {
    const from = stagingBlobPath(tag, stagingId)
    const to = liveBlobPath(tag, resourceTag)
    try {
      // `copy` is atomic per the SDK contract — either the new
      // pathname carries the full source bytes, or it fails. No
      // partial state at the destination.
      //
      // `allowOverwrite: true` is REQUIRED for version bumps — the
      // live pathname `${tag}/${resourceTag}.bin` is reused across
      // commits (each new version overwrites the prior). Without
      // this, the SDK sends `x-allow-overwrite: 0` (verified against
      // @vercel/blob 2.3.3 source) and Vercel rejects the second
      // commit with BlobAccessError, breaking every re-upload.
      await sdk.copy(from, to, {
        access: 'private',
        allowOverwrite: true,
        token,
        contentType: 'application/octet-stream',
        // Short cache TTL so the CDN can't serve a stale version of
        // a private blob after a re-upload. Private blobs use the
        // CDN by default (see openLiveReader's useCache: false);
        // belt-and-braces here for any path that pulls bypassing
        // the get() helper.
        cacheControlMaxAge: 60,
      })
    } catch (err) {
      console.warn('vercel-blob promote: copy failed:', errMsg(err))
      return false
    }
    // Staging-blob cleanup runs in the caller AFTER upsertLive so a
    // crash between copy() and the DB write leaves the staging blob
    // intact (commit can be retried). Same ordering principle the
    // FS backend gets implicitly from rename's atomicity.
    return true
  }
}

function buildOpenLiveReader(sdk: VercelBlobSdk, token: string): BlobBackend['openLiveReader'] {
  return async (tag, resourceTag): Promise<OpenLiveResult> => {
    const path = liveBlobPath(tag, resourceTag)
    let res
    // `useCache: false` — bypass Vercel's CDN cache so a re-upload
    // (same pathname, new version) is immediately visible. The CDN
    // cache for private blobs is on by default and would otherwise
    // serve a stale prior version for up to `cacheControlMaxAge`
    // seconds (defaults to 30 days; we cap at 60s on put/copy as
    // belt-and-braces). Origin fetch is the right default for a
    // versioned store where freshness > latency.
    try { res = await sdk.get(path, { access: 'private', useCache: false, token }) } catch (err) {
      if (isNotFound(err)) return { ok: false, reason: 'not-found' }
      throw err
    }
    if (res == null) return { ok: false, reason: 'not-found' }
    // statusCode 304 doesn't reach here in practice — the REST
    // GET layer doesn't pass If-None-Match — but a future call
    // site could. Treat as unavailable rather than streaming a
    // null body.
    if (res.statusCode !== 200 || res.stream == null || res.blob.size == null) {
      return { ok: false, reason: 'unavailable' }
    }
    // SDK returns a web ReadableStream<Uint8Array>; the REST layer
    // expects a Node Readable for pipeline(). Convert via
    // Readable.fromWeb — built-in and zero-copy where possible.
    const { Readable: NodeReadable } = await import('node:stream')
    const nodeStream = NodeReadable.fromWeb(res.stream as Parameters<typeof NodeReadable.fromWeb>[0])
    return {
      ok: true,
      reader: {
        stream: nodeStream,
        size: res.blob.size,
        // eslint-disable-next-line require-await
        close: async () => {
          // Destroying the Node wrapper also cancels the underlying
          // web stream reader (Readable.fromWeb installs the
          // cleanup). Tolerate errors — close() is idempotent and
          // may be called after the stream already finished.
          try { nodeStream.destroy() } catch {}
        },
      },
    }
  }
}

function buildUnlink(sdk: VercelBlobSdk, token: string, op: 'staging' | 'live', toPath: (tag: string, id: string) => string): (tag: string, id: string) => Promise<void> {
  return async (tag, id) => {
    try { await sdk.del(toPath(tag, id), { token }) } catch (err) {
      if (isNotFound(err)) return
      // Don't propagate — the DB-side row drop has already
      // committed by the time the caller reaches here, and the
      // reaper picks up the stranded blob on its next sweep. Same
      // policy as FS unlinkIfExists (PR #4 review).
      console.warn(`vercel-blob unlink ${op} failed:`, errMsg(err))
    }
  }
}

function buildListWorkspaceTags(sdk: VercelBlobSdk, token: string): BlobBackend['listWorkspaceTags'] {
  return async (): Promise<string[]> => {
    const { folders } = await listAll(sdk, { mode: 'folded', token })
    const out: string[] = []
    for (const f of folders) {
      // Folder names come back with trailing slash, e.g. "ws-1/".
      // Strip it to get the bare tag.
      const tag = f.endsWith('/') ? f.slice(0, -1) : f
      if (tag.length > 0) out.push(tag)
    }
    return out
  }
}

// Shared helper for the two per-prefix list builders. Both walk
// `list({ prefix, mode })` and strip the prefix + `.bin` suffix
// from each blob's pathname to recover the bare id. Entries whose
// remainder contains a `/` are skipped — they're inside a deeper
// sub-prefix (e.g. listing `${tag}/` shouldn't surface staging blobs
// under `${tag}/.staging/`).
function buildListIds(sdk: VercelBlobSdk, token: string, mkPrefix: (tag: string) => string, mode?: 'folded'): (tag: string) => Promise<string[]> {
  return async (tag) => {
    const prefix = mkPrefix(tag)
    const opts: Parameters<typeof listAll>[1] = { prefix, token }
    if (mode !== undefined) opts.mode = mode
    const { blobs } = await listAll(sdk, opts)
    const out: string[] = []
    for (const b of blobs) {
      const id = stripBinSuffix(b.pathname, prefix)
      if (id == null || id.includes('/')) continue
      out.push(id)
    }
    return out
  }
}

export type VercelBlobBackendOptions = {
  // Vercel Blob R/W token, typically from BLOB_READ_WRITE_TOKEN.
  // The SDK also reads it from process.env, but passing it
  // explicitly here keeps the env-var → boot config path single-
  // sourced through server/index.ts (matches the Neon DATABASE_URL
  // handling — env-read at boot, threaded as a parameter).
  token: string
  // Test seam: inject a stub of the @vercel/blob module to avoid
  // pulling the real SDK / hitting the network in unit tests. When
  // absent, the real package is dynamic-imported.
  sdk?: VercelBlobSdk
}

export async function openVercelBlobBackend(opts: VercelBlobBackendOptions): Promise<BlobBackend> {
  // Dynamic import so a SQLite/FS deployment never reaches the peer
  // dep. `@ts-ignore` (not `@ts-expect-error`) so an operator who
  // DOES install `@vercel/blob` doesn't trip TS2578 "unused
  // directive" — same pattern as db-neon.ts.
  const sdk: VercelBlobSdk = opts.sdk ?? (await loadSdk())
  const token = opts.token
  return {
    // No-op: Vercel Blob has no folder concept. The pathname's
    // slashes are presentational only — listing with mode: 'folded'
    // synthesises the "directory" view client-side.
    // eslint-disable-next-line require-await
    ensureWorkspace: async () => {},
    openStagingWriter: buildOpenStagingWriter(sdk, token),
    statStaging: buildStatStaging(sdk, token),
    promoteStagingToLive: buildPromoteStagingToLive(sdk, token),
    openLiveReader: buildOpenLiveReader(sdk, token),
    unlinkStaging: buildUnlink(sdk, token, 'staging', stagingBlobPath),
    unlinkLive: buildUnlink(sdk, token, 'live', liveBlobPath),
    // Workspace tags = top-level folders. `mode: 'folded'` with no
    // prefix returns folder names at the store root; each folder is
    // one workspace.
    listWorkspaceTags: buildListWorkspaceTags(sdk, token),
    // `mode: 'folded'` keeps `.staging/` rolled up as a folder
    // entry (filtered out below) rather than expanded into the
    // blobs[] array — without it, listing a workspace prefix would
    // double-count every staging blob as a live resource.
    listLiveResourceTags: buildListIds(sdk, token, (tag) => `${tag}/`, 'folded'),
    listStagingIds: buildListIds(sdk, token, (tag) => `${tag}/.staging/`),
  }
}

async function loadSdk(): Promise<VercelBlobSdk> {
  // @ts-ignore optional peer dep: '@vercel/blob'
  const mod = (await import('@vercel/blob')) as VercelBlobSdk
  return mod
}
