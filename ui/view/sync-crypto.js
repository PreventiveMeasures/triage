import { chacha20poly1305 } from '@noble/ciphers/chacha.js'

// AEAD layer for triage-sync. Wraps ChaCha20-Poly1305 (RFC 8439) so
// changesets travel encrypted through the relay server. The server
// only ever sees `{ base, nonce, ciphertext }` — the actual triage
// values are sealed under the workspace's private key.
//
// Implementation prefers WebCrypto's native ChaCha20-Poly1305 (Chrome
// 137+, Firefox 144+) and falls back to `@noble/ciphers` everywhere
// else. Detection is one-shot at module load and cached.
//
// Each per-workspace content key is derived from the workspace's
// 32-byte private key via HKDF-SHA-256 with the domain-separating
// info string below — the private key itself never reaches the
// cipher, so future protocols can derive other keys (signing,
// MAC, future versions) from the same secret without collision.

const KEY_INFO = 'deepview-triage-sync.v1.content-key'
const TAG_INFO = 'deepview-triage-sync.v1.workspace-tag'
const NONCE_LEN = 12

let webCryptoChaChaCheck = null
function detectWebCryptoChaCha() {
  // Cache the probe — one importKey is cheap but every send /
  // receive shouldn't pay for it. Returns a Promise either way.
  if (webCryptoChaChaCheck) return webCryptoChaChaCheck
  webCryptoChaChaCheck = (async () => {
    try {
      await crypto.subtle.importKey(
        'raw',
        new Uint8Array(32),
        { name: 'ChaCha20-Poly1305' },
        false,
        ['encrypt', 'decrypt'],
      )
      return true
    } catch {
      return false
    }
  })()
  return webCryptoChaChaCheck
}

// Derive a 32-byte content-encryption key from the workspace's
// private key (32 random bytes, base64-encoded in the workspace
// record). HKDF-SHA-256 with empty salt + the domain-separating
// info string — same private key + same info = same key, so two
// clients on the same workspace agree without a key-exchange
// step.
export async function deriveSessionKey(privateKeyBase64) {
  const secret = Uint8Array.fromBase64(privateKeyBase64)
  if (secret.length !== 32) {
    throw new Error(`workspace private key must be 32 bytes (got ${secret.length})`)
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    secret,
    'HKDF',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: new TextEncoder().encode(KEY_INFO),
    },
    baseKey,
    256,
  )
  return new Uint8Array(bits)
}

// Derive an opaque server-facing identifier for the workspace.
// Hides the workspaceId UUID from the relay server: clients with
// the same private key + workspaceId converge on the same tag, but
// the server can't reverse-engineer the underlying UUID from the
// tag (without the private key it can't distinguish a tag from
// random bytes). Domain-separated from the content key — the same
// IKM passes through HKDF with a different `info`, so leaking the
// tag tells you nothing about the encryption key and vice versa.
// 128 bits is plenty for collision-resistance across a sane number
// of workspaces; output is base64url so the tag is safe to use as
// a URL path / WebSocket header value if the server protocol grows
// to want that.
export async function deriveWorkspaceTag(privateKeyBase64, workspaceId) {
  const secret = Uint8Array.fromBase64(privateKeyBase64)
  if (secret.length !== 32) {
    throw new Error(`workspace private key must be 32 bytes (got ${secret.length})`)
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    secret,
    'HKDF',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: new TextEncoder().encode(`${TAG_INFO}|${workspaceId}`),
    },
    baseKey,
    128,
  )
  return new Uint8Array(bits).toBase64({ alphabet: 'base64url', omitPadding: true })
}

function randomNonce() {
  const nonce = new Uint8Array(NONCE_LEN)
  crypto.getRandomValues(nonce)
  return nonce
}

// Bind ciphertext to its workspace + base-revision context so a
// malicious server can't replay a changeset under a different
// workspace or graft it onto a different revision history. The
// workspace half is the derived tag (not the UUID) — that's what
// travels on the wire, and the receiver reconstructs the AAD
// straight from the message header without needing to look the
// local workspace up. Format: ASCII bytes of `<tag>|<base>` (base
// = '' when the session has no base yet, e.g. the very first save).
export function buildAad(workspaceTag, base) {
  const baseStr = base == null ? '' : String(base)
  return new TextEncoder().encode(`${workspaceTag}|${baseStr}`)
}

export async function encryptBytes(keyBytes, plaintext, aad) {
  const nonce = randomNonce()
  if (await detectWebCryptoChaCha()) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'ChaCha20-Poly1305' },
      false,
      ['encrypt'],
    )
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'ChaCha20-Poly1305', iv: nonce, additionalData: aad },
      cryptoKey,
      plaintext,
    ))
    return { nonce, ciphertext: ct }
  }
  const cipher = chacha20poly1305(keyBytes, nonce, aad)
  return { nonce, ciphertext: cipher.encrypt(plaintext) }
}

export async function decryptBytes(keyBytes, nonce, ciphertext, aad) {
  if (await detectWebCryptoChaCha()) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'ChaCha20-Poly1305' },
      false,
      ['decrypt'],
    )
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'ChaCha20-Poly1305', iv: nonce, additionalData: aad },
      cryptoKey,
      ciphertext,
    ))
  }
  const cipher = chacha20poly1305(keyBytes, nonce, aad)
  return cipher.decrypt(ciphertext)
}

// JSON-friendly conveniences — encrypt a JSON-able value to
// `{ nonce, ciphertext }` (both base64) and decrypt back. Tag is
// appended to the ciphertext by the AEAD; we ship it as one blob.
export async function encryptJson(keyBytes, value, aad) {
  const plaintext = new TextEncoder().encode(JSON.stringify(value))
  const { nonce, ciphertext } = await encryptBytes(keyBytes, plaintext, aad)
  return { nonce: nonce.toBase64(), ciphertext: ciphertext.toBase64() }
}

export async function decryptJson(keyBytes, nonceB64, ciphertextB64, aad) {
  const nonce = Uint8Array.fromBase64(nonceB64)
  const ciphertext = Uint8Array.fromBase64(ciphertextB64)
  const plaintext = await decryptBytes(keyBytes, nonce, ciphertext, aad)
  return JSON.parse(new TextDecoder().decode(plaintext))
}
