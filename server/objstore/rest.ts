// HTTP plane for the v1.objstore extension.
//
// Two routes mounted under `/api/objstore/{workspaceTag}/{resourceTag}`:
//
//   PUT  — body is the raw ciphertext blob; `Authorization: Bearer
//          <put-token>` carries the WS-issued capability that binds
//          (workspaceTag, resourceTag, stagingId, expectedLength).
//          Server streams the body to the staging file, then under
//          the per-resource lock runs `commitPut`, broadcasts
//          `objstore-put` to subscribed peers, and replies 200 with
//          `{ version, contentHash }`.
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
  isValidStagingId,
  isValidTag,
  lockKey,
} from './store.ts'
import type { LiveReader } from './blob.ts'
import { CommitLockContendedError, withCommitLock } from './commit-lock.ts'
import { type TokenSecret, extractBearer, verifyToken } from './tokens.ts'

// Server-side fault codes that should surface as 500 `io-error`
// rather than 400 `aborted`. `pipeline(req, ws)` rejects with the
// first stream error; the client-side codes (socket close, the
// manual `overrun`) are everything else. ENOENT is included because
// `createWriteStream` will reject with it if the `${tag}/.staging`
// dir was removed out from under us (operator action / external
// fs activity) — that's a server-side state, not a client-fixable
// abort. PR #4 review. The Vercel-blob backend surfaces failures
// through other paths (rejected put promise → caught by the
// pipeline catch as a plain Error without a `code`); those land in
// the default `aborted` branch and the operator-facing log line
// carries the SDK's error message.
const IO_FAULT_CODES = new Set(['ENOSPC', 'EACCES', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'EDQUOT', 'EPERM', 'ENOENT'])

export type ObjstoreRestDeps = {
  handle: Handle
  secret: TokenSecret
  broadcast: (tag: string, msg: object, except: WebSocket | null) => void
  debug: boolean
}

// Concurrent replay protection: rejected via the DB-backed
// distributed commit lock taken at PUT start
// (`server/objstore/commit-lock.ts`). Previously a per-process
// `Set<string>` of in-flight stagingIds, which broke under multi-
// replica deployments — two replicas processing the same put-token
// would each pass their own in-process set. The lock is keyed by
// (workspace_tag, resource_tag) so it ALSO serializes the upload
// itself against concurrent commits / deletes / reaper unlinks on
// the same key, which the prior in-process lock could only do
// within a single replica.

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

function deny(res: ServerResponse, status: number, body: string): void {
  // Uniform `{ error: <reason> }` JSON envelope for every failure so
  // clients have one shape to parse. Status + reason are NOT
  // intentionally indistinguishable across causes — 401, 404, 405,
  // 410, 411, 500 each map to a documented reason in server/README.md
  // and the client decides recovery from the code. Defense against
  // probe-driven distinguishing isn't a property the relay aims for;
  // every error reason is reachable only after the route + bearer-
  // token check passes (or as 401/404 from the public surface), so
  // there's no signal here a probe couldn't otherwise enumerate.
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: body }))
}

// Variant of `deny` that augments the JSON envelope with the
// live row's `currentVersion` so a REST PUT 409 lets the caller
// retry with the right precondition. Without this the client only
// learns the slot is occupied — not at what version — and retries
// with `prevVersion: null` against a non-empty slot, looping
// indefinitely against a live row. Symmetric with the WS plane's
// `objstore-conflict` envelope.
function denyConflict(res: ServerResponse, currentVersion: number | null): void {
  res.writeHead(409, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'conflict', currentVersion }))
}

export async function handleRest(deps: ObjstoreRestDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const route = matchRoute(req.url)
  if (!route) { deny(res, 404, 'not-found'); return }
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
      if (deps.debug) console.warn('objstore PUT error:', (err as Error)?.stack ?? err)
      if (res.headersSent) res.destroy()
      else deny(res, 500, 'internal')
    }
    return
  }
  if (req.method === 'GET' && payload.op === 'get') {
    try { await handleRestGet(deps, res, route, payload) }
    catch (err: unknown) {
      if (deps.debug) console.warn('objstore GET error:', (err as Error)?.stack ?? err)
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
  // Distributed commit-lock acquired at PUT start, held across the
  // entire upload + commit critical section. Cross-replica
  // serialization against concurrent put / delete / reaper-unlink
  // on the same (tag, resourceTag). Lock is TTL-leased (5 min by
  // default, tunable via OBJSTORE_COMMIT_LOCK_LEASE_MS) so a
  // crashed PUT doesn't permanently pin the key — expires for the
  // next attempt. Contention returns 503 + reason='contended' so
  // clients can distinguish a transient lock contention
  // (retryable) from an expired-staging 410 (re-begin required).
  // The server already waited up to 2s on the lock inside
  // tryAcquireCommitLockWithWait, so reaching CommitLockContended
  // here means the holder is genuinely busy.
  try {
    // Pass `lock.holder` into `handleRestPutLocked` → `commitPut`
    // so the live-row write goes through the atomic
    // `upsertLiveIfHeld` SQL — guards against a stolen-mid-upload
    // lease overwriting the live row with bytes from a racing
    // replica's commit. See `commit-lock.ts:CommitLock.holder`.
    await withCommitLock(deps.handle, route.tag, route.resourceTag, (lock) =>
      handleRestPutLocked(deps, req, res, route, payload, declared, lock.holder))
  } catch (err) {
    if (err instanceof CommitLockContendedError) {
      // Don't write a response body if headers were already
      // committed by handleRestPutLocked (shouldn't be — the
      // contended path means the inner fn never ran — but
      // defensive).
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' })
        res.end(JSON.stringify({ error: 'contended' }))
      }
      return
    }
    throw err
  }
}

// Map a `commitPut` failure to its wire response. Extracted from
// `handleRestPutLocked` to keep it under the per-function line cap
// and to make the wire-mapping ladder its own audit surface — the
// exhaustiveness `never` guard at the bottom catches a forward-
// compat hazard where a new `CommitPutResult` reason lands without
// updating this dispatch.
function denyCommitFailure(res: ServerResponse, result: Exclude<CommitPutResult, { ok: true }>): void {
  if (result.reason === 'conflict') {
    denyConflict(res, result.conflict?.version ?? null)
    return
  }
  if (result.reason === 'no-staging') { deny(res, 410, 'gone'); return }
  // `lock-lost` — our lease expired (or was stolen) during the
  // upload phase; the conditional `upsertLiveIfHeld` correctly
  // skipped the write. Surface as the same 503 'contended' the
  // server uses for inbound-lock contention so the client's typed
  // `contended` result handles both shapes identically.
  if (result.reason === 'lock-lost') {
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' })
    res.end(JSON.stringify({ error: 'contended' }))
    return
  }
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

async function handleRestPutLocked(
  deps: ObjstoreRestDeps,
  req: IncomingMessage,
  res: ServerResponse,
  route: RouteMatch,
  payload: { sid: string; len: number },
  declared: number,
  commitLockHolder: string,
): Promise<void> {
  // Cheap staging-row precheck — bail before accepting up to
  // MAX_CONTENT_LENGTH bytes for a replayed / expired token. The
  // row could still vanish before commit (reaper / abort) but the
  // commit recheck catches that. PR #4 review.
  if (!await deps.handle.selectStaging.get(route.tag, route.resourceTag, payload.sid)) {
    deny(res, 410, 'gone'); return
  }
  const key = lockKey(route.tag, route.resourceTag)
  const abortLocked = () => deps.handle.lock.run(key, () => abortPut(deps.handle, route.tag, route.resourceTag, payload.sid))
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
    // BlobRequestAbortedError) BEFORE abortLocked → unlinkStaging
    // runs. Otherwise a late-arriving upload chunk recreates the
    // staging blob after we've cleaned it. FS backend's abort is
    // an immediate microtask — no real wait.
    await writer.abort(err)
    await abortLocked()
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
    return
  }
  if (received !== declared) { await abortLocked(); deny(res, 400, 'length-mismatch'); return }
  // Belt-and-braces: confirm storage-side size (catches a writer
  // that silently absorbed less, e.g. ENOSPC near the end on FS,
  // or a partial multipart upload that the SDK didn't propagate as
  // a reject). A null result here means the staging slot is gone
  // entirely (racing reaper / abort), which is an FS-side / backend
  // fault — wire string is `io-error`, mapped to HTTP 500, matching
  // the README contract.
  let onDisk: number | null
  try { onDisk = await deps.handle.blob.statStaging(route.tag, payload.sid) } catch {
    await abortLocked(); deny(res, 500, 'io-error'); return
  }
  if (onDisk == null) { await abortLocked(); deny(res, 500, 'io-error'); return }
  if (onDisk !== payload.len) { await abortLocked(); deny(res, 400, 'length-mismatch'); return }
  // Commit ladder: refresh `begun_at` AND commitPut under ONE lock.
  // Refreshing outside the lock leaves a window where the reaper's
  // freshness re-check inside its own per-resource lock can win on
  // a SELECT that races our (yet-to-run) UPDATE — reaper deletes
  // the row + file, we then commit and get `no-staging` → 410 to a
  // client that just streamed up to 100 MiB. PR #4 review H4
  // originally added the refresh; subsequent audit (round-12) moved
  // it inside this lock to close the race. Acquire here:
  const result = await deps.handle.lock.run(key, async () => {
    // Step 1 (lock-protected): refresh begun_at so the reaper's
    // next freshness check inside its own lock-block sees us as
    // fresh — bounded by the lock against other readers. Mostly
    // belt-and-braces now that the DB commit lock already excludes
    // the reaper from this key (see commit-lock.ts), but keep it
    // so a future caller running outside the commit-lock (e.g.
    // future test fixture / direct-DB tooling) still extends the
    // staging-row TTL across the upload.
    await deps.handle.refreshStagingBegunAt.run(Date.now(), route.tag, route.resourceTag, payload.sid)
    // Step 2 (still under the lock): commit. Precondition recheck
    // + durable rename + DB write are serialised against concurrent
    // commits / deletes / begins on the same (tag, resourceTag).
    // Thread the post-upload `onDisk` size as `observedSize` so
    // commitPut skips its own redundant statStaging round-trip
    // (one fewer Vercel HEAD per PUT). Safe because the staging
    // blob cannot have been resized between the stat at line 299
    // and here — the DB commit lock + this in-process lock both
    // exclude every writer of this stagingId.
    const r = await commitPut(deps.handle, {
      workspaceTag: route.tag, resourceTag: route.resourceTag, stagingId: payload.sid,
      observedSize: onDisk,
      // Threading the holder enables the `upsertLiveIfHeld` SQL
      // gate. A long upload whose lease silently expired mid-
      // flight (a peer replica's reaper or commit may have stolen)
      // hits `lock-lost` here instead of blindly overwriting.
      holder: commitLockHolder,
    })
    if (!r.ok) await abortPut(deps.handle, route.tag, route.resourceTag, payload.sid)
    return r
  })
  if (!result.ok) { denyCommitFailure(res, result); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    version: result.row.version,
    contentHash: result.row.contentHash,
    contentLength: result.row.contentLength,
  }))
  deps.broadcast(route.tag, {
    type: 'objstore-put',
    workspaceTag: route.tag,
    resourceTag: route.resourceTag,
    version: result.row.version,
    contentHash: result.row.contentHash,
    contentLength: result.row.contentLength,
    signature: result.row.signature,
  }, null)
  if (deps.debug) console.log(`objstore put → ${route.tag.slice(0, 12)}…/${route.resourceTag.slice(0, 8)}… v${result.row.version}`)
}

type GetOpened =
  | { reason: 'ok'; reader: LiveReader }
  | { reason: 'not-found' }
  | { reason: 'unavailable' }

function openLiveUnderLock(
  deps: ObjstoreRestDeps, route: RouteMatch, payload: { ver: number },
): Promise<GetOpened> {
  // Validate row version + open the reader inside the lock so a
  // concurrent commit's promote or delete's unlink can't slip
  // between the row check and the open. For the FS backend the
  // open returns a pinned fd (inode stays alive even if the path
  // is later unlinked / overwritten); for the Vercel backend the
  // SDK's `get` returns a stream backed by a fetch reader that
  // streams the bytes the token was issued for. Either way the
  // snapshot stays consistent for the duration of the response.
  return deps.handle.lock.run<GetOpened>(lockKey(route.tag, route.resourceTag), async (): Promise<GetOpened> => {
    const live = await deps.handle.selectLiveOne.get(route.tag, route.resourceTag)
    if (!live || live.version !== payload.ver) return { reason: 'not-found' }
    let opened
    try { opened = await deps.handle.blob.openLiveReader(route.tag, route.resourceTag) }
    catch { return { reason: 'unavailable' } }
    if (!opened.ok) return { reason: opened.reason }
    // Size mismatch between the live row and the on-storage bytes
    // is a transient inconsistency — reaper will reconcile. Close
    // the reader before returning so we don't leak the fd / fetch
    // reader. PR #4 review H8.
    if (opened.reader.size !== live.content_length) {
      await opened.reader.close().catch(() => {})
      return { reason: 'unavailable' }
    }
    return { reason: 'ok', reader: opened.reader }
  })
}

async function handleRestGet(
  deps: ObjstoreRestDeps,
  res: ServerResponse,
  route: RouteMatch,
  payload: { ver: number },
): Promise<void> {
  // Token's `ver` is the live row's version at issuance. A later
  // PUT/DELETE invalidates the capability — new version (or missing
  // row) means this snapshot is gone. 404 keeps the response shape
  // uniform with "never existed" so a probe can't distinguish.
  const opened = await openLiveUnderLock(deps, route, payload)
  if (opened.reason === 'not-found') { deny(res, 404, 'not-found'); return }
  // If the live row is there but the bytes are missing / wrong size,
  // it's a transient inconsistency the reaper will sort out — 503
  // (vs 404) tells the client this is a server-side state, not a
  // "the resource truly isn't there" answer.
  if (opened.reason === 'unavailable') { deny(res, 503, 'unavailable'); return }
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
