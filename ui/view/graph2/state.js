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
  // Package focus mode — when set, the canvas drops the spiral
  // and renders ONLY this package's intra-imports in graph v1
  // style (single hue, arrowheads, file labels). null = full
  // graph; reset on report swap and on the back-button click.
  focusedPkg: null,
  // Right-panel "Top packages" sort axis. Same role as graph v1's
  // hubs Issues/Imports tab — issues-first by default so the user
  // lands on the actionable list, files for "what's the codebase
  // shape" exploration.
  topPkgsTab: 'issues',  // 'issues' | 'files'
  // Collapsed state for right-panel sections. Display starts
  // collapsed because most users don't tweak edge opacity / node
  // size on every visit; surfacing the controls behind a click
  // shrinks the panel's idle vertical footprint.
  displayCollapsed: true,
  edgeOpacity: 0.22,
  minDegree: 0,
  nodeSize: 1.0,
  showHalos: true,
  highlightHubs: true,
  showLabels: false,
  // Severity highlight filter — empty = no filter, every node
  // draws at full opacity (the default). When 1+ severities are
  // selected, matching nodes stay full opacity and everything
  // else dims to 0.1; the previous boolean-per-severity model
  // and the standalone "Show only issues" toggle both collapse
  // into this single set (selecting all four = the old
  // issues-only behavior, automatically).
  selectedSeverities: new Set(),
  // Path-substring filter. Empty = no filter. Non-empty =
  // case-insensitive substring match; non-matching nodes
  // dim to 0.1 (same soft-dim path as solo / severity).
  pathFilter: '',
  // Package solo — narrows the canvas highlight to a single
  // package via the Top-packages list click. `hidden` is a
  // legacy hide-set that nothing currently writes to, kept as
  // an empty Set so nodeVisible can still read it without an
  // undefined check.
  hidden: new Set(),
  solo: null,
  // Per-render canvas state — owned by canvas.js, re-built on every
  // attach. Cleanup tears down listeners + rAF + ResizeObserver.
  graphState: null,
  // Layout result cache, keyed off (mode, files, w, h).
  // Recomputed when the user switches layouts or the underlying file
  // set changes (showAll on graph v1 invalidates v2's cache too via
  // cleanupGraph2 in events.js).
  layoutCache: null,
}

export function cleanupGraph2() {
  if (graph2.graphState?._cleanup) graph2.graphState._cleanup()
  graph2.graphState = null
}
