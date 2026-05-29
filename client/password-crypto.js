// Password-based encryption shared by `workspace-share-link.js` and
// `workspace-bundle-crypto.js`. PBKDF2-SHA-256 (3M iterations) → AES-GCM.
// Wire: `[version | salt | nonce | ciphertext+tag]`. AES-GCM (not the
// ChaCha20-Poly1305 triage-sync uses) so WebCrypto covers it directly,
// no `@noble/ciphers` fallback.
//
// `version | salt | nonce` rides in the AES-GCM AAD so any tampering
// of those fields surfaces as an auth-tag mismatch (`wrong-password`)
// instead of a successful decrypt under attacker-chosen parameters —
// matters once a v2 wire format coexists with v1.
//
// Every shape failure (truncated wire, wrong version byte,
// non-Uint8Array) collapses into the same `'malformed'` reason —
// message-level oracle defense only; the timing difference between
// shape-rejects (microseconds) and auth-fail (PBKDF2, hundreds of ms)
// is still observable.

import { encodeUtf8 } from '../common/utf8.js'
import { PBKDF2_ITERATIONS } from './password-crypto-params.js'

export const WIRE_VERSION = 1
const SALT_LEN = 16
const NONCE_LEN = 12
// version + salt + nonce + 16-byte GCM tag.
export const MIN_WIRE_LEN = 1 + SALT_LEN + NONCE_LEN + 16
// Length of the AAD prefix (version byte + salt + nonce) that rides
// outside the ciphertext; see header for the tamper-detection rationale.
const AAD_LEN = 1 + SALT_LEN + NONCE_LEN

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

// Magic-byte sniff so the workspace-import path can dispatch encrypted
// vs plaintext-gzip drops without depending on the filename.
export function isEncryptedWire(bytes) {
  if (!(bytes instanceof Uint8Array)) return false
  if (bytes.length < MIN_WIRE_LEN) return false
  return bytes[0] === WIRE_VERSION
}

export async function encryptWithPassword(plaintext, password) {
  if (!(plaintext instanceof Uint8Array)) {
    throw new TypeError('encryptWithPassword: plaintext Uint8Array required')
  }
  if (typeof password !== 'string' || !password) {
    throw new TypeError('encryptWithPassword: password required')
  }
  const out = new Uint8Array(AAD_LEN + plaintext.length + 16)
  out[0] = WIRE_VERSION
  crypto.getRandomValues(out.subarray(1, 1 + SALT_LEN))
  crypto.getRandomValues(out.subarray(1 + SALT_LEN, AAD_LEN))
  const salt = out.subarray(1, 1 + SALT_LEN)
  const nonce = out.subarray(1 + SALT_LEN, AAD_LEN)
  const aesKey = await deriveAesKey(password, salt)
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: out.subarray(0, AAD_LEN) },
    aesKey,
    plaintext,
  ))
  out.set(ct, AAD_LEN)
  return out
}

// Returns `{ ok: true, plaintext }` or `{ ok: false, reason: 'malformed'
// | 'wrong-password' }`. Result envelope (instead of throw) on cipher /
// shape failure so callers can map the generic reason to their own
// user-facing copy. Bad-argument cases (missing / non-string password)
// still throw — those are programmer errors, not attacker-controlled.
export async function tryDecryptWithPassword(wire, password) {
  if (typeof password !== 'string' || !password) {
    throw new TypeError('tryDecryptWithPassword: password required')
  }
  if (!(wire instanceof Uint8Array) || wire.length < MIN_WIRE_LEN) {
    return { ok: false, reason: 'malformed' }
  }
  if (wire[0] !== WIRE_VERSION) {
    return { ok: false, reason: 'malformed' }
  }
  const salt = wire.subarray(1, 1 + SALT_LEN)
  const nonce = wire.subarray(1 + SALT_LEN, AAD_LEN)
  const ct = wire.subarray(AAD_LEN)
  const aesKey = await deriveAesKey(password, salt)
  let plaintext
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: wire.subarray(0, AAD_LEN) },
      aesKey,
      ct,
    ))
  } catch {
    return { ok: false, reason: 'wrong-password' }
  }
  return { ok: true, plaintext }
}

// Convenience wrapper that maps `tryDecryptWithPassword`'s result
// envelope to thrown errors with caller-supplied user-facing copy.
// Lets both share-link and bundle decoders share one mapper instead
// of hand-maintaining twin "malformed X / wrong password or corrupt X"
// strings.
export async function decryptWithPasswordOrThrow(wire, password, opts) {
  if (!opts || typeof opts.malformedMsg !== 'string' || typeof opts.wrongPasswordMsg !== 'string') {
    throw new TypeError('decryptWithPasswordOrThrow: { malformedMsg, wrongPasswordMsg } strings required')
  }
  const result = await tryDecryptWithPassword(wire, password)
  if (result.ok) return result.plaintext
  if (result.reason === 'wrong-password') throw new Error(opts.wrongPasswordMsg)
  throw new Error(opts.malformedMsg)
}
