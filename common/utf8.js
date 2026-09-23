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
// `ignoreBOM: true` keeps a leading U+FEFF (EF BB BF in UTF-8)
// in the output as a regular character. The default
// `ignoreBOM: false` *strips* a leading BOM, which is invisible
// at the call site but breaks byte-exact round-trips: encoding
// the decoded string would not reproduce the original bytes,
// and any downstream hash / sig / storage compare would mismatch.
// We treat the BOM as data — callers that want it stripped can
// do so explicitly.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function encodeUtf8(str) {
  if (typeof str !== 'string') {
    throw new TypeError(`encodeUtf8 expects a string, got ${typeof str}`)
  }
  if (!str.isWellFormed()) {
    throw new TypeError('encodeUtf8: input contains lone surrogates')
  }
  return encoder.encode(str)
}

// ASCII characters in a row after which the count hands back to the
// native scan. A jump costs a call and a step does not, so it pays only
// across a real gap: at 1, alternating text (`aéaé…`) takes a jump per
// character, and past 2, text with an accent every few words steps
// through ASCII the scan crosses faster. Measured on 50 MB of each, 2 was
// never more than 1.5x the best of the thresholds tried, 1 to 32.
const ASCII_RUN = 2

// The number of bytes `str` takes in UTF-8, without encoding it where
// that can be helped. A string with no character past \xFF is Latin-1:
// ASCII takes a byte and \x80-\xFF two, so its size is its length plus
// its high characters. An engine stores such a string a byte per
// character, where no character past \xFF can be, so the first test is
// answered without reading it. Only a string with a wider character is
// encoded to be measured.
//
// The high characters are counted without collecting them: a match array
// takes an entry apiece, which for Latin-1-heavy text outweighs the
// encoding this avoids. A native scan jumps to the next one — for ASCII
// it finds none — and a loop counts on from there while they keep coming,
// handing back to the scan after a run of ASCII. Sparse text is read
// natively, dense text by the loop, and neither allocates.
//
// This sizes text for display, so unlike `encodeUtf8` it does not refuse
// a lone surrogate: it counts the U+FFFD that TextEncoder writes for one.
export function utf8ByteLength(str) {
  if (typeof str !== 'string') {
    throw new TypeError(`utf8ByteLength expects a string, got ${typeof str}`)
  }
  // Code units, not code points: a `u` regexp reads a two-byte string by
  // code point, several times slower, and a surrogate is past \xFF either way.
  // eslint-disable-next-line require-unicode-regexp
  if (/[\u0100-\uFFFF]/.test(str)) return encoder.encode(str).byteLength
  const high = /[\u0080-\u00FF]/gu
  let bytes = str.length
  while (high.test(str)) {
    let i = high.lastIndex - 1
    for (let ascii = 0; i < str.length && ascii < ASCII_RUN; i++) {
      if (str.codePointAt(i) > 0x7F) { bytes++; ascii = 0 } else ascii++
    }
    high.lastIndex = i
  }
  return bytes
}

export function decodeUtf8(bytes) {
  // Reject non-BufferSource so a missed destructure / optional field /
  // misnamed property surfaces here instead of silently defaulting to
  // `decoder.decode(undefined)` → `""`. The empty string then JSON-
  // parses to `""` and hashes to the empty-string digest — exactly
  // the "fail late" class of bug this module exists to prevent.
  // Mirrors `encodeUtf8`'s explicit type-check.
  if (!ArrayBuffer.isView(bytes) && !(bytes instanceof ArrayBuffer)) {
    throw new TypeError(`decodeUtf8 expects a BufferSource, got ${bytes === null ? 'null' : typeof bytes}`)
  }
  return decoder.decode(bytes)
}
