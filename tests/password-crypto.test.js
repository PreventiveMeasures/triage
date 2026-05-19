// Direct tests for the shared password-encryption primitive: result-
// envelope shape, magic-byte sniff, programmer-error throws.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  MIN_WIRE_LEN,
  WIRE_VERSION,
  decryptWithPasswordOrThrow,
  encryptWithPassword,
  isEncryptedWire,
  tryDecryptWithPassword,
} = await import('../client/password-crypto.js')

function randomBytes(n) {
  const buf = new Uint8Array(n)
  crypto.getRandomValues(buf)
  return buf
}

// PBKDF2 (3M iterations) is the per-test bottleneck — each
// encrypt/decrypt pair burns ~1.4 s. WebCrypto runs the derivation
// on libuv's threadpool, so concurrent `it`s share up to
// UV_THREADPOOL_SIZE cores (default 4) instead of serialising on
// one. The tests are otherwise independent — fresh ciphertext per
// test, no shared state.
describe('password-crypto', { concurrency: true }, () => {
  it('round-trips arbitrary bytes through the encrypt/decrypt pair', async () => {
    const plaintext = randomBytes(256)
    const wire = await encryptWithPassword(plaintext, 'pw')
    assert.equal(wire[0], WIRE_VERSION)
    const result = await tryDecryptWithPassword(wire, 'pw')
    assert.equal(result.ok, true)
    assert.deepEqual(result.plaintext, plaintext)
  })

  it('returns { ok: false, reason: "wrong-password" } on auth failure', async () => {
    const wire = await encryptWithPassword(randomBytes(32), 'right')
    const result = await tryDecryptWithPassword(wire, 'wrong')
    assert.deepEqual(result, { ok: false, reason: 'wrong-password' })
  })

  // Version-mismatch lands in the generic `'malformed'` bucket along with
  // every other shape failure — an attacker probing tampered wires only
  // learns the wire failed the shape check, not which field they hit.
  it('returns { ok: false, reason: "malformed" } on a tampered version byte', async () => {
    const wire = await encryptWithPassword(randomBytes(32), 'pw')
    wire[0] = 0xff
    const result = await tryDecryptWithPassword(wire, 'pw')
    assert.deepEqual(result, { ok: false, reason: 'malformed' })
  })

  it('returns { ok: false, reason: "malformed" } on a truncated wire', async () => {
    assert.deepEqual(
      await tryDecryptWithPassword(new Uint8Array(MIN_WIRE_LEN - 1), 'pw'),
      { ok: false, reason: 'malformed' },
    )
    assert.deepEqual(
      await tryDecryptWithPassword(new Uint8Array(0), 'pw'),
      { ok: false, reason: 'malformed' },
    )
  })

  it('returns { ok: false, reason: "malformed" } on a non-Uint8Array wire', async () => {
    assert.deepEqual(
      await tryDecryptWithPassword(new ArrayBuffer(64), 'pw'),
      { ok: false, reason: 'malformed' },
    )
  })

  it('throws on a missing / non-string password (programmer error)', async () => {
    await assert.rejects(
      () => encryptWithPassword(randomBytes(8), ''),
      /password required/u,
    )
    await assert.rejects(
      () => encryptWithPassword(randomBytes(8), null),
      /password required/u,
    )
    const wire = await encryptWithPassword(randomBytes(8), 'pw')
    await assert.rejects(
      () => tryDecryptWithPassword(wire, ''),
      /password required/u,
    )
  })

  it('throws on a non-Uint8Array plaintext (programmer error)', async () => {
    await assert.rejects(
      () => encryptWithPassword('not bytes', 'pw'),
      /plaintext Uint8Array required/u,
    )
  })

  it('produces a different wire on each encrypt (fresh salt + nonce)', async () => {
    const plaintext = randomBytes(32)
    const a = await encryptWithPassword(plaintext, 'pw')
    const b = await encryptWithPassword(plaintext, 'pw')
    assert.notDeepEqual(a, b)
  })

  // Tampering with the salt or nonce surfaces as `wrong-password` —
  // a flipped salt byte derives a different key (tag mismatch); a
  // flipped nonce byte feeds the wrong IV into GCM (tag mismatch).
  // These two tests pin overall prefix integrity, not specifically
  // that the AAD layer fires — the AAD-isolation test below is what
  // confirms AAD is doing its job.
  it('detects salt tampering as wrong-password (prefix integrity)', async () => {
    const wire = await encryptWithPassword(randomBytes(32), 'pw')
    wire[5] ^= 0x01
    assert.deepEqual(await tryDecryptWithPassword(wire, 'pw'), { ok: false, reason: 'wrong-password' })
  })

  it('detects nonce tampering as wrong-password (prefix integrity)', async () => {
    const wire = await encryptWithPassword(randomBytes(32), 'pw')
    wire[1 + 16 + 2] ^= 0x01
    assert.deepEqual(await tryDecryptWithPassword(wire, 'pw'), { ok: false, reason: 'wrong-password' })
  })

  // Construct a wire whose ciphertext was produced WITHOUT AAD, then
  // verify the new decoder rejects it. This is what salt/nonce
  // tampering alone can't prove — they'd fail without AAD too via
  // different mechanisms. AAD isolation needs a wire that decrypts
  // correctly under the standalone-cipher view but mismatches under
  // the AAD-bound one.
  it('rejects a wire whose ciphertext lacks AAD (AAD isolation)', async () => {
    const plaintext = randomBytes(32)
    const password = 'pw'
    // Encrypt manually with no additionalData. Mirror the wire shape
    // but skip the AAD on the AES-GCM call.
    const { encodeUtf8 } = await import('../common/utf8.js')
    const salt = new Uint8Array(16)
    const nonce = new Uint8Array(12)
    crypto.getRandomValues(salt)
    crypto.getRandomValues(nonce)
    const baseKey = await crypto.subtle.importKey('raw', encodeUtf8(password), 'PBKDF2', false, ['deriveKey'])
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 3000000 },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext))
    const wire = new Uint8Array(1 + 16 + 12 + ct.length)
    wire[0] = WIRE_VERSION
    wire.set(salt, 1)
    wire.set(nonce, 1 + 16)
    wire.set(ct, 1 + 16 + 12)
    // The AAD-bound decoder must reject — the tag was computed over
    // ct alone, so re-verifying with AAD=(version|salt|nonce) flips
    // the tag check.
    assert.deepEqual(await tryDecryptWithPassword(wire, password), { ok: false, reason: 'wrong-password' })
  })

  describe('decryptWithPasswordOrThrow', () => {
    const labels = { malformedMsg: 'BAD-SHAPE', wrongPasswordMsg: 'BAD-PASSWORD' }

    it('returns the plaintext on success', async () => {
      const plaintext = randomBytes(16)
      const wire = await encryptWithPassword(plaintext, 'pw')
      assert.deepEqual(await decryptWithPasswordOrThrow(wire, 'pw', labels), plaintext)
    })

    it('throws the caller-supplied malformed copy on shape failure', async () => {
      await assert.rejects(
        () => decryptWithPasswordOrThrow(new Uint8Array(0), 'pw', labels),
        /BAD-SHAPE/u,
      )
    })

    it('throws the caller-supplied wrong-password copy on auth failure', async () => {
      const wire = await encryptWithPassword(randomBytes(8), 'right')
      await assert.rejects(
        () => decryptWithPasswordOrThrow(wire, 'wrong', labels),
        /BAD-PASSWORD/u,
      )
    })

    it('throws TypeError on missing or partial opts (programmer error)', async () => {
      const wire = await encryptWithPassword(randomBytes(8), 'pw')
      await assert.rejects(() => decryptWithPasswordOrThrow(wire, 'pw'), TypeError)
      await assert.rejects(() => decryptWithPasswordOrThrow(wire, 'pw', {}), TypeError)
      await assert.rejects(() => decryptWithPasswordOrThrow(wire, 'pw', { malformedMsg: 'only-one' }), TypeError)
    })
  })

  describe('isEncryptedWire', () => {
    it('accepts our own encrypted output', async () => {
      const wire = await encryptWithPassword(randomBytes(8), 'pw')
      assert.equal(isEncryptedWire(wire), true)
    })

    it('rejects a gzip magic prefix', () => {
      assert.equal(isEncryptedWire(new Uint8Array([0x1f, 0x8b, ...Array.from({ length: 60 }, () => 0)])), false)
    })

    it('rejects too-short / non-Uint8Array inputs', () => {
      assert.equal(isEncryptedWire(new Uint8Array(MIN_WIRE_LEN - 1)), false)
      assert.equal(isEncryptedWire(null), false)
      assert.equal(isEncryptedWire(undefined), false)
      assert.equal(isEncryptedWire(new ArrayBuffer(64)), false)
    })
  })
})
