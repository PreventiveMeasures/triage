// Type declarations for `common/utf8.js`. Hand-written to keep
// `tsc --noEmit` (server-only type-lint) from needing `allowJs:
// true` to traverse the JS source — the helpers' contracts are
// small enough that the .d.ts is the cleanest way to expose them.

// `Uint8Array<ArrayBuffer>` (not the default `Uint8Array<ArrayBufferLike>`)
// because the helper feeds WebCrypto / signature paths that reject
// SharedArrayBuffer-backed views via `BufferSource =
// NonSharedArrayBufferView | ArrayBuffer`. Node's `TextEncoder`
// always allocates a regular `ArrayBuffer` at runtime, so the
// narrower declaration is safe.
export function encodeUtf8(str: string): Uint8Array<ArrayBuffer>
export function decodeUtf8(bytes: Uint8Array | ArrayBuffer | ArrayBufferView): string
