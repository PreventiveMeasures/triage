// Brotli decompressor — native browsers only, no third-party
// dependencies. Modern Chromium (138+) ships brotli on the streams
// API as `DecompressionStream('br')` / `'brotli'`. Earlier browsers
// have no native path: the SW Content-Encoding echo trick and the
// Cache API echo trick BOTH return the bytes unchanged (the
// browser's response-decoder pipeline only runs on real network
// responses, not on SW- or Cache-constructed ones), and we don't
// ship a JS/WASM brotli decoder. Stasis bundles on those browsers
// show "contents not parsed" via the unsupported branch — the
// user can still inspect the bundle's metadata + integrity.
//
// Older revisions of this module experimented with both echo tricks
// and registered a service worker (`/brotli-sw.js`) for the SW
// path. The SW is no longer used; `unregisterSW()` runs on every
// init so any leftover registration from those revisions is
// cleaned up regardless of which mode this load lands in.

let mode = null
let initPromise = null

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
  mode = { kind: 'unsupported' }
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
  throw new Error('Brotli decompression unavailable in this browser')
}

// Eager init at module-load — runs the SW cleanup + native
// detection without waiting for the first stasis bundle open.
// Errors are swallowed: callers handle "unsupported" via the throw
// above.
ensure().catch(() => {})
