// Brotli decompression hack via service worker — for browsers
// without DecompressionStream('br'). The fetch handler intercepts
// POST requests to `/__deepview_brotli__`, echoes the posted body
// back as the response, and stamps `Content-Encoding: br` on the
// reply. The browser's HTTP layer then auto-decompresses brotli
// inside the response stream — so the page-side fetch resolves with
// the decompressed bytes even when the JS-level DecompressionStream
// API can't handle the format.
//
// Registered by view/brotli-decompress.js only when native brotli
// is missing; that module also unregisters this SW if a future
// browser update lands native support.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.pathname !== '/__deepview_brotli__') return
  event.respondWith((async () => {
    const buf = await event.request.arrayBuffer()
    return new Response(buf, {
      headers: {
        'Content-Encoding': 'br',
        'Content-Type': 'application/octet-stream',
      },
    })
  })())
})
