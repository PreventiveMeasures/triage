// Bundle-side wrapper tests: pins the user-facing error copy and the
// `isEncryptedBundle` re-export. The underlying primitive is covered
// in `password-crypto.test.js`.

import './_password-crypto-mock.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  decryptBundle,
  encryptBundle,
  isEncryptedBundle,
} = await import('../client/workspace-bundle-crypto.js')

function randomBytes(n) {
  const buf = new Uint8Array(n)
  crypto.getRandomValues(buf)
  return buf
}

// PBKDF2 (3M iterations) dominates per-test cost. WebCrypto runs
// derivations on libuv's threadpool, so parallel `it`s share up to
// UV_THREADPOOL_SIZE cores instead of serialising on one. Tests
// are independent — fresh ciphertext per test, no shared state.
describe('workspace-bundle-crypto', { concurrency: true }, () => {
  it('round-trips a gzipped-JSON-shaped payload through a password-encrypted bundle', async () => {
    const plaintext = randomBytes(4096)
    const password = 'correct horse battery staple'
    const wire = await encryptBundle(plaintext, password)
    assert.ok(wire instanceof Uint8Array)
    // version + salt + nonce + tag overhead; AES-GCM is length-preserving.
    assert.equal(wire.length, plaintext.length + 1 + 16 + 12 + 16)
    assert.equal(wire[0], 1)
    const decrypted = await decryptBundle(wire, password)
    assert.deepEqual(decrypted, plaintext)
  })

  it('rejects a wrong password with a friendly error', async () => {
    const wire = await encryptBundle(randomBytes(32), 'right password')
    await assert.rejects(
      () => decryptBundle(wire, 'wrong password'),
      /wrong password or corrupt bundle/u,
    )
  })

  it('rejects a malformed bundle (short / non-encrypted bytes)', async () => {
    await assert.rejects(
      () => decryptBundle(new Uint8Array([1, 2, 3]), 'pw'),
      /malformed encrypted bundle/u,
    )
    await assert.rejects(
      () => decryptBundle(new Uint8Array(0), 'pw'),
      /malformed encrypted bundle/u,
    )
  })

  it('maps a tampered version byte to the generic malformed error', async () => {
    const password = 'pw'
    const wire = await encryptBundle(randomBytes(32), password)
    wire[0] = 0xff
    await assert.rejects(
      () => decryptBundle(wire, password),
      /malformed encrypted bundle/u,
    )
  })

  it('rejects an encrypt call with an empty password', async () => {
    await assert.rejects(
      () => encryptBundle(randomBytes(8), ''),
      /password required/u,
    )
  })

  it('rejects an encrypt call without a Uint8Array plaintext', async () => {
    await assert.rejects(
      () => encryptBundle('not bytes', 'pw'),
      /plaintext Uint8Array required/u,
    )
  })

  it('produces a different ciphertext on each encrypt (random salt + nonce)', async () => {
    const plaintext = randomBytes(32)
    const password = 'pw'
    const a = await encryptBundle(plaintext, password)
    const b = await encryptBundle(plaintext, password)
    assert.notDeepEqual(a, b)
  })

  describe('isEncryptedBundle', () => {
    it('returns true for our own encrypted output', async () => {
      const wire = await encryptBundle(randomBytes(8), 'pw')
      assert.equal(isEncryptedBundle(wire), true)
    })

    it('returns false on a gzip magic-byte prefix (legacy plaintext export)', () => {
      const gzipMagic = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, ...Array.from({ length: 64 }, () => 0)])
      assert.equal(isEncryptedBundle(gzipMagic), false)
    })

    it('returns false on too-short buffers (no room for salt + nonce + tag)', () => {
      assert.equal(isEncryptedBundle(new Uint8Array(0)), false)
      assert.equal(isEncryptedBundle(new Uint8Array([0x01])), false)
      // 1 + 16 + 12 + 15 = 44 bytes — one byte short of a tag.
      assert.equal(isEncryptedBundle(new Uint8Array(44)), false)
    })

    it('returns false on a non-Uint8Array argument', () => {
      assert.equal(isEncryptedBundle(null), false)
      assert.equal(isEncryptedBundle(undefined), false)
      assert.equal(isEncryptedBundle(new ArrayBuffer(64)), false)
    })
  })
})
