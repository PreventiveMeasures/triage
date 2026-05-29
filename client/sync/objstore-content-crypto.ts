// Content-encryption helpers for the v1.objstore client. Wraps
// `client/objstore.ts`'s wire surface so plaintext (`fileName`,
// `content`) never leaves the client — the relay only ever sees:
//
//   - HMAC-SHA-256(tagKey, fileName) base64url-no-padding as the
//     wire `resourceTag` (privacy-preserving routing identifier,
//     deterministic so two peers naming the same fileName agree
//     without coordination),
//   - ChaCha20-Poly1305(contentKey) over `u16BE(nameLen) || name ||
//     content` with random 12-byte nonce prepended, bound via AAD
//     to (workspaceTag, resourceTag) so the server can't shuffle
//     blobs between resources or across workspaces.
//
// Sibling of `client/objstore-crypto.ts` — that file owns the
// Ed25519 signing canonical builders for wire frames; this file
// owns the content-layer AEAD + HMAC. They share no functions.
//
// Keys live in `ObjstoreKeys`: a sign-only Ed25519 CryptoKey for
// frame signatures, a 32-byte ChaCha20-Poly1305 key for payload
// encryption, and a 32-byte HMAC-SHA-256 key for tag derivation.
// All three derive from the workspace's 32-byte privateKey via
// HKDF-SHA-256 with distinct domain-separating info strings, so
// leaking any one key reveals nothing about the others.

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { encodeUtf8 } from '../../common/utf8.js'
import { deriveSigningKeypair } from './sync-crypto.ts'

const HKDF_CONTENT_INFO = 'deepview-objstore.v1.content'
const HKDF_TAG_INFO = 'deepview-objstore.v1.tag'

// Bytes prepended to each fileName / integrity before HMAC. Domain-
// separating prefixes prevent a hypothetical bug from cross-mapping
// a report `resourceTag` to a bundle's `bundleResourceTag` (or
// vice-versa) when they're both derived from the same `tagKey` —
// distinct prefixes make the tag spaces disjoint by construction.
// The literal `\n` separator matches the convention
// canonicalObjstore* uses.
const TAG_HMAC_PREFIX = 'objstore-tag\n'
const BUNDLE_TAG_HMAC_PREFIX = 'objstore-bundle-tag\n'

// AEAD nonce is 12 random bytes per PUT. Reused across multiple
// PUTs would be a key-recovery vulnerability with ChaCha20-Poly1305
// (the AEAD relies on nonce uniqueness for confidentiality), so
// each PUT MUST generate a fresh nonce — never derived from
// fileName or version.
const AEAD_NONCE_LEN = 12
// ChaCha20-Poly1305 appends a fixed 16-byte Poly1305 authentication
// tag to the ciphertext, so a payload's wire byte-length is a pure
// function of the plaintext length (see `objstorePayloadWireLength`).
const AEAD_TAG_LEN = 16

export type ObjstoreKeys = {
  // Ed25519 CryptoKey scoped to `['sign']`. Mirrors the existing
  // sync-crypto signing key — same derivation path so a session
  // can sign objstore frames AND triage-sync frames under one key.
  signingKey: CryptoKey
  // 32-byte raw key for ChaCha20-Poly1305. NOT a CryptoKey —
  // @noble/ciphers operates on raw bytes, and the WebCrypto
  // ChaCha20-Poly1305 support is uneven across runtimes (Node 22
  // ships it; Safari is still working on it), so the raw form
  // keeps the cipher in pure JS where the same code path works
  // everywhere.
  contentKey: Uint8Array
  // 32-byte raw key for HMAC-SHA-256. The HMAC primitive is
  // imported via WebCrypto at use time (`crypto.subtle.importKey
  // ('raw', tagKey, 'HMAC', false, ['sign'])`) — the raw form
  // here lets `deriveObjstoreKeys` hand back a Uint8Array without
  // a separate CryptoKey round-trip.
  tagKey: Uint8Array
  // base64url Ed25519 public key — what the relay knows the
  // session as. Stashed alongside the keys so callers don't have
  // to thread it separately.
  workspaceTag: string
}

// Derive all four objstore handles from the workspace's 32-byte
// secret + UUID. Single entrypoint so the domain-separation invariants
// (distinct info strings per key role) live in one file. Two peers
// with the same (privateKey, workspaceId) reproduce identical keys
// without a key-exchange step — which is the whole point of the
// share-by-link flow.
//
// Signing keypair + workspaceTag are produced by `sync-crypto.ts`'s
// `deriveSigningKeypair` — IMPORTANT for cross-protocol identity:
// the objstore session and the triage-sync session for the SAME
// workspace MUST resolve to the same Ed25519 keypair, so peers'
// `workspace-subscribe` and `objstore-*` traffic share one
// server-facing identifier. Duplicating the derivation here would
// risk a silent info-string drift (audit round-1 H1).
export async function deriveObjstoreKeys(privateKeyBase64: string, workspaceId: string): Promise<ObjstoreKeys> {
  const secret = Uint8Array.fromBase64(privateKeyBase64)
  if (secret.length !== 32) {
    throw new Error(`workspace private key must be 32 bytes (got ${secret.length})`)
  }
  const contentKey = await hkdfExpand(secret, HKDF_CONTENT_INFO, 32)
  const tagKey = await hkdfExpand(secret, HKDF_TAG_INFO, 32)
  // Zero the local copy of the raw secret as soon as the content +
  // tag keys are derived; the signing keypair walks the same path
  // (and zeros its own seed). Defense in depth — JS doesn't expose
  // a deterministic erase primitive (the GC may have moved the
  // bytes), but the explicit fill(0) drops the wrapper we hold.
  secret.fill(0)
  const { privateKey: signingKey, publicKeyB64: workspaceTag } = await deriveSigningKeypair(privateKeyBase64, workspaceId)
  return { signingKey, contentKey, tagKey, workspaceTag }
}

// HKDF-Expand step — Node 24 supports HKDF natively via WebCrypto's
// deriveBits, so we don't pull in @noble/hashes for this.
//
// Empty salt is RFC 5869-acceptable: the workspace privateKey IKM
// is a 32-byte CSPRNG output (uniformly random), so HKDF-Extract is
// a no-op-with-relabeling and a salt would add no entropy. Domain
// separation across all HKDF derivations in this codebase
// (`.content-key`, `.sign-key|<workspaceId>` in sync-crypto.ts;
// `.objstore.v1.content`, `.objstore.v1.tag` here) lives entirely
// in the info string. Pairwise-distinctness of info strings is
// pinned by `tests/sync-crypto-info-uniqueness.test.js`. See
// https://soatok.blog/2021/11/17/understanding-hkdf/ §3.
async function hkdfExpand(secret: Uint8Array, info: string, lengthBytes: number): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey('raw', secret as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: encodeUtf8(info) },
    baseKey,
    lengthBytes * 8,
  )
  return new Uint8Array(bits)
}

// Deterministic resource tag — HMAC-SHA-256(tagKey, 'objstore-tag\n'
// || fileName), base64url-no-padding (43 chars). Two peers naming
// the same fileName under the same workspaceKey produce the same
// tag without coordinating; an attacker without the tagKey can't
// link tags back to fileNames (HMAC is a PRF).
export async function computeResourceTag(tagKey: Uint8Array, fileName: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', tagKey as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encodeUtf8(TAG_HMAC_PREFIX + fileName)))
  return mac.toBase64({ alphabet: 'base64url', omitPadding: true })
}

// Bundle-specific resource tag — HMAC-SHA-256(tagKey,
// 'objstore-bundle-tag\n' || integrity), base64url-no-padding (43
// chars). Same shape as `computeResourceTag` for reports but with a
// distinct prefix so the report and bundle tag namespaces don't
// collide under the same tagKey. `integrity` is the bundle's sha512
// SRI string ("sha512-…") — peer-deterministic by content, so two
// peers seeing the same bundle bytes derive the same tag without
// coordinating.
export async function computeBundleResourceTag(tagKey: Uint8Array, integrity: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', tagKey as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encodeUtf8(BUNDLE_TAG_HMAC_PREFIX + integrity)))
  return mac.toBase64({ alphabet: 'base64url', omitPadding: true })
}

// Encrypt (fileName, content) into the wire payload the relay
// stores opaquely. Wire layout: `nonce(12) || ciphertext`. AEAD
// binds (workspaceTag, resourceTag) into AAD so the relay can't
// shuffle blobs between resources or across workspaces — a peer
// fetching workspace W1's tag T1 won't accidentally decrypt a
// blob the relay swapped in from workspace W2 (the AAD mismatches
// and `chacha20poly1305.decrypt` raises).
export function encryptObjstorePayload(
  contentKey: Uint8Array,
  fileName: string,
  content: Uint8Array,
  workspaceTag: string,
  resourceTag: string,
): Uint8Array {
  const nameBytes = encodeUtf8(fileName)
  if (nameBytes.length > 0xffff) {
    throw new Error(`fileName too long: ${nameBytes.length} bytes (max 65535)`)
  }
  const plaintext = new Uint8Array(2 + nameBytes.length + content.length)
  const dv = new DataView(plaintext.buffer)
  dv.setUint16(0, nameBytes.length, false)
  plaintext.set(nameBytes, 2)
  plaintext.set(content, 2 + nameBytes.length)
  const nonce = new Uint8Array(AEAD_NONCE_LEN)
  crypto.getRandomValues(nonce)
  const aad = encodeUtf8(`${workspaceTag}\n${resourceTag}`)
  const ciphertext = chacha20poly1305(contentKey, nonce, aad).encrypt(plaintext)
  const out = new Uint8Array(AEAD_NONCE_LEN + ciphertext.length)
  out.set(nonce, 0)
  out.set(ciphertext, AEAD_NONCE_LEN)
  return out
}

// Wire byte-length `encryptObjstorePayload` produces for a given
// (fileName, content) — computed WITHOUT encrypting. The framing is a
// fixed `nonce(12) || AEAD( u16BE(nameLen) || name || content )` and
// the AEAD adds a fixed 16-byte tag, so the length is a pure function
// of the name's UTF-8 byte length and the content length.
//
// The recovery path uses this as the "matching the expected one" gate:
// once a remote blob's bytes are gone (the server 503s the GET), the
// only surviving "same content?" signal is the live row's recorded
// `contentLength` — the random per-PUT nonce means the contentHash can
// NOT be reproduced from local plaintext. A locally-held report is
// reuploaded only when its re-encrypted wire length equals that
// recorded length. Kept next to the framing it mirrors so the two
// can't drift.
export function objstorePayloadWireLength(fileName: string, contentByteLength: number): number {
  return AEAD_NONCE_LEN + 2 + encodeUtf8(fileName).length + contentByteLength + AEAD_TAG_LEN
}

// Bundles carry both the sha512 integrity (for tag round-trip
// verification) AND a user-friendly name (for display in the sidebar
// + bundles list). The encryption primitive's "name" slot is
// reserved for the integrity, so the name rides in a structured
// content prefix:
//
//   wire content slot = u16BE(nameLen) || nameUtf8 || actualBundleBytes
//
// `wrapBundleContent` produces that shape; `unwrapBundleContent`
// reverses it. The maximum name length is the same 65535-byte cap
// that gates the name slot (the prefix word is u16BE either way).
// No backward-compat shim for unwrapped bundles: cloud sync is still
// pre-release.
export function wrapBundleContent(name: string, content: Uint8Array): Uint8Array {
  const nameBytes = encodeUtf8(name)
  if (nameBytes.length > 0xffff) {
    throw new Error(`bundle name too long: ${nameBytes.length} bytes (max 65535)`)
  }
  const out = new Uint8Array(2 + nameBytes.length + content.length)
  const dv = new DataView(out.buffer)
  dv.setUint16(0, nameBytes.length, false)
  out.set(nameBytes, 2)
  out.set(content, 2 + nameBytes.length)
  return out
}

export function unwrapBundleContent(wrapped: Uint8Array): { name: string; content: Uint8Array } {
  if (wrapped.length < 2) {
    throw new Error(`bundle wrapped content truncated: ${wrapped.length} bytes`)
  }
  const dv = new DataView(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength)
  const nameLen = dv.getUint16(0, false)
  if (2 + nameLen > wrapped.length) {
    throw new Error(`bundle wrapped nameLen ${nameLen} overflows ${wrapped.length}`)
  }
  const name = new TextDecoder('utf-8', { fatal: true }).decode(wrapped.subarray(2, 2 + nameLen))
  const content = new Uint8Array(wrapped.subarray(2 + nameLen))
  return { name, content }
}

// Reverse of `encryptObjstorePayload`. Throws on:
//   - too-short payload (< 12 + 16 = 28 bytes; AEAD tag is 16),
//   - AEAD tag mismatch (raises from @noble),
//   - AAD mismatch (raises from @noble — the (workspaceTag,
//     resourceTag) tuple must be the one the original PUT used),
//   - malformed inner frame (nameLen overflows the plaintext).
export function decryptObjstorePayload(
  contentKey: Uint8Array,
  payload: Uint8Array,
  workspaceTag: string,
  resourceTag: string,
): { fileName: string; content: Uint8Array } {
  if (payload.length < AEAD_NONCE_LEN + 16) {
    throw new Error(`objstore payload too short: ${payload.length} bytes`)
  }
  const nonce = payload.subarray(0, AEAD_NONCE_LEN)
  const ciphertext = payload.subarray(AEAD_NONCE_LEN)
  const aad = encodeUtf8(`${workspaceTag}\n${resourceTag}`)
  const plaintext = chacha20poly1305(contentKey, nonce, aad).decrypt(ciphertext)
  if (plaintext.length < 2) {
    throw new Error(`objstore plaintext truncated: ${plaintext.length} bytes`)
  }
  const dv = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength)
  const nameLen = dv.getUint16(0, false)
  if (2 + nameLen > plaintext.length) {
    throw new Error(`objstore plaintext nameLen ${nameLen} overflows ${plaintext.length}`)
  }
  const fileName = new TextDecoder('utf-8', { fatal: true }).decode(plaintext.subarray(2, 2 + nameLen))
  const content = plaintext.subarray(2 + nameLen)
  // Slice the inner Uint8Array into its own backing buffer so a
  // caller mutating one slice doesn't affect the other (decrypt
  // returns a single contiguous allocation we'd otherwise hand
  // back two aliased views into).
  return { fileName, content: new Uint8Array(content) }
}
