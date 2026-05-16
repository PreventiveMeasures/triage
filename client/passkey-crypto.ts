// Passkey-derived envelope encryption for local triage + report data.
//
// WebAuthn's `prf` extension lets a relying party derive a stable,
// per-credential 32-byte secret from an authenticator (TouchID,
// Windows Hello, hardware key) without ever exposing the secret to
// scripts beyond a single assertion. We HKDF that PRF output into an
// AES-GCM-256 content key; the key is never persisted and the
// authenticator is required every time the user unlocks.
//
// Two operations against the authenticator:
//   1. `registerPasskey()` — calls navigator.credentials.create() with
//      the `prf` extension hint. We also generate the 32-byte PRF
//      salt up front and run an IMMEDIATE follow-up assertion to
//      probe the PRF output; some browsers (Chrome) accept the prf
//      input at create time, others (Safari) ignore it on create and
//      only honor it on get. Either way the salt + credentialId are
//      what we persist; the derived key is in-memory only.
//   2. `assertPasskey()` — calls navigator.credentials.get() against
//      the stored credentialId + salt; returns the PRF output bytes.
//
// Detection: WebAuthn PRF is gated behind `PublicKeyCredential` AND
// the prf extension support — `isPasskeySupported()` returns false
// when either is missing. Caller (passkey-vault.js) surfaces a
// disabled / explanatory UI in that case rather than silently
// downgrading to plaintext.

import { encodeUtf8 } from '../common/utf8.js'

// Envelope magic — distinguishes encrypted blobs from raw
// gzip/deflate content. The triage blob (deflate, no fixed magic in
// the first byte) and OPFS report files (gzip, magic `1f 8b`) both
// reuse this same envelope shape so callers in `triage.js` and
// `storage.js` can sniff at the boundary and route to decrypt vs.
// the legacy path. "DVE1" = DeepView Encrypted v1.
export const ENVELOPE_MAGIC = new Uint8Array([0x44, 0x56, 0x45, 0x31])
const NONCE_LEN = 12
const KEY_LEN = 32
const KDF_INFO = 'deepview-passkey.v1.content-key'

export type PasskeyRegistration = {
  credentialId: string  // base64url
  prfSalt: string       // base64url, 32 random bytes
  prfOutput: Uint8Array // 32 bytes, returned ONCE — caller derives a session key immediately
}

// Probe: does this environment support WebAuthn AT ALL? PRF support
// is a separate runtime question that only the actual register/get
// call can answer authoritatively — Safari, for example, advertises
// PublicKeyCredential but quietly drops unsupported extensions. We
// surface a separate error path on the assertion-side if PRF comes
// back empty.
export function isPasskeySupported(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof PublicKeyCredential === 'undefined') return false
  if (typeof navigator === 'undefined' || !navigator.credentials) return false
  return true
}

// Pre-flight probe for the PRF extension via
// `PublicKeyCredential.getClientCapabilities` (Chrome 133+,
// progressively rolling out in other browsers). Returns:
//   - true: capabilities API says PRF is supported.
//   - false: capabilities API says PRF is NOT supported — caller
//     should refuse `enableEncryption` and tell the user before
//     a passkey is registered (otherwise the post-register PRF
//     probe will leave an orphan credential on the authenticator).
//   - null: capabilities API isn't available — caller falls
//     through to the existing register+probe flow, which orphan-
//     cleans up on failure.
export async function probePrfSupport(): Promise<boolean | null> {
  if (typeof PublicKeyCredential === 'undefined') return false
  const getCaps = /** @type {{ getClientCapabilities?: () => Promise<Record<string, boolean>> }} */ (
    /** @type {unknown} */ (PublicKeyCredential)
  ).getClientCapabilities
  if (typeof getCaps !== 'function') return null
  try {
    const caps = await getCaps.call(PublicKeyCredential)
    if (!caps || typeof caps !== 'object') return null
    // The WebAuthn L3 spec surfaces extension capabilities under the
    // `extension:<id>` key; Chrome 133+'s actual implementation
    // exposes both that and the bare `prf` key for compatibility.
    // Check both so we work across the spec's lifetime — a future
    // Chrome that drops the bare key still produces a positive
    // signal, and a current Chrome that only ships one of the two
    // also works.
    const extPrf = (caps as Record<string, unknown>)['extension:prf']
    const barePrf = (caps as Record<string, unknown>)['prf']
    if (extPrf === true || barePrf === true) return true
    if (extPrf === false || barePrf === false) return false
    return null
  } catch {
    return null
  }
}

function randomBytes(len: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(len)
  crypto.getRandomValues(out)
  return out
}

// Derive a 32-byte AES-GCM key from the raw PRF output via HKDF-
// SHA-256 with a domain-separating info string. Two reasons to KDF
// rather than use the PRF output directly:
//   1. Domain separation — the same PRF output can later be re-used
//      under a different `info` string (e.g. an `objstore` content
//      key) without two protocols sharing the same key bytes.
//   2. Decouples the envelope from any future change to what the PRF
//      output looks like (some authenticators may emit > 32 bytes).
export async function deriveContentKey(prfOutput: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (prfOutput.length < 32) {
    throw new Error(`PRF output too short (${prfOutput.length} bytes; need ≥ 32)`)
  }
  const baseKey = await crypto.subtle.importKey(
    'raw', prfOutput as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: encodeUtf8(KDF_INFO),
    },
    baseKey,
    KEY_LEN * 8,
  )
  return new Uint8Array(bits)
}

// Wrap a CryptoKey around the raw 32 bytes so we hold onto an
// importable handle for the duration of the session. AES-GCM accepts
// raw + ['encrypt', 'decrypt'] usages; non-extractable so the bytes
// can't be re-exported from JS after import. Caller may also `fill(0)`
// the input buffer afterwards (defence-in-depth — the GC may have
// already moved the bytes).
export function importContentKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', rawKey as Uint8Array<ArrayBuffer>, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  )
}

// AES-GCM seal: out = MAGIC || nonce || (ciphertext || authTag).
// Caller passes optional AAD bytes — we bind every envelope to a
// context string so a triage blob can't be swapped in as an OPFS
// report (and vice versa), and so two OPFS report files can't be
// swapped under each other's filenames at rest. The AAD is NOT
// stored on the wire; both sides reconstruct it from context.
export async function sealEnvelope(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = randomBytes(NONCE_LEN)
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad as Uint8Array<ArrayBuffer> },
    key,
    plaintext as Uint8Array<ArrayBuffer>,
  ))
  const out = new Uint8Array(ENVELOPE_MAGIC.length + NONCE_LEN + ct.length)
  out.set(ENVELOPE_MAGIC, 0)
  out.set(nonce, ENVELOPE_MAGIC.length)
  out.set(ct, ENVELOPE_MAGIC.length + NONCE_LEN)
  return out
}

// Reverse of `sealEnvelope`. Throws on:
//   - too-short input,
//   - missing magic prefix,
//   - AEAD tag mismatch (wrong key, tampered ciphertext, wrong AAD).
// Caller (decryptIfEnveloped) handles the "no magic = legacy
// plaintext" case BEFORE invoking this — we don't tolerate it here
// so a corrupted magic doesn't silently fall through.
export async function openEnvelope(
  key: CryptoKey,
  bytes: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!hasEnvelopeMagic(bytes)) {
    throw new Error('passkey: missing envelope magic')
  }
  if (bytes.length < ENVELOPE_MAGIC.length + NONCE_LEN + 16) {
    throw new Error('passkey: envelope too short')
  }
  const nonce = bytes.subarray(ENVELOPE_MAGIC.length, ENVELOPE_MAGIC.length + NONCE_LEN) as Uint8Array<ArrayBuffer>
  const ct = bytes.subarray(ENVELOPE_MAGIC.length + NONCE_LEN) as Uint8Array<ArrayBuffer>
  const pt = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad as Uint8Array<ArrayBuffer> },
    key,
    ct,
  ))
  return pt
}

export function hasEnvelopeMagic(bytes: Uint8Array): boolean {
  if (bytes.length < ENVELOPE_MAGIC.length) return false
  for (let i = 0; i < ENVELOPE_MAGIC.length; i++) {
    if (bytes[i] !== ENVELOPE_MAGIC[i]) return false
  }
  return true
}

// WebAuthn create: registers a new resident-key passkey with the
// `prf` extension. `rpId` is passed explicitly (not relying on the
// browser default) so the matching `assertPasskey` and
// `signalUnknownCredential` calls target the same RP; eTLD+1
// resolution can otherwise differ across browser versions or when
// the page moves between subdomains. user.id is a 16-byte
// device-scoped value the caller (vault) keeps in its metadata; a
// future "rotate keys" affordance is expected to reuse it so the
// re-registration replaces the existing authenticator slot rather
// than stacking duplicates.
//
// The PRF salt is generated here (32 random bytes), embedded in the
// extension input, and returned to the caller for storage. The
// salt is NOT a secret — it's part of the public credential's
// metadata and must be persisted next to the credentialId.
//
// Some authenticators (older Safari) don't honor PRF on create; we
// fall through and let the caller probe via assertPasskey() on the
// next unlock. Returns `prfOutput` only when create-time PRF
// succeeded; null otherwise (caller still proceeds — the
// registration is fine, we just have to assert separately to derive
// the key).
export async function registerPasskey(opts: {
  userName: string
  userId: Uint8Array<ArrayBuffer>
  rpName: string
  rpId: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<{ credentialId: string, prfSalt: string, prfOutput: Uint8Array | null }> {
  if (!isPasskeySupported()) throw new Error('passkey: not supported in this environment')
  const challenge = randomBytes(32)
  const prfSalt = randomBytes(32)
  // ES256 (-7) + RS256 (-257) cover the platform authenticator set
  // every current browser ships. Resident-key REQUIRED so the user
  // can unlock later without remembering / typing the credential id.
  const created = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: opts.rpName, id: opts.rpId },
      user: {
        id: opts.userId,
        name: opts.userName,
        displayName: opts.userName,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      extensions: { prf: { eval: { first: prfSalt } } },
      timeout: opts.timeoutMs ?? 120_000,
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!(created instanceof PublicKeyCredential)) {
    throw new Error('passkey: registration returned no credential')
  }
  const credentialId = new Uint8Array(created.rawId).toBase64({ alphabet: 'base64url', omitPadding: true })
  // Some browsers expose prf result on create, others only on get —
  // the wrapper accepts either path. The `unknown` cast is the
  // ergonomic shim around TypeScript's stale @types/dom not yet
  // describing the prf extension result shape.
  const ext = (created.getClientExtensionResults() as unknown as { prf?: { results?: { first?: ArrayBuffer } } }).prf
  const prfOutput = ext?.results?.first ? new Uint8Array(ext.results.first) : null
  return {
    credentialId,
    prfSalt: prfSalt.toBase64({ alphabet: 'base64url', omitPadding: true }),
    prfOutput,
  }
}

// WebAuthn get: asserts a previously-registered passkey, scoped to
// the stored credentialId, and pulls the PRF output. Throws when
// the user cancels (NotAllowedError), no matching credential is
// found (also NotAllowedError on most browsers — opaque on purpose),
// or PRF isn't supported by the authenticator that responded.
// `rpId` is required and must match what was used at registration —
// the credential is bound to it and an assertion against a different
// rpId surfaces as NotAllowedError.
export async function assertPasskey(opts: {
  credentialId: string
  prfSalt: string
  rpId: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<Uint8Array> {
  if (!isPasskeySupported()) throw new Error('passkey: not supported in this environment')
  const challenge = randomBytes(32)
  const credentialIdBytes = Uint8Array.fromBase64(opts.credentialId, { alphabet: 'base64url' })
  const prfSaltBytes = Uint8Array.fromBase64(opts.prfSalt, { alphabet: 'base64url' })
  const got = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: opts.rpId,
      allowCredentials: [{
        type: 'public-key',
        id: credentialIdBytes,
      }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: prfSaltBytes } } },
      timeout: opts.timeoutMs ?? 120_000,
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!(got instanceof PublicKeyCredential)) {
    throw new Error('passkey: assertion returned no credential')
  }
  const ext = (got.getClientExtensionResults() as unknown as { prf?: { results?: { first?: ArrayBuffer } } }).prf
  const first = ext?.results?.first
  if (!first) {
    throw new Error('passkey: authenticator did not return PRF output (extension unsupported)')
  }
  return new Uint8Array(first)
}
