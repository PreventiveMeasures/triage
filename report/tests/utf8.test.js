// `report/src/utf8.js` — the library's own UTF-8 encoder, the one every
// finding id is hashed through (finding-id.js).
//
// A COPY of the app's `common/utf8.js` encoder, and so is this suite a
// copy of the encode half of the app's `tests/utf8.test.js`. The
// duplication is the point: nothing under `report/` imports from
// outside it, so the library can be lifted into another project — or
// published on its own — without dragging a `common/` along for one
// function, and it has to be able to prove its own encoder correct
// without reaching for the app's either.
//
// The two copies are pinned to the same expectations rather than to
// each other: the byte arrays below are the ones `tests/utf8.test.js`
// asserts of `common/utf8.js`, written out again here. A fix made to
// one encoder and not the other fails whichever suite it was not made
// in — which matters more here than anywhere, since a change to what
// these bytes are moves every finding id the library derives.
//
// Fail-fast is the whole reason the function exists: `TextEncoder`
// silently replaces a lone surrogate with U+FFFD, which is fine for
// display and a footgun feeding a hash — the string the hasher saw is
// no longer recoverable from the one the caller thought it produced,
// and the id that comes out is stable but wrong.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { encodeUtf8 } from '../src/utf8.js'

describe('encodeUtf8 — the library\'s copy', () => {
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

  // The cases the app's suite compared the two copies over, kept as the
  // shared list so neither side loses one silently. A BOM is DATA here
  // (the decoder half keeps it too), a NUL is a character like any
  // other, and U+10FFFF is the last code point there is.
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
