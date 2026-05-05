// Centralised mutable view state. Every module that reads or writes
// shared state imports this object and accesses fields directly —
// `state.reports`, `state.currentView = 'tree'`, etc. Keeping it as a
// single object means we never have to chase scattered `let` bindings
// across modules (ES module live bindings are read-only from outside,
// so cross-module assignment would otherwise need setter functions).
//
// Tree-tab state lives separately in `./graph/state.js` because it has
// its own teardown semantics tied to the canvas lifecycle.
export const state = {
  // Exactly one OPFS-backed report is active at a time — the sidebar
  // switches between them; merging is gone. Headless callers
  // (`window.__loadFile` from src/print.js) bypass OPFS and may call
  // `ingestReport` repeatedly, in which case `reports` does accumulate
  // (the print pipeline still merges that way). The renderer is shape-
  // agnostic.
  reports: [],
  // Currently-displayed OPFS basename, or null when nothing is loaded
  // (drop zone visible). Tracked separately from `reports` so the
  // sidebar can highlight the active file even before render finishes.
  currentFile: null,
  // Top-level tab — 'findings' (default), 'tree' (force-directed graph
  // with file info sidebar), or 'files' (the per-file cards listing).
  // Tree / files tabs are only visible when the loaded report carries
  // a `tree` block with more than one file; switching files / loading
  // a tree-less report auto-falls back to 'findings' inside render().
  currentView: 'findings',
  // Severity + color filters are multi-select: empty Set = "no filter,
  // show everything" (selecting every option individually is equivalent
  // — the predicate passes when every finding's value is in the Set).
  // UI-wise each .stat card toggles membership independently; no single
  // "all" sentinel. `filterColors` stores mark colors
  // (`red|blue|green|gray`) plus the literal `'none'` for unmarked
  // findings.
  filterSeverities: new Set(),
  filterColors: new Set(),
  filterSource: 'all',
  filterConfMin: 8,
  filterConfMax: '',
  filterInclude: '',
  filterExclude: '',
  repoUrl: '',
  sortBy: 'file',
  // Display toggle — orthogonal to filters (doesn't affect which
  // findings show), so it's outside resetFilters; a filter reset or a
  // new report drop doesn't wipe it. Default off for a denser view;
  // flip on to inspect the source-hash provenance.
  showMetadata: false,
  // `groupByFile` true (default) renders findings under per-file
  // headers — the original behavior. When false, every dedup group
  // renders flat in sort order with its own location label above it
  // (file path + line), so the reader can scan results across files in
  // pure severity/confidence/file order without the file-header chrome.
  // Only meaningful in viewMode='list' — table view is always flat.
  groupByFile: true,
  // 'list' (default) renders the full per-finding card with badges,
  // confidence value, full description, recommendation, etc. 'table'
  // renders one compact 2-row block per finding (severity/title/type
  // on top, conf/file/actions below, plus a tab strip if multi-tab) —
  // never grouped by file, regardless of groupByFile.
  viewMode: 'list',
  // Per-finding manual annotations. Keyed by `tabKey(f)` =
  // `f.id ?? String(f._id)`: the export's derived uuid when available
  // (persists across reloads via localStorage), else a session-local
  // numeric id (session-only). uuid-shaped keys round-trip through a
  // single `deepview.triage` localStorage entry; numeric-_id keys do
  // not. Both PER-TAB (per individual finding even within a dedup
  // group). Group-level rollup is computed on demand in groupState().
  markers: new Map(),
  deletedIds: new Set(),
  showDeleted: false,
  nextFindingId: 0,
  // Ephemeral per-render state — which tab is active within each dedup
  // group. Keyed by `groupKey(g)` (the first member's tabKey), value is
  // a tabKey within the group. Falls back to the sorted-primary tab
  // when absent or when the stored tab no longer exists. Session-only;
  // NOT persisted (it's a pure UI focus state, not triage).
  activeTabByGroup: new Map(),
}
