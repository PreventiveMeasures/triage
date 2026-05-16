// Passkey crypto — symmetric envelope round-trips. WebAuthn itself
// is not testable in node:test (no authenticator, no
// `navigator.credentials.create`); these tests cover the AES-GCM
// envelope + HKDF derivation that the vault layers stack on top of
// the WebAuthn PRF output. The PRF output is simulated with a
// 32-byte random buffer — semantically identical to what a real
// authenticator would return.

import './_polyfills.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  ENVELOPE_MAGIC,
  deriveContentKey,
  hasEnvelopeMagic,
  importContentKey,
  isPasskeySupported,
  openEnvelope,
  sealEnvelope,
} = await import('../client/passkey-crypto.ts')

function randomBytes(n) {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

async function freshKey() {
  const prf = randomBytes(32)
  const raw = await deriveContentKey(prf)
  return importContentKey(raw)
}

describe('passkey-crypto — envelope round-trip', () => {
  it('seals and opens with the same key + AAD', async () => {
    const key = await freshKey()
    const aad = new TextEncoder().encode('test.context.v1')
    const plaintext = new TextEncoder().encode('hello passkey world')
    const env = await sealEnvelope(key, plaintext, aad)
    assert.ok(hasEnvelopeMagic(env), 'sealed bytes start with the envelope magic')
    const out = await openEnvelope(key, env, aad)
    assert.deepEqual(out, plaintext, 'unwrap returns the original plaintext')
  })

  it('rejects open with the wrong AAD', async () => {
    const key = await freshKey()
    const aad = new TextEncoder().encode('right')
    const env = await sealEnvelope(key, new TextEncoder().encode('x'), aad)
    await assert.rejects(
      () => openEnvelope(key, env, new TextEncoder().encode('wrong')),
      /./u,
    )
  })

  it('rejects open with a different key', async () => {
    const a = await freshKey()
    const b = await freshKey()
    const aad = new TextEncoder().encode('ctx')
    const env = await sealEnvelope(a, new TextEncoder().encode('x'), aad)
    await assert.rejects(() => openEnvelope(b, env, aad), /./u)
  })

  it('rejects open when the magic is missing (legacy bytes leaked into the path)', async () => {
    const key = await freshKey()
    const aad = new TextEncoder().encode('ctx')
    const bogus = new Uint8Array([0x1f, 0x8b, 0x00, 0x00, 0x99, 0x99])
    await assert.rejects(
      () => openEnvelope(key, bogus, aad),
      /missing envelope magic/u,
    )
  })

  it('rejects open on too-short input', async () => {
    const key = await freshKey()
    const aad = new TextEncoder().encode('ctx')
    const tooShort = new Uint8Array([...ENVELOPE_MAGIC, 0x01, 0x02])
    await assert.rejects(
      () => openEnvelope(key, tooShort, aad),
      /envelope too short/u,
    )
  })

  it('produces a fresh nonce on each seal (no determinism leak)', async () => {
    const key = await freshKey()
    const aad = new TextEncoder().encode('ctx')
    const pt = new TextEncoder().encode('same plaintext')
    const a = await sealEnvelope(key, pt, aad)
    const b = await sealEnvelope(key, pt, aad)
    // The nonces are bytes 4..16 of the envelope; if they collide the
    // wire bytes are identical — that would be a catastrophic AES-GCM
    // misuse (key/nonce reuse breaks confidentiality + integrity).
    const nonceA = a.subarray(ENVELOPE_MAGIC.length, ENVELOPE_MAGIC.length + 12)
    const nonceB = b.subarray(ENVELOPE_MAGIC.length, ENVELOPE_MAGIC.length + 12)
    assert.notDeepEqual(nonceA, nonceB, 'random nonces should differ across two seals')
  })
})

describe('passkey-crypto — deriveContentKey', () => {
  it('produces a 32-byte output regardless of input length (≥32)', async () => {
    const small = await deriveContentKey(new Uint8Array(32).fill(7))
    const big = await deriveContentKey(new Uint8Array(64).fill(7))
    assert.equal(small.length, 32)
    assert.equal(big.length, 32)
  })

  it('rejects PRF output shorter than 32 bytes', async () => {
    await assert.rejects(
      () => deriveContentKey(new Uint8Array(16)),
      /too short/u,
    )
  })

  it('two different PRF outputs derive different content keys', async () => {
    const a = await deriveContentKey(randomBytes(32))
    const b = await deriveContentKey(randomBytes(32))
    assert.notDeepEqual(a, b)
  })

  it('same PRF output is deterministic (HKDF is a pure function)', async () => {
    const seed = randomBytes(32)
    const a = await deriveContentKey(seed.slice())
    const b = await deriveContentKey(seed.slice())
    assert.deepEqual(a, b)
  })
})

describe('passkey-crypto — magic sniff helper', () => {
  it('returns false for bytes too short to carry the magic', () => {
    assert.equal(hasEnvelopeMagic(new Uint8Array()), false)
    assert.equal(hasEnvelopeMagic(new Uint8Array([0x44, 0x56, 0x45])), false)
  })

  it('returns true for the exact magic prefix', () => {
    assert.equal(hasEnvelopeMagic(new Uint8Array([0x44, 0x56, 0x45, 0x31])), true)
    assert.equal(hasEnvelopeMagic(new Uint8Array([0x44, 0x56, 0x45, 0x31, 0xAB, 0xCD])), true)
  })

  it('returns false for gzip-shaped bytes (different magic)', () => {
    assert.equal(hasEnvelopeMagic(new Uint8Array([0x1f, 0x8b, 0x00, 0x00])), false)
  })
})

describe('passkey-crypto — environment probe', () => {
  it('isPasskeySupported() returns false in node (no PublicKeyCredential)', () => {
    assert.equal(isPasskeySupported(), false)
  })
})
