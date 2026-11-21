// The graph view's mutable state, shared by the renderer, the canvas and the
// event handlers, plus the canvas attachment's cleanup hook.
export const graph2 = {
  // "All files": include files without own or subtree findings.
  showAll: false,
  // "Packages": one node per package, edges aggregated from cross-package
  // imports. Bundle Graph layout only, engaged when the bundle has 3+
  // packages (`canPackagesView`, see buildBundleGraphData).
  packagesView: false,
  // The same switch for Dependencies (small bundles start at file level,
  // larger ones always aggregate) and for Size flow.
  dependencyPackagesView: false,
  flowPackagesView: false,
  // The bundle graph's "Issues" switch, offered when findings matched the
  // bundle: off, it opens as a plain map of the code.
  bundleIssues: false,
  bundleLayout: 'graph', // 'graph' | 'layers' | 'matrix' | 'dependencies' | 'flow' | 'package-flow'; bundle-only
  // The layout lockfiles open on (lockfile-graph.js), apart from the bundle
  // graph's: Dependencies, then the last one picked. The lockfile viewer
  // draws by bundleLayout while it is on the page, and gives it back after.
  lockfileLayout: 'dependencies',
  bundleReason: null, // null = all files, else a scope's id (bundleScopes); shared by graph and layers
  bundleReasonFor: null, // bundle integrity; reset selection on bundle changes
  selected: null,        // file path or null
  // The package drawn alone, file by file (null for the whole graph); reset
  // on a report swap and by the back button.
  focusedPkg: null,
  topPkgsTab: 'issues',  // the Packages list's axis: 'issues' | 'files' | 'size'
  // Severity and mark-color highlights: empty for none, else nodes with a
  // finding of a selected value stay at full opacity (both filters
  // AND-combined, as in the findings tab) and the rest dim.
  selectedSeverities: new Set(),
  selectedColors: new Set(),
  // Path / package substring filter, case-insensitive; non-matching nodes dim.
  pathFilter: '',
  // A package hide-set nothing adds to (ingest.js clears it).
  hidden: new Set(),
  // The package picked in the Packages list: a filter in the file views, the
  // selection at package altitude.
  solo: null,
  // The canvas attachment's live handle ({ requestDraw, _cleanup }), rebuilt
  // on every attach.
  graphState: null,
  // Positions keyed by (file set, size, focus, packages view); the "All
  // files" toggle clears it along with the canvas.
  layoutCache: null,
  // Pan and zoom handed from one canvas attachment to the next for the same
  // view (cleanupGraph2's keepViewport), consumed by that attach.
  keptViewport: null,
}

// `keepViewport`: the next attachment of the SAME view (see
// attachGraph2Interaction) takes over this one's pan and zoom instead
// of refitting. Only a re-attach of the graph on screen asks for it;
// every other teardown (layout, Packages, focus, reason, navigation)
// refits as before.
export function cleanupGraph2({ keepViewport = false } = {}) {
  if (graph2.graphState?._cleanup) graph2.graphState._cleanup({ keepViewport })
  else if (!keepViewport) graph2.keptViewport = null
  graph2.graphState = null
}
