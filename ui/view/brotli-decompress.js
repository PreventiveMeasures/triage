// Brotli decompressor — native first, with a lazy-loaded JS
// fallback for browsers that don't ship brotli on the streams API.
//
//   1. `DecompressionStream('br')` / `'brotli'` — modern Chromium
//      (138+) ships brotli natively. No extra cost on those
//      browsers.
//   2. `brotli-fallback.js` — a separate bundler entry point that
//      bundles the foliojs `brotli` decoder (~200KB after minify).
//      Pulled in via `await import('./brotli-fallback.js')` only
//      when the page actually hits a brotli payload AND native
//      detection failed; the import is a runtime string + the
//      `@vite-ignore` annotation so the bundler doesn't statically
//      resolve it into the main bundle, the browser resolves it
//      against the page URL.
//
// Older revisions of this module experimented with a SW Content-
// Encoding echo trick and a Cache API echo trick. Both returned the
// bytes unchanged in modern browsers (the response decoder runs
// only on real network responses), so they were dropped.
// `unregisterSW()` still runs on every init so any leftover
// `/brotli-sw.js` registration from those revisions is cleaned up.

let mode = null
let initPromise = null
let fallbackPromise = null

function nativeAvailable() {
  for (const fmt of ['br', 'brotli']) {
    try {
      // eslint-disable-next-line no-new
      new DecompressionStream(fmt)
      return fmt
    } catch {}
  }
  return null
}

async function decompressNative(format, bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// Drop any leftover `/brotli-sw.js` registration from a prior
// revision that tried the echo-trick fallback. Idempotent — does
// nothing when no such SW is registered. Always awaited from init
// so callers don't observe the SW lingering in DevTools.
async function unregisterSW() {
  if (!('serviceWorker' in navigator)) return
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    for (const reg of regs) {
      const url = reg.active?.scriptURL ?? reg.installing?.scriptURL ?? reg.waiting?.scriptURL
      if (url && url.endsWith('/brotli-sw.js')) await reg.unregister()
    }
  } catch {}
}

function loadFallback() {
  if (fallbackPromise) return fallbackPromise
  fallbackPromise = (async () => {
    // The path is held in a variable + the `@vite-ignore` annotation
    // tells the bundler to leave this dynamic import alone — that
    // keeps `brotli-fallback.js` (and the foliojs/brotli decoder it
    // pulls in) out of the main view.js bundle. The browser resolves
    // the URL relative to the page, so it works at any deploy path
    // (root or subdirectory).
    const path = './brotli-fallback.js'
    return await import(/* @vite-ignore */ path)
  })()
  return fallbackPromise
}

async function init() {
  // Always cleanup leftover SW first so a non-functional registration
  // from an earlier deploy is dropped regardless of which mode this
  // load picks. Cheap when there's nothing to unregister.
  await unregisterSW()
  const format = nativeAvailable()
  if (format) {
    mode = { kind: 'native', format }
    return mode
  }
  mode = { kind: 'fallback' }
  return mode
}

function ensure() {
  if (initPromise) return initPromise
  initPromise = init()
  return initPromise
}

export async function brotliDecompress(bytes) {
  const m = await ensure()
  if (m.kind === 'native') return decompressNative(m.format, bytes)
  // Fallback path: lazy-load the JS decoder bundle on first use.
  // Subsequent calls share the same promise so the bundle only
  // downloads + parses once per session.
  const fallback = await loadFallback()
  return fallback.brotliDecompress(bytes)
}

// Eager init at module-load — runs the SW cleanup + native
// detection without waiting for the first stasis bundle open. Does
// NOT pre-load the fallback bundle: that only happens on demand
// when a brotli payload actually needs decompressing.
ensure().catch(() => {})
