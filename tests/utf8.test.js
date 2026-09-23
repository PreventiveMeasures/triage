// Coverage for the centralised UTF-8 helpers. Both
// `encodeUtf8` and `decodeUtf8` deliberately fail-fast on
// malformed input — the WHATWG defaults silently substitute
// U+FFFD, which would let a corrupted byte sequence sail past a
// JSON.parse (since `"<U+FFFD>"` is valid JSON) and end up
// stored / hashed / signed as a different string than the caller
// thought it produced.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeUtf8, encodeUtf8, utf8ByteLength } from '../common/utf8.js'

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

  // `report/src/utf8.js` carries a copy of this encoder — the library
  // imports nothing from outside its directory, so it holds the one
  // function it needs rather than reaching into `common/`. The copy is
  // only safe while the two behave identically: a fix made to one and
  // not the other would move the finding ids the library derives, which
  // is the whole reason its hashing goes through a checked encoder.
  //
  // The two are pinned to the same expectations rather than to each
  // other — this list and its bytes are asserted again, of the library's
  // copy, in `report/tests/utf8.test.js`. Neither suite imports the
  // other's module, so the library's stays runnable on its own; a change
  // to one encoder alone fails whichever suite it was not made in. Keep
  // the two lists in step.
  it('encodes the shared case list byte for byte', () => {
    const expected = new Map([
      ['', []],
      ['hello', [0x68, 0x65, 0x6c, 0x6c, 0x6f]],
      ['é😀', [0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80]],
      ['\u{FEFF}leading BOM', [0xef, 0xbb, 0xbf, 0x6c, 0x65, 0x61, 0x64, 0x69, 0x6e, 0x67, 0x20, 0x42, 0x4f, 0x4d]],
      ['a\0b', [0x61, 0x00, 0x62]],
      ['中文', [0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]],
      ['\u{10FFFF}', [0xf4, 0x8f, 0xbf, 0xbf]],
    ])
    for (const [input, bytes] of expected) {
      assert.deepEqual(encodeUtf8(input), new Uint8Array(bytes), JSON.stringify(input))
    }
  })

  it('rejects the shared reject list', () => {
    for (const bad of [42, null, undefined, new Uint8Array([1]), {}]) {
      assert.throws(() => encodeUtf8(bad), /encodeUtf8 expects a string/u, String(bad))
    }
    assert.throws(() => encodeUtf8('lone \uD800 surrogate'), /lone surrogates/u)
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

describe('utf8ByteLength', () => {
  const enc = new TextEncoder()

  it('agrees with TextEncoder on ASCII, Latin-1, wide, astral and malformed text', () => {
    // Latin-1 past \x7F is the case a width check alone gets wrong: it is
    // no wider than a byte per character to store, but two to encode.
    const cases = [
      '', 'hello', 'a\0b', '\u0080', '\u00FF', 'aé\u00FFb', 'x'.repeat(1000) + '©',
      '\u0100', '\u00FF\u0100', '—', '€', '中文', '\uFEFFbom',
      '😀', 'é😀', '\u{10FFFF}',
      // Lone and reversed surrogates count as the U+FFFD they encode to.
      '\uD83D', '\uDE00', '\uDE00\uD83D', 'a\uD83Db',
    ]
    for (const str of cases) assert.equal(utf8ByteLength(str), enc.encode(str).byteLength, JSON.stringify(str))
  })

  it('reads a string the same whichever way the engine stores it', () => {
    // A slice of a two-byte string can hold only Latin-1 while stored two
    // bytes per character; its size must not depend on that.
    const latin = `${'é'.repeat(100)}—`.slice(0, 100)
    assert.equal(utf8ByteLength(latin), 200)
    const ascii = `${'a'.repeat(100)}—`.slice(0, 100)
    assert.equal(utf8ByteLength(ascii), 100)
  })

  it('counts high characters wherever they fall, however many there are', () => {
    // First, last and only character; dense and sparse Latin-1. The count
    // starts at the first one the scan finds.
    // Gaps either side of the run of ASCII after which the count hands back
    // to the scan, so both the loop and the jump land on every one.
    const gaps = [0, 1, 2, 3, 4, 31, 32, 33, 100].map((n) => `${'a'.repeat(n)}é`.repeat(50))
    for (const str of ['é', 'éabc', 'abcé', `é${'a'.repeat(1000)}ü`, 'é'.repeat(100_000), 'aé'.repeat(50_000), `${'a'.repeat(1000)}\u00A0`, ...gaps, gaps.join('')]) {
      assert.equal(utf8ByteLength(str), enc.encode(str).byteLength, `${str.length} chars from ${JSON.stringify(str.slice(0, 8))}`)
    }
  })

  it('is the length of a string that is all ASCII', () => {
    const src = 'export const a = 1 // plain\n'.repeat(1000)
    assert.equal(utf8ByteLength(src), src.length)
  })

  it('rejects a non-string', () => {
    assert.throws(() => utf8ByteLength(null), /utf8ByteLength expects a string/u)
    assert.throws(() => utf8ByteLength(new Uint8Array(1)), /utf8ByteLength expects a string/u)
  })
})
