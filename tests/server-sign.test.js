// `server/sign.js` direct unit tests. The end-to-end paths through
// `verifySaveSigAndCanonical` / `verifySubscribeSig` /
// `computeRevisionIdFromCanonical` are exercised via
// `tests/sync-server.test.js` (full WS round-trips) and the wire-
// format goldens in `tests/sync-crypto-v1.test.js`. This file
// targets the module's negative paths (bad shape / wrong key /
// length-precheck) and the content-addressed-id contract so a
// regression in any one branch surfaces here, without standing up
// the WS server.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Buffer } from 'node:buffer'
import { encodeUtf8 } from '../common/utf8.js'
import {
  computeRevisionIdFromCanonical,
  verifySaveSigAndCanonical,
  verifySubscribeSig,
} from '../server/sign.js'

const SAVE_DOMAIN = 'deepview-triage-sync.v1.save'
const SUBSCRIBE_DOMAIN = 'deepview-triage-sync.v1.subscribe'

function b64url(bytes) { return Buffer.from(bytes).toString('base64url') }

async function makeKp() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { sk: kp.privateKey, tag: b64url(Buffer.from(jwk.x, 'base64url')) }
}

function canonicalSaveBytes({ tag, base, keyframe, nonce, ciphertext }) {
  return encodeUtf8([
    SAVE_DOMAIN,
    tag,
    base == null ? '' : String(base),
    keyframe === true ? '1' : '',
    nonce,
    ciphertext,
  ].join('\n'))
}

function canonicalSubscribeBytes({ tag, from, nonce }) {
  return encodeUtf8([SUBSCRIBE_DOMAIN, tag, from == null ? '' : String(from), nonce].join('\n'))
}

async function signSaveMsg(sk, fields) {
  const canon = canonicalSaveBytes(fields)
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sk, canon))
  return b64url(sig)
}

async function signSubscribeMsg(sk, fields) {
  const canon = canonicalSubscribeBytes(fields)
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sk, canon))
  return b64url(sig)
}

describe('verifySaveSigAndCanonical', () => {
  it('returns ok=true and the exact canonical bytes on a valid save', async () => {
    const { sk, tag } = await makeKp()
    const nonce = b64url(new Uint8Array(12))
    const ciphertext = b64url(new TextEncoder().encode('payload'))
    const signature = await signSaveMsg(sk, { tag, base: null, keyframe: false, nonce, ciphertext })
    const msg = { workspaceTag: tag, base: null, nonce, ciphertext, signature }
    const { ok, canonical } = await verifySaveSigAndCanonical(msg)
    assert.equal(ok, true)
    assert.ok(canonical instanceof Uint8Array, 'canonical bytes returned')
    // The canonical the verify checked is the same the caller would
    // reconstruct — pin the bytes so a future divergence between
    // server-side and shared canonical breaks here.
    const expected = canonicalSaveBytes({ tag, base: null, keyframe: false, nonce, ciphertext })
    assert.deepEqual(canonical, expected)
  })

  it('binds keyframe into the canonical (true → "1", missing → "")', async () => {
    const { sk, tag } = await makeKp()
    const nonce = b64url(new Uint8Array(12))
    const ciphertext = b64url(new TextEncoder().encode('payload'))
    // Sign as keyframe=true; verify accepts only when the wire flag
    // matches.
    const signature = await signSaveMsg(sk, { tag, base: null, keyframe: true, nonce, ciphertext })
    const okMsg = { workspaceTag: tag, base: null, keyframe: true, nonce, ciphertext, signature }
    const goodResult = await verifySaveSigAndCanonical(okMsg)
    assert.equal(goodResult.ok, true)
    // Same signature, wire flag flipped — verify must fail. Otherwise
    // the server could promote / demote keyframes after the fact.
    const flipped = { ...okMsg, keyframe: false }
    const badResult = await verifySaveSigAndCanonical(flipped)
    assert.equal(badResult.ok, false)
    assert.equal(badResult.canonical, null)
  })

  it('rejects a non-string signature without throwing', async () => {
    const { tag } = await makeKp()
    const msg = {
      workspaceTag: tag, base: null,
      nonce: b64url(new Uint8Array(12)),
      ciphertext: b64url(new Uint8Array(8)),
      signature: 42,
    }
    const result = await verifySaveSigAndCanonical(msg)
    assert.equal(result.ok, false)
    assert.equal(result.canonical, null)
  })

  it('rejects a signature with the wrong byte length (length precheck)', async () => {
    const { tag } = await makeKp()
    const nonce = b64url(new Uint8Array(12))
    const ciphertext = b64url(new Uint8Array(8))
    // 32 bytes instead of 64 — the length precheck inside
    // verifyEd25519 rejects without invoking SubtleCrypto.
    const signature = b64url(new Uint8Array(32))
    const msg = { workspaceTag: tag, base: null, nonce, ciphertext, signature }
    const result = await verifySaveSigAndCanonical(msg)
    assert.equal(result.ok, false)
  })

  it('rejects a workspaceTag whose decoded length is not 32 bytes', async () => {
    // Decoded pubkey length must be 32 for Ed25519. A short / long
    // tag fails the length precheck without invoking SubtleCrypto's
    // import.
    const shortTag = b64url(new Uint8Array(16))
    const sig = b64url(new Uint8Array(64))
    const msg = {
      workspaceTag: shortTag, base: null,
      nonce: b64url(new Uint8Array(12)),
      ciphertext: b64url(new Uint8Array(8)),
      signature: sig,
    }
    const result = await verifySaveSigAndCanonical(msg)
    assert.equal(result.ok, false)
  })

  it('rejects a workspaceTag containing lone surrogates (canonical encode throws)', async () => {
    // A tag containing a lone surrogate would make `encodeUtf8`
    // throw inside `canonicalSave`; the wrapper catches and returns
    // ok=false instead of crashing the handler.
    const sig = b64url(new Uint8Array(64))
    const msg = {
      workspaceTag: '\uD83D', base: null,
      nonce: b64url(new Uint8Array(12)),
      ciphertext: b64url(new Uint8Array(8)),
      signature: sig,
    }
    const result = await verifySaveSigAndCanonical(msg)
    assert.equal(result.ok, false)
  })

  it('rejects a save signed by a different keypair', async () => {
    // Forgery attempt: attacker signs a payload claiming the
    // victim's tag. The signature verifies against the attacker's
    // pubkey, NOT the victim's — so verifySaveSigAndCanonical with
    // the victim's tag (= victim's pubkey) returns ok=false.
    const victim = await makeKp()
    const attacker = await makeKp()
    const nonce = b64url(new Uint8Array(12))
    const ciphertext = b64url(new Uint8Array(8))
    const signature = await signSaveMsg(attacker.sk, {
      tag: victim.tag, base: null, keyframe: false, nonce, ciphertext,
    })
    const msg = { workspaceTag: victim.tag, base: null, nonce, ciphertext, signature }
    const result = await verifySaveSigAndCanonical(msg)
    assert.equal(result.ok, false)
  })
})

describe('computeRevisionIdFromCanonical', () => {
  it('returns base64url SHA-256 (43 chars, no padding) of the input', async () => {
    const canonical = encodeUtf8('hello world')
    const id = await computeRevisionIdFromCanonical(canonical)
    // SHA-256 → 32 bytes → 43 base64url chars (no padding).
    assert.equal(id.length, 43)
    assert.match(id, /^[A-Za-z0-9_-]{43}$/u)
    // Spot-check against a known SHA-256: hex
    // b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    // Convert the canonical hash result independently:
    const expected = await crypto.subtle.digest('SHA-256', canonical)
    assert.equal(id, Buffer.from(new Uint8Array(expected)).toString('base64url'))
  })

  it('produces distinct ids for distinct inputs', async () => {
    const a = await computeRevisionIdFromCanonical(encodeUtf8('a'))
    const b = await computeRevisionIdFromCanonical(encodeUtf8('b'))
    assert.notEqual(a, b)
  })

  it('produces the same id for byte-equal inputs', async () => {
    const a = await computeRevisionIdFromCanonical(encodeUtf8('same'))
    const b = await computeRevisionIdFromCanonical(encodeUtf8('same'))
    assert.equal(a, b)
  })
})

describe('verifySubscribeSig', () => {
  const NONCE_A = 'nonce-A-aaaaaaaa'
  const NONCE_B = 'nonce-B-bbbbbbbb'

  it('returns true on a valid subscribe signature', async () => {
    const { sk, tag } = await makeKp()
    const signature = await signSubscribeMsg(sk, { tag, from: null, nonce: NONCE_A })
    const msg = { workspaceTag: tag, from: null, signature }
    assert.equal(await verifySubscribeSig(msg, NONCE_A), true)
  })

  it('returns false synchronously for a non-string signature', async () => {
    const { tag } = await makeKp()
    const result = verifySubscribeSig({ workspaceTag: tag, from: null, signature: null }, NONCE_A)
    // Sync false (not a Promise); awaiting a non-thenable yields the value.
    assert.equal(result, false)
  })

  it('returns false for a signature with wrong byte length', async () => {
    const { tag } = await makeKp()
    const signature = b64url(new Uint8Array(32))
    const msg = { workspaceTag: tag, from: null, signature }
    assert.equal(await verifySubscribeSig(msg, NONCE_A), false)
  })

  it('returns false when signed against a different `from` cursor', async () => {
    // Replay-resistance: a captured subscribe sig for from=X can't
    // be reused for from=Y (the canonical bytes differ).
    const { sk, tag } = await makeKp()
    const signature = await signSubscribeMsg(sk, { tag, from: 'cursor-A', nonce: NONCE_A })
    const replayed = { workspaceTag: tag, from: 'cursor-B', signature }
    assert.equal(await verifySubscribeSig(replayed, NONCE_A), false)
  })

  it('returns false when verified against a different connection nonce (audit round-9 H2)', async () => {
    // Cross-connection replay protection: a captured subscribe sig
    // signed under the originating connection's nonce can't be
    // replayed against a different connection (which has a
    // different nonce).
    const { sk, tag } = await makeKp()
    const signature = await signSubscribeMsg(sk, { tag, from: null, nonce: NONCE_A })
    const msg = { workspaceTag: tag, from: null, signature }
    assert.equal(await verifySubscribeSig(msg, NONCE_B), false,
      'replay against a different nonce fails verify')
  })

  it('returns false when no connection nonce is supplied', async () => {
    const { sk, tag } = await makeKp()
    const signature = await signSubscribeMsg(sk, { tag, from: null, nonce: NONCE_A })
    const msg = { workspaceTag: tag, from: null, signature }
    assert.equal(await verifySubscribeSig(msg, undefined), false)
    assert.equal(await verifySubscribeSig(msg, null), false)
  })

  it('returns false when the subscribe was signed by a different keypair', async () => {
    const victim = await makeKp()
    const attacker = await makeKp()
    const signature = await signSubscribeMsg(attacker.sk, { tag: victim.tag, from: null, nonce: NONCE_A })
    const msg = { workspaceTag: victim.tag, from: null, signature }
    assert.equal(await verifySubscribeSig(msg, NONCE_A), false)
  })

  it('returns false when workspaceTag contains lone surrogates', async () => {
    const signature = b64url(new Uint8Array(64))
    const msg = { workspaceTag: '\uD83D', from: null, signature }
    assert.equal(await verifySubscribeSig(msg, NONCE_A), false)
  })
})

describe('domain separation', () => {
  it('a subscribe signature does NOT verify as a save (and vice versa)', async () => {
    // Different domain prefixes (`v1.save` vs `v1.subscribe`) keep
    // a captured signature from being replayed across message
    // types. Pin the cross-replay rejection.
    const { sk, tag } = await makeKp()
    const NONCE = 'shared-nonce'
    const subSig = await signSubscribeMsg(sk, { tag, from: null, nonce: NONCE })
    // Build a save message that reuses the subscribe signature.
    const nonce = b64url(new Uint8Array(12))
    const ciphertext = b64url(new Uint8Array(8))
    const fakeSave = {
      workspaceTag: tag, base: null, nonce, ciphertext, signature: subSig,
    }
    const saveResult = await verifySaveSigAndCanonical(fakeSave)
    assert.equal(saveResult.ok, false)

    // Reverse: a save signature shouldn't verify as a subscribe.
    const saveSig = await signSaveMsg(sk, { tag, base: null, keyframe: false, nonce, ciphertext })
    const fakeSub = { workspaceTag: tag, from: null, signature: saveSig }
    assert.equal(await verifySubscribeSig(fakeSub, NONCE), false)
  })
})
