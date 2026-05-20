import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { decodeUtf8, encodeUtf8 } from '../../common/utf8.js'

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

// Canonical save payload — fields the signature covers and the
// content-addressed revision id hashes. `base` is the parent
// revision id (string) once the chain has rolled past genesis,
// nullable on the very first save. `keyframe === true` exactly is
// what the canonical bytes serialize as `'1'`; anything else
// becomes `''` (matches server/sign.ts's `canonicalSave`).
export type SavePayload = {
  publicKeyB64: string
  base: string | number | null | undefined
  keyframe: boolean
  nonceB64: string
  ciphertextB64: string
}

export type SigningKeypair = {
  privateKey: CryptoKey
  publicKey: Uint8Array<ArrayBuffer>
  publicKeyB64: string
}

export type EncryptedJson = {
  nonce: string
  ciphertext: string
}

let webCryptoChaChaCheck: Promise<boolean> | null = null
function detectWebCryptoChaCha(): Promise<boolean> {
  // Cache the probe — one importKey is cheap but every send /
  // receive shouldn't pay for it. Returns a Promise either way.
  if (webCryptoChaChaCheck) return webCryptoChaChaCheck
  webCryptoChaChaCheck = (async (): Promise<boolean> => {
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
export async function deriveSessionKey(privateKeyBase64: string): Promise<Uint8Array<ArrayBuffer>> {
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
      // Empty salt is RFC 5869-acceptable here: IKM is 32 bytes
      // from a CSPRNG (uniformly random), so HKDF-Extract is a
      // no-op-with-relabeling and a salt would add no entropy.
      // Domain separation lives in `info` — every HKDF call site
      // in this codebase uses a distinct info string. Pinned by
      // `tests/sync-crypto-info-uniqueness.test.js`. See
      // https://soatok.blog/2021/11/17/understanding-hkdf/ §3.
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
export async function deriveSigningKeypair(privateKeyBase64: string, workspaceId: string): Promise<SigningKeypair> {
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
      // Empty salt rationale: see deriveSessionKey above. The info
      // string carries the workspaceId suffix so two distinct
      // workspaces sharing the same private key (impossible under
      // CSPRNG generation, but defense-in-depth) would still derive
      // different signing keys. The `|${workspaceId}` portion is
      // load-bearing — dropping it would collide signing keys with
      // any other workspace and is pinned by the info-uniqueness
      // regression test.
      salt: new Uint8Array(),
      info: encodeUtf8(`${SIGN_INFO}|${workspaceId}`),
    },
    baseKey,
    256,
  )
  const seed = new Uint8Array(seedBits)
  // PKCS8-wrap the raw seed so WebCrypto will import it; the same
  // envelope feeds both the public-key probe and the signing key.
  const pkcs8 = new Uint8Array(ED25519_PKCS8_HEADER.length + 32)
  pkcs8.set(ED25519_PKCS8_HEADER, 0)
  pkcs8.set(seed, ED25519_PKCS8_HEADER.length)
  // Recover the 32-byte public key through WebCrypto rather than
  // @noble/curves. WebCrypto exposes no seed→public-key derivation,
  // so import the seed as an EXTRACTABLE key and read the JWK `x`
  // member — already base64url, unpadded: exactly the wire form.
  // The JWK also exposes `d` (the seed) as an immutable string we
  // can't zero, so drop the reference the moment `x` is read, before
  // the next await, so it's collectable. The key we RETURN is the
  // separate non-extractable import below, so no extractable handle
  // to the seed survives this call. This is the JWK round-trip the
  // old @noble/curves path was added to avoid (audit L1); moving to
  // WebCrypto trades that transient in-memory copy for dropping the
  // elliptic-curve dependency.
  const probe = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'Ed25519' },
    true,
    ['sign'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', probe)
  const publicKeyB64 = jwk.x
  delete jwk.d
  if (publicKeyB64 == null) throw new Error('Ed25519 JWK export returned no public key')
  const publicKey = Uint8Array.fromBase64(publicKeyB64, { alphabet: 'base64url' })
  // NON-extractable (`false`): nothing in the JS realm — including
  // the same module that imported it — can call exportKey('pkcs8'/
  // 'raw'/'jwk', key) to recover the seed afterwards. The signing
  // key only does what the `['sign']` usage allows.
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'Ed25519' },
    false,
    ['sign'],
  )
  // Zero the seed bytes (and the pkcs8 envelope that copied them)
  // so a heap-snapshot dump of this realm doesn't expose the
  // workspace's signing material. The WebCrypto `privateKey` is
  // already non-extractable; this closes the in-process disclosure
  // window for the brief lifetime of the local Uint8Arrays.
  // Defense-in-depth — JS doesn't expose a deterministic erase
  // primitive (the GC may have already moved the bytes), but the
  // explicit `fill(0)` guarantees the wrappers we hold no longer
  // contain the seed. Audit round-8 L1.
  seed.fill(0)
  pkcs8.fill(0)
  return { privateKey, publicKey, publicKeyB64 }
}

// Bytes the signature covers — kept identical between sender and
// every receiver. Domain prefix + newline-joined fields. Newlines
// can't appear in base64url or in the bare integer/empty
// `base` field, so this is unambiguous without explicit
// length-prefix framing.
//
// The `keyframe` field is `'1'` only when the value is `=== true`,
// `''` otherwise — STRICT, not truthy. The server's
// `canonicalSave` matches; the storage path (`msg.keyframe ===
// true`) matches; if any of the three drifted to a looser rule
// (e.g. `keyframe ? '1' : ''`), a non-boolean truthy wire flag
// like `keyframe: 1` would hash differently between the sender
// and one of the receivers, sail past sig-verify on the wrong
// side, and end up as a chain row that no one can apply.
//
// Including `keyframe` in the SIGNED bytes also stops a malicious
// server from relabeling a normal save as a keyframe (or vice
// versa) — the wire flag the server uses for routing/storage
// MUST match the signed flag, or the signature fails.
function canonicalSavePayload(
  { publicKeyB64, base, keyframe, nonceB64, ciphertextB64 }: SavePayload,
): Uint8Array<ArrayBuffer> {
  return encodeUtf8([
    SIGN_DOMAIN,
    publicKeyB64,
    base == null ? '' : String(base),
    keyframe === true ? '1' : '',
    nonceB64,
    ciphertextB64,
  ].join('\n'))
}

export async function signSavePayload(privateKey: CryptoKey, payload: SavePayload): Promise<string> {
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
export async function computeRevisionId(payload: SavePayload): Promise<string> {
  const message = canonicalSavePayload(payload)
  const digest = await crypto.subtle.digest('SHA-256', message)
  return new Uint8Array(digest).toBase64({ alphabet: 'base64url', omitPadding: true })
}

// Same idea as the save signature, but the canonical bytes are
// `<subscribe-domain>\n<pubkey>\n<from>\n<connectionNonce>` —
// `from` is the last revision the client knows it has applied (so
// the server can skip straight to revisions newer than that), and
// `connectionNonce` is the per-socket challenge the server emitted
// in a `challenge` frame the moment this socket opened (round-9 H2).
// The nonce binds this signature to the connection; a captured
// subscribe frame can't be replayed from a different connection
// because that connection's nonce is different and the signature
// won't verify against the new canonical bytes. Different domain
// prefix from save so a save signature can't be replayed as a
// subscribe and vice versa.
function canonicalSubscribePayload(
  publicKeyB64: string,
  fromBase: string | number | null | undefined,
  connectionNonce: string,
): Uint8Array<ArrayBuffer> {
  const fromStr = fromBase == null ? '' : String(fromBase)
  return encodeUtf8([SUBSCRIBE_DOMAIN, publicKeyB64, fromStr, connectionNonce].join('\n'))
}

export async function signSubscribePayload(
  privateKey: CryptoKey,
  publicKeyB64: string,
  fromBase: string | number | null | undefined,
  connectionNonce: string,
): Promise<string> {
  const message = canonicalSubscribePayload(publicKeyB64, fromBase, connectionNonce)
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message)
  return new Uint8Array(sig).toBase64({ alphabet: 'base64url', omitPadding: true })
}

export async function verifySavePayload(
  publicKey: Uint8Array<ArrayBuffer>,
  payload: SavePayload,
  signatureB64: string,
): Promise<boolean> {
  // Wrap the entire verify in one try / catch — `Uint8Array.fromBase64`
  // throws SyntaxError on a malformed `signatureB64` (e.g. a peer or
  // relay-supplied non-base64 string), and `canonicalSavePayload`
  // throws via `encodeUtf8` on a lone surrogate or non-string field.
  // The previous shape only caught `importKey` and `verify` errors,
  // letting fromBase64 throw unhandled out of `applyChainToBase` —
  // a bad sig from a peer would unwind the chain mid-loop, leaving
  // session.baseState / baseRevision partially advanced and the
  // captured user overlay lost. Treating any throw as `ok=false`
  // routes through the existing structured `applyChainToBase`
  // recovery (skip + bump savesSinceKeyframe). Audit round-12 H9.
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      publicKey,
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    const sig = Uint8Array.fromBase64(signatureB64, { alphabet: 'base64url' })
    const message = canonicalSavePayload(payload)
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, message)
  } catch {
    return false
  }
}

function randomNonce(): Uint8Array<ArrayBuffer> {
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
export function buildAad(
  workspaceTag: string,
  base: string | number | null | undefined,
): Uint8Array<ArrayBuffer> {
  const baseStr = base == null ? '' : String(base)
  return encodeUtf8(`${workspaceTag}|${baseStr}`)
}

async function encryptBytes(
  keyBytes: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<{ nonce: Uint8Array<ArrayBuffer>, ciphertext: Uint8Array<ArrayBuffer> }> {
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
  return { nonce, ciphertext: cipher.encrypt(plaintext) as Uint8Array<ArrayBuffer> }
}

async function decryptBytes(
  keyBytes: Uint8Array<ArrayBuffer>,
  nonce: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
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
  return cipher.decrypt(ciphertext) as Uint8Array<ArrayBuffer>
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

// Smallest power of two ≥ max(n, floor). Capped at 2^30 (~1 GiB)
// because `1 << 31` is signed-cyclic in JS (= -2147483648) and
// would crash `new Uint8Array(target)`. The frameAndPad guard
// below rejects compressed payloads > 0x3FFFFFFC, keeping the
// (4 + compressed.length) bucketing within the safe range.
function nextPow2AtLeast(n: number, floor: number): number {
  if (n <= floor) return floor
  return 2 ** (32 - Math.clz32(n - 1))
}

async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  writer.write(bytes)
  writer.close()
  return new Uint8Array(await new Response(cs.readable).arrayBuffer())
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const ds = new DecompressionStream('gzip')
  const writer = ds.writable.getWriter()
  writer.write(bytes)
  writer.close()
  return new Uint8Array(await new Response(ds.readable).arrayBuffer())
}

async function frameAndPad(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const json = encodeUtf8(JSON.stringify(value))
  const compressed = await gzip(json)
  // 4-byte length prefix + bucketing to next pow2 (capped at 2^30
  // so the result fits a Uint32 length passed to `new Uint8Array`).
  if (compressed.length > 0x3FFFFFFC) throw new Error('payload too large')
  const target = nextPow2AtLeast(4 + compressed.length, PAD_FLOOR)
  const out = new Uint8Array(target)
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, compressed.length, false)
  out.set(compressed, 4)
  return out
}

async function unframeAndUngzip(plaintext: Uint8Array<ArrayBuffer>): Promise<unknown> {
  if (plaintext.length < 4) throw new Error('plaintext too short')
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength)
  const len = view.getUint32(0, false)
  if (len + 4 > plaintext.length) throw new Error('length prefix exceeds buffer')
  const compressed = plaintext.subarray(4, 4 + len) as Uint8Array<ArrayBuffer>
  const json = await gunzip(compressed)
  return JSON.parse(decodeUtf8(json))
}

// JSON-friendly conveniences — gzip + pad + encrypt a JSON-able
// value to `{ nonce, ciphertext }` (both base64) and reverse on the
// way back. Tag is appended to the ciphertext by the AEAD; we ship
// it as one blob.
export async function encryptJson(
  keyBytes: Uint8Array<ArrayBuffer>,
  value: unknown,
  aad: Uint8Array<ArrayBuffer>,
): Promise<EncryptedJson> {
  const plaintext = await frameAndPad(value)
  const { nonce, ciphertext } = await encryptBytes(keyBytes, plaintext, aad)
  return { nonce: nonce.toBase64(), ciphertext: ciphertext.toBase64() }
}

export async function decryptJson(
  keyBytes: Uint8Array<ArrayBuffer>,
  nonceB64: string,
  ciphertextB64: string,
  aad: Uint8Array<ArrayBuffer>,
): Promise<unknown> {
  const nonce = Uint8Array.fromBase64(nonceB64)
  const ciphertext = Uint8Array.fromBase64(ciphertextB64)
  const plaintext = await decryptBytes(keyBytes, nonce, ciphertext, aad)
  return unframeAndUngzip(plaintext)
}
