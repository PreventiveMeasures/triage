// UTF-8 encoding for the id hashing, and the library's own copy of it.
//
// `common/utf8.js` is the app's — same encoder, plus the decoding half
// this directory has no use for. The duplication is deliberate: nothing
// under `report/` imports from outside it, so the library can be lifted
// into another project (or published on its own) without dragging a
// `common/` along for one function. `tests/utf8.test.js` pins the two
// copies to the same behaviour, so a fix to either is caught if it
// isn't made to both.
//
// Centralised rather than reaching for `new TextEncoder().encode(...)`
// at the call site, because the WHATWG encoder silently replaces lone
// surrogates with U+FFFD. That is fine for best-effort display and a
// footgun anywhere the bytes feed a hash: the string the hasher
// actually saw is no longer recoverable from the one we thought we
// produced, and the finding id that comes out is stable but wrong.
// Failing fast surfaces that at the call site instead of as a finding
// whose id nothing else derives.
//
// The TextEncoder instance is reused — the spec guarantees it is
// stateless across `.encode()` calls.

const encoder = new TextEncoder()

export function encodeUtf8(str) {
  if (typeof str !== 'string') {
    throw new TypeError(`encodeUtf8 expects a string, got ${typeof str}`)
  }
  if (!str.isWellFormed()) {
    throw new TypeError('encodeUtf8: input contains lone surrogates')
  }
  return encoder.encode(str)
}
