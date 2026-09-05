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
import { encodeUtf8 as encodeUtf8Report } from '../report/utf8.js'

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

  it('throws on non-BufferSource inputs (audit round-11 F2)', () => {
    // `TextDecoder.prototype.decode`'s argument is optional and
    // defaults to an empty buffer, so without an explicit type
    // check `decodeUtf8(undefined)` (missed destructure, optional
    // field, misnamed property) silently returns `""` — which then
    // JSON.parses to `""` and hashes to the empty-string digest.
    // Mirror `encodeUtf8`'s fail-fast contract.
    assert.throws(() => decodeUtf8(undefined), /decodeUtf8 expects a BufferSource, got undefined/u)
    assert.throws(() => decodeUtf8(null), /decodeUtf8 expects a BufferSource, got null/u)
    assert.throws(() => decodeUtf8(), /decodeUtf8 expects a BufferSource, got undefined/u)
    assert.throws(() => decodeUtf8('plain string'), /decodeUtf8 expects a BufferSource, got string/u)
    assert.throws(() => decodeUtf8(42), /decodeUtf8 expects a BufferSource, got number/u)
    assert.throws(() => decodeUtf8({}), /decodeUtf8 expects a BufferSource, got object/u)
    assert.throws(() => decodeUtf8([0x68, 0x69]), /decodeUtf8 expects a BufferSource, got object/u)
  })

  it('accepts both Uint8Array and bare ArrayBuffer', () => {
    // The TextDecoder API documents both as valid BufferSources.
    // Pin both so the type-check above doesn't accidentally tighten
    // beyond the helper's contract.
    assert.equal(decodeUtf8(new Uint8Array([104, 105])), 'hi')
    const buf = new Uint8Array([104, 105]).buffer
    assert.equal(decodeUtf8(buf), 'hi')
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

  it('preserves a leading BOM (ignoreBOM: true)', () => {
    // EF BB BF is the UTF-8 encoding of U+FEFF. The default decoder
    // strips it; we want byte-exact round-trips so callers can
    // hash / sign / compare without an invisible-character mismatch.
    const withBom = decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))
    assert.equal(withBom, '﻿hi')
    assert.equal(withBom.length, 3, 'BOM is included as a regular character')
    // Encode round-trip preserves the BOM bytes.
    assert.deepEqual(encodeUtf8(withBom), new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))
  })

  it('preserves a mid-string U+FEFF as ZWNBSP', () => {
    // A U+FEFF that isn't at offset 0 is unambiguously data
    // (ZERO WIDTH NO-BREAK SPACE) and the default decoder leaves
    // it alone too — pinned here for completeness.
    const text = decodeUtf8(new Uint8Array([0x68, 0xef, 0xbb, 0xbf, 0x69]))
    assert.equal(text, 'h﻿i')
  })
})

// `report/utf8.js` is the report library's own copy of the encoder: the
// library imports nothing from outside its directory, so it carries the
// one function it needs rather than reaching into `common/`. The copy
// is only safe while the two behave identically — a fix made to one and
// not the other would move the finding ids the library derives, which
// is the whole reason its hashing goes through a checked encoder.
describe('report/utf8.js — the library\'s copy', () => {
  const CASES = ['', 'hello', 'é😀', '\u{FEFF}leading BOM', 'a\0b', '中文', '\u{10FFFF}']

  it('encodes byte for byte what common/utf8.js encodes', () => {
    for (const input of CASES) {
      assert.deepEqual(encodeUtf8Report(input), encodeUtf8(input), JSON.stringify(input))
    }
  })

  it('rejects what common/utf8.js rejects', () => {
    for (const bad of [42, null, undefined, new Uint8Array([1]), {}]) {
      assert.throws(() => encodeUtf8Report(bad), /encodeUtf8 expects a string/u, String(bad))
    }
    assert.throws(() => encodeUtf8Report('lone \uD800 surrogate'), /lone surrogates/u)
  })
})
