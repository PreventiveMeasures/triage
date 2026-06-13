// Canonical signing payloads + Ed25519 sign helpers for the
// v1.objstore WS plane. Wire-byte mirror of `e2e-server/objstore/sign.ts`
// so a server-side `verifyEd25519(workspaceTag, canonical, signature)`
// reproduces the same bytes the client signed.
//
// Domain prefixes are distinct from triage-sync's so a captured save
// / subscribe signature can't be replayed as a PUT / DELETE / LIST /
// FETCH and vice versa.

import { encodeUtf8 } from '../../common/utf8.js'

const PUT_DOMAIN = 'deepview-objstore.v1.put'
const DELETE_DOMAIN = 'deepview-objstore.v1.delete'
const FETCH_DOMAIN = 'deepview-objstore.v1.fetch'
// REST fetch-mint (POST /api/objstore/{tag}/{res}) — a DISTINCT domain
// from the WS FETCH so a captured WS-fetch signature can't be replayed
// as a REST mint, and vice versa. Binds a client timestamp instead of
// the connection nonce; the server enforces a freshness window + a
// replay cache in its place. See e2e-server/objstore/rest.ts.
const FETCH_REST_DOMAIN = 'deepview-objstore.v1.fetch-rest'
// REST put-begin mint (POST /api/objstore/{tag}/{res}, op:'put') — a
// DISTINCT domain from the WS PUT so a captured WS put-begin signature
// can't be replayed as a REST mint, and vice versa. Binds a client
// timestamp (same anti-replay model as FETCH_REST_DOMAIN).
const PUT_REST_DOMAIN = 'deepview-objstore.v1.put-rest'
// REST delete mint (POST /api/objstore/{tag}/{res}, op:'delete') — a
// DISTINCT domain from the WS DELETE so a captured WS delete signature
// can't be replayed as a REST mint. Binds a client timestamp (same
// anti-replay model as the other *-rest domains).
const DELETE_REST_DOMAIN = 'deepview-objstore.v1.delete-rest'

// Fields the client passes to the canonical builders. `prevVersion`
// is `number | null` — null is the "must-not-exist" precondition.
// Numeric fields are the wire shape, NOT pre-stringified — the
// canonical builders coerce uniformly so the server's
// `String(expectedLength)` and the client's match byte-for-byte.
export type ObjstorePutBeginFields = {
  workspaceTag: string
  resourceTag: string
  prevVersion: number | null
  prevIncarnation: string | null
  expectedLength: number
  contentHash: string
}

export type ObjstoreDeleteFields = {
  workspaceTag: string
  resourceTag: string
  prevVersion: number | null
  prevIncarnation: string | null
}

// Null-or-int → '' or decimal string. Matches `intOrEmpty` in
// `e2e-server/objstore/sign.ts`; the server's verify path uses the
// same coercion, so any reachable client-side `null | number`
// produces identical canonical bytes.
function intOrEmpty(v: number | null): string {
  return v == null ? '' : String(v)
}

// Mirror of `strOrEmpty` in e2e-server/objstore/sign.ts — '' when null,
// the base64url incarnation id verbatim otherwise. Keeps the canonical
// bytes byte-identical with the server verifier.
function incOrEmpty(v: string | null): string {
  return v == null ? '' : v
}

// Newline-joined fields after the domain prefix — same construction
// as triage-sync's canonicalSave. Newlines can't appear in base64url
// tokens or in the bare integer fields, so framing is unambiguous
// without length-prefixes. Each builder must match its server-side
// counterpart in BOTH field order AND coercion.
//
// EVERY canonical (put / delete / list / fetch) binds the per-
// connection challenge nonce so a captured frame can't be replayed
// across connections (round-9 H2).
export function canonicalObjstorePut(fields: ObjstorePutBeginFields, connectionNonce: string): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    PUT_DOMAIN,
    fields.workspaceTag,
    fields.resourceTag,
    intOrEmpty(fields.prevVersion),
    incOrEmpty(fields.prevIncarnation),
    fields.contentHash,
    String(fields.expectedLength),
    connectionNonce,
  ].join('\n'))
}

export function canonicalObjstoreDelete(fields: ObjstoreDeleteFields, connectionNonce: string): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    DELETE_DOMAIN,
    fields.workspaceTag,
    fields.resourceTag,
    intOrEmpty(fields.prevVersion),
    incOrEmpty(fields.prevIncarnation),
    connectionNonce,
  ].join('\n'))
}

export function canonicalObjstoreFetch(workspaceTag: string, resourceTag: string, connectionNonce: string): Uint8Array<ArrayBuffer> {
  return encodeUtf8([FETCH_DOMAIN, workspaceTag, resourceTag, connectionNonce].join('\n'))
}

// Ed25519 sign over the canonical bytes; base64url-no-padding to
// match the server's `isValidSignature` wire-shape gate.
async function signCanonical(privateKey: CryptoKey, canonical: Uint8Array<ArrayBuffer>): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, canonical))
  return sig.toBase64({ alphabet: 'base64url', omitPadding: true })
}

export function signObjstorePut(privateKey: CryptoKey, fields: ObjstorePutBeginFields, connectionNonce: string): Promise<string> {
  return signCanonical(privateKey, canonicalObjstorePut(fields, connectionNonce))
}

export function signObjstoreDelete(privateKey: CryptoKey, fields: ObjstoreDeleteFields, connectionNonce: string): Promise<string> {
  return signCanonical(privateKey, canonicalObjstoreDelete(fields, connectionNonce))
}

export function signObjstoreFetch(privateKey: CryptoKey, workspaceTag: string, resourceTag: string, connectionNonce: string): Promise<string> {
  return signCanonical(privateKey, canonicalObjstoreFetch(workspaceTag, resourceTag, connectionNonce))
}

// Canonical bytes for the REST fetch-mint signature. `ts` is the
// client's epoch-ms timestamp; the server rejects it outside a skew
// window and dedups the signature, so it plays the anti-replay role the
// connection nonce plays on the WS path. Stringified so the canonical
// form is byte-stable across the wire (matches the server's `String(ts)`).
export function canonicalObjstoreFetchRest(workspaceTag: string, resourceTag: string, ts: number): Uint8Array<ArrayBuffer> {
  return encodeUtf8([FETCH_REST_DOMAIN, workspaceTag, resourceTag, String(ts)].join('\n'))
}

export function signObjstoreFetchRest(privateKey: CryptoKey, workspaceTag: string, resourceTag: string, ts: number): Promise<string> {
  return signCanonical(privateKey, canonicalObjstoreFetchRest(workspaceTag, resourceTag, ts))
}

// REST put-begin canonical — the WS `canonicalObjstorePut` fields in the
// same order/coercion, but under the put-rest domain and binding a client
// `ts` instead of the connection nonce. Byte-stable against the server's
// `canonicalObjstorePutRest`.
export function canonicalObjstorePutRest(fields: ObjstorePutBeginFields, ts: number): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    PUT_REST_DOMAIN,
    fields.workspaceTag,
    fields.resourceTag,
    intOrEmpty(fields.prevVersion),
    incOrEmpty(fields.prevIncarnation),
    fields.contentHash,
    String(fields.expectedLength),
    String(ts),
  ].join('\n'))
}

export function signObjstorePutBeginRest(privateKey: CryptoKey, fields: ObjstorePutBeginFields, ts: number): Promise<string> {
  return signCanonical(privateKey, canonicalObjstorePutRest(fields, ts))
}

// REST delete canonical — the WS `canonicalObjstoreDelete` fields in the
// same order/coercion, under the delete-rest domain and binding a client
// `ts` instead of the connection nonce. Byte-stable against the server's
// `canonicalObjstoreDeleteRest`.
export function canonicalObjstoreDeleteRest(fields: ObjstoreDeleteFields, ts: number): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    DELETE_REST_DOMAIN,
    fields.workspaceTag,
    fields.resourceTag,
    intOrEmpty(fields.prevVersion),
    incOrEmpty(fields.prevIncarnation),
    String(ts),
  ].join('\n'))
}

export function signObjstoreDeleteRest(privateKey: CryptoKey, fields: ObjstoreDeleteFields, ts: number): Promise<string> {
  return signCanonical(privateKey, canonicalObjstoreDeleteRest(fields, ts))
}

// SHA-256 of the bytes, base64url-no-padding. Used to populate
// `contentHash` on put-begin AND to verify integrity on fetch:
// `SHA-256(received body) === contentHash from objstore-fetch-token`.
// A peer fetching bytes that don't match the signed `contentHash`
// has proof that the relay (or network) tampered with the bytes,
// since the workspaceTag-holder signed the hash into put-begin.
export async function computeContentHash(bytes: Uint8Array): Promise<string> {
  // Cast to `Uint8Array<ArrayBuffer>` — `crypto.subtle.digest` rejects
  // SharedArrayBuffer-backed views, but Node's `Buffer` /
  // `crypto.getRandomValues` always produce regular ArrayBuffer.
  // Same narrowing applies to the verify path on the server.
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return new Uint8Array(digest).toBase64({ alphabet: 'base64url', omitPadding: true })
}
