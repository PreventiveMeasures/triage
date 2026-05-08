// Brotli decompressor — no third-party dependencies. Tries each
// browser-native path, self-testing each one against a known
// brotli payload before declaring it usable:
//
//   1. `DecompressionStream('br')` / `'brotli'` — modern Chromium
//      ships native brotli on the streams API.
//   2. Cache API echo trick — `cache.put(req, new Response(bytes,
//      { headers: { 'Content-Encoding': 'br' } }))` followed by
//      `cache.match(req)`. Some browser versions run the
//      Content-Encoding decoder when the response is read out of
//      the Cache.
//   3. Service worker echo trick — POST the brotli bytes to the SW,
//      which echoes the body back with `Content-Encoding: br`. The
//      browser's HTTP-layer decoder runs on the response IF the
//      browser honors Content-Encoding from SW-constructed
//      responses (Chrome historically did; behavior has varied).
//
// Each path is verified with `selfTest`: a 1-byte brotli stream
// (0x06) that decodes to the empty string. If the path returns the
// input unchanged (echo without decoding), it gets dropped from
// the candidates. The first verified path wins.
//
// All three trigger the page's decoder pipeline through native
// browser APIs only — no JS or WASM brotli library is bundled.

let mode = null
let initPromise = null

// brotli-encoded empty string: WBITS=16 (`0`), ISLAST=1 (`1`),
// ISLASTEMPTY=1 (`1`), padded LSB-first → byte 0x06. Decodes to a
// zero-length Uint8Array on a working brotli pipeline; an echoing
// "decoder" returns the same 1 byte back.
const TEST_INPUT = new Uint8Array([0x06])

async function nativeAvailable() {
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

async function decompressViaCache(bytes) {
  const cache = await caches.open('deepview-brotli-decode')
  // Random URL so concurrent decodes don't collide on the same
  // cache key. Origin-relative so it stays within scope.
  const url = `${location.origin}/__brotli_${crypto.randomUUID()}__`
  const req = new Request(url)
  try {
    await cache.put(req, new Response(bytes, {
      headers: { 'Content-Encoding': 'br', 'Content-Type': 'application/octet-stream' },
    }))
    const cached = await cache.match(req)
    if (!cached) throw new Error('cache miss after put')
    return new Uint8Array(await cached.arrayBuffer())
  } finally {
    try { await cache.delete(req) } catch {}
  }
}

async function decompressViaSW(fetchUrl, bytes) {
  const response = await fetch(fetchUrl, { method: 'POST', body: bytes })
  if (!response.ok) throw new Error(`SW returned ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

async function selfTest(decompress) {
  try {
    const out = await decompress(TEST_INPUT)
    // A working decoder produces an empty result for the test input;
    // an echoing pipeline returns the 1-byte input verbatim.
    return out.byteLength === 0
  } catch {
    return false
  }
}

async function setupSW() {
  if (!('serviceWorker' in navigator)) return null
  try {
    const reg = await navigator.serviceWorker.register('brotli-sw.js')
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
        setTimeout(resolve, 1500)
      })
      if (!navigator.serviceWorker.controller) {
        // First-load registrations sometimes don't claim the page that
        // registered them; reload once so the SW controls from the
        // start. Session-flagged so a misbehaving SW can't reload-loop.
        const RELOAD_FLAG = 'deepview.brotli-sw-reloaded'
        if (!sessionStorage.getItem(RELOAD_FLAG)) {
          sessionStorage.setItem(RELOAD_FLAG, '1')
          location.reload()
          await new Promise(() => {})
        }
        sessionStorage.removeItem(RELOAD_FLAG)
        return null
      }
      sessionStorage.removeItem('deepview.brotli-sw-reloaded')
    }
    return new URL('__deepview_brotli__', reg.scope).toString()
  } catch (err) {
    console.warn('Brotli SW failed to register:', err)
    return null
  }
}

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
  // Native first — when available, we don't need either echo trick,
  // so any leftover SW from a prior session gets cleaned up.
  const nativeFormat = await nativeAvailable()
  if (nativeFormat && await selfTest((b) => decompressNative(nativeFormat, b))) {
    unregisterSW()
    mode = { kind: 'native', format: nativeFormat }
    return mode
  }
  // Cache API — works in some browsers, no SW needed.
  if ('caches' in window) {
    if (await selfTest(decompressViaCache)) {
      unregisterSW()
      mode = { kind: 'cache' }
      return mode
    }
  }
  // SW echo trick — last resort for older browsers.
  const swUrl = await setupSW()
  if (swUrl && await selfTest((b) => decompressViaSW(swUrl, b))) {
    mode = { kind: 'sw', fetchUrl: swUrl }
    return mode
  }
  // None of the native paths can actually decompress brotli on this
  // browser. Stasis bundles will show "contents not parsed" — the
  // user can still inspect the metadata + integrity.
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
  if (m.kind === 'cache') return decompressViaCache(bytes)
  if (m.kind === 'sw') return decompressViaSW(m.fetchUrl, bytes)
  throw new Error('Brotli decompression unavailable in this browser')
}

// Eager init at module-load — kicks off detection + cleanup +
// (lazy) SW registration without waiting for the first stasis
// bundle open. Errors are swallowed: callers handle "unsupported"
// via the throw above.
ensure().catch(() => {})
