// Pin the v1 canonical formulas so any change is conscious.
// Touching the canonical bytes / domain string / AAD shape here
// means a v2 bump, not an in-place edit — `client/sync-crypto.js`
// has the implementation, this file is the contract.

import './_polyfills.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Buffer } from 'node:buffer'
import { encodeUtf8 } from '../common/utf8.js'

const { computeRevisionId, buildAad, verifySavePayload } = await import('../client/sync/sync-crypto.ts')

async function sha256b64url(str) {
  const digest = await crypto.subtle.digest('SHA-256', encodeUtf8(str))
  return Buffer.from(new Uint8Array(digest)).toString('base64url')
}

describe('triage-sync v1 canonical formulas (golden)', () => {
  // Re-build the canonical save payload in the test by hand, then
  // assert computeRevisionId produces the matching hash. If
  // canonicalSavePayload in sync-crypto.js drifts (field order,
  // separator, domain string, what's signed, keyframe encoding),
  // this fails — and the signal is "bump to v2", not "edit this
  // expectation".
  it('save canonical: <domain>\\n<pk>\\n<base>\\n<keyframe>\\n<nonce>\\n<ciphertext>', async () => {
    const input = {
      publicKeyB64: 'pk-fixture',
      base: 'base-fixture',
      keyframe: false,
      nonceB64: 'nonce-fixture',
      ciphertextB64: 'ct-fixture',
    }
    const expected = await sha256b64url([
      'deepview-triage-sync.v1.save',
      input.publicKeyB64,
      input.base,
      // keyframe = false → empty
      '',
      input.nonceB64,
      input.ciphertextB64,
    ].join('\n'))
    assert.equal(await computeRevisionId(input), expected)
  })

  it('save canonical: null base encodes as "" and keyframe=true encodes as "1"', async () => {
    const input = {
      publicKeyB64: 'pk',
      base: null,
      keyframe: true,
      nonceB64: 'n',
      ciphertextB64: 'c',
    }
    const expected = await sha256b64url(
      ['deepview-triage-sync.v1.save', 'pk', '', '1', 'n', 'c'].join('\n'),
    )
    assert.equal(await computeRevisionId(input), expected)
  })

  it('save canonical: keyframe is STRICT === true, not truthy', async () => {
    // Truthy non-boolean values (e.g. `keyframe: 1` from a buggy
    // sender) hash as the EMPTY string, identical to `false`.
    // The server's storage path uses `=== true`, so the canonical
    // and the storage MUST agree on what counts as a keyframe —
    // otherwise a malformed save can land in the chain unreadable
    // to peers (sig fails on the receive side because the wire
    // flag canonicalises differently from what the sender signed).
    const truthy = await computeRevisionId({
      publicKeyB64: 'pk',
      base: null,
      keyframe: 1,
      nonceB64: 'n',
      ciphertextB64: 'c',
    })
    const explicitFalse = await computeRevisionId({
      publicKeyB64: 'pk',
      base: null,
      keyframe: false,
      nonceB64: 'n',
      ciphertextB64: 'c',
    })
    const explicitTrue = await computeRevisionId({
      publicKeyB64: 'pk',
      base: null,
      keyframe: true,
      nonceB64: 'n',
      ciphertextB64: 'c',
    })
    assert.equal(truthy, explicitFalse, 'non-boolean truthy hashes as `false`')
    assert.notEqual(truthy, explicitTrue, 'non-boolean truthy is NOT a keyframe')
  })

  it('AAD: `<workspaceTag>|<base>` with empty string for null base', () => {
    assert.deepEqual(buildAad('TAG', null), encodeUtf8('TAG|'))
    assert.deepEqual(buildAad('TAG', 'rev-id'), encodeUtf8('TAG|rev-id'))
  })
})

// Round-12 H9 regression: `verifySavePayload` used to call
// `Uint8Array.fromBase64(signatureB64)` outside its try / catch.
// A peer or relay-supplied non-base64 signature string threw
// SyntaxError instead of returning `false`, propagating up out of
// `applyChainToBase` mid-loop and leaving session.baseState /
// baseRevision partially advanced — the captured user overlay
// was lost for that round and the structured recovery path never
// ran. Fix wraps the entire verify (including base64 decode +
// canonical-payload encode) in one try / catch.
describe('verifySavePayload — must not throw on malformed inputs (round-12 H9)', () => {
  // 32-byte zero pubkey — valid Ed25519 length but `verify` will
  // reject. The point of this test is that no path THROWS; either
  // returns false (any rejection) or true (would need a real key).
  const zeroPubkey = new Uint8Array(32)
  const validPayload = {
    publicKeyB64: 'pk',
    base: null,
    keyframe: false,
    nonceB64: 'n',
    ciphertextB64: 'c',
  }

  it('returns false on a malformed (non-base64) signature string', async () => {
    const result = await verifySavePayload(zeroPubkey, validPayload, '!!!not-base64!!!')
    assert.equal(result, false, 'non-base64 signature surfaces as a clean reject')
  })

  it('returns false on a non-string signature', async () => {
    const result = await verifySavePayload(zeroPubkey, validPayload, /* @ts-ignore */ 42)
    assert.equal(result, false, 'non-string signature surfaces as a clean reject')
  })

  it('returns false on a signature whose decoded length is wrong', async () => {
    // 16 bytes (base64url) — valid base64 but wrong length for Ed25519.
    const tooShort = Buffer.from(new Uint8Array(16)).toString('base64url')
    const result = await verifySavePayload(zeroPubkey, validPayload, tooShort)
    assert.equal(result, false, 'wrong-length signature surfaces as a clean reject')
  })

  it('returns false when canonical payload encoding throws (lone surrogate)', async () => {
    // `encodeUtf8` inside `canonicalSavePayload` throws on a lone
    // surrogate. Pre-fix that throw escaped verifySavePayload; now
    // the outer try / catch catches it.
    const sig = Buffer.from(new Uint8Array(64)).toString('base64url')
    const result = await verifySavePayload(zeroPubkey, {
      ...validPayload,
      ciphertextB64: '\uD83D',  // unpaired high-surrogate
    }, sig)
    assert.equal(result, false, 'canonical encode throw surfaces as a clean reject')
  })
})
