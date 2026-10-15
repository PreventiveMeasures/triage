// Bundles of their own that view.js and client-managed.js load on first use
// (ui/scan.js, ui/compare.js), the pattern of graph-attach.js and
// terminal-attach.js: the path is a runtime string, so esbuild leaves the
// import to the browser, which resolves it beside the bundle at any deploy
// path. Built with view.js, such a bundle takes lit and the client state from
// the same chunks, and so the same instances. Each is fetched and parsed once;
// a failed load is forgotten, so the next use retries rather than replay a
// transient failure.
export function lazyEntry(path) {
  let promise = null
  const entry = {
    // The module once loaded, for callers that can't wait for it.
    module: null,
    load() {
      promise ??= import(path).then(module => (entry.module = module), err => { promise = null; throw err })
      return promise
    },
  }
  return entry
}
