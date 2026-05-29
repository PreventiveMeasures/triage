// Ed25519 signature verification for incoming wire messages. The
// canonical signing payload format is identical to the client's
// (see client/sync-crypto.js's `canonicalSavePayload`) so a
// signature produced by a holder of the workspace seed verifies
// here without re-derivation.
//
// Two payload types:
//   save:      `<domain>\n<pubkey>\n<base>\n<keyframe>\n<nonce>\n<ciphertext>`
//   subscribe: `<domain>\n<pubkey>\n<from>\n<connectionNonce>`
//
// `keyframe` is `1` / `0` (string), bound into the signed bytes so
// the server can't promote/demote a revision after the fact.
// `from` is the client's last-applied revision id (or empty for a
// fresh subscribe), so a captured subscribe sig can't be replayed
// to fast-forward another peer to a different cursor.
// `connectionNonce` is a per-socket challenge the server emits in
// a `challenge` frame the moment the socket opens (round-9 H2). A
// captured subscribe frame can't be replayed from a different
// connection because the canonical bytes the captured signature
// covered include the OLD nonce; the attacker's new connection
// has a DIFFERENT nonce; signature verify fails.
//
// Domains are different so a save signature can't be replayed as
// a subscribe and vice versa.

import { Buffer } from 'node:buffer'
import { encodeUtf8 } from '../common/utf8.js'

const SAVE_DOMAIN = 'deepview-triage-sync.v1.save'
const SUBSCRIBE_DOMAIN = 'deepview-triage-sync.v1.subscribe'

// Wire-message shapes the verifiers accept. Fields land here
// post-`JSON.parse`, so every value starts life as `unknown` —
// strict type checks (`typeof x === 'string'`) inside the
// verifiers are the trust boundary, and call sites can pass any
// `Record<string, unknown>` shape without casts.
export type SaveMsg = {
  workspaceTag?: unknown
  base?: unknown
  keyframe?: unknown
  nonce?: unknown
  ciphertext?: unknown
  signature?: unknown
}

export type SubscribeMsg = {
  workspaceTag?: unknown
  from?: unknown
  signature?: unknown
}

// `verifySaveSigAndCanonical` returns either the validated canonical
// bytes (for the follow-up content-id hash) or a flat reject. Modeled
// as a discriminated union so a caller pattern-matches on `ok`.
// `Uint8Array<ArrayBuffer>` (not `<ArrayBufferLike>`) so the bytes
// thread directly into `crypto.subtle.digest` — `BufferSource`
// rejects SharedArrayBuffer-backed views.
//
// NOTE: `verifySaveSigAndCanonical` is a test-friendly composition
// helper. Production `handleSave` in `server/index.ts` does NOT
// call it — it composes `canonicalSave` +
// `computeRevisionIdFromCanonical` + `verifyEd25519` separately so
// the dup-precheck (`revisionExists`) can fire BEFORE the Ed25519
// verify, closing the round-9 H1 CPU-DoS vector where a passive
// observer floods captured saves. The wrapper exists for unit
// tests that don't need the precheck ordering.
export type VerifyResult =
  | { ok: true; canonical: Uint8Array<ArrayBuffer> }
  | { ok: false; canonical: null }

function fromB64Url(str: string): Uint8Array<ArrayBuffer> {
  // `Buffer.from(..., 'base64url')` returns `Buffer<ArrayBufferLike>`;
  // WebCrypto's `BufferSource` (per @types/node:
  // `NonSharedArrayBufferView | ArrayBuffer`) rejects
  // SharedArrayBuffer-backed views. Node's Buffer pool is always
  // regular ArrayBuffer at runtime, so narrowing the return type
  // is safe — the cast is the only way to thread the value through
  // `crypto.subtle.importKey` / `verify` without a redundant copy.
  return Buffer.from(str, 'base64url') as Uint8Array<ArrayBuffer>
}

// Mirrors client/sync-crypto.js's `canonicalSavePayload`. `keyframe`
// is `'1'` for a keyframe revision (`=== true` exactly), `''`
// otherwise. STRICT equality, not truthy: a non-boolean truthy
// value like `keyframe: 1` (which JSON.parse couldn't have
// produced unless the sender went out of its way) hashes as `''`
// here, matching `handleSave`'s `msg.keyframe === true` storage
// rule. Without strict matching the canonical and the storage
// disagree on which inputs are keyframes, and a malformed save
// can land in the chain unreadable to peers.
export function canonicalSave(
  { workspaceTag, base, keyframe, nonce, ciphertext }: SaveMsg,
): Uint8Array<ArrayBuffer> {
  // Strict input gates — defense-in-depth against a future caller
  // that invokes canonicalSave without going through handleSave's
  // upstream `validTagSigBase` / `validNonce` / `validCiphertextShape`
  // gates. `base` is `string | null` (previous revision's id); any
  // non-string non-null value (object, array, number, ...) would
  // otherwise coerce via `String(...)` to canonical bytes the client
  // could never reproduce, producing a verify failure with a
  // confusing diff in the canonical bytes rather than a clean drop.
  // Mirrors the `isSafeNonNegativeInt` rigor that the objstore
  // canonical builders apply. Input-validation audit
  // `server/sign.ts:88`.
  if (typeof workspaceTag !== 'string') throw new TypeError('canonicalSave: workspaceTag must be string')
  if (typeof nonce !== 'string') throw new TypeError('canonicalSave: nonce must be string')
  if (typeof ciphertext !== 'string') throw new TypeError('canonicalSave: ciphertext must be string')
  if (base != null && typeof base !== 'string') throw new TypeError('canonicalSave: base must be string or null')
  return encodeUtf8([
    SAVE_DOMAIN,
    workspaceTag,
    base ?? '',
    keyframe === true ? '1' : '',
    nonce,
    ciphertext,
  ].join('\n'))
}

function canonicalSubscribe(
  { workspaceTag, from }: SubscribeMsg,
  connectionNonce: string,
): Uint8Array<ArrayBuffer> {
  // Strict `from` typing, mirroring canonicalSave's `base` check: `from`
  // is `string | null`. A non-string non-null value would otherwise
  // coerce via `String(...)` to canonical bytes the client could never
  // reproduce (123 → "123", {} → "[object Object]"), so a signature
  // computed over that coercion would verify against a malformed wire
  // shape. verifySubscribeSig wraps this call in try/catch → clean drop.
  if (from != null && typeof from !== 'string') throw new TypeError('canonicalSubscribe: from must be string or null')
  const fromStr = from == null ? '' : from
  return encodeUtf8([SUBSCRIBE_DOMAIN, workspaceTag as string, fromStr, connectionNonce].join('\n'))
}

// Exported because the v1.objstore signing module (server/objstore/sign.ts)
// reuses it for its four verifiers — same workspaceTag-as-pubkey contract,
// same domain-separated canonical bytes. Keeping the WebCrypto plumbing
// in one place avoids drift between the triage-sync and objstore verify
// implementations.
export async function verifyEd25519(
  pubkeyB64Url: string,
  message: Uint8Array<ArrayBuffer>,
  sigB64Url: string,
): Promise<boolean> {
  const pubkeyBytes = fromB64Url(pubkeyB64Url)
  const sigBytes = fromB64Url(sigB64Url)
  if (pubkeyBytes.length !== 32) return false
  if (sigBytes.length !== 64) return false
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      pubkeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify('Ed25519', key, sigBytes, message)
  } catch {
    return false
  }
}

// Test-friendly composition: verify the save signature AND return
// the canonical bytes the signature was checked against, so a
// follow-up step (computing the content-addressed revision id)
// hashes the EXACT bytes the signature covered. Returns
// `{ ok: false, canonical: null }` on bad shape / bad sig;
// `{ ok: true, canonical: <bytes> }` on success.
//
// NOT used by `server/index.ts handleSave`. Production composes
// the smaller helpers (`canonicalSave`, `computeRevisionIdFromCanonical`,
// `verifyEd25519`) separately so the dup-precheck via
// `revisionExists` can fire BEFORE Ed25519-verify and skip the
// expensive crypto work on a replayed save (round-9 H1 CPU-DoS
// defense). The helper survives because unit tests in
// `tests/server-sign.test.js` benefit from a clean single-call
// surface; the round-9 H1 ordering is exercised end-to-end in
// `tests/sync-server.test.js`.
//
// `encodeUtf8` throws on non-string or lone-surrogate input (any of
// which on the wire is already a hostile / malformed message), so
// any error in the canonical-payload path is a verification failure.
export async function verifySaveSigAndCanonical(msg: SaveMsg): Promise<VerifyResult> {
  // Type-check `workspaceTag` here (alongside `signature`) so a
  // non-string slips reach `fromB64Url(msg.workspaceTag)` inside
  // `verifyEd25519` — `fromB64Url` is `Buffer.from(s, 'base64url')`,
  // which throws TypeError on non-string non-array-like input.
  // Without this gate, the throw escapes verifyEd25519 (it lives
  // BEFORE the try/catch around the WebCrypto calls) and the function
  // rejects with TypeError instead of honouring its `{ ok: false,
  // canonical: null }` contract — a malformed wire message would
  // bubble out as a connection-handler exception rather than a clean
  // drop. Audit round-11.
  if (typeof msg.workspaceTag !== 'string') return { ok: false, canonical: null }
  if (typeof msg.signature !== 'string') return { ok: false, canonical: null }
  let payload: Uint8Array<ArrayBuffer>
  try { payload = canonicalSave(msg) } catch { return { ok: false, canonical: null } }
  const ok = await verifyEd25519(msg.workspaceTag, payload, msg.signature)
  return ok ? { ok: true, canonical: payload } : { ok: false, canonical: null }
}

// Content-addressed revision id — SHA-256 of the canonical save
// bytes (same input the signature covers), base64url no padding.
// Server doesn't get to assign ids: it derives the id from received
// content and stores under that. Mirrors the client's
// `computeRevisionId` so two ends always land on the same string.
// Takes the canonical bytes produced by `canonicalSave` (or, in
// tests, returned by `verifySaveSigAndCanonical`) so the hash is
// over EXACTLY the bytes the signature covered.
export async function computeRevisionIdFromCanonical(canonical: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', canonical)
  return Buffer.from(new Uint8Array(digest)).toString('base64url')
}

// `connectionNonce` is the per-socket challenge the server issued
// to the originating connection (see `Peer.challenge` in
// server/peer.ts). The client signs a canonical that includes the
// nonce; verifying against the SAME nonce here is what blocks
// cross-connection replay of a captured subscribe frame. Audit
// round-9 H2.
export async function verifySubscribeSig(msg: SubscribeMsg, connectionNonce: unknown): Promise<boolean> {
  // `async` + `await` the verifyEd25519 result. Without `async` the
  // function's verify path returned a `Promise<boolean>` while its
  // type-check / canonical-throw paths returned the literal `false`
  // — a caller using it as a synchronous predicate (`if
  // (verifySubscribeSig(...))`) would treat the truthy Promise as
  // "valid" and accept arbitrary forged signatures. Production's
  // only call site already `await`s, but the inconsistency was a
  // footgun for any future caller. Audit round-11.
  // Same workspaceTag type-check as `verifySaveSigAndCanonical` —
  // see that function for the rationale (fromB64Url throws TypeError
  // on non-string and the throw escapes verifyEd25519's try/catch).
  if (typeof msg.workspaceTag !== 'string') return false
  if (typeof msg.signature !== 'string') return false
  if (typeof connectionNonce !== 'string') return false
  let payload: Uint8Array<ArrayBuffer>
  try { payload = canonicalSubscribe(msg, connectionNonce) } catch { return false }
  return await verifyEd25519(msg.workspaceTag, payload, msg.signature)
}
