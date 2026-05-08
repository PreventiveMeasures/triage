// Brotli decompression fallback — loaded ONLY when the page hits a
// brotli payload AND the browser doesn't ship native
// `DecompressionStream('br')`. Built as a separate esbuild entry
// point so the foliojs `brotli` package (~200KB after minify, most
// of which is the static dictionary) doesn't land in the main
// view.js bundle and slow down the typical load that doesn't need
// it. `view/brotli-decompress.js` `await import('./brotli-fallback.js')`s
// this file lazily on first use; the dynamic import URL is a
// runtime string so esbuild leaves it alone and the browser
// resolves it against the page's URL.
import decompress from 'brotli/decompress'

export function brotliDecompress(bytes) {
  // foliojs/brotli exposes the decoder as a single function via the
  // `decompress` subpath (`module.exports = require('./dec/decode')
  // .BrotliDecompressBuffer`). It accepts a Uint8Array (or Buffer)
  // and returns a Uint8Array of the decompressed payload.
  return decompress(bytes)
}
