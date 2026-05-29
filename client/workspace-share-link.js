// Workspace share-by-link — pure logic side. Encodes the workspace's
// identity triple (id + name + 32-byte privateKey) into a password-
// encrypted, base64url-encoded blob for the URL hash (`#share=…`);
// decodes the same back on the receiving side.
//
// Sender + recipient must derive matching Ed25519 signing keypairs
// (sync-crypto derives from `(privateKey, workspaceId)`) and sync
// against the same chain on the relay — otherwise the workspaces only
// share a name + key on paper. To keep the id alignment robust
// without bloating the URL on the common path, the wire is one of two
// shapes:
//   - `{ v:1, n, k }`     — id OMITTED. Decoder re-derives it from the
//                           key via `deriveWorkspaceIdFromPrivateKey`.
//                           Used when the sender's stored id ALREADY
//                           equals `derive(privateKey)` (workspaces
//                           created after the derivation switch).
//   - `{ v:1, i, n, k }`  — id EXPLICIT. Used when the sender's stored
//                           id does NOT match derivation (legacy
//                           workspaces predating it, or imported from
//                           an external bundle that fixed an id).
// Either way the decoder hands the caller a single `{ id, name,
// privateKeyBase64 }` triple. Triage / reports do NOT ride this
// channel; the full-bundle export/import path transfers those.
//
// The password-encryption layer lives in `password-crypto.js`; this
// module only handles the JSON payload + base64url envelope.

import { decodeUtf8, encodeUtf8 } from '../common/utf8.js'
import {
  decryptWithPasswordOrThrow,
  encryptWithPassword,
} from './password-crypto.js'
import { deriveWorkspaceIdFromPrivateKey } from './workspace-id.js'

// Build the encrypted hash payload. `name` is the already-sanitised
// workspace name; `privateKeyBase64` is the 32-byte secret in the
// default alphabet (matching `workspace.privateKey`'s on-disk shape).
// See the wire-shape note above for how `id` is/isn't carried.
export async function encodeShareLink({ id, name, privateKeyBase64, password }) {
  if (typeof id !== 'string' || !id) throw new TypeError('encodeShareLink: id required')
  if (typeof name !== 'string' || !name) throw new TypeError('encodeShareLink: name required')
  if (typeof privateKeyBase64 !== 'string' || !privateKeyBase64) {
    throw new TypeError('encodeShareLink: privateKey required')
  }
  if (typeof password !== 'string' || !password) {
    throw new TypeError('encodeShareLink: password required')
  }
  // Omit the id when it matches what the recipient would compute via
  // `deriveWorkspaceIdFromPrivateKey`; legacy workspaces with random
  // ids still ship it explicitly so sync compatibility holds.
  const derivedId = await deriveWorkspaceIdFromPrivateKey(privateKeyBase64)
  const payload = derivedId === id
    ? { v: 1, n: name, k: privateKeyBase64 }
    : { v: 1, i: id, n: name, k: privateKeyBase64 }
  const wire = await encryptWithPassword(encodeUtf8(JSON.stringify(payload)), password)
  return wire.toBase64({ alphabet: 'base64url', omitPadding: true })
}

// Reverse of `encodeShareLink`. Throws a stable message on a shape
// failure ('malformed share link') and on a key/tag mismatch ('wrong
// password or corrupt link') so the dialog shows a single friendly
// line either way.
export async function decodeShareLink({ encoded, password }) {
  if (typeof encoded !== 'string' || !encoded) {
    throw new Error('malformed share link')
  }
  if (typeof password !== 'string' || !password) {
    // Programmer error — the dialog gates the unlock button on a
    // non-empty password, so this is unreachable from the UI.
    throw new TypeError('decodeShareLink: password required')
  }
  let bytes
  try {
    bytes = Uint8Array.fromBase64(encoded, { alphabet: 'base64url' })
  } catch {
    throw new Error('malformed share link')
  }
  const plaintext = await decryptWithPasswordOrThrow(bytes, password, {
    malformedMsg: 'malformed share link',
    wrongPasswordMsg: 'wrong password or corrupt link',
  })
  // Every post-decrypt failure (bad JSON, missing fields, oversized
  // id, non-32-byte key) collapses into the same `'wrong password or
  // corrupt link'` error as a genuine auth failure — else an attacker
  // probing error messages distinguishes "decryption succeeded but
  // plaintext malformed" from "decryption failed", confirming the
  // password against a crafted ciphertext.
  try {
    return await parsePlaintextPayload(plaintext)
  } catch (err) {
    throw new Error('wrong password or corrupt link', { cause: err })
  }
}

async function parsePlaintextPayload(plaintext) {
  const parsed = JSON.parse(decodeUtf8(plaintext))
  if (
    !parsed
    || typeof parsed !== 'object'
    || typeof parsed.n !== 'string'
    || typeof parsed.k !== 'string'
    || !parsed.n
    || !parsed.k
  ) {
    throw new Error('shape')
  }
  // `i` (id) is optional. When present it overrides derivation (senders
  // whose stored id doesn't match `derive(privateKey)` — legacy
  // workspaces, imported bundles); when absent the recipient re-derives
  // from the key. A present-but-wrong-shape `i` is still a rejection.
  if (parsed.i !== undefined && (typeof parsed.i !== 'string' || !parsed.i)) {
    throw new Error('shape')
  }
  // Cap the explicit id's length so a crafted payload can't plant a
  // multi-MB string in localStorage. `crypto.randomUUID()` is 36
  // chars; a generous 256-char cap covers any future id format without
  // bloating the workspaces blob.
  if (typeof parsed.i === 'string' && parsed.i.length > 256) {
    throw new Error('shape')
  }
  // Same bloat guard for the workspace name `n`, which is persisted
  // verbatim into the localStorage workspaces blob: without a cap, a
  // crafted link could plant a multi-MB name and saturate the origin's
  // storage quota. Names are short labels; 1024 chars is generous.
  if (parsed.n.length > 1024) {
    throw new Error('shape')
  }
  // The privateKey rides through to `sync-crypto`'s 32-byte assertion.
  // Reject up front so a crafted payload (wrong length, non-base64)
  // surfaces as a clean error instead of an unhandled rejection later,
  // and a sender substituting a non-32-byte key can't silently break
  // triage-sync on the recipient.
  const keyBytes = Uint8Array.fromBase64(parsed.k)
  if (keyBytes.length !== 32) {
    throw new Error('shape')
  }
  const id = typeof parsed.i === 'string'
    ? parsed.i
    : await deriveWorkspaceIdFromPrivateKey(parsed.k)
  return { id, name: parsed.n, privateKeyBase64: parsed.k }
}

// Build the share URL for the current page origin + pathname. Hash
// format `#share=<base64url>`. Decoupled from `encodeShareLink` so the
// dialog can show a single URL to copy, not just the encoded blob.
//
// `location.search` is intentionally NOT preserved: the target page
// takes no query params, and dragging the sender's current `?foo=bar`
// (analytics tokens or other PII unrelated to the share) into the
// recipient's URL would be a surprising leak. The receiver-side
// `replaceState` strips search on attach; mirror that here so the
// copied link is also clean.
export function buildShareUrl(encoded) {
  if (typeof location === 'undefined') return `#share=${encoded}`
  return `${location.origin}${location.pathname}#share=${encoded}`
}

// Extract the `share=<base64url>` argument from a hash string (or
// `location.hash` when called with no argument). Returns the encoded
// payload or null when no share parameter is present.
//
// HASH ONLY — `location.search` is deliberately NOT supported. The
// encrypted blob is useless without the password, but a sender who
// pastes a URL into a chat client that rewrites `#share=…` to
// `?share=…` would then have the payload ride in the `Referer` header
// to every subresource (subject to the recipient's Referrer-Policy).
// Rejecting query-string carriage stops a future caller inviting that
// leak — `buildShareUrl` only emits the `#` form and the boot handler
// reads `location.hash` only.
export function extractShareEncoded(hash) {
  const raw = typeof hash === 'string' ? hash : (typeof location === 'undefined' ? '' : location.hash)
  if (!raw) return null
  // Strip a leading '#' so we match both `#share=…` and a fragment
  // with multiple `&`-joined params (e.g. `#share=…&x=y`).
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
