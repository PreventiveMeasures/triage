// Lazy loader for the graph view, as terminal-attach.js's: a runtime-string
// import keeps `<graph-layout>`, its CSS and the canvas logic out of
// view.js, fetched and parsed once.

import { html, render as litRender } from 'lit'

let loadPromise = null
// The module once loaded, for the synchronous refreshes (render.js,
// render-bundle.js) to dispatch to; null till the graph first opens, when
// there is nothing to refresh.
let loaded = null

export function loadedGraphMod() { return loaded }

export function loadGraph() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    // A variable, so esbuild leaves it to the browser, which resolves it
    // against the page URL.
    const path = './graph.js'
    try {
      const mod = await import(path)
      loaded = mod
      return mod
    } catch (err) {
      // Not pinned to a rejection: the next attach retries.
      loadPromise = null
      throw err
    }
  })()
  return loadPromise
}

// A `<graph-layout>` mounted into `slot` for `prep` (what buildGraph2Data /
// buildBundleGraphData assemble; the lazy module builds the graph), the
// sidebar and top-packages refreshed once its shadow tree renders, then the
// canvas's hover, pan and zoom wired. The host, or null where the module
// failed to load, said in the slot.
export async function attachGraphLayout(slot, prep, options, refreshSidebar, refreshTopPkgs) {
  try {
    const mod = await loadGraph()
    const graph = mod.buildGraphFromPrep(prep)
    litRender(html`<graph-layout .graph=${graph} .options=${options}></graph-layout>`, slot)
    const host = slot.querySelector('graph-layout')
    // Lit's first render is a microtask later: the refreshes and the canvas
    // read its shadow tree.
    await host.updateComplete
    refreshSidebar()
    refreshTopPkgs()
    mod.attachGraph2Interaction(slot, graph, refreshSidebar, refreshTopPkgs)
    return host
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    slot.textContent = `Graph failed to load: ${msg}`
    return null
  }
}
