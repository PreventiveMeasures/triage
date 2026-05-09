import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { encodeUtf8 } from '../common/utf8.js'

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
const SIGN_INFO = 'deepview-triage-sync.v1.sign-key'
const SIGN_DOMAIN = 'deepview-triage-sync.v1.save'
const SUBSCRIBE_DOMAIN = 'deepview-triage-sync.v1.subscribe'
const NONCE_LEN = 12

// PKCS8 prefix for an Ed25519 private key seed (RFC 8410). The
// 32-byte seed concatenated to the end produces a valid PKCS8 blob
// that crypto.subtle.importKey('pkcs8', …, { name: 'Ed25519' }, …)
// accepts. Letting WebCrypto own the keypair means the seed never
// needs to leave the implementation as raw bytes after derivation.
const ED25519_PKCS8_HEADER = new Uint8Array([
  0x30, 0x2e,
  0x02, 0x01, 0x00,
  0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22,
  0x04, 0x20,
])

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
      info: encodeUtf8(KEY_INFO),
    },
    baseKey,
    256,
  )
  return new Uint8Array(bits)
}

// Derive an Ed25519 signing keypair deterministically from the
// workspace's private key + UUID. Two clients on the same
// workspace get the same keypair, so each can sign messages the
// others (and the server) will accept as authoritative. The seed
// passes through HKDF-SHA-256 with a different `info` from the
// content key, so leaking the signing seed reveals nothing about
// the encryption key (and vice versa).
//
// The returned `privateKey` is a non-extractable WebCrypto
// CryptoKey scoped to ['sign'] only. The 32-byte public key
// material is also returned (raw + base64url) — the wire layer
// uses it as the workspace's server-facing identifier (the
// "workspaceTag" field is the public key).
export async function deriveSigningKeypair(privateKeyBase64, workspaceId) {
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
  const seedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: encodeUtf8(`${SIGN_INFO}|${workspaceId}`),
    },
    baseKey,
    256,
  )
  const seed = new Uint8Array(seedBits)
  // PKCS8 wrap so WebCrypto accepts the raw seed. Importable as
  // extractable so we can pull the public key out via JWK; the
  // signing key never gets re-exported as raw bytes from JS code
  // — the JWK path only happens once at derivation time.
  const pkcs8 = new Uint8Array(ED25519_PKCS8_HEADER.length + 32)
  pkcs8.set(ED25519_PKCS8_HEADER, 0)
  pkcs8.set(seed, ED25519_PKCS8_HEADER.length)
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'Ed25519' },
    true,
    ['sign'],
  )
  // JWK export gives us the raw 32-byte public key in `x`
  // (base64url). Easier than re-implementing the curve maths to
  // recover the pubkey from the seed.
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const publicKey = Uint8Array.fromBase64(jwk.x, { alphabet: 'base64url' })
  const publicKeyB64 = publicKey.toBase64({ alphabet: 'base64url', omitPadding: true })
  return { privateKey, publicKey, publicKeyB64 }
}

// Bytes the signature covers — kept identical between sender and
// every receiver. Domain prefix + newline-joined fields. Newlines
// can't appear in base64url or in the bare integer/empty
// `base` field, so this is unambiguous without explicit
// length-prefix framing.
//
// The `keyframe` field is `'1'` for a keyframe revision, `''`
// otherwise. Including it in the SIGNED bytes means a malicious
// server can't relabel a normal save as a keyframe (or vice
// versa): the wire-level flag the server uses for routing /
// storage MUST match the signed flag, or the signature fails.
function canonicalSavePayload({ publicKeyB64, base, keyframe, nonceB64, ciphertextB64 }) {
  return encodeUtf8([
    SIGN_DOMAIN,
    publicKeyB64,
    base == null ? '' : String(base),
    keyframe ? '1' : '',
    nonceB64,
    ciphertextB64,
  ].join('\n'))
}

export async function signSavePayload(privateKey, payload) {
  const message = canonicalSavePayload(payload)
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message)
  return new Uint8Array(sig).toBase64({ alphabet: 'base64url', omitPadding: true })
}

// Content-addressed revision id — SHA-256 of the same canonical
// bytes the signature covers, base64url-encoded with no padding.
// Both ends derive the same id from the same content; the server
// can validate but can't assign or alter, so it can't re-attribute
// a revision under a different id without mismatching the hash
// (or breaking the upstream signature). Used as the wire `id` for
// `workspace-save-ack` and chain entries.
export async function computeRevisionId(payload) {
  const message = canonicalSavePayload(payload)
  const digest = await crypto.subtle.digest('SHA-256', message)
  return new Uint8Array(digest).toBase64({ alphabet: 'base64url', omitPadding: true })
}

// Same idea as the save signature, but the canonical bytes are
// `<subscribe-domain>\n<pubkey>\n<from>` — `from` is the last
// revision the client knows it has applied (so the server can skip
// straight to revisions newer than that). Different domain prefix
// from save so a save signature can't be replayed as a subscribe
// and vice versa.
function canonicalSubscribePayload(publicKeyB64, fromBase) {
  const fromStr = fromBase == null ? '' : String(fromBase)
  return encodeUtf8([SUBSCRIBE_DOMAIN, publicKeyB64, fromStr].join('\n'))
}

export async function signSubscribePayload(privateKey, publicKeyB64, fromBase) {
  const message = canonicalSubscribePayload(publicKeyB64, fromBase)
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message)
  return new Uint8Array(sig).toBase64({ alphabet: 'base64url', omitPadding: true })
}

export async function verifySavePayload(publicKey, payload, signatureB64) {
  let key
  try {
    key = await crypto.subtle.importKey(
      'raw',
      publicKey,
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
  } catch {
    return false
  }
  const sig = Uint8Array.fromBase64(signatureB64, { alphabet: 'base64url' })
  const message = canonicalSavePayload(payload)
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, message)
  } catch {
    return false
  }
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
  return encodeUtf8(`${workspaceTag}|${baseStr}`)
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

// Compress + pad before encrypting so the wire ciphertext size
// reveals only the bucket the changeset falls into, not its real
// length. Plaintext layout is:
//   <4-byte BE compressed-length><gzip bytes><zero pad>
// — the length prefix lets the decoder strip the trailing zero-pad
// before gunzip (gzip's footer is fine, but a deflate stream
// followed by trailing zeros isn't portably tolerated by every
// decompressor). Ciphertext length = padded plaintext length + 16
// (Poly1305 tag), so a single-color toggle and a 600-byte comment
// edit collapse to the same wire size as long as both fit the same
// power-of-two bucket. Floor at 64 bytes so the smallest bucket
// doesn't itself reveal "this is an empty / tiny update".
const PAD_FLOOR = 64

function nextPow2AtLeast(n, floor) {
  if (n <= floor) return floor
  return 1 << (32 - Math.clz32(n - 1))
}

async function gzip(bytes) {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  writer.write(bytes)
  writer.close()
  return new Uint8Array(await new Response(cs.readable).arrayBuffer())
}

async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip')
  const writer = ds.writable.getWriter()
  writer.write(bytes)
  writer.close()
  return new Uint8Array(await new Response(ds.readable).arrayBuffer())
}

async function frameAndPad(value) {
  const json = encodeUtf8(JSON.stringify(value))
  const compressed = await gzip(json)
  if (compressed.length > 0xFFFFFFFF) throw new Error('payload too large')
  const target = nextPow2AtLeast(4 + compressed.length, PAD_FLOOR)
  const out = new Uint8Array(target)
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, compressed.length, false)
  out.set(compressed, 4)
  return out
}

async function unframeAndUngzip(plaintext) {
  if (plaintext.length < 4) throw new Error('plaintext too short')
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength)
  const len = view.getUint32(0, false)
  if (len + 4 > plaintext.length) throw new Error('length prefix exceeds buffer')
  const compressed = plaintext.subarray(4, 4 + len)
  const json = await gunzip(compressed)
  return JSON.parse(new TextDecoder().decode(json))
}

// JSON-friendly conveniences — gzip + pad + encrypt a JSON-able
// value to `{ nonce, ciphertext }` (both base64) and reverse on the
// way back. Tag is appended to the ciphertext by the AEAD; we ship
// it as one blob.
export async function encryptJson(keyBytes, value, aad) {
  const plaintext = await frameAndPad(value)
  const { nonce, ciphertext } = await encryptBytes(keyBytes, plaintext, aad)
  return { nonce: nonce.toBase64(), ciphertext: ciphertext.toBase64() }
}

export async function decryptJson(keyBytes, nonceB64, ciphertextB64, aad) {
  const nonce = Uint8Array.fromBase64(nonceB64)
  const ciphertext = Uint8Array.fromBase64(ciphertextB64)
  const plaintext = await decryptBytes(keyBytes, nonce, ciphertext, aad)
  return unframeAndUngzip(plaintext)
}
