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
      /encodeShareLink: id required/u,
    )
  })

  it('rejects an encode call missing the name field', async () => {
    await assert.rejects(
      () => encodeShareLink({
        id: fakeUuid(),
        privateKeyBase64: randomPrivateKeyBase64(),
        password: 'pw',
      }),
      /encodeShareLink: name required/u,
    )
  })

  it('rejects an encode call missing the privateKey field', async () => {
    await assert.rejects(
      () => encodeShareLink({
        id: fakeUuid(),
        name: 'X',
        password: 'pw',
      }),
      /encodeShareLink: privateKey required/u,
    )
  })

  it('rejects an encode call missing the password field', async () => {
    await assert.rejects(
      () => encodeShareLink({
        id: fakeUuid(),
        name: 'X',
        privateKeyBase64: randomPrivateKeyBase64(),
      }),
      /encodeShareLink: password required/u,
    )
  })

  it('rejects a decode call missing the password field (programmer error)', async () => {
    const encoded = await encodeShareLink({
      id: fakeUuid(),
      name: 'X',
      privateKeyBase64: randomPrivateKeyBase64(),
      password: 'pw',
    })
    await assert.rejects(
      () => decodeShareLink({ encoded }),
      /decodeShareLink: password required/u,
    )
  })

  it('maps a tampered version byte to the generic malformed-share-link error', async () => {
    // A flipped version byte is a pre-decrypt shape failure: the
    // explicit `wire[0] !== WIRE_VERSION` check in `password-crypto.js`
    // fires before PBKDF2 runs. Pre-decrypt failures (bad base64,
    // wrong version, truncated wire) surface as 'malformed share link';
    // post-decrypt failures collapse into 'wrong password or corrupt
    // link' so the password-correct path can't be distinguished from
    // post-decrypt shape failures (which IS the oracle defense).
    // Pre-decrypt distinction is intentional and harmless since the
    // structural bytes are attacker-known anyway.
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
    // length for the sync-crypto pipeline. The decoder must refuse
    // before the boot pipeline pulls the value into use. Post-
    // decrypt shape failures surface as the wrong-password error so
    // they can't be told apart from a genuine auth failure.
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
      /wrong password or corrupt link/u,
    )
  })

  it('rejects a payload whose id exceeds the 256-char cap', async () => {
    // A crafted payload could otherwise plant a multi-MB id in
    // localStorage. Bound the id length to a generous 256 chars
    // (UUIDs are 36) so a hostile sender can't bloat the workspaces
    // blob. Post-decrypt failures collapse into the wrong-password
    // error so the cap check isn't an oracle.
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
      /wrong password or corrupt link/u,
    )
  })

  // The post-decrypt oracle: a ciphertext that decrypts cleanly under
  // the correct password but whose plaintext doesn't have the share-
  // link shape must surface the same error as a genuine auth failure.
  // Otherwise an attacker probing crafted ciphertexts can use the
  // distinct error to confirm "the password decrypted my payload" vs
  // "the password is wrong" without knowing the password.
  it('collapses post-decrypt failures into the wrong-password error', async () => {
    // Build a wire that decrypts to something which isn't valid JSON,
    // by encrypting via the password-crypto primitive directly (skips
    // the share-link JSON envelope).
    const { encryptWithPassword } = await import('../client/password-crypto.js')
    const password = 'pw'
    const wire = await encryptWithPassword(new Uint8Array(64).fill(0xff), password)
    const encoded = wire.toBase64({ alphabet: 'base64url', omitPadding: true })
    await assert.rejects(
      () => decodeShareLink({ encoded, password }),
      /wrong password or corrupt link/u,
    )
  })

  // The oracle defense depends on the auth-failure path and the
  // post-decrypt-failure path returning the SAME error message text.
  // A future refactor that diverges the two strings silently re-opens
  // the oracle without breaking the regex-only assertions elsewhere.
  // Pin byte-for-byte equality.
  it('auth-failure and post-decrypt-failure produce byte-identical share-link error messages', async () => {
    const { encryptWithPassword } = await import('../client/password-crypto.js')
    const goodEncoded = await encodeShareLink({
      id: fakeUuid(),
      name: 'Workspace',
      privateKeyBase64: randomPrivateKeyBase64(),
      password: 'right',
    })
    let authErr
    try {
      await decodeShareLink({ encoded: goodEncoded, password: 'wrong' })
    } catch (err) {
      authErr = err
    }
    // Build a different wire that decrypts cleanly under its password
    // but isn't a share-link payload (post-decrypt collapse).
    const wire = await encryptWithPassword(new Uint8Array(64).fill(0xff), 'pw2')
    const postDecryptEncoded = wire.toBase64({ alphabet: 'base64url', omitPadding: true })
    let postDecryptErr
    try {
      await decodeShareLink({ encoded: postDecryptEncoded, password: 'pw2' })
    } catch (err) {
      postDecryptErr = err
    }
    assert.equal(authErr.message, postDecryptErr.message, 'oracle defense requires byte-identical messages')
  })

  // The oracle-collapse path preserves the underlying error as `cause`
  // so DevTools / console diagnosis sees the gunzip / JSON parse error.
  // The user-facing message stays generic; only the cause chain carries
  // diagnostics. A refactor that dropped `{ cause }` would regress
  // debug ergonomics without changing the user-facing oracle defense.
  it('preserves `cause` on the post-decrypt oracle-collapse path', async () => {
    const { encryptWithPassword } = await import('../client/password-crypto.js')
    const password = 'pw'
    const wire = await encryptWithPassword(new Uint8Array(64).fill(0xff), password)
    const encoded = wire.toBase64({ alphabet: 'base64url', omitPadding: true })
    let caught
    try {
      await decodeShareLink({ encoded, password })
    } catch (err) {
      caught = err
    }
    assert.ok(caught, 'expected the decode to throw')
    assert.match(caught.message, /wrong password or corrupt link/u)
    assert.ok(caught.cause, 'expected the rethrown error to carry `cause`')
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
