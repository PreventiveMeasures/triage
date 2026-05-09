// UTF-8 helpers. Centralised so callers don't reach for
// `new TextEncoder().encode(...)` / `new TextDecoder().decode(...)`
// directly — the WHATWG encoder silently replaces lone surrogates
// with U+FFFD, and the default decoder silently replaces invalid
// byte sequences the same way. Either is fine for best-effort
// display but a footgun anywhere the bytes feed into a hash, AEAD,
// signature, JSON parse, or storage round-trip (the input the
// signer / parser / hasher actually saw is no longer recoverable
// from the string we thought we'd produced). Both helpers fail
// fast with an explicit throw, so that class of bug surfaces at
// the call site rather than as a downstream verification mismatch
// or a silently-corrupted JSON parse.
//
// The TextEncoder / TextDecoder instances are reused — the spec
// guarantees both are stateless across `.encode()` / `.decode()`
// calls (with the default `stream: false`).

const encoder = new TextEncoder()
// `fatal: true` makes `decode()` throw a TypeError on invalid
// UTF-8 instead of substituting U+FFFD. Every call site here
// either feeds the result into JSON.parse (where U+FFFD would
// usually but not always provoke a parse error — `"�"` is
// valid JSON, so a corrupted string field would silently survive)
// or stores it; in both cases we want to know about the
// corruption immediately.
const decoder = new TextDecoder('utf-8', { fatal: true })

export function encodeUtf8(str) {
  if (typeof str !== 'string') {
    throw new TypeError(`encodeUtf8 expects a string, got ${typeof str}`)
  }
  if (!str.isWellFormed()) {
    throw new TypeError('encodeUtf8: input contains lone surrogates')
  }
  return encoder.encode(str)
}

export function decodeUtf8(bytes) {
  return decoder.decode(bytes)
}
