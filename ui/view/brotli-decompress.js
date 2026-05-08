// Brotli decompressor with a graceful fallback chain:
//
//   1. Try DecompressionStream('br') / DecompressionStream('brotli')
//      — modern Chromium ships native brotli on the streams API.
//   2. If that throws, register `/brotli-sw.js` and pipe the bytes
//      through a service-worker fetch round-trip. The SW echoes the
//      POSTed body with `Content-Encoding: br`; the browser's HTTP
//      layer transparently decompresses brotli in response streams,
//      so the page-side `await fetch(...).arrayBuffer()` lands with
//      the decompressed bytes. This works in Firefox / Safari which
//      don't yet expose brotli through DecompressionStream.
//   3. If neither path is available (file:// origins, or browsers
//      without service workers), throw — callers degrade by showing
//      "contents not parsed in-browser" rather than crashing.
//
// On every module load we re-detect native support and either
// (re-)register the SW or, conversely, unregister a leftover one if
// a browser update has since landed native brotli. Detection runs
// once and the result is cached on `mode`.

let mode = null
let initPromise = null

function detectNative() {
  for (const fmt of ['br', 'brotli']) {
    try {
      // Constructing the stream throws synchronously on unsupported
      // formats — no need to actually pipe anything through it.
      // eslint-disable-next-line no-new
      new DecompressionStream(fmt)
      return fmt
    } catch {}
  }
  return null
}

async function unregisterBrotliSW() {
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
  const native = detectNative()
  if (native) {
    // Browser updated to native brotli — drop any SW left behind by
    // a previous session; once cleaned up, the page never touches
    // the SW path again on this load.
    await unregisterBrotliSW()
    mode = { kind: 'native', format: native }
    return mode
  }
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/brotli-sw.js', { scope: '/' })
      // `ready` resolves once the active SW for this scope is
      // controlling — we need that before the first fetch hits the
      // intercept path, otherwise the request misses the worker.
      await navigator.serviceWorker.ready
      mode = { kind: 'sw' }
      return mode
    } catch (err) {
      console.warn('Brotli SW failed to register:', err)
    }
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
  if (m.kind === 'native') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(m.format))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  if (m.kind === 'sw') {
    const response = await fetch('/__deepview_brotli__', {
      method: 'POST',
      body: bytes,
    })
    if (!response.ok) throw new Error(`Brotli SW returned ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }
  throw new Error('Brotli decompression unavailable in this browser')
}

// Eager init at module-load — kicks off detection + (un)registration
// without waiting for the first stasis bundle open. Errors are
// swallowed: callers handle "unsupported" via the throw above, and
// SW-register failures shouldn't crash the boot.
ensure().catch(() => {})
