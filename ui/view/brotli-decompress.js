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
      // Relative URL — the SW file lives next to the loaded page,
      // so a subdirectory install (e.g. /foo/view.html) registers
      // /foo/brotli-sw.js with scope /foo/. Hard-coding `/brotli-
      // sw.js` would only work at the origin root.
      const reg = await navigator.serviceWorker.register('brotli-sw.js')
      await navigator.serviceWorker.ready
      // `ready` resolves once an active SW exists for this scope,
      // but on FIRST registration the page that registered the
      // worker often isn't actually CONTROLLED by it — clients.claim()
      // is meant to take over existing clients but doesn't always
      // fire `controllerchange` on the page that registered the
      // worker (browser quirk; reproducible on GitHub Pages).
      // Until controller is set, fetches bypass the SW and the
      // server's static handler answers — which on GH Pages means a
      // 405 for POST.
      //
      // Strategy: wait briefly for `controllerchange`; if we time
      // out without a controller, reload the page ONCE — after the
      // reload the SW is already active for the scope and the new
      // page document loads as controlled from the very start. A
      // sessionStorage flag prevents a reload-loop in the case
      // where the SW never manages to control (e.g. an unsupported
      // browser environment); the second pass falls through to
      // 'unsupported' rather than reloading again.
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
          setTimeout(resolve, 1500)
        })
        if (!navigator.serviceWorker.controller) {
          const RELOAD_FLAG = 'deepview.brotli-sw-reloaded'
          if (!sessionStorage.getItem(RELOAD_FLAG)) {
            sessionStorage.setItem(RELOAD_FLAG, '1')
            location.reload()
            // Park forever — the reload is in flight.
            await new Promise(() => {})
          }
          // Already reloaded once and still no controller — give up
          // gracefully so callers (stasis details parsing) fall back
          // to "contents not parsed" rather than hanging on a SW
          // that's not actually intercepting. Clear the flag so a
          // future visit can retry the bootstrap.
          sessionStorage.removeItem(RELOAD_FLAG)
          mode = { kind: 'unsupported' }
          return mode
        }
        // Successful claim — clear the flag so it doesn't carry
        // forward into other browsing sessions if the user happens
        // to share a tab.
        sessionStorage.removeItem('deepview.brotli-sw-reloaded')
      }
      // Build the intercept URL from the SW's scope so the fetch
      // lands inside it. `reg.scope` is an absolute URL ending in
      // `/` (e.g. `https://app.example.com/foo/`).
      const fetchUrl = new URL('__deepview_brotli__', reg.scope).toString()
      mode = { kind: 'sw', fetchUrl }
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
    // `m.fetchUrl` is anchored at the SW's scope, which tracks the
    // install path — so subdirectory deployments hit the right
    // intercept URL without further config.
    const response = await fetch(m.fetchUrl, {
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
