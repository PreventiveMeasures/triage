// Canonical bytes + Ed25519 verifiers for the v1.objstore extension.
// Domain prefixes are distinct from triage-sync's so a captured save
// / subscribe signature can't be replayed as a PUT / DELETE / LIST
// / FETCH and vice versa.

import { encodeUtf8 } from '../../common/utf8.js'
import { verifyEd25519 } from '../sign.ts'
import { isValidIncarnation } from './store.ts'

const OBJSTORE_PUT_DOMAIN = 'deepview-objstore.v1.put'
const OBJSTORE_DELETE_DOMAIN = 'deepview-objstore.v1.delete'
const OBJSTORE_FETCH_DOMAIN = 'deepview-objstore.v1.fetch'
// REST fetch-mint domain — MUST match the client's FETCH_REST_DOMAIN
// (client/sync/objstore-crypto.ts). Distinct from OBJSTORE_FETCH_DOMAIN so
// a WS-fetch signature can't be replayed against the REST mint endpoint.
const OBJSTORE_FETCH_REST_DOMAIN = 'deepview-objstore.v1.fetch-rest'
// REST put-begin domain — MUST match the client's PUT_REST_DOMAIN. Distinct
// from OBJSTORE_PUT_DOMAIN so a WS put-begin signature can't be replayed
// against the REST mint endpoint.
const OBJSTORE_PUT_REST_DOMAIN = 'deepview-objstore.v1.put-rest'
// REST delete domain — MUST match the client's DELETE_REST_DOMAIN. Distinct
// from OBJSTORE_DELETE_DOMAIN so a WS delete signature can't be replayed
// against the REST mint endpoint.
const OBJSTORE_DELETE_REST_DOMAIN = 'deepview-objstore.v1.delete-rest'

// Wire shapes the verifiers accept. Fields land here post-
// `JSON.parse`, so every value starts life as `unknown` — strict
// type checks inside each verifier are the trust boundary.
export type ObjstorePutBeginMsg = {
  workspaceTag?: unknown
  resourceTag?: unknown
  prevVersion?: unknown
  prevIncarnation?: unknown
  expectedLength?: unknown
  contentHash?: unknown
  signature?: unknown
}

export type ObjstoreDeleteMsg = {
  workspaceTag?: unknown
  resourceTag?: unknown
  prevVersion?: unknown
  prevIncarnation?: unknown
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

// `prevIncarnation` → '' when null, the base64url id otherwise. The
// client mirror (`incOrEmpty`) passes the string through verbatim;
// `String(v)` here is a no-op on the validated string and matches it
// byte-for-byte.
function strOrEmpty(v: unknown): string {
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
    strOrEmpty(msg.prevIncarnation),
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
    strOrEmpty(msg.prevIncarnation),
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

// REST fetch-mint canonical. Binds a client epoch-ms timestamp (string-
// encoded to match the client) in place of the connection nonce; the REST
// handler enforces the freshness window + replay dedup.
function canonicalObjstoreFetchRest(workspaceTag: string, resourceTag: string, ts: number): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    OBJSTORE_FETCH_REST_DOMAIN,
    workspaceTag,
    resourceTag,
    String(ts),
  ].join('\n'))
}

// REST put-begin canonical — the WS `canonicalObjstorePut` fields in the
// same order/coercion (intOrEmpty / strOrEmpty), under the put-rest domain
// and binding the client `ts` in place of the connection nonce.
function canonicalObjstorePutRest(
  workspaceTag: string, resourceTag: string,
  prevVersion: number | null, prevIncarnation: string | null,
  contentHash: string, expectedLength: number, ts: number,
): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    OBJSTORE_PUT_REST_DOMAIN,
    workspaceTag,
    resourceTag,
    intOrEmpty(prevVersion),
    strOrEmpty(prevIncarnation),
    contentHash,
    String(expectedLength),
    String(ts),
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

// prevIncarnation must travel as an inseparable pair with prevVersion:
// a numeric prevVersion carries a valid base64url incarnation id; a
// null prevVersion carries null. Reject the mixed combos (a half-pair)
// so a forged or stale precondition can't slip a version match past the
// CAS without the matching incarnation. The shape gate mirrors the
// staging-id check — a malformed id can't reach the CAS predicate.
function validPrevPair(prevVersion: unknown, prevIncarnation: unknown): boolean {
  if (prevVersion == null) return prevIncarnation == null
  return isValidIncarnation(prevIncarnation)
}

export function verifyObjstorePutSig(msg: ObjstorePutBeginMsg, connectionNonce: unknown): Promise<boolean> {
  if (typeof msg.resourceTag !== 'string') return Promise.resolve(false)
  if (typeof msg.contentHash !== 'string') return Promise.resolve(false)
  if (!isSafeIntOrNull(msg.prevVersion)) return Promise.resolve(false)
  if (!validPrevPair(msg.prevVersion, msg.prevIncarnation)) return Promise.resolve(false)
  if (!isSafeNonNegativeInt(msg.expectedLength)) return Promise.resolve(false)
  return verifyObjstoreSig(msg, connectionNonce, (nonce) => canonicalObjstorePut(msg, nonce))
}

export function verifyObjstoreDeleteSig(msg: ObjstoreDeleteMsg, connectionNonce: unknown): Promise<boolean> {
  if (typeof msg.resourceTag !== 'string') return Promise.resolve(false)
  if (!isSafeIntOrNull(msg.prevVersion)) return Promise.resolve(false)
  if (!validPrevPair(msg.prevVersion, msg.prevIncarnation)) return Promise.resolve(false)
  return verifyObjstoreSig(msg, connectionNonce, (nonce) => canonicalObjstoreDelete(msg, nonce))
}

export function verifyObjstoreFetchSig(msg: ObjstoreFetchMsg, connectionNonce: unknown): Promise<boolean> {
  if (typeof msg.resourceTag !== 'string') return Promise.resolve(false)
  return verifyObjstoreSig(msg, connectionNonce, (nonce) => canonicalObjstoreFetch(msg, nonce))
}

// Verify a REST fetch-mint signature. Unlike the WS verifiers this takes
// the already-validated fields directly (the REST handler parsed +
// range-checked `ts` and `signature`) rather than a wire `msg` + socket
// nonce. The workspaceTag IS the Ed25519 public key, so verification is
// fully self-contained — no session or stored key needed. A throw from
// the canonical build (lone surrogate, etc.) is treated as a verify
// failure, never an escaping exception.
export function verifyObjstoreFetchRestSig(
  workspaceTag: string, resourceTag: string, ts: number, signature: string,
): Promise<boolean> {
  let payload: Uint8Array<ArrayBuffer>
  try { payload = canonicalObjstoreFetchRest(workspaceTag, resourceTag, ts) }
  catch { return Promise.resolve(false) }
  return verifyEd25519(workspaceTag, payload, signature)
}

// Verify a REST put-begin signature. Same self-contained shape as
// `verifyObjstoreFetchRestSig` — the caller (rest.ts) has already
// range-checked the put fields + `ts`. The workspaceTag IS the pubkey.
export function verifyObjstorePutBeginRestSig(
  fields: { workspaceTag: string; resourceTag: string; prevVersion: number | null; prevIncarnation: string | null; contentHash: string; expectedLength: number },
  ts: number, signature: string,
): Promise<boolean> {
  let payload: Uint8Array<ArrayBuffer>
  try {
    payload = canonicalObjstorePutRest(
      fields.workspaceTag, fields.resourceTag, fields.prevVersion, fields.prevIncarnation,
      fields.contentHash, fields.expectedLength, ts,
    )
  } catch { return Promise.resolve(false) }
  return verifyEd25519(fields.workspaceTag, payload, signature)
}

// REST delete-mint canonical. WS `canonicalObjstoreDelete` fields, under the
// delete-rest domain, binding the client `ts` in place of the nonce.
function canonicalObjstoreDeleteRest(
  workspaceTag: string, resourceTag: string,
  prevVersion: number | null, prevIncarnation: string | null, ts: number,
): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    OBJSTORE_DELETE_REST_DOMAIN,
    workspaceTag,
    resourceTag,
    intOrEmpty(prevVersion),
    strOrEmpty(prevIncarnation),
    String(ts),
  ].join('\n'))
}

// Verify a REST delete-mint signature. Self-contained (workspaceTag IS the
// pubkey); the caller (rest.ts) has range-checked `ts` + the prev pair.
export function verifyObjstoreDeleteRestSig(
  fields: { workspaceTag: string; resourceTag: string; prevVersion: number | null; prevIncarnation: string | null },
  ts: number, signature: string,
): Promise<boolean> {
  let payload: Uint8Array<ArrayBuffer>
  try { payload = canonicalObjstoreDeleteRest(fields.workspaceTag, fields.resourceTag, fields.prevVersion, fields.prevIncarnation, ts) }
  catch { return Promise.resolve(false) }
  return verifyEd25519(fields.workspaceTag, payload, signature)
}
