// Canonical signing payloads + Ed25519 sign helpers for the
// v1.objstore WS plane. Wire-byte mirror of `server/objstore/sign.ts`
// so a server-side `verifyEd25519(workspaceTag, canonical, signature)`
// reproduces the same bytes the client signed.
//
// Domain prefixes are distinct from triage-sync's so a captured save
// / subscribe signature can't be replayed as a PUT / DELETE / LIST /
// FETCH and vice versa.

import { encodeUtf8 } from '../common/utf8.js'

const PUT_DOMAIN = 'deepview-objstore.v1.put'
const DELETE_DOMAIN = 'deepview-objstore.v1.delete'
const LIST_DOMAIN = 'deepview-objstore.v1.list'
const FETCH_DOMAIN = 'deepview-objstore.v1.fetch'

// Fields the client passes to the canonical builders. `prevVersion`
// is `number | null` — null is the "must-not-exist" precondition.
// Numeric fields are the wire shape, NOT pre-stringified — the
// canonical builders coerce uniformly so the server's
// `String(expectedLength)` and the client's match byte-for-byte.
export type ObjstorePutBeginFields = {
  workspaceTag: string
  resourceTag: string
  prevVersion: number | null
  expectedLength: number
  contentHash: string
}

export type ObjstoreDeleteFields = {
  workspaceTag: string
  resourceTag: string
  prevVersion: number | null
}

// Null-or-int → '' or decimal string. Matches `intOrEmpty` in
// `server/objstore/sign.ts`; the server's verify path uses the
// same coercion, so any reachable client-side `null | number`
// produces identical canonical bytes.
function intOrEmpty(v: number | null): string {
  return v == null ? '' : String(v)
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
    connectionNonce,
  ].join('\n'))
}

export function canonicalObjstoreList(workspaceTag: string, connectionNonce: string): Uint8Array<ArrayBuffer> {
  return encodeUtf8([LIST_DOMAIN, workspaceTag, connectionNonce].join('\n'))
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

export function signObjstoreList(privateKey: CryptoKey, workspaceTag: string, connectionNonce: string): Promise<string> {
  return signCanonical(privateKey, canonicalObjstoreList(workspaceTag, connectionNonce))
}

export function signObjstoreFetch(privateKey: CryptoKey, workspaceTag: string, resourceTag: string, connectionNonce: string): Promise<string> {
  return signCanonical(privateKey, canonicalObjstoreFetch(workspaceTag, resourceTag, connectionNonce))
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
