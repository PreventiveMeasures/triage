export const VIEW_MODE_KEY = 'deepview.viewMode'
const VALID_VIEW_MODES = new Set(['grouped', 'list', 'table'])

// Hoisted so the `state` object literal below can call it during its
// own initialization. Reads localStorage and validates against the
// known set — anything else (missing, corrupted, future-only value)
// returns null and the default kicks in.
function readSavedViewMode() {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY)
    return VALID_VIEW_MODES.has(v) ? v : null
  } catch { return null }
}

// Centralised mutable view state. Every module that reads or writes
// shared state imports this object and accesses fields directly —
// `state.reports`, `state.currentView = 'graph2'`, etc. Keeping it as
// a single object means we never have to chase scattered `let`
// bindings across modules (ES module live bindings are read-only from
// outside, so cross-module assignment would otherwise need setter
// functions).
//
// Graph-tab state lives separately in `./graph2/state.js` because it
// has its own teardown semantics tied to the canvas lifecycle.
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
  // Top-level tab — 'findings' (default), 'graph2' (canvas graph with
  // selection card sidebar), or 'files' (the per-file cards listing).
  // Graph / files tabs are only visible when the loaded report carries
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
  // 'grouped' (default) renders per-finding cards under per-file
  // headers — the original behavior. 'list' renders the same per-
  // finding cards but flat in sort order (each in a self-contained
  // card with its own location header). 'table' renders one compact
  // block per finding, never grouped. Selected via the icon-button
  // group in the toolbar; persisted to localStorage so the choice
  // survives reloads (events.js writes on click).
  viewMode: readSavedViewMode() ?? 'grouped',
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
