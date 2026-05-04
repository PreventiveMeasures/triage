// Mutable tree-tab state. Owned here, but writable from anywhere so
// outer click handlers / drop handlers can reset selection and discard
// the cached force layout when the active report changes.
//   showAll      — include clean files in the force graph (toolbar toggle)
//   selected     — currently-selected file in the right sidebar
//   layoutCache  — cached forceLayout result, keyed off (tree, showAll)
//   graphState   — per-render canvas state (nodes, edges, listeners)
export const tree = {
  showAll: false,
  selected: null,
  layoutCache: null,
  graphState: null,
}

// Tear down the active canvas's listeners + observers and forget the
// per-render state. Called whenever the report changes (drop / switch /
// delete) and from canvas.js before re-attaching.
export function cleanupGraphInteraction() {
  if (tree.graphState?._cleanupListeners) tree.graphState._cleanupListeners()
  tree.graphState = null
}
