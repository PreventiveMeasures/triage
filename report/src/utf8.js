// UTF-8 encoding for the id hashing — a copy of the app's
// `common/utf8.js` minus its decoding half, since nothing under
// `report/` imports from outside it. Both copies' tests assert the same
// cases byte for byte.
//
// Centralised rather than `new TextEncoder().encode(...)` per call site,
// because the WHATWG encoder silently replaces lone surrogates with
// U+FFFD: fine for display, a footgun where the bytes feed a hash, where
// the id comes out stable but hashed from a string nobody meant.

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
