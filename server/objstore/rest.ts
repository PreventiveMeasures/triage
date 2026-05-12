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
import { createWriteStream } from 'node:fs'
import { type FileHandle, open, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { Buffer } from 'node:buffer'
import type { WebSocket } from 'ws'
import {
  type Handle,
  MAX_CONTENT_LENGTH,
  abortPut,
  commitPut,
  isValidStagingId,
  isValidTag,
  lockKey,
} from './store.ts'
import { liveFilePath, stagingFilePath } from './fs.ts'
import { type TokenSecret, extractBearer, verifyToken } from './tokens.ts'

// Server-side filesystem fault codes that should surface as 500
// `io-error` rather than 400 `aborted`. `pipeline(req, ws)` rejects
// with the first stream error; the client-side codes (socket close,
// the manual `overrun`) are everything else. ENOENT is included
// because `createWriteStream` will reject with it if the
// `${tag}/.staging` dir was removed out from under us (operator
// action / external fs activity) — that's a server-side state, not
// a client-fixable abort. PR #4 review.
const IO_FAULT_CODES = new Set(['ENOSPC', 'EACCES', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'EDQUOT', 'EPERM', 'ENOENT'])

export type ObjstoreRestDeps = {
  handle: Handle
  secret: TokenSecret
  broadcast: (tag: string, msg: object, except: WebSocket | null) => void
  debug: boolean
}

// In-flight upload set, keyed by stagingId. A concurrent replay of
// the same put-token would otherwise let two requests open the same
// staging file with `flags: 'w'`. After the first commit renames
// staging → live, the second's still-open fd points at the inode
// that's now under the live name — its remaining writes would
// corrupt the committed blob. Reject the second outright;
// sequential replays still hit the staging-row precheck → 410.
// PR #4 review.
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
  // Reject a concurrent replay of the same put-token — two writers
  // opening `flags: 'w'` on the same staging path would race the
  // post-commit rename and corrupt the live file. Sequential replay
  // still falls through to the row-precheck below → 410. PR #4
  // review.
  if (inFlightSids.has(payload.sid)) { deny(res, 410, 'gone'); return }
  inFlightSids.add(payload.sid)
  try {
    await handleRestPutLocked(deps, req, res, route, payload, declared)
  } finally {
    inFlightSids.delete(payload.sid)
  }
}

async function handleRestPutLocked(
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
  const key = lockKey(route.tag, route.resourceTag)
  const abortLocked = () => deps.handle.lock.run(key, () => abortPut(deps.handle, route.tag, route.resourceTag, payload.sid))
  const stagingPath = stagingFilePath(deps.handle.dir, route.tag, payload.sid)
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
  const ws = createWriteStream(stagingPath, { flags: 'w' })
  try { await pipeline(req, counter, ws) } catch (err) {
    await abortLocked()
    // Branch on `err.code` so a write-side fault (ENOSPC / EACCES /
    // EIO …) surfaces as a 5xx per the README contract, separate
    // from a client-side abort / overrun which stays 400. PR #4
    // review.
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
  // Belt-and-braces: confirm on-disk size (catches a writestream
  // that silently absorbed less, e.g. ENOSPC near the end). A
  // failure to stat the file we just wrote is an FS-side fault
  // (EACCES / EIO / racing reaper / abort) — wire string is
  // `io-error`, mapped to HTTP 500, matching the README contract.
  let onDisk: number
  try { onDisk = (await stat(stagingPath)).size } catch {
    await abortLocked(); deny(res, 500, 'io-error'); return
  }
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
    // fresh — bounded by the lock against other readers.
    await deps.handle.refreshStagingBegunAt.run(Date.now(), route.tag, route.resourceTag, payload.sid)
    // Step 2 (still under the lock): commit. Precondition recheck
    // + durable rename + DB write are serialised against concurrent
    // commits / deletes / begins on the same (tag, resourceTag).
    const r = await commitPut(deps.handle, {
      workspaceTag: route.tag, resourceTag: route.resourceTag, stagingId: payload.sid,
    })
    if (!r.ok) await abortPut(deps.handle, route.tag, route.resourceTag, payload.sid)
    return r
  })
  if (!result.ok) {
    if (result.reason === 'conflict') { deny(res, 409, 'conflict'); return }
    if (result.reason === 'no-staging') { deny(res, 410, 'gone'); return }
    // `io-error` = FS/disk fault (EACCES/ENOSPC/EIO/racing abort);
    // server-side, not client-fixable. `size-mismatch` is the
    // remaining client-data fault — wire-rename to the documented
    // `length-mismatch` shape so the README enumeration stays
    // exhaustive.
    if (result.reason === 'io-error') { deny(res, 500, 'io-error'); return }
    if (result.reason === 'size-mismatch') { deny(res, 400, 'length-mismatch'); return }
    // Exhaustiveness guard. The four branches above cover every
    // `CommitPutResult` rejection reason; a future reason added to
    // the union without updating this ladder would trip the
    // `never` cast at compile time. Forward-compat hazard called
    // out in audit round-10. Was previously
    // `deny(res, 400, result.reason)` — silent passthrough that
    // would have leaked the raw internal reason as a wire string
    // bypassing the README's documented enumeration.
    const _exhaustive: never = result.reason
    void _exhaustive
    deny(res, 500, 'internal'); return
  }
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
    chunkCount: result.row.chunkCount,
    noncePrefix: result.row.noncePrefix,
    signature: result.row.signature,
  }, null)
  if (deps.debug) console.log(`objstore put → ${route.tag.slice(0, 12)}…/${route.resourceTag.slice(0, 8)}… v${result.row.version}`)
}

type GetOpened =
  | { reason: 'ok'; fh: FileHandle; size: number }
  | { reason: 'not-found' }
  | { reason: 'unavailable' }

function openLiveUnderLock(
  deps: ObjstoreRestDeps, route: RouteMatch, payload: { ver: number },
): Promise<GetOpened> {
  // Validate row version + open the fd inside the lock so a
  // concurrent commit's rename or delete's unlink can't slip between
  // the row check and the open. Once we hold the open fd, the inode
  // is pinned even if the path is later overwritten/unlinked — the
  // bytes we stream are the snapshot the token was issued for.
  return deps.handle.lock.run<GetOpened>(lockKey(route.tag, route.resourceTag), async (): Promise<GetOpened> => {
    const live = await deps.handle.selectLiveOne.get(route.tag, route.resourceTag)
    if (!live || live.version !== payload.ver) return { reason: 'not-found' }
    const path = liveFilePath(deps.handle.dir, route.tag, route.resourceTag)
    let fh: FileHandle
    try { fh = await open(path, 'r') } catch { return { reason: 'unavailable' } }
    // Wrap stat + size check — a throw between open and the
    // `await fh.close()` line would otherwise leak the fd until
    // GC. PR #4 review H8.
    try {
      const size = (await fh.stat()).size
      if (size !== live.content_length) {
        await fh.close().catch(() => {})
        return { reason: 'unavailable' }
      }
      return { reason: 'ok', fh, size }
    } catch {
      await fh.close().catch(() => {})
      return { reason: 'unavailable' }
    }
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
  // If the live row is there but the file is missing / wrong size,
  // it's a transient inconsistency the reaper will sort out — 503
  // (vs 404) tells the client this is a server-side state, not a
  // "the resource truly isn't there" answer.
  if (opened.reason === 'unavailable') { deny(res, 503, 'unavailable'); return }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(opened.size),
  })
  // `pipeline` (vs `stream.pipe(res)`) destroys the source when the
  // destination errors — a client that aborts mid-download would
  // otherwise leak the read-stream fd until GC. The FileHandle's
  // createReadStream() auto-closes the fd when the stream finishes
  // or is destroyed; `pipeline` rejecting will bubble to handleRest's
  // outer catch for `res.destroy()`.
  await pipeline(opened.fh.createReadStream(), res)
}
