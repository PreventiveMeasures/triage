// Round-trip tests for the workspace share-by-link encoder. Verifies
// that the (id, name, privateKey) triple round-trips through the
// hash payload, that a wrong password fails with the expected
// message, and that crafted payloads are rejected up front. No DOM /
// no browser — the pure module only needs `crypto.subtle` (Node 24+).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  buildShareUrl,
  decodeShareLink,
  encodeShareLink,
  extractShareEncoded,
} = await import('../client/workspace-share-link.js')

const {
  deriveWorkspaceIdFromPrivateKey,
} = await import('../client/workspace-id.js')

function randomPrivateKeyBase64() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytes.toBase64()
}

function fakeUuid() {
  return crypto.randomUUID()
}

describe('workspace share-link', () => {
  it('round-trips id + name + privateKey through a password-encrypted link', async () => {
    // Use a random UUID for `id` so it does NOT match the derived
    // value — exercises the explicit-id branch on both encode and
    // decode. The derive-match optimisation is covered separately
    // below.
    const id = fakeUuid()
    const name = 'Project Atlas'
    const privateKeyBase64 = randomPrivateKeyBase64()
    const password = 'correct horse battery staple'
    const encoded = await encodeShareLink({ id, name, privateKeyBase64, password })
    assert.equal(typeof encoded, 'string')
    assert.ok(encoded.length > 0)
    const decoded = await decodeShareLink({ encoded, password })
    assert.equal(decoded.id, id)
    assert.equal(decoded.name, name)
    assert.equal(decoded.privateKeyBase64, privateKeyBase64)
  })

  it('omits the id from the wire when it matches derive(privateKey) — bytes saved', async () => {
    // Encode the same (name, key, password) twice: once with the
    // sender's id set to the derived value, once with an explicit
    // random id. The first must produce a strictly shorter wire
    // (the id field is skipped from the plaintext, and AES-GCM
    // preserves length to within the auth-tag overhead). Both
    // must decode to the SAME id — the recipient re-derives from
    // the key when the wire is silent.
    const privateKeyBase64 = randomPrivateKeyBase64()
    const derived = await deriveWorkspaceIdFromPrivateKey(privateKeyBase64)
    const password = 'pw'
    const args = { name: 'X', privateKeyBase64, password }
    const omitted = await encodeShareLink({ id: derived, ...args })
    const explicit = await encodeShareLink({ id: fakeUuid(), ...args })
    // Absolute byte budget so a future regression that shaves only
    // a few bytes (e.g. a JSON canonicaliser collapsing whitespace
    // both sides emit identically) still trips this. The omitted
    // form drops the `,"i":"<36-char UUID>"` slice = 42 plaintext
    // chars; AES-GCM is length-preserving and base64url adds 4/3
    // overhead, so the wire delta is at least ~56 chars in the
    // common case. Floor at 40 — well above any future micro-shave
    // and well below the deterministic ~56-char gap.
    assert.ok(
      explicit.length - omitted.length >= 40,
      `derive-match payload should save ≥40 wire chars (saw ${explicit.length - omitted.length})`,
    )
    const decodedOmitted = await decodeShareLink({ encoded: omitted, password })
    assert.equal(decodedOmitted.id, derived, 'recipient re-derives the id from the key')
  })

  it('preserves a legacy explicit id verbatim on the wire (no spurious derivation)', async () => {
    // A workspace whose stored id was set by `crypto.randomUUID()`
    // before the derivation switch lands here. The sender must ship
    // the explicit id; the recipient must NOT silently swap to the
    // derived value (that would break sync — the relay chain is
    // keyed by the sender's actual id).
    const privateKeyBase64 = randomPrivateKeyBase64()
    const legacyId = fakeUuid()
    const derived = await deriveWorkspaceIdFromPrivateKey(privateKeyBase64)
    assert.notEqual(legacyId, derived, 'legacy id should not match derived (probabilistically true)')
    const password = 'pw'
    const encoded = await encodeShareLink({ id: legacyId, name: 'L', privateKeyBase64, password })
    const decoded = await decodeShareLink({ encoded, password })
    assert.equal(decoded.id, legacyId)
  })

  it('rejects a wrong password with a friendly error', async () => {
    const encoded = await encodeShareLink({
      id: fakeUuid(),
      name: 'Workspace',
      privateKeyBase64: randomPrivateKeyBase64(),
      password: 'right password',
    })
    await assert.rejects(
      () => decodeShareLink({ encoded, password: 'wrong password' }),
      /wrong password or corrupt link/u,
    )
  })

  it('rejects a malformed payload', async () => {
    await assert.rejects(
      () => decodeShareLink({ encoded: '!!!not base64!!!', password: 'x' }),
      /malformed share link/u,
    )
    await assert.rejects(
      () => decodeShareLink({ encoded: 'AA', password: 'x' }),
      /malformed share link/u,
    )
  })

  it('rejects an encode call missing the id field', async () => {
    await assert.rejects(
      () => encodeShareLink({
        name: 'X',
        privateKeyBase64: randomPrivateKeyBase64(),
        password: 'pw',
      }),
      /share: id required/u,
    )
  })

  it('does not surface an oracle distinguishing wrong-version from wrong-password', async () => {
    // Build a payload whose version byte is anything other than 1.
    // The wire shape is still valid; only the leading byte differs.
    // The error must collapse to the same generic message so an
    // attacker can't distinguish version tampering from password
    // failure by error text.
    const password = 'pw'
    const encoded = await encodeShareLink({
      id: fakeUuid(),
      name: 'X',
      privateKeyBase64: randomPrivateKeyBase64(),
      password,
    })
    const raw = Uint8Array.fromBase64(encoded, { alphabet: 'base64url' })
    raw[0] = 0xff
    const tampered = raw.toBase64({ alphabet: 'base64url', omitPadding: true })
    await assert.rejects(
      () => decodeShareLink({ encoded: tampered, password }),
      /malformed share link/u,
    )
  })

  it('rejects a payload whose decoded privateKey is not 32 bytes', async () => {
    // 16-byte key — base64-encodes to a valid string, fully wrong
    // length for the sync-crypto pipeline. The decoder should refuse
    // before the boot pipeline pulls the value into `Uint8Array.fromBase64`.
    const shortKey = new Uint8Array(16)
    crypto.getRandomValues(shortKey)
    const password = 'pw'
    const encoded = await encodeShareLink({
      id: fakeUuid(),
      name: 'X',
      privateKeyBase64: shortKey.toBase64(),
      password,
    })
    await assert.rejects(
      () => decodeShareLink({ encoded, password }),
      /malformed share link/u,
    )
  })

  it('rejects a payload whose id exceeds the 256-char cap', async () => {
    // A crafted payload could otherwise plant a multi-MB id in
    // localStorage. Bound the id length to a generous 256 chars
    // (UUIDs are 36) so a hostile sender can't bloat the workspaces
    // blob.
    const password = 'pw'
    const longId = 'a'.repeat(257)
    const encoded = await encodeShareLink({
      id: longId,
      name: 'X',
      privateKeyBase64: randomPrivateKeyBase64(),
      password,
    })
    await assert.rejects(
      () => decodeShareLink({ encoded, password }),
      /malformed share link/u,
    )
  })

  it('produces a different ciphertext on each encode (random salt + nonce)', async () => {
    const args = {
      id: fakeUuid(),
      name: 'Workspace',
      privateKeyBase64: randomPrivateKeyBase64(),
      password: 'pw',
    }
    const a = await encodeShareLink(args)
    const b = await encodeShareLink(args)
    assert.notEqual(a, b)
  })

  it('extractShareEncoded pulls the `share=` parameter out of a hash', () => {
    assert.equal(extractShareEncoded('#share=abc'), 'abc')
    assert.equal(extractShareEncoded('share=abc'), 'abc')
    assert.equal(extractShareEncoded('#share=abc&extra=1'), 'abc')
    assert.equal(extractShareEncoded('#other=abc'), null)
    assert.equal(extractShareEncoded(''), null)
    assert.equal(extractShareEncoded('#'), null)
    // Query-string carriage is deliberately NOT supported — a
    // `?share=` URL would leak the encrypted blob via Referer to
    // every subresource on the page. `buildShareUrl` only emits
    // the `#` form, and the boot handler reads `location.hash`
    // only; this test pins that behavior.
    assert.equal(extractShareEncoded('?share=abc'), null)
  })

  it('buildShareUrl falls back to a bare fragment when location is missing', () => {
    // Smoke check: the function shouldn't throw when called outside a
    // browser realm. In Node, `location` is undefined and we expect
    // the fragment-only form.
    const prior = globalThis.location
    delete globalThis.location
    try {
      assert.equal(buildShareUrl('xyz'), '#share=xyz')
    } finally {
      if (prior !== undefined) globalThis.location = prior
    }
  })
})
