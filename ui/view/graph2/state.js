// Graph v2 tab — mutable state. Mirrors graph/state.js: a single
// shared object the renderer + canvas + event handlers all read and
// mutate, plus a cleanup hook the canvas owns so re-attach can drop
// stale listeners and rAF callbacks.
//
// Most fields here back UI controls in the left/topbar panels: the
// segmented controls (layout, edge mode), the sliders (edge opacity /
// min degree / node size), the toggle rows (halos / hub highlight /
// labels / issues-only), the severity-row filter, and the palette
// solo / hidden + search state. Defaults are tuned to read well on
// the small typical DeepView graph (10–80 files) so the empty state
// is informative even before any user input.
export const graph2 = {
  selected: null,        // file path or null
  layoutMode: 'spiral',  // 'spiral' | 'force' | 'radial' | 'grid' | 'classic'
  edgeMode: 'all',       // 'all' | 'cross' | 'none'
  // Right-panel "Top packages" sort axis. Same role as graph v1's
  // hubs Issues/Imports tab — issues-first by default so the user
  // lands on the actionable list, files for "what's the codebase
  // shape" exploration.
  topPkgsTab: 'issues',  // 'issues' | 'files'
  edgeOpacity: 0.22,
  minDegree: 0,
  nodeSize: 1.0,
  showHalos: true,
  highlightHubs: true,
  showLabels: false,
  issuesOnly: false,
  // Severity filter — clicking a row in the Issues panel toggles its
  // entry; nodes whose top-severity isn't enabled drop out of the
  // canvas (and the issue counts).
  showIssues: { critical: true, high: true, medium: true, low: true },
  // Package palette — `hidden` is the user's hide selection, `solo`
  // limits to a single package. Search box drives the muted/visible
  // state of swatches but doesn't permanently hide them so clearing
  // restores the full set.
  hidden: new Set(),
  solo: null,
  paletteSearch: '',
  // Per-render canvas state — owned by canvas.js, re-built on every
  // attach. Cleanup tears down listeners + rAF + ResizeObserver.
  graphState: null,
  // forceLayout result cache, keyed off (treeData, files, layoutMode).
  // Recomputed when the user switches layouts or the underlying file
  // set changes (showAll on graph v1 invalidates v2's cache too via
  // cleanupGraph2 in events.js).
  layoutCache: null,
}

export function cleanupGraph2() {
  if (graph2.graphState?._cleanup) graph2.graphState._cleanup()
  graph2.graphState = null
}
