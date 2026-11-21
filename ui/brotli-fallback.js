// Brotli decoder for browsers without native `DecompressionStream('br')`, an
// esbuild entry of its own so the foliojs decoder (~200KB) stays out of
// view.js. view/brotli-decompress.js runs it as a module worker, as decoding a
// multi-MB bundle synchronously freezes the tab for seconds; where no worker
// can run (CSP, no module workers) it imports it on the main thread instead.
//
// Nothing here may touch the DOM or fetch: the worker's response carries
// `default-src 'none'` (server-e2e/static.ts), which Firefox applies to its
// static imports too, so build.js bundles this file alone, decoder inline,
// and fails if the output imports anything.
import decompress from 'brotli/decompress'

export function brotliDecompress(bytes) {
  return decompress(bytes)
}

// In a worker only: `{ id, bytes }` in; `{ id, bytes }` (its buffer
// transferred) or `{ id, error }` out.
if (globalThis.WorkerGlobalScope !== undefined && globalThis instanceof globalThis.WorkerGlobalScope) {
  globalThis.addEventListener('message', (event) => {
    const { id, bytes } = event.data ?? {}
    try {
      const decoded = brotliDecompress(bytes)
      // A worker's second argument is the transfer list, not a targetOrigin.
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      globalThis.postMessage({ id, bytes: decoded }, [decoded.buffer])
    } catch (err) {
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      globalThis.postMessage({ id, error: err?.message ?? String(err) })
    }
  })
}
