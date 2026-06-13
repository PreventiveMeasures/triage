// HTTP plane for the v1.objstore extension.
//
// Two routes mounted under `/api/objstore/{workspaceTag}/{resourceTag}`:
//
//   PUT  — body is the raw ciphertext blob; `Authorization: Bearer
//          <put-token>` carries the WS-issued capability that binds
//          (workspaceTag, resourceTag, stagingId, expectedLength).
//          Server streams the body to the staging file, runs
//          `commitPut` (whose version-CAS arbitrates concurrent
//          commits — no lock), broadcasts `objstore-put` to subscribed
//          peers, and replies 200 with `{ version, contentHash }`.
//
//   GET  — `Authorization: Bearer <get-token>` carries a capability
//          bound to (workspaceTag, resourceTag, version). Server
//          opens the live file and pipes it as the response body.
//          A token whose `version` no longer matches the live row
//          (resource was overwritten or deleted post-issuance) is
//          a 404 — the issued capability was for a specific snapshot
//          that no longer exists.
//
// Same-origin deployment means no CORS preflight machinery.
// 4xx responses carry a tiny JSON body so a developer staring at
// devtools sees something more useful than an empty status code,
// but the body is not load-bearing for the protocol.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { Buffer } from 'node:buffer'
import type { WebSocket } from 'ws'
import {
  type CommitPutResult,
  type Handle,
  MAX_CONTENT_LENGTH,
  abortPut,
  commitPut,
  getLive,
  isValidStagingId,
  isValidTag,
  objectMetaWire,
} from './store.ts'
import type { LiveReader } from './blob.ts'
import { type TokenSecret, extractBearer, verifyToken } from './tokens.ts'
import { deny, denyConflict } from './rest-deny.ts'
import { handleRestMint } from './rest-mint.ts'
import { debugId, debugTag, errMsg, errStack } from '../util.ts'

// Server-side fault codes that should surface as 500 `io-error`
// rather than 400 `aborted`. `pipeline(req, ws)` rejects with the
// first stream error; client-side codes (socket close, the manual
// `overrun`) are everything else. ENOENT is included because
// `createWriteStream` rejects with it if the `${tag}/.staging` dir
// was removed out from under us (operator / external fs activity) —
// a server-side state, not a client-fixable abort. Vercel-blob
// failures arrive without a `code` (rejected put promise → plain
// Error); those land in the default `aborted` branch, with the SDK
// error in the operator log line.
const IO_FAULT_CODES = new Set(['ENOSPC', 'EACCES', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'EDQUOT', 'EPERM', 'ENOENT'])

export type ObjstoreRestDeps = {
  handle: Handle
  secret: TokenSecret
  broadcast: (tag: string, msg: object, except: WebSocket | null) => void
  // Cross-instance pub/sub for objstore-put. Fired alongside the local
  // `broadcast` after a successful commitPut so peers on OTHER server
  // instances see the new version in real time. Carries only
  // `(tag, resourceTag)` — receivers re-fetch the live row from
  // workspace_object for the full metadata (version, hash, length,
  // signature). SQLite mode passes a no-op.
  publishObjPut: (tag: string, resourceTag: string) => void
  // Cross-instance pub/sub for objstore-deleted — fired alongside the local
  // `broadcast` after a successful REST delete mint, so peers on OTHER
  // instances drop the resource in real time. Carries (tag, resourceTag,
  // version) inline (the row is gone post-delete). SQLite mode passes a no-op.
  publishObjDeleted: (tag: string, resourceTag: string, version: number) => void
  // New-workspace operator gate for the REST put-begin mint — the
  // connection-independent analog of the WS path's `authGate`. Returns
  // `true` to DENY (a password is configured AND the workspace is
  // never-before-seen), which routes the client to its in-band WS
  // put-begin fallback (REST has no socket auth state to consult).
  // No-config default is open (never deny), matching the WS authGate.
  restPutGate: (workspaceTag: string) => Promise<boolean>
  debug: boolean
}

// Concurrent commits need no lock: the live blob is content-addressed
// (`${tag}/${contentHash}.bin`) so two racing commits write to
// DIFFERENT immutable addresses, and the commit is an atomic version
// compare-and-set on the live row (see commitPut in store.ts). Exactly
// one racer wins the CAS; the loser gets a 409 `conflict` and rebases.
// Holds within a process and across replicas — no in-process mutex
// serialises commits. (The PUT *body* takes a per-process single-
// writer reservation — `inFlightSids` below — but that only rejects a
// duplicate upload of one staging slot; distinct commits never wait.)

// Per-process single-writer guard for the REST PUT body. A put-token is
// a REUSABLE bearer capability (tokens.ts) valid for its whole TTL, so a
// client replaying it on overlapping PUTs (a retry that doesn't cancel
// the in-flight request, a proxy re-issuing the PUT, a double-submit)
// would otherwise have two requests stream into the SAME staging file
// (same sid). On FS, `createWriteStream(…, { flags: 'w' })` truncates,
// so the two writers clobber each other's bytes/size and BOTH can fail
// (size-mismatch 400 + promote-race 500) with neither committing.
// `inFlightSids` admits exactly ONE in-flight upload per staging id; a
// concurrent same-token PUT is rejected (409) before it can open a
// second writer. The slot is held only across body + commit, released
// in a `finally`, and bounded by the REST idle-body timeout in
// server-e2e/http.ts so a slow-loris can't pin it. NOT a commit lock —
// commits stay lock-free on the version-CAS above. Per-process: the
// Vercel multi-replica path leans on `allowOverwrite: true` + the
// commit CAS + content-addressing for cross-replica correctness (a
// duplicate landing on another replica can't clobber a shared local
// file and still loses the CAS), not on this set.
const inFlightSids = new Set<string>()

// `/api/objstore/${workspaceTag}/${resourceTag}` — base64url
// alphabet, case-sensitive. The `?…` query is permitted but ignored
// (token rides the Authorization header, not the URL — querystring
// tokens leak via access logs and referer).
const ROUTE_RE = /^\/api\/objstore\/([\w-]+)\/([\w-]+)(?:\?.*)?$/u

export type RouteMatch = { tag: string; resourceTag: string }

export function matchRoute(url: string | undefined): RouteMatch | null {
  if (typeof url !== 'string') return null
  const m = ROUTE_RE.exec(url)
  if (!m) return null
  const [, tag, resourceTag] = m
  if (!isValidTag(tag) || !isValidTag(resourceTag)) return null
  return { tag: tag!, resourceTag: resourceTag! }
}

export async function handleRest(deps: ObjstoreRestDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const route = matchRoute(req.url)
  if (!route) { deny(res, 404, 'not-found'); return }
  // POST = REST mint (fetch or put-begin, by body `op`; signature-authed
  // via the JSON body, no bearer token). Dispatched before the bearer-token
  // gate below, which guards the token-authed GET/PUT byte transfers.
  if (req.method === 'POST') {
    try { await handleRestMint(deps, req, res, route) }
    catch (err: unknown) {
      if (deps.debug) console.warn('objstore POST error:', errStack(err))
      if (res.headersSent) res.destroy()
      else deny(res, 500, 'internal')
    }
    return
  }
  const token = extractBearer(req.headers['authorization'])
  if (!token) { deny(res, 401, 'unauthorized'); return }
  const payload = verifyToken(deps.secret, token)
  if (!payload) { deny(res, 401, 'unauthorized'); return }
  if (payload.tag !== route.tag || payload.res !== route.resourceTag) {
    deny(res, 401, 'unauthorized'); return
  }
  // Defense in depth: `verifyToken` only checked `typeof sid ===
  // 'string'`. A path-bearing sid (`../../etc/passwd`) inside an
  // HMAC-valid payload would otherwise reach `stagingFilePath` and
  // escape `OBJSTORE_DIR`. The HMAC binds the payload bytes, so this
  // is reachable only under a secret compromise — match the
  // reaper's row-field validation (PR #4 review #15) at the wire
  // boundary too.
  if (payload.op === 'put' && !isValidStagingId(payload.sid)) {
    deny(res, 401, 'unauthorized'); return
  }
  if (req.method === 'PUT' && payload.op === 'put') {
    try { await handleRestPut(deps, req, res, route, payload) }
    catch (err: unknown) {
      // Outer catch is the forensic safety net — handleRestPut has
      // its own internal pipeline catch. Log `.stack` so a post-
      // mortem has the throw site.
      if (deps.debug) console.warn('objstore PUT error:', errStack(err))
      if (res.headersSent) res.destroy()
      else deny(res, 500, 'internal')
    }
    return
  }
  if (req.method === 'GET' && payload.op === 'get') {
    try { await handleRestGet(deps, res, route, payload) }
    catch (err: unknown) {
      if (deps.debug) console.warn('objstore GET error:', errStack(err))
      if (res.headersSent) res.destroy()
      else deny(res, 500, 'internal')
    }
    return
  }
  deny(res, 405, 'method-not-allowed')
}

async function handleRestPut(
  deps: ObjstoreRestDeps,
  req: IncomingMessage,
  res: ServerResponse,
  route: RouteMatch,
  payload: { sid: string; len: number },
): Promise<void> {
  // Require an explicit Content-Length so a mismatch is rejected
  // before opening the file. Chunked transfer-encoding without a
  // length header is rejected — the client always knows the size
  // up front (signed into put-begin).
  const lenHeader = req.headers['content-length']
  const declared = typeof lenHeader === 'string' ? Number(lenHeader) : NaN
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_CONTENT_LENGTH) {
    deny(res, 411, 'length-required'); return
  }
  if (declared !== payload.len) { deny(res, 400, 'length-mismatch'); return }
  // No lock: the commit's version-CAS arbitrates concurrent commits
  // (the live blob is content-addressed, so racers can't desync
  // metadata vs bytes — the loser surfaces a 409 `conflict`). The
  // staging row is protected from the reaper by its `begun_at`, not a
  // lock: an upload under the staging TTL stays fresh through the body,
  // and the after-body `refreshStagingBegunAt` re-extends the TTL across
  // the commit. (An upload exceeding the TTL during the body can be
  // reaped mid-flight → commit 410s; documented accepted tradeoff —
  // see commitPut in store.ts.)
  await handleRestPutBody(deps, req, res, route, payload, declared)
}

// Map a `commitPut` failure to its wire response. Extracted from
// `handleRestPutBody` to keep it under the per-function line cap and
// to make the wire-mapping ladder its own audit surface — the
// exhaustiveness `never` guard at the bottom catches a new
// `CommitPutResult` reason landing without updating this dispatch.
function denyCommitFailure(res: ServerResponse, result: Exclude<CommitPutResult, { ok: true }>): void {
  if (result.reason === 'conflict') {
    denyConflict(res, result.conflict?.version ?? null, result.conflict?.incarnation ?? null)
    return
  }
  if (result.reason === 'no-staging') { deny(res, 410, 'gone'); return }
  // `io-error` = FS/disk fault (EACCES/ENOSPC/EIO/racing abort);
  // server-side, not client-fixable. `size-mismatch` is the
  // remaining client-data fault — wire-rename to the documented
  // `length-mismatch` shape so the README enumeration stays
  // exhaustive.
  if (result.reason === 'io-error') { deny(res, 500, 'io-error'); return }
  if (result.reason === 'size-mismatch') { deny(res, 400, 'length-mismatch'); return }
  // Exhaustiveness guard — a new `CommitPutResult` reason added
  // without updating this ladder trips the `never` cast at compile
  // time. Forward-compat hazard called out in audit round-10.
  const _exhaustive: never = result.reason
  void _exhaustive
  deny(res, 500, 'internal')
}

async function handleRestPutBody(
  deps: ObjstoreRestDeps,
  req: IncomingMessage,
  res: ServerResponse,
  route: RouteMatch,
  payload: { sid: string; len: number },
  declared: number,
): Promise<void> {
  // Cheap staging-row precheck — bail before accepting up to
  // MAX_CONTENT_LENGTH bytes for a replayed / expired token. The
  // row could still vanish before commit (reaper / abort) but the
  // commit recheck catches that. PR #4 review.
  if (!await deps.handle.selectStaging.get(route.tag, route.resourceTag, payload.sid)) {
    deny(res, 410, 'gone'); return
  }
  // Single-writer guard (see `inFlightSids`): reject a concurrent PUT
  // replaying this same token before it can open a second writer on the
  // shared staging file. `has` + `add` run with no `await` between them,
  // so they're atomic on Node's single thread — exactly one concurrent
  // PUT passes. The 409 echoes the live version like a commit-time
  // conflict so the client rebases / re-handshakes.
  if (inFlightSids.has(payload.sid)) {
    const cur = await getLive(deps.handle, route.tag, route.resourceTag)
    denyConflict(res, cur?.version ?? null, cur?.incarnation ?? null)
    return
  }
  inFlightSids.add(payload.sid)
  try {
    // Stream the upload + commit, no lock — version-CAS arbitrates
    // commits, the staging row stays fresh for the reaper via its
    // `begun_at` (+ after-body refresh). See handleRestPut above.
    const result = await runUploadAndCommit(deps, route, payload, declared, req, res)
    if (result.handled) return
    if (!result.commit.ok) { denyCommitFailure(res, result.commit); return }
    const row = result.commit.row
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      version: row.version,
      incarnation: row.incarnation,
      contentHash: row.contentHash,
      contentLength: row.contentLength,
    }))
    deps.broadcast(route.tag, {
      type: 'objstore-put',
      workspaceTag: route.tag,
      ...objectMetaWire(row),
    }, null)
    // Cross-instance fan-out (Neon mode). The bus payload carries only
    // (tag, resourceTag); peers on other instances re-fetch the live row
    // from workspace_object to compose their broadcast. The committed
    // row is durable by here (commitPut's version-CAS landed), so the
    // receiver sees THIS version or a STRICTLY newer one (also valid —
    // clients are idempotent on (resourceTag, version)), or no live row
    // at all if a subsequent delete races the notification (bus-
    // receiver.ts drops that silently). SQLite mode publishes to a no-op.
    deps.publishObjPut(route.tag, route.resourceTag)
    if (deps.debug) console.log(`objstore put → ${route.tag.slice(0, 12)}…/${route.resourceTag.slice(0, 8)}… v${row.version}`)
  } finally {
    // Release the slot on every exit (success, commit failure, pipeline
    // error, idle-timeout abort) so a later legitimate retry isn't
    // wrongly rejected.
    inFlightSids.delete(payload.sid)
  }
}

// The body of a PUT: stream the upload into the staging slot, verify
// size, refresh the staging row's begun_at, and commit. No lock — the
// commit's version-CAS arbitrates concurrent commits. Returns
// `{ handled: true }` when it already wrote the (error) response
// itself; `{ handled: false, commit }` when it reached commitPut
// (caller maps the result to the success / failure response, keeping
// the broadcast + body write out of this helper).
async function runUploadAndCommit(
  deps: ObjstoreRestDeps,
  route: RouteMatch,
  payload: { sid: string; len: number },
  declared: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ handled: true } | { handled: false; commit: CommitPutResult }> {
  // Open the backend's staging writer. For the FS backend this is a
  // `createWriteStream` to the canonical staging path; for the
  // Vercel backend it's a PassThrough whose other end feeds the
  // SDK's `put`. Both surfaces are awaited via `finalize()` after
  // the pipeline below.
  const writer = await deps.handle.blob.openStagingWriter(route.tag, payload.sid)
  // Byte counter as a Transform in the pipeline. EventEmitter delivers
  // chunks to every attached listener, so `req.on('data', count)` +
  // `pipeline(req, ws)` would also work — but the dual-listener
  // pattern is brittle: a future stream-semantics change (or an
  // upstream resuming synchronously on listener attach) could let
  // chunks bypass the pipe. Sitting in the pipeline removes the
  // ambiguity — we count exactly what gets written. Overrun aborts
  // by callback-error, which pipeline propagates to tear down req +
  // ws together (no manual `req.destroy()` / `ws.destroy()` dance).
  //
  // Defensive overrun cap — Node truncates at Content-Length, but a
  // buggy proxy / hostile client sending more shouldn't end up on
  // disk.
  let received = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, cb): void {
      received += chunk.byteLength
      if (received > declared) cb(new Error('overrun'))
      else cb(null, chunk)
    },
  })
  try {
    await pipeline(req, counter, writer.writable)
    // For the FS backend `finalize` is a no-op (pipeline already
    // awaited the WriteStream's 'finish'); for the Vercel backend
    // it awaits the SDK's put-promise so we know the bytes are
    // durable at the remote before commitPut runs its size check.
    await writer.finalize()
  } catch (err) {
    // Await writer.abort() so a Vercel-backed upload's in-flight
    // HTTP request has time to settle (rejected with
    // BlobRequestAbortedError) BEFORE abortPut → unlinkStaging runs.
    // Otherwise a late-arriving upload chunk recreates the staging
    // blob after we've cleaned it. FS backend's abort is an immediate
    // microtask — no real wait.
    await writer.abort(err)
    await abortPut(deps.handle, route.tag, route.resourceTag, payload.sid)
    // Branch on `err.code` so a write-side fault (ENOSPC / EACCES /
    // EIO …) surfaces as a 5xx per the README contract, separate
    // from a client-side abort / overrun which stays 400. PR #4
    // review. Vercel-blob upload failures land here without a
    // `code` field and route through the 400 `aborted` branch; the
    // DEBUG=1 log line carries the SDK's error.message for
    // operator triage.
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== undefined && IO_FAULT_CODES.has(code)) deny(res, 500, 'io-error')
    else deny(res, 400, 'aborted')
    // Log `code` only; Node `fs` error messages interpolate the
    // full path, which includes the raw (un-truncated) workspaceTag
    // (= Ed25519 public key). Operator logs shouldn't carry it
    // verbatim — `debugTag` is the convention everywhere else. If
    // `code` is missing (non-errno throw), log a placeholder so the
    // count is still visible at DEBUG=1.
    if (deps.debug) console.warn('objstore PUT aborted mid-body:', code ?? '<no-code>')
    return { handled: true }
  }
  if (received !== declared) {
    await abortPut(deps.handle, route.tag, route.resourceTag, payload.sid)
    deny(res, 400, 'length-mismatch'); return { handled: true }
  }
  // Belt-and-braces: confirm storage-side size (catches a writer
  // that silently absorbed less, e.g. ENOSPC near the end on FS,
  // or a partial multipart upload that the SDK didn't propagate as
  // a reject). A null result here means the staging slot is gone
  // entirely (racing reaper / abort), which is an FS-side / backend
  // fault — wire string is `io-error`, mapped to HTTP 500, matching
  // the README contract.
  let onDisk: number | null
  try { onDisk = await deps.handle.blob.statStaging(route.tag, payload.sid) } catch {
    await abortPut(deps.handle, route.tag, route.resourceTag, payload.sid)
    deny(res, 500, 'io-error'); return { handled: true }
  }
  if (onDisk == null) {
    await abortPut(deps.handle, route.tag, route.resourceTag, payload.sid)
    deny(res, 500, 'io-error'); return { handled: true }
  }
  if (onDisk !== payload.len) {
    await abortPut(deps.handle, route.tag, route.resourceTag, payload.sid)
    deny(res, 400, 'length-mismatch'); return { handled: true }
  }
  // Refresh begun_at AFTER the body lands so the TTL effectively
  // counts from upload-done. This is what keeps the reaper's atomic
  // conditional delete (`deleteStagingIfStale`, predicate
  // `begun_at < staleBefore`) from matching this row at the commit
  // step: a sub-TTL upload's begun_at is bumped fresh here, well
  // inside the window, so a concurrent reaper sweep can't drop it.
  // (No lock — the conditional delete IS the F1 protection now.)
  await deps.handle.refreshStagingBegunAt.run(Date.now(), route.tag, route.resourceTag, payload.sid)
  // Commit: precondition recheck + content-addressed promote + version
  // CAS (the CAS arbitrates concurrent commits — no lock). Thread the
  // post-upload `onDisk` size as `observedSize` so commitPut skips its
  // own redundant statStaging round-trip (one fewer Vercel HEAD per
  // PUT) — safe because staging ids are random, so nothing else writes
  // this blob, and the upload pipeline already finished above.
  const commit = await commitPut(deps.handle, {
    workspaceTag: route.tag, resourceTag: route.resourceTag, stagingId: payload.sid,
    observedSize: onDisk,
  })
  if (!commit.ok) await abortPut(deps.handle, route.tag, route.resourceTag, payload.sid)
  return { handled: false, commit }
}

type GetOpened =
  | { reason: 'ok'; reader: LiveReader }
  | { reason: 'not-found' }
  // `detail` is a short non-sensitive cause tag (backend sub-reason +
  // content-hash prefix) the GET handler logs so a 503 is diagnosable —
  // every byte-side failure collapses to the same wire 503 otherwise.
  | { reason: 'unavailable'; detail: string }

async function openLiveSnapshot(
  deps: ObjstoreRestDeps, route: RouteMatch, payload: { ver: number; inc: string },
): Promise<GetOpened> {
  // Validate row version + open the reader (by the row's content hash).
  // No lock is needed because the live blob is CONTENT-ADDRESSED and
  // therefore IMMUTABLE: a concurrent re-upload writes a DIFFERENT hash
  // (a new address), leaving the hash this row names untouched. So the
  // bytes behind `live.content_hash` can never change underneath us —
  // the worst a race can do is have the reaper GC an already-superseded
  // hash just before we open it, which surfaces as openLiveReader
  // returning `unavailable` → 503, and the client refetches. We can
  // never serve torn or wrong bytes. (For the FS backend the open also
  // returns a pinned fd; for the Vercel backend a fetch-backed stream.)
  const live = await deps.handle.selectLiveOne.get(route.tag, route.resourceTag)
  if (!live || live.version !== payload.ver || live.incarnation !== payload.inc) return { reason: 'not-found' }
  // Tag the content hash into every `unavailable` detail so an operator
  // can go check the byte store directly for THIS blob (gone → reaper /
  // deletion; present → transient read fault).
  const hashTag = `hash=${debugId(live.content_hash)}`
  let opened
  try { opened = await deps.handle.blob.openLiveReader(route.tag, live.content_hash) }
  // Length-cap the thrown error text: today a non-BlobNotFound SDK throw
  // (BlobServiceNotAvailable / store-not-found) carries no credential
  // (the RW token rides the Authorization header, never `.message`), but
  // a future SDK could embed a signed URL / token fragment — bound the
  // log line so it can't dump one verbatim. Mirrors the `.slice(0, 200)`
  // cap used on SDK error text in blob-vercel.ts.
  catch (err) { return { reason: 'unavailable', detail: `open-threw ${hashTag} ${String(errMsg(err)).slice(0, 200)}` } }
  if (!opened.ok) return { reason: 'unavailable', detail: `${opened.detail ?? 'backend'} ${hashTag}` }
  // Size mismatch between the live row and the on-storage bytes
  // is a transient inconsistency — reaper will reconcile. Close
  // the reader before returning so we don't leak the fd / fetch
  // reader. PR #4 review H8.
  if (opened.reader.size !== live.content_length) {
    await opened.reader.close().catch(() => {})
    return { reason: 'unavailable', detail: `size-mismatch row=${live.content_length} blob=${opened.reader.size} ${hashTag}` }
  }
  return { reason: 'ok', reader: opened.reader }
}

async function handleRestGet(
  deps: ObjstoreRestDeps,
  res: ServerResponse,
  route: RouteMatch,
  payload: { ver: number; inc: string },
): Promise<void> {
  // Token's `ver` is the live row's version at issuance. A later
  // PUT/DELETE invalidates the capability — new version (or missing
  // row) means this snapshot is gone. 404 keeps the response shape
  // uniform with "never existed" so a probe can't distinguish.
  const opened = await openLiveSnapshot(deps, route, payload)
  if (opened.reason === 'not-found') { deny(res, 404, 'not-found'); return }
  // If the live row is there but the bytes are missing / wrong size,
  // it's a transient inconsistency the reaper will sort out — 503
  // (vs 404) tells the client this is a server-side state, not a
  // "the resource truly isn't there" answer. Log the cause
  // UNCONDITIONALLY (not behind `debug`): a 503 means a live row whose
  // bytes can't be served, and the wire response can't distinguish a
  // permanent loss (reaper GC'd referenced bytes) from a transient read
  // fault. `detail` carries the backend sub-reason + content-hash prefix
  // so an operator can tell which — the only server-side breadcrumb for
  // the "all data turned into 503" failure. (Volume is bounded: a 503 is
  // an error path; a workspace-wide outage is exactly when these are
  // wanted.)
  if (opened.reason === 'unavailable') {
    console.warn(`objstore-get: 503 unavailable ${debugTag(route.tag)}/${route.resourceTag.slice(0, 8)}… v${payload.ver} ${opened.detail}`)
    deny(res, 503, 'unavailable'); return
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(opened.reader.size),
  })
  // `pipeline` (vs `stream.pipe(res)`) destroys the source when the
  // destination errors — a client that aborts mid-download would
  // otherwise leak the read-stream fd / fetch reader until GC. The
  // backend's reader auto-closes its underlying resource when the
  // stream finishes or is destroyed; `pipeline` rejecting bubbles
  // to handleRest's outer catch for `res.destroy()`.
  await pipeline(opened.reader.stream, res)
}
