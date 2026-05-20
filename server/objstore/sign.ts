// Canonical bytes + Ed25519 verifiers for the v1.objstore extension.
// Domain prefixes are distinct from triage-sync's so a captured save
// / subscribe signature can't be replayed as a PUT / DELETE / LIST
// / FETCH and vice versa.

import { encodeUtf8 } from '../../common/utf8.js'
import { verifyEd25519 } from '../sign.ts'

const OBJSTORE_PUT_DOMAIN = 'deepview-objstore.v1.put'
const OBJSTORE_DELETE_DOMAIN = 'deepview-objstore.v1.delete'
const OBJSTORE_LIST_DOMAIN = 'deepview-objstore.v1.list'
const OBJSTORE_FETCH_DOMAIN = 'deepview-objstore.v1.fetch'

// Wire shapes the verifiers accept. Fields land here post-
// `JSON.parse`, so every value starts life as `unknown` — strict
// type checks inside each verifier are the trust boundary.
export type ObjstorePutBeginMsg = {
  workspaceTag?: unknown
  resourceTag?: unknown
  prevVersion?: unknown
  expectedLength?: unknown
  contentHash?: unknown
  signature?: unknown
}

export type ObjstoreDeleteMsg = {
  workspaceTag?: unknown
  resourceTag?: unknown
  prevVersion?: unknown
  signature?: unknown
}

export type ObjstoreListMsg = {
  workspaceTag?: unknown
  signature?: unknown
}

export type ObjstoreFetchMsg = {
  workspaceTag?: unknown
  resourceTag?: unknown
  signature?: unknown
}

function intOrEmpty(v: unknown): string {
  return v == null ? '' : String(v)
}

// Newline-joined fields after the domain prefix — same construction
// as triage-sync's canonicalSave. Newlines can't appear in base64url
// tokens or in the bare integer fields, so framing is unambiguous
// without length-prefixes. `prevVersion` is `''` when null, decimal
// otherwise — matches the server's storage convention.
//
// EVERY canonical (put / delete / list / fetch) binds the per-
// connection challenge nonce so a captured frame can't be replayed
// across connections. Without this, a passive observer of past wire
// traffic could replay a `objstore-delete` whenever the live version
// happens to match (versions restart at 1 after each delete, so
// `prevVersion=1` is a recurring alignment window). PR #4 review H2.
function canonicalObjstorePut(msg: ObjstorePutBeginMsg, connectionNonce: string): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    OBJSTORE_PUT_DOMAIN,
    msg.workspaceTag as string,
    msg.resourceTag as string,
    intOrEmpty(msg.prevVersion),
    msg.contentHash as string,
    String(msg.expectedLength),
    connectionNonce,
  ].join('\n'))
}

function canonicalObjstoreDelete(msg: ObjstoreDeleteMsg, connectionNonce: string): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    OBJSTORE_DELETE_DOMAIN,
    msg.workspaceTag as string,
    msg.resourceTag as string,
    intOrEmpty(msg.prevVersion),
    connectionNonce,
  ].join('\n'))
}

function canonicalObjstoreList(msg: ObjstoreListMsg, connectionNonce: string): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    OBJSTORE_LIST_DOMAIN,
    msg.workspaceTag as string,
    connectionNonce,
  ].join('\n'))
}

function canonicalObjstoreFetch(msg: ObjstoreFetchMsg, connectionNonce: string): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    OBJSTORE_FETCH_DOMAIN,
    msg.workspaceTag as string,
    msg.resourceTag as string,
    connectionNonce,
  ].join('\n'))
}

// `Number.isSafeInteger` rather than `Number.isInteger`: JSON numbers
// are IEEE-754 and integers above 2^53-1 aren't precisely
// representable. Accepting non-safe integers would let a signed
// `expectedLength = 9_007_199_254_740_993` round-trip to a different
// value on receivers, fail size comparisons silently, and cascade
// into mismatched-canonical-bytes / failed verifies. PR #4 review.
function isSafeNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

function isSafeIntOrNull(v: unknown): boolean {
  return v == null || (typeof v === 'number' && Number.isSafeInteger(v))
}

// Shared tail for the four verifiers. The universal trust-boundary
// checks (workspaceTag / signature / connectionNonce must be strings)
// live here; each verifier adds only its own message-specific field
// gates before delegating. `build` is a thunk over the already-
// validated message + the (now-narrowed) nonce — a throw from it
// (lone surrogate, etc.) is treated as a verify failure, never an
// escaping exception. Centralising the build→verify step keeps the
// four message types from drifting on the canonical-bytes / Ed25519
// plumbing.
async function verifyObjstoreSig(
  msg: { workspaceTag?: unknown; signature?: unknown },
  connectionNonce: unknown,
  build: (connectionNonce: string) => Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  if (typeof msg.workspaceTag !== 'string') return false
  if (typeof msg.signature !== 'string') return false
  if (typeof connectionNonce !== 'string') return false
  let payload: Uint8Array<ArrayBuffer>
  try { payload = build(connectionNonce) } catch { return false }
  return await verifyEd25519(msg.workspaceTag, payload, msg.signature)
}

export function verifyObjstorePutSig(msg: ObjstorePutBeginMsg, connectionNonce: unknown): Promise<boolean> {
  if (typeof msg.resourceTag !== 'string') return Promise.resolve(false)
  if (typeof msg.contentHash !== 'string') return Promise.resolve(false)
  if (!isSafeIntOrNull(msg.prevVersion)) return Promise.resolve(false)
  if (!isSafeNonNegativeInt(msg.expectedLength)) return Promise.resolve(false)
  return verifyObjstoreSig(msg, connectionNonce, (nonce) => canonicalObjstorePut(msg, nonce))
}

export function verifyObjstoreDeleteSig(msg: ObjstoreDeleteMsg, connectionNonce: unknown): Promise<boolean> {
  if (typeof msg.resourceTag !== 'string') return Promise.resolve(false)
  if (!isSafeIntOrNull(msg.prevVersion)) return Promise.resolve(false)
  return verifyObjstoreSig(msg, connectionNonce, (nonce) => canonicalObjstoreDelete(msg, nonce))
}

export function verifyObjstoreListSig(msg: ObjstoreListMsg, connectionNonce: unknown): Promise<boolean> {
  return verifyObjstoreSig(msg, connectionNonce, (nonce) => canonicalObjstoreList(msg, nonce))
}

export function verifyObjstoreFetchSig(msg: ObjstoreFetchMsg, connectionNonce: unknown): Promise<boolean> {
  if (typeof msg.resourceTag !== 'string') return Promise.resolve(false)
  return verifyObjstoreSig(msg, connectionNonce, (nonce) => canonicalObjstoreFetch(msg, nonce))
}
