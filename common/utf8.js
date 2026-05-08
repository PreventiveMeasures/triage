// UTF-8 helpers. Centralised so callers don't reach for
// `new TextEncoder().encode(...)` directly — the WHATWG encoder
// silently replaces lone surrogates with U+FFFD, which is fine for
// best-effort display but a footgun anywhere the bytes feed into a
// hash, AEAD, signature, or storage round-trip (the input the
// signer / hasher actually saw is no longer recoverable from the
// string we thought we'd encoded). `encodeUtf8` rejects lone
// surrogates up front via `String.prototype.isWellFormed()`, so
// that class of bug surfaces as an explicit throw at the call
// site rather than as a downstream verification mismatch.
//
// The TextEncoder instance is reused — the spec guarantees it's
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
