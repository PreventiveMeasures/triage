// Coverage for the centralised UTF-8 helpers. Both
// `encodeUtf8` and `decodeUtf8` deliberately fail-fast on
// malformed input — the WHATWG defaults silently substitute
// U+FFFD, which would let a corrupted byte sequence sail past a
// JSON.parse (since `"<U+FFFD>"` is valid JSON) and end up
// stored / hashed / signed as a different string than the caller
// thought it produced.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeUtf8, encodeUtf8 } from '../common/utf8.js'

describe('encodeUtf8', () => {
  it('round-trips ASCII', () => {
    assert.deepEqual(encodeUtf8('hello'), new Uint8Array([104, 101, 108, 108, 111]))
  })

  it('round-trips multi-byte UTF-8', () => {
    // U+00E9 (é) → C3 A9; U+1F600 (😀) → F0 9F 98 80.
    const bytes = encodeUtf8('é😀')
    assert.deepEqual(bytes, new Uint8Array([0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80]))
  })

  it('throws on a non-string input', () => {
    assert.throws(() => encodeUtf8(42), /encodeUtf8 expects a string/u)
    assert.throws(() => encodeUtf8(null), /encodeUtf8 expects a string/u)
    assert.throws(() => encodeUtf8(new Uint8Array([1])), /encodeUtf8 expects a string/u)
  })

  it('throws on a lone surrogate', () => {
    // U+D83D without a trailing low-surrogate is malformed UTF-16.
    assert.throws(() => encodeUtf8('\uD83D'), /lone surrogates/u)
  })
})

describe('decodeUtf8', () => {
  it('round-trips ASCII', () => {
    assert.equal(decodeUtf8(new Uint8Array([104, 105])), 'hi')
  })

  it('round-trips multi-byte UTF-8', () => {
    const text = decodeUtf8(new Uint8Array([0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80]))
    assert.equal(text, 'é😀')
  })

  it('throws on invalid UTF-8 sequences (fatal mode)', () => {
    // 0xC3 0x28 — 0xC3 starts a 2-byte sequence but 0x28 is not a
    // valid continuation. Default decoder would silently substitute
    // U+FFFD; fatal mode throws.
    assert.throws(() => decodeUtf8(new Uint8Array([0xc3, 0x28])), TypeError)
    // Bare continuation byte.
    assert.throws(() => decodeUtf8(new Uint8Array([0x80])), TypeError)
    // Truncated 3-byte sequence.
    assert.throws(() => decodeUtf8(new Uint8Array([0xe2, 0x82])), TypeError)
  })

  it('round-trips through encode/decode', () => {
    const samples = ['plain', 'é', '中文', '😀 mixed 中 ascii', '']
    for (const s of samples) {
      assert.equal(decodeUtf8(encodeUtf8(s)), s)
    }
  })
})
