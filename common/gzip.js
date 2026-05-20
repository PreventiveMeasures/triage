// Gzip helpers built on the platform CompressionStream /
// DecompressionStream. Centralised so the half-dozen call sites
// (storage, triage / workspace export + import, sync-crypto) share
// one implementation of the Blob → stream → Response plumbing instead
// of hand-copying it. Bytes in / bytes out is the primitive; the text
// helpers run the bytes through `common/utf8.js` so the same
// fatal-on-invalid / BOM-preserving decode rules apply everywhere.
//
// `deflate` (raw, no gzip framing) is intentionally NOT covered here —
// `triage.js` uses it for its own at-rest blob and must stay distinct
// from the gzip-magic sniffing the bundles / import paths rely on.

import { decodeUtf8, encodeUtf8 } from './utf8.js'

export async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function gzipText(text) {
  return await gzipBytes(encodeUtf8(text))
}

export async function gunzipToText(bytes) {
  return decodeUtf8(await gunzipBytes(bytes))
}
