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

// `maxBytes` (optional) caps the DECOMPRESSED size: gzip expands up to
// ~1032:1, so a small hostile payload can balloon to GiBs and OOM the
// process before any content validation runs. Callers decompressing
// peer-controlled bytes (sync-crypto's inbound changesets) pass a cap;
// the read then aborts with a throw the moment the budget is crossed,
// instead of materialising the full expansion. Uncapped callers keep
// the one-shot Response read.
export async function gunzipBytes(bytes, { maxBytes } = {}) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  if (maxBytes == null) return new Uint8Array(await new Response(stream).arrayBuffer())
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      // Cancel so the DecompressionStream stops inflating the rest.
      try { await reader.cancel() } catch {}
      throw new Error(`gunzipBytes: decompressed size exceeds ${maxBytes}-byte cap`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export async function gzipText(text) {
  return await gzipBytes(encodeUtf8(text))
}

export async function gunzipToText(bytes) {
  return decodeUtf8(await gunzipBytes(bytes))
}
