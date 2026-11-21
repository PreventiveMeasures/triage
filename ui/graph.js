// The graph view: `<graph-layout>` (with its shadow CSS), the canvas logic
// and the selection-card, focus-overlay and top-packages templates, as an
// esbuild entry that view/graph-attach.js imports the first time a graph
// shows, so view.js doesn't carry them. The wrappers in render.js and
// render-bundle.js assemble `prep` and `ctx` from state and call in here.
import { render as litRender } from 'lit'
import './view/graph/graph-layout.js'
import { renderFocusOverlay, renderSelectionCard, renderTopPkgsBlock } from './view/graph/render.js'
import { buildGraph } from './view/graph/data.js'

export { attachGraph2Interaction } from './view/graph/canvas.js'

// The selection card and the canvas's focus overlay, which share the
// selection state (view/graph/state.js). `host` is the page's one
// `<graph-layout>` unless named: the lockfile viewer's is in its own shadow
// root (view/lockfile-graph.js).
export function refreshSidebar(prep, ctx, host = document.querySelector('graph-layout')) {
  const root = host?.shadowRoot
  if (!root) return
  const graph = buildGraphFromPrep(prep)
  const area = root.querySelector('#g2-selection-area')
  if (area) litRender(renderSelectionCard(graph, ctx), area)
  const focusSlot = root.querySelector('#g2-focus-overlay-slot')
  if (focusSlot) litRender(renderFocusOverlay(graph), focusSlot)
}

// The Top-packages block alone, as its Issues / Files tab flips, so the
// canvas's frame loop and hover survive.
export function refreshTopPkgs(prep, host = document.querySelector('graph-layout')) {
  const root = host?.shadowRoot
  if (!root) return
  const block = root.querySelector('#g2-top-pkgs-block')
  if (!block) return
  litRender(renderTopPkgsBlock(buildGraphFromPrep(prep)), block)
}

// `prep`, as buildGraph2Data / buildBundleGraphData assemble it; built here
// so data.js stays out of view.js. `strippedToOrig` (bundles) gives each
// node the unstripped path its "View source →" opens.
export function buildGraphFromPrep(prep) {
  const graph = buildGraph(prep.treeData, prep.files, prep.ownCounts, prep.transitiveCounts,
    prep.severitySets, prep.colorSets, prep.fileFindings, prep.options)
  if (prep.strippedToOrig) {
    for (const n of graph.nodes) n.origFile = prep.strippedToOrig.get(n.file)
  }
  // Gates the persisted Packages toggle (3+ packages, buildBundleGraphData),
  // so another bundle's setting can't switch this graph to packages.
  graph.canPackagesView = prep.canPackagesView ?? false
  // A lockfile's graph (lockfile-graph-inputs.js): its members are installed
  // copies, not files, so it stays at package level whatever the toggles say.
  graph.packagesOnly = prep.packagesOnly ?? false
  graph.supportsLayers = prep.supportsLayers ?? false
  graph.layerRoots = prep.layerRoots
  graph.flowEntries = prep.flowEntries
  graph.ownSourcePackages = prep.ownSourcePackages
  graph.entryPackages = prep.entryPackages
  graph.ownSourceFiles = prep.ownSourceFiles
  graph.reasons = prep.reasons ?? []
  // Issues off (or none matched): the shared severity and mark filters must
  // not dim nodes that carry no findings here.
  graph.issuesHidden = prep.issuesShown === false
  // The bundle's integrity, so a kept pan and zoom stays with its bundle.
  graph.viewId = prep.viewId ?? null
  return graph
}
