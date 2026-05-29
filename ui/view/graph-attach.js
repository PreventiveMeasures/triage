// Lazy loader for the graph view. Mirrors the terminal pattern in
// `./terminal-attach.js`: a runtime-string dynamic import keeps
// the `<graph-layout>` LitElement (and its ~37 KB inlined CSS
// bundle) plus `canvas.js`'s ~33 KB of hover / pan / zoom logic
// out of the main view.js bundle. First call kicks the fetch;
// subsequent calls share the same promise so graph.js is
// downloaded + parsed once per session.

import { html, render as litRender } from 'lit'
import { _currentImpl as _mainGraph2Impl } from './graph/state.js'

let loadPromise = null
// Resolved module reference, cached after the first successful
// `loadGraph()` so synchronous callers (the refresh wrappers in
// `view/render.js` / `view/render-bundle.js`, fired from
// `events.js` click handlers) can dispatch without awaiting. `null`
// means the graph has never been opened this session — those
// callers no-op, fine since there's no graph DOM to refresh anyway.
let loaded = null

export function loadedGraphMod() { return loaded }

function loadGraph() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    // Path held in a variable so esbuild can't statically resolve
    // it — keeps `ui/graph.js` (and the LitElement + shadow CSS +
    // canvas modules it transitively pulls in) out of the main
    // bundle. Browser resolves relative to the page URL, so this
    // works at any deploy path.
    const path = './graph.js'
    try {
      const mod = await import(path)
      // Cross-bundle sharing — point the lazy `graph2` proxy at
      // the main bundle's live `_impl` so subsequent reads/writes
      // on either side touch the same underlying object. Without
      // this, events.js mutations (severity chips, path filter,
      // showAll, selection) would never reach the canvas.
      mod._swapGraph2Impl(_mainGraph2Impl())
      loaded = mod
      return mod
    } catch (err) {
      // Don't pin the module to a rejected promise — a transient
      // failure (offline at first attach, stale service-worker
      // cache, etc.) would otherwise make every future call replay
      // the same rejection forever. Reset so the next attach
      // retries the import from scratch.
      loadPromise = null
      throw err
    }
  })()
  return loadPromise
}

// Mount a `<graph-layout>` host into `slot`, wait for its shadow
// tree to render, then call the two refresh callbacks (sidebar +
// top-pkgs slots) before wiring canvas hover / pan / zoom. The
// canvas's per-click sidebar refresh is bound to `refreshSidebar`
// so node selections re-paint the selection card in place.
//
// `prep` is the raw-inputs shape `buildGraph2Data` /
// `buildBundleGraphData` assemble from main-bundle state
// (`state.reports` / `state.bundleDetails`). The lazy module's
// `buildGraphFromPrep(prep)` does the actual `buildGraph(...)`
// call — keeps the graph-data assembly out of the main bundle.
//
// Returns the host element on success, or null on a module-load
// failure (with the error text written into the slot so the user
// sees what went wrong instead of an empty panel).
export async function attachGraphLayout(slot, prep, options, refreshSidebar, refreshTopPkgs) {
  try {
    const mod = await loadGraph()
    const graph = mod.buildGraphFromPrep(prep)
    litRender(html`<graph-layout .graph=${graph} .options=${options}></graph-layout>`, slot)
    const host = slot.querySelector('graph-layout')
    // Lit's first render is microtask-async, so the shadow tree
    // isn't populated the microtask the parent template stamps
    // the host. Wait for the host's pending update to complete
    // before the refresh helpers (which `querySelector` into the
    // shadow root) and the canvas attach (which expects
    // `#g2-canvas` to exist) try to read it.
    await host.updateComplete
    refreshSidebar()
    refreshTopPkgs()
    mod.attachGraph2Interaction(slot, graph, refreshSidebar)
    return host
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    slot.textContent = `Graph failed to load: ${msg}`
    return null
  }
}
