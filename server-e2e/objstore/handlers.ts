// v1.objstore WS message handlers — control plane only. Byte
// transfer lives on the REST plane (rest.ts); these handlers mint
// the bearer tokens the REST handler validates. Each WS message
// that authorises byte transfer requires an Ed25519 signature
// against the workspaceTag, then a short-TTL HMAC token bound to
// the (tag, resource, version-or-stagingId, length) tuple.
//
// Operations that mutate (begin / commit / delete) take NO in-process
// lock: commit correctness is the atomic version-CAS in commitPut,
// begin's prev_version check is advisory, and delete is a precondition-
// checked single-row drop (see store.ts for the full lock-free
// rationale).
//
// Broadcasts to peers subscribed via `workspace-subscribe` reuse
// the existing subscriber map: `objstore-deleted` is emitted from
// handleDelete here; `objstore-put` is emitted from the REST PUT
// handler after commit.

import type { WebSocket } from 'ws'
import {
  type Handle,
  MAX_CONTENT_LENGTH,
  type ObjectRow,
  beginPut,
  deleteObject,
  getLive,
  isValidContentHash,
  isValidSignature,
  isValidTag,
  objectMetaWire,
} from './store.ts'
import {
  type ObjstoreDeleteMsg,
  type ObjstoreFetchMsg,
  type ObjstorePutBeginMsg,
  verifyObjstoreDeleteSig,
  verifyObjstoreFetchSig,
  verifyObjstorePutSig,
} from './sign.ts'
import { type TokenSecret, mintGetToken, mintPutToken } from './tokens.ts'
import { debugTag } from '../util.ts'

export type ObjstoreDeps = {
  handle: Handle
  secret: TokenSecret
  send: (socket: WebSocket, msg: object) => void
  broadcast: (tag: string, msg: object, except: WebSocket | null) => void
  // Cross-instance pub/sub for objstore-deleted. Fired alongside the
  // local `broadcast` after a successful delete so peers on OTHER
  // server instances see the version drop in real time. Carries the
  // full (tag, resourceTag, version) tuple inline — the workspace_object
  // row is gone post-delete, so the bus payload IS the wire data.
  publishObjDeleted: (tag: string, resourceTag: string, version: number) => void
  getNonce: (socket: WebSocket) => string | undefined
  debug: boolean
  // Auth gate for the FIRST put-begin against a never-before-seen
  // workspace tag. See ObjstoreInitDeps for rationale. Run AFTER
  // sig verify so `unauthorized` only reaches legitimate signers.
  // Absent → no gating (no-config default).
  authGate?: (socket: WebSocket, workspaceTag: string) => Promise<boolean>
  sendUnauthorized?: (socket: WebSocket, ctx: { kind: 'gated'; workspaceTag: string; resourceTag: string }) => void
}

function urlPathFor(tag: string, resourceTag: string): string {
  return `/api/objstore/${tag}/${resourceTag}`
}

// Shared gate every objstore handler runs after its message-specific
// field checks: fetch the socket's challenge nonce, verify the signed
// message against it, then re-confirm the socket is still OPEN — the
// close handler may have fired during the verify await, and replying
// on a closed socket is the half-handshake leak case (PR #4 review
// F4). Centralising the post-await readyState recheck keeps that
// invariant in one auditable place. Returns true when the caller may
// proceed.
async function verified<M extends { workspaceTag?: unknown }>(
  deps: ObjstoreDeps, socket: WebSocket, msg: M, label: string,
  verify: (m: M, nonce: string) => Promise<boolean>,
): Promise<boolean> {
  const nonce = deps.getNonce(socket)
  if (typeof nonce !== 'string') return false
  if (!await verify(msg, nonce)) {
    if (deps.debug) console.warn(`reject objstore-${label}: bad sig`, debugTag(msg.workspaceTag as string))
    return false
  }
  return socket.readyState === socket.OPEN
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
  // Same up-front reject for `prevVersion` (symmetric with handleDelete
  // and `verifyObjstorePutSig`'s `isSafeIntOrNull`): a non-safe-integer
  // (NaN, 2^53+1, ...) would pass the typeof check below and reach sig
  // verify, burning a hash + Ed25519 round-trip on a guaranteed fail.
  if (msg.prevVersion != null && (typeof msg.prevVersion !== 'number' || !Number.isSafeInteger(msg.prevVersion))) return
  if (!await verified(deps, socket, msg, 'put-begin', verifyObjstorePutSig)) return
  const tag = msg.workspaceTag
  const resourceTag = msg.resourceTag
  // Auth gate for the FIRST action against a never-before-seen
  // workspace tag (no rows in workspace_revision AND none in
  // workspace_object). Mirrors handleSave in server-e2e/index.ts; runs
  // AFTER sig verify so `unauthorized` only reaches a legitimate
  // signer. Config-driven (server-e2e/config.json `password`), no-op when
  // unconfigured.
  if (deps.authGate && deps.sendUnauthorized && await deps.authGate(socket, tag)) {
    if (socket.readyState !== socket.OPEN) return
    if (deps.debug) console.warn(`reject objstore-put-begin: unauthorized (new workspace ${debugTag(tag)})`)
    deps.sendUnauthorized(socket, { kind: 'gated', workspaceTag: tag, resourceTag })
    return
  }
  const prevVersion = typeof msg.prevVersion === 'number' ? msg.prevVersion : null
  // `verifyObjstorePutSig` already enforced the prevVersion/prevIncarnation
  // pairing (null-iff-null + valid id shape), so this narrows safely.
  const prevIncarnation = typeof msg.prevIncarnation === 'string' ? msg.prevIncarnation : null
  // No lock: beginPut's prev check is advisory (a fast-fail so the
  // client rebases before uploading). The authoritative precondition is
  // commitPut's version+incarnation-CAS, which stays correct no matter
  // what races between this begin and that commit.
  const result = await beginPut(deps.handle, {
    workspaceTag: tag, resourceTag, prevVersion, prevIncarnation,
    expectedLength: msg.expectedLength as number,
    contentHash: msg.contentHash as string,
    signature: msg.signature as string,
  })
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

// `current` is the live `ObjectRow`, which carries the server-only
// `putAt` debug column. Project it through `objectMetaWire` before it
// reaches the wire so the conflict frame matches the fetch/list/PUT
// frames and never leaks `putAt`. Typed `ObjectRow | null` so the
// projection contract is checked rather than relying on `object`.
function conflictReply(action: 'put' | 'delete', tag: string, resourceTag: string, current: ObjectRow | null): object {
  return current
    ? { type: 'objstore-conflict', action, workspaceTag: tag, resourceTag, current: objectMetaWire(current) }
    : { type: 'objstore-conflict', action, workspaceTag: tag, resourceTag }
}

async function handleDelete(deps: ObjstoreDeps, socket: WebSocket, msg: ObjstoreDeleteMsg): Promise<void> {
  if (!isValidTag(msg.workspaceTag) || !isValidTag(msg.resourceTag) || !isValidSignature(msg.signature)) return
  if (msg.prevVersion != null && (typeof msg.prevVersion !== 'number' || !Number.isSafeInteger(msg.prevVersion))) return
  if (!await verified(deps, socket, msg, 'delete', verifyObjstoreDeleteSig)) return
  const tag = msg.workspaceTag
  const resourceTag = msg.resourceTag
  const prev = typeof msg.prevVersion === 'number' ? msg.prevVersion : null
  const prevIncarnation = typeof msg.prevIncarnation === 'string' ? msg.prevIncarnation : null
  // No lock: deleteObject is a precondition-checked version-CAS drop.
  // A concurrent commit OR delete races that CAS (not a shared blob —
  // the live blob is content-addressed + GC'd by the reaper, never
  // unlinked here): exactly one op wins, the loser gets conflict /
  // not-found (and never broadcasts). See the deleteObject doc in
  // store.ts.
  const result = await deleteObject(deps.handle, tag, resourceTag, prev, prevIncarnation)
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
  // Cross-instance fan-out (Neon mode). The workspace_object row is
  // gone post-delete so the bus payload carries (tag, resourceTag,
  // version) inline; the receiver builds its `objstore-deleted`
  // broadcast directly from the bus envelope. SQLite mode publishes
  // to a no-op.
  deps.publishObjDeleted(tag, resourceTag, result.deletedVersion)
  if (deps.debug) console.log(`objstore delete → ${debugTag(tag)}/${resourceTag.slice(0, 8)}…`)
}

async function handleFetch(deps: ObjstoreDeps, socket: WebSocket, msg: ObjstoreFetchMsg): Promise<void> {
  if (!isValidTag(msg.workspaceTag) || !isValidTag(msg.resourceTag) || !isValidSignature(msg.signature)) return
  if (!await verified(deps, socket, msg, 'fetch', verifyObjstoreFetchSig)) return
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
  const { token, exp } = mintGetToken(deps.secret, tag, resourceTag, row.version, row.incarnation)
  deps.send(socket, {
    type: 'objstore-fetch-token',
    workspaceTag: tag,
    ...objectMetaWire(row),
    urlPath: urlPathFor(tag, resourceTag),
    token, expiresAt: exp,
  })
}

// Staging rows abandoned by a disconnected socket are picked up by
// the reaper's TTL pass within `STAGING_TTL_MS_DEFAULT` — no per-
// socket bookkeeping is needed on disconnect today. If that ever
// changes, wire a `cleanupSocket(socket)` into both this bundle and
// server-e2e/index.ts's close handler.

export type ObjstoreHandlers = {
  handlePutBegin: (s: WebSocket, m: ObjstorePutBeginMsg) => Promise<void>
  handleDelete: (s: WebSocket, m: ObjstoreDeleteMsg) => Promise<void>
  handleFetch: (s: WebSocket, m: ObjstoreFetchMsg) => Promise<void>
}

export function createObjstoreHandlers(deps: ObjstoreDeps): ObjstoreHandlers {
  return {
    handlePutBegin: (s, m) => handlePutBegin(deps, s, m),
    handleDelete: (s, m) => handleDelete(deps, s, m),
    handleFetch: (s, m) => handleFetch(deps, s, m),
  }
}
