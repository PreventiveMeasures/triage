// Brotli decompression fallback — loaded ONLY when the page hits a
// brotli payload AND the browser doesn't ship native
// `DecompressionStream('br')`. Built as a separate esbuild entry
// point so the foliojs `brotli` package (~200KB after minify, most
// of which is the static dictionary) doesn't land in the main
// view.js bundle and slow down the typical load that doesn't need
// it.
//
// This file is BOTH a worker script and an importable module:
//
//   * `view/brotli-decompress.js` normally runs it as a dedicated
//     worker (`new Worker(url, { type: 'module' })`). The foliojs
//     decoder is synchronous and spends seconds on a multi-MB
//     bundle, so decoding on the main thread freezes the tab —
//     no repaint, no input, no spinner — for the whole decode.
//     Off-thread it costs the main thread one message instead.
//   * The same module is `await import()`ed on the main thread as a
//     last resort, when no worker can be spawned (CSP, or a browser
//     that can't run module workers). It blocks there, but a frozen
//     tab still beats an unopenable bundle.
//
// Nothing here may touch the DOM or fetch anything: the worker's own
// response carries `default-src 'none'` (see server-e2e/static.ts),
// and esbuild bundles the decoder inline so the worker's module
// graph has no dependency to load.
import decompress from 'brotli/decompress'

export function brotliDecompress(bytes) {
  // foliojs/brotli exposes the decoder as a single function via the
  // `decompress` subpath (`module.exports = require('./dec/decode')
  // .BrotliDecompressBuffer`). It accepts a Uint8Array (or Buffer)
  // and returns a Uint8Array of the decompressed payload.
  return decompress(bytes)
}

// Worker mode. `WorkerGlobalScope` only exists inside a worker, so
// importing this module on the window side installs nothing.
//
// Protocol (the other half lives in `view/brotli-decompress.js`):
//   in   { id, bytes }           compressed payload
//   out  { id, bytes }           decoded, buffer transferred
//        { id, error: message }  the decoder threw — bad payload
if (globalThis.WorkerGlobalScope !== undefined && globalThis instanceof globalThis.WorkerGlobalScope) {
  globalThis.addEventListener('message', (event) => {
    const { id, bytes } = event.data ?? {}
    try {
      const decoded = brotliDecompress(bytes)
      // Transfer the decoded buffer rather than copying it: it's the
      // big one (bundles decode to tens of MB) and this side has no
      // further use for it. (The rule disabled below is thinking of
      // window.postMessage, whose second argument is a targetOrigin;
      // a worker's is the transfer list.)
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      globalThis.postMessage({ id, bytes: decoded }, [decoded.buffer])
    } catch (err) {
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      globalThis.postMessage({ id, error: err?.message ?? String(err) })
    }
  })
}
