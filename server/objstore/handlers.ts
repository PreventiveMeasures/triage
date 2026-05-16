// v1.objstore WS message handlers — control plane only. Byte
// transfer lives on the REST plane (rest.ts); these handlers mint
// the bearer tokens the REST handler validates. Each WS message
// that authorises byte transfer requires an Ed25519 signature
// against the workspaceTag, then a short-TTL HMAC token bound to
// the (tag, resource, version-or-stagingId, length) tuple.
//
// Operations that mutate (begin / commit / delete) hold a per-
// resource async mutex (see lock.ts) so two concurrent commits
// against the same (tag, resourceTag) can't interleave their
// precondition recheck across the `await` boundary in commitPut.
//
// Broadcasts to peers subscribed via `workspace-subscribe` reuse
// the existing subscriber map: `objstore-deleted` is emitted from
// handleDelete here; `objstore-put` is emitted from the REST PUT
// handler after commit.

import type { WebSocket } from 'ws'
import {
  type Handle,
  MAX_CONTENT_LENGTH,
  beginPut,
  deleteObject,
  getLive,
  isValidContentHash,
  isValidSignature,
  isValidTag,
  listLive,
  lockKey,
} from './store.ts'
import {
  type ObjstoreDeleteMsg,
  type ObjstoreFetchMsg,
  type ObjstoreListMsg,
  type ObjstorePutBeginMsg,
  verifyObjstoreDeleteSig,
  verifyObjstoreFetchSig,
  verifyObjstoreListSig,
  verifyObjstorePutSig,
} from './sign.ts'
import { type TokenSecret, mintGetToken, mintPutToken } from './tokens.ts'

export type ObjstoreDeps = {
  handle: Handle
  secret: TokenSecret
  send: (socket: WebSocket, msg: object) => void
  broadcast: (tag: string, msg: object, except: WebSocket | null) => void
  getNonce: (socket: WebSocket) => string | undefined
  debug: boolean
}

function debugTag(s: string): string { return `${s.slice(0, 12)}…` }
function urlPathFor(tag: string, resourceTag: string): string {
  return `/api/objstore/${tag}/${resourceTag}`
}

async function handlePutBegin(deps: ObjstoreDeps, socket: WebSocket, msg: ObjstorePutBeginMsg): Promise<void> {
  if (!isValidTag(msg.workspaceTag) || !isValidTag(msg.resourceTag)) return
  if (!isValidContentHash(msg.contentHash)) return
  if (!isValidSignature(msg.signature)) return
  // `Number.isSafeInteger` rather than `typeof === 'number'`: a NaN
  // or non-finite value would pass typeof + comparisons (NaN <
  // MAX_CONTENT_LENGTH is false), reaching sig verify only for the
  // signature to fail. Cheaper to reject up-front, and consistent
  // with `verifyObjstorePutSig`'s `isSafeNonNegativeInt` gate.
  if (!Number.isSafeInteger(msg.expectedLength) || (msg.expectedLength as number) < 0 || (msg.expectedLength as number) > MAX_CONTENT_LENGTH) return
  // Symmetric with `handleDelete`'s prevVersion gate (line 116) and
  // `verifyObjstorePutSig`'s `isSafeIntOrNull` (sign.ts:119). Without
  // this, a non-safe-integer `prevVersion` (NaN, 2^53+1, ...) would
  // pass the typeof check below and reach sig verify, burning a
  // hash + Ed25519 round-trip on a guaranteed-fail input. Input-
  // validation audit `server/objstore/handlers.ts:76`.
  if (msg.prevVersion != null && (typeof msg.prevVersion !== 'number' || !Number.isSafeInteger(msg.prevVersion))) return
  const nonce = deps.getNonce(socket)
  if (typeof nonce !== 'string') return
  if (!await verifyObjstorePutSig(msg, nonce)) {
    if (deps.debug) console.warn('reject objstore-put-begin: bad sig', debugTag(msg.workspaceTag))
    return
  }
  if (socket.readyState !== socket.OPEN) return
  const tag = msg.workspaceTag
  const resourceTag = msg.resourceTag
  const prevVersion = typeof msg.prevVersion === 'number' ? msg.prevVersion : null
  // Serialise against concurrent commits / deletes on the same
  // resource so the prev_version recheck inside beginPut isn't
  // stale when the staging row lands.
  const result = await deps.handle.lock.run(lockKey(tag, resourceTag), () => beginPut(deps.handle, {
    workspaceTag: tag, resourceTag, prevVersion,
    expectedLength: msg.expectedLength as number,
    contentHash: msg.contentHash as string,
    signature: msg.signature as string,
  }))
  if (!result.ok) {
    // `workspace-full` is the per-workspace 100-resource cap; goes
    // out as a typed error so the client can distinguish a quota
    // refusal from a `conflict` (which is a version-precondition
    // mismatch that the client can fix by re-reading + rebasing).
    if (result.reason === 'workspace-full') {
      deps.send(socket, { type: 'objstore-put-error', workspaceTag: tag, resourceTag, reason: 'workspace-full' })
      return
    }
    deps.send(socket, conflictReply('put', tag, resourceTag, result.conflict))
    return
  }
  const { token, exp } = mintPutToken(deps.secret, tag, resourceTag, result.stagingId, msg.expectedLength as number)
  deps.send(socket, {
    type: 'objstore-put-token',
    workspaceTag: tag, resourceTag,
    stagingId: result.stagingId,
    urlPath: urlPathFor(tag, resourceTag),
    token, expiresAt: exp,
  })
}

function conflictReply(action: 'put' | 'delete', tag: string, resourceTag: string, current: object | null): object {
  return current
    ? { type: 'objstore-conflict', action, workspaceTag: tag, resourceTag, current }
    : { type: 'objstore-conflict', action, workspaceTag: tag, resourceTag }
}

async function handleDelete(deps: ObjstoreDeps, socket: WebSocket, msg: ObjstoreDeleteMsg): Promise<void> {
  if (!isValidTag(msg.workspaceTag) || !isValidTag(msg.resourceTag) || !isValidSignature(msg.signature)) return
  if (msg.prevVersion != null && (typeof msg.prevVersion !== 'number' || !Number.isSafeInteger(msg.prevVersion))) return
  const nonce = deps.getNonce(socket)
  if (typeof nonce !== 'string') return
  if (!await verifyObjstoreDeleteSig(msg, nonce)) {
    if (deps.debug) console.warn('reject objstore-delete: bad sig', debugTag(msg.workspaceTag))
    return
  }
  // Symmetric with handlePutBegin / handleList / handleFetch — a
  // socket that closed mid-verify is the half-handshake leak case;
  // dropping the delete here keeps the protocol's "ack on this same
  // socket" contract from racing the close handler. PR #4 review F4.
  if (socket.readyState !== socket.OPEN) return
  const tag = msg.workspaceTag
  const resourceTag = msg.resourceTag
  const prev = typeof msg.prevVersion === 'number' ? msg.prevVersion : null
  const result = await deps.handle.lock.run(lockKey(tag, resourceTag), () => deleteObject(deps.handle, tag, resourceTag, prev))
  if (!result.ok) {
    if (result.reason === 'conflict') deps.send(socket, conflictReply('delete', tag, resourceTag, result.conflict ?? null))
    else deps.send(socket, { type: 'objstore-delete-error', workspaceTag: tag, resourceTag, reason: result.reason })
    return
  }
  deps.send(socket, { type: 'objstore-deleted-ack', workspaceTag: tag, resourceTag, deletedVersion: result.deletedVersion })
  if (result.deletedVersion === 0) return // sentinel: nothing to broadcast
  // Broadcast to ALL subscribers (including the originator). The
  // REST PUT path's `objstore-put` broadcast at rest.ts:308 already
  // uses `except: null`, so a session that listens via `onPut`
  // observes its own PUTs as echo events. The same symmetry on
  // `onDeleted` lets `session.onDeleted` fire for the session's
  // own deletes — pinned by `tests/objstore-client-races.test.js`.
  deps.broadcast(tag, { type: 'objstore-deleted', workspaceTag: tag, resourceTag, version: result.deletedVersion }, null)
  if (deps.debug) console.log(`objstore delete → ${debugTag(tag)}/${resourceTag.slice(0, 8)}…`)
}

async function handleList(deps: ObjstoreDeps, socket: WebSocket, msg: ObjstoreListMsg): Promise<void> {
  if (!isValidTag(msg.workspaceTag) || !isValidSignature(msg.signature)) return
  const nonce = deps.getNonce(socket)
  if (typeof nonce !== 'string') return
  if (!await verifyObjstoreListSig(msg, nonce)) {
    if (deps.debug) console.warn('reject objstore-list: bad sig', debugTag(msg.workspaceTag))
    return
  }
  if (socket.readyState !== socket.OPEN) return
  const rows = await listLive(deps.handle, msg.workspaceTag)
  deps.send(socket, {
    type: 'objstore-list-result',
    workspaceTag: msg.workspaceTag,
    resources: rows.map((r) => ({
      resourceTag: r.resourceTag, version: r.version, contentHash: r.contentHash,
      contentLength: r.contentLength, signature: r.signature,
    })),
  })
}

async function handleFetch(deps: ObjstoreDeps, socket: WebSocket, msg: ObjstoreFetchMsg): Promise<void> {
  if (!isValidTag(msg.workspaceTag) || !isValidTag(msg.resourceTag) || !isValidSignature(msg.signature)) return
  const nonce = deps.getNonce(socket)
  if (typeof nonce !== 'string') return
  if (!await verifyObjstoreFetchSig(msg, nonce)) {
    if (deps.debug) console.warn('reject objstore-fetch: bad sig', debugTag(msg.workspaceTag))
    return
  }
  if (socket.readyState !== socket.OPEN) return
  const tag = msg.workspaceTag
  const resourceTag = msg.resourceTag
  // Direct (workspace_tag, resource_tag) lookup — `listLive(...).find()`
  // is O(n) per fetch and gets expensive for workspaces with many
  // resources. PR #4 review.
  const row = await getLive(deps.handle, tag, resourceTag)
  if (!row) {
    deps.send(socket, { type: 'objstore-fetch-not-found', workspaceTag: tag, resourceTag })
    return
  }
  const { token, exp } = mintGetToken(deps.secret, tag, resourceTag, row.version)
  deps.send(socket, {
    type: 'objstore-fetch-token',
    workspaceTag: tag, resourceTag,
    version: row.version,
    contentHash: row.contentHash,
    contentLength: row.contentLength,
    signature: row.signature,
    urlPath: urlPathFor(tag, resourceTag),
    token, expiresAt: exp,
  })
}

// Staging rows abandoned by a disconnected socket are picked up by
// the reaper's TTL pass within `STAGING_TTL_MS_DEFAULT` — no per-
// socket bookkeeping is needed on disconnect today. If that ever
// changes, wire a `cleanupSocket(socket)` into both this bundle and
// server/index.ts's close handler.

export type ObjstoreHandlers = {
  handlePutBegin: (s: WebSocket, m: ObjstorePutBeginMsg) => Promise<void>
  handleDelete: (s: WebSocket, m: ObjstoreDeleteMsg) => Promise<void>
  handleList: (s: WebSocket, m: ObjstoreListMsg) => Promise<void>
  handleFetch: (s: WebSocket, m: ObjstoreFetchMsg) => Promise<void>
}

export function createObjstoreHandlers(deps: ObjstoreDeps): ObjstoreHandlers {
  return {
    handlePutBegin: (s, m) => handlePutBegin(deps, s, m),
    handleDelete: (s, m) => handleDelete(deps, s, m),
    handleList: (s, m) => handleList(deps, s, m),
    handleFetch: (s, m) => handleFetch(deps, s, m),
  }
}
