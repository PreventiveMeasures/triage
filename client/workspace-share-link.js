// Workspace share-by-link — pure logic side. Encodes the workspace's
// identity triple (id + name + 32-byte privateKey) into a
// password-encrypted, base64url-encoded blob suitable for the URL
// hash (`#share=…`); decodes the same back on the receiving side.
//
// Sender + recipient must derive matching Ed25519 signing keypairs
// (sync-crypto derives from `(privateKey, workspaceId)`) and end up
// syncing against the same chain on the relay — otherwise the
// workspaces would only share a name + key on paper. To keep the
// id alignment robust without bloating the URL on the common path,
// the wire is one of two shapes:
//   - `{ v:1, n, k }`        — id is OMITTED. Decoder re-derives
//                              the id from the key via
//                              `deriveWorkspaceIdFromPrivateKey`.
//                              Used when the sender's stored id
//                              ALREADY equals `derive(privateKey)`,
//                              i.e. workspaces created after the
//                              derivation switch in workspaces.js.
//   - `{ v:1, i, n, k }`     — id is EXPLICIT. Used when the
//                              sender's stored id does NOT match
//                              the derivation (legacy workspaces
//                              that pre-date the derivation, or
//                              workspaces imported from an
//                              external bundle that fixed an id).
// Either way the decoder hands the caller a single `{ id, name,
// privateKeyBase64 }` triple. Triage / reports do NOT ride this
// channel; the full-bundle export/import path is still the way to
// transfer those.
//
// Wire format (binary, then base64url):
//   1 byte    version (= 0x01)
//   16 bytes  PBKDF2 salt
//   12 bytes  AES-GCM nonce
//   N bytes   AES-GCM ciphertext + 16-byte auth tag
//
// PBKDF2-SHA-256 with 3M iterations derives a 256-bit AES-GCM
// key. AES-GCM is picked over ChaCha20-Poly1305 (which the rest
// of the codebase uses for triage-sync) purely because WebCrypto
// covers AES-GCM unconditionally — no `detectWebCryptoChaCha` /
// `@noble/ciphers` fallback to plumb through this path.

import { decodeUtf8, encodeUtf8 } from '../common/utf8.js'
import { deriveWorkspaceIdFromPrivateKey } from './workspace-id.js'

const VERSION = 1
const SALT_LEN = 16
const NONCE_LEN = 12
const PBKDF2_ITERATIONS = 3000000

async function deriveAesKey(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encodeUtf8(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// Build the encrypted hash payload. `id` is the workspace's
// UUID-shaped identifier — for workspaces created via
// `createWorkspace` it's `deriveWorkspaceIdFromPrivateKey(key)`
// output (and the wire optimisation below drops `i` from the
// plaintext on that match); for legacy workspaces predating the
// derivation switch it's the original `crypto.randomUUID()`
// value and the wire ships `i` explicitly. `name` is the
// (already sanitised) workspace name to ship; `privateKeyBase64`
// is the 32-byte secret encoded with the default alphabet
// (matching `workspace.privateKey`'s on-disk shape).
export async function encodeShareLink({ id, name, privateKeyBase64, password }) {
  if (typeof id !== 'string' || !id) throw new Error('share: id required')
  if (typeof name !== 'string' || !name) throw new Error('share: name required')
  if (typeof privateKeyBase64 !== 'string' || !privateKeyBase64) {
    throw new Error('share: privateKey required')
  }
  if (typeof password !== 'string' || !password) {
    throw new Error('share: password required')
  }
  const salt = new Uint8Array(SALT_LEN)
  const nonce = new Uint8Array(NONCE_LEN)
  crypto.getRandomValues(salt)
  crypto.getRandomValues(nonce)
  const aesKey = await deriveAesKey(password, salt)
  // Omit the id from the wire when it matches what the recipient
  // would compute via `deriveWorkspaceIdFromPrivateKey`. New
  // workspaces (created via createWorkspace after the derivation
  // switch) always take this path; legacy workspaces with random
  // ids still ship the id explicitly so sync compatibility holds.
  const derivedId = await deriveWorkspaceIdFromPrivateKey(privateKeyBase64)
  const payload = derivedId === id
    ? { v: 1, n: name, k: privateKeyBase64 }
    : { v: 1, i: id, n: name, k: privateKeyBase64 }
  const plaintext = encodeUtf8(JSON.stringify(payload))
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    aesKey,
    plaintext,
  ))
  const out = new Uint8Array(1 + SALT_LEN + NONCE_LEN + ct.length)
  out[0] = VERSION
  out.set(salt, 1)
  out.set(nonce, 1 + SALT_LEN)
  out.set(ct, 1 + SALT_LEN + NONCE_LEN)
  return out.toBase64({ alphabet: 'base64url', omitPadding: true })
}

// Reverse of `encodeShareLink`. Throws with a stable message on a
// shape failure ('malformed share link') and on a key/tag mismatch
// ('wrong password or corrupt link') so the dialog layer can show
// the user a single friendly line either way.
export async function decodeShareLink({ encoded, password }) {
  if (typeof encoded !== 'string' || !encoded) {
    throw new Error('malformed share link')
  }
  if (typeof password !== 'string' || !password) {
    throw new Error('share: password required')
  }
  let bytes
  try {
    bytes = Uint8Array.fromBase64(encoded, { alphabet: 'base64url' })
  } catch {
    throw new Error('malformed share link')
  }
  if (bytes.length < 1 + SALT_LEN + NONCE_LEN + 16) {
    throw new Error('malformed share link')
  }
  // Collapse the version mismatch into the same generic message as
  // every other shape failure so an attacker probing a victim with
  // tampered payloads can't distinguish "version byte flipped" from
  // "wrong password" by error text. Future versions will need a
  // dispatch step BEFORE the password is consumed; for v1, the
  // single supported version makes the check effectively a sanity
  // gate on the leading byte.
  if (bytes[0] !== VERSION) {
    throw new Error('malformed share link')
  }
  const salt = bytes.subarray(1, 1 + SALT_LEN)
  const nonce = bytes.subarray(1 + SALT_LEN, 1 + SALT_LEN + NONCE_LEN)
  const ct = bytes.subarray(1 + SALT_LEN + NONCE_LEN)
  const aesKey = await deriveAesKey(password, salt)
  let plaintext
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      ct,
    ))
  } catch {
    throw new Error('wrong password or corrupt link')
  }
  let parsed
  try {
    parsed = JSON.parse(decodeUtf8(plaintext))
  } catch {
    throw new Error('malformed share link')
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || typeof parsed.n !== 'string'
    || typeof parsed.k !== 'string'
    || !parsed.n
    || !parsed.k
  ) {
    throw new Error('malformed share link')
  }
  // `i` (id) is optional on the wire. When present it overrides
  // derivation — used by senders whose stored id doesn't match
  // `derive(privateKey)` (legacy workspaces, imported bundles).
  // When absent the recipient re-derives the same value from the
  // key. Either way the caller gets a single `{ id, name, k }`
  // triple. A present-but-wrong-shape `i` is still a rejection.
  if (parsed.i !== undefined && (typeof parsed.i !== 'string' || !parsed.i)) {
    throw new Error('malformed share link')
  }
  // Cap the explicit id's length so a crafted payload can't plant
  // a multi-MB string in localStorage. `crypto.randomUUID()` output
  // is 36 chars; a generous 256-char cap covers any conceivable
  // future id format without bloating the workspaces blob.
  if (typeof parsed.i === 'string' && parsed.i.length > 256) {
    throw new Error('malformed share link')
  }
  // The privateKey rides through to `sync-crypto`'s 32-byte
  // assertion. Reject up front so a crafted payload (wrong length,
  // non-base64) surfaces as a clean "malformed share link" instead
  // of an unhandled rejection later, and so a sender substituting
  // a non-32-byte key can't silently break triage-sync on the
  // recipient.
  let keyBytes
  try {
    keyBytes = Uint8Array.fromBase64(parsed.k)
  } catch {
    throw new Error('malformed share link')
  }
  if (keyBytes.length !== 32) {
    throw new Error('malformed share link')
  }
  const id = typeof parsed.i === 'string'
    ? parsed.i
    : await deriveWorkspaceIdFromPrivateKey(parsed.k)
  return { id, name: parsed.n, privateKeyBase64: parsed.k }
}

// Build the share URL for the current page origin + pathname.
// Hash payload format: `#share=<base64url>`. Decoupled from
// `encodeShareLink` so the dialog can show the user a single
// URL to copy (rather than just the encoded blob).
//
// `location.search` is intentionally NOT preserved: the share-
// link target page doesn't take query params, and dragging the
// sender's current `?foo=bar` (which may carry analytics tokens
// or other PII unrelated to the share) into the recipient's URL
// would be a surprising leak. The receiver-side `replaceState`
// already strips search on attach; mirror that on the sender
// side so the copied link is also clean.
export function buildShareUrl(encoded) {
  if (typeof location === 'undefined') return `#share=${encoded}`
  return `${location.origin}${location.pathname}#share=${encoded}`
}

// Extract the `share=<base64url>` argument from a hash string (or
// from `location.hash` when called with no argument). Returns the
// encoded payload string or null when no share parameter is
// present.
//
// HASH ONLY — `location.search` is deliberately NOT a supported
// source. The encrypted blob alone is useless without the password,
// but a sender who pastes a URL into a chat client that rewrites
// `#share=…` to `?share=…` would then have the encrypted payload
// ride in the `Referer` header to every subresource on the page
// (subject to the recipient's Referrer-Policy). We don't accept
// query-string carriage so a future caller can't accidentally
// invite that leak — `buildShareUrl` only ever emits the `#`
// form, and the boot handler reads `location.hash` only.
export function extractShareEncoded(hash) {
  const raw = typeof hash === 'string' ? hash : (typeof location === 'undefined' ? '' : location.hash)
  if (!raw) return null
  // Strip a leading '#' so we can match both `#share=…` and a
  // fragment with multiple `&`-joined params (e.g. `#share=…&x=y`).
  const stripped = raw.replace(/^#/u, '')
  if (!stripped) return null
  for (const part of stripped.split('&')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq) !== 'share') continue
    const val = part.slice(eq + 1)
    return val || null
  }
  return null
}
