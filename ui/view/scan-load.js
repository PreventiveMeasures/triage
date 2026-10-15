// Lazy loader for Scans, the pattern of `./graph-attach.js`: a runtime-string
// dynamic import keeps the shared scan page (`<deepview-scan-page>`, its model
// picker, regime editor and report inputs) and the local host's
// `<local-scan-page>` out of view.js and client-managed.js until Scans opens.
// Both hosts share one promise, so ui/scan.js is downloaded + parsed once.

let loadPromise = null

export function loadScanPage() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    // Held in a variable so esbuild can't resolve it statically; the browser
    // resolves it beside the bundle, at any deploy path.
    const path = './scan.js'
    try {
      return await import(path)
    } catch (err) {
      // Retry from scratch next time rather than replay a transient failure.
      loadPromise = null
      throw err
    }
  })()
  return loadPromise
}
