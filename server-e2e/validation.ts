// Wire-field shape gates for `workspace-save`: base64-or-base64url
// alphabet, length-bounded. The critical guarantee is "no newlines" —
// without it, `nonce = "AAA\nBBB"` + `ciphertext = "CCC"` produces the
// same canonical bytes as `nonce = "AAA"` + `ciphertext = "BBB\nCCC"`
// (canonicalSave newline-joins), causing same-id collisions across
// distinct stored fields. Two alphabets:
//
//   - workspaceTag / signature / base — base64url-no-padding only.
//     Clients always emit these via `toBase64({ alphabet: 'base64url',
//     omitPadding: true })` (client/sync-crypto.ts), and the same
//     workspaceTag must round-trip through objstore's TAG_RE (also
//     base64url-no-padding) for cross-protocol consistency. Accepting
//     `+/=` here would let a buggy or hostile client split its data
//     across two encodings of the same workspace.
//   - nonce / ciphertext — base64 OR base64url (union alphabet).
//     Clients emit these via `toBase64()` with no alphabet hint
//     (standard base64 with `+/=` padding), and the bytes are opaque
//     to the server — no cross-protocol identity is bound to the
//     encoding. The newline-collision guard is the only invariant
//     here; the wider alphabet is acceptable.
//
// Short-field length caps bound the canonical and `MAX_CIPHERTEXT_LEN`
// bounds chain-bloat; the ciphertext size check runs post-sig (in
// handleSave) so the error response only reaches a legit signer.
const TAG_SIG_BASE_RE = /^[\w-]+$/u
const NONCE_CIPHER_RE = /^[\w+/=-]+$/u
export const MAX_FIELD_LEN = 128
export const MAX_CIPHERTEXT_LEN = 2 * 1024 * 1024

export const validTagSigBase = (s: unknown, max: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= max && TAG_SIG_BASE_RE.test(s)
export const validNonce = (s: unknown, max: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= max && NONCE_CIPHER_RE.test(s)
// Ciphertext: same alphabet as nonce but the size cap is checked
// POST-sig (to avoid leaking the cap to unauthenticated probes).
// Pre-sig only the shape gate applies; `maxPayload` (4 MiB) already
// bounds the total frame, so the worst-case bytes are still bounded.
export const validCiphertextShape = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && NONCE_CIPHER_RE.test(s)
