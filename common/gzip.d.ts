// Type declarations for `common/gzip.js`. Hand-written so `tsc
// --noEmit` can resolve the helpers from `.ts` callers without
// `allowJs`. Returns are `Uint8Array<ArrayBuffer>` (not the default
// `ArrayBufferLike`) because callers feed the bytes into WebCrypto /
// AEAD paths that reject SharedArrayBuffer-backed views — same
// narrowing rationale as `common/utf8.d.ts`.

export function gzipBytes(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
// `maxBytes` caps the decompressed size (throws past it) — for callers
// decompressing peer-controlled bytes; omit for trusted/local data.
export function gunzipBytes(bytes: Uint8Array, opts?: { maxBytes?: number }): Promise<Uint8Array<ArrayBuffer>>
export function gzipText(text: string): Promise<Uint8Array<ArrayBuffer>>
export function gunzipToText(bytes: Uint8Array): Promise<string>
