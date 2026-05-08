import { store } from '../rray-modules/frontend/state-management.mjs'

export const VIEW_MODE_KEY = 'deepview.viewMode'
export const REPO_URLS_KEY = 'deepview.repoUrls'
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

// Per-report repo URLs. The user's typed URL is meaningful in the
// context of one specific report (different reports can analyze
// different projects), so we key it on the OPFS filename rather
// than store a single global value. JSON object so the whole map
// round-trips in one localStorage call; missing entries default
// to empty string. Exported so `switchToFile` can populate
// `state.repoUrl` on every file switch and the events.js input
// handler can write back without re-deriving the key.
function readRepoUrlMap() {
  try { return JSON.parse(localStorage.getItem(REPO_URLS_KEY) || '{}') } catch { return {} }
}
function writeRepoUrlMap(map) {
  try { localStorage.setItem(REPO_URLS_KEY, JSON.stringify(map)) } catch {}
}
export function loadRepoUrlFor(name) {
  if (!name) return ''
  return readRepoUrlMap()[name] ?? ''
}
export function saveRepoUrlFor(name, url) {
  if (!name) return
  const map = readRepoUrlMap()
  if (url) map[name] = url
  else delete map[name]
  writeRepoUrlMap(map)
}

// Centralised mutable view state. Every module that reads or writes
// shared state imports this object and accesses fields directly —
// `state.reports`, `state.currentView = 'graph2'`, etc. Wrapped in
// `store()` (see rray-modules/frontend/state-management.mjs) so
// reads done from inside a `StateElement.render()` are tracked and
// the element re-renders automatically when those properties (or
// keys inside the Maps / Sets) mutate.
//
// Graph-tab state lives separately in `./graph2/state.js` because it
// has its own teardown semantics tied to the canvas lifecycle.
export const state = store({
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
  // Workspace id when the active view is a merged-workspace load
  // (every report assigned to that workspace stacked into one list);
  // null otherwise. Mutually exclusive with `currentFile`: switching
  // to a workspace nulls the file, switching to a file nulls the
  // workspace. Persists via the same LAST_FILE_KEY entry, prefixed
  // with `ws:` when set.
  currentWorkspace: null,
  // Top-level tab — 'findings' (default), 'graph2' (canvas graph with
  // selection card sidebar), or 'files' (the per-file cards listing).
  // Graph / files tabs are only visible when the loaded report carries
  // a `tree` block with more than one file; switching files / loading
  // a tree-less report auto-falls back to 'findings' inside render().
  currentView: 'findings',
  // Tracks the last non-`files` view so the page-header Files
  // toggle (top-right of the header, next to the repo chip) can
  // restore the user's prior view when toggled off — same
  // on/off semantic the Trash button uses for state.showDeleted.
  preFilesView: 'findings',
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
  // Confidence range — both bounds always set (the new
  // `<range-slider>` has no "unset" concept). 0 / 10 means "no
  // filter": findings with `f.confidence === undefined` pass when
  // the lower bound is at 0, and findings with `f.confidence > 10`
  // (rare but possible) pass when the upper bound is at 10. See
  // filters.js / matchesFilters for the membership semantics.
  filterConfMin: 0,
  filterConfMax: 10,
  filterInclude: '',
  repoUrl: '',
  // Transient flag — true while the header's repo chip has expanded
  // into its `<input>` form (user clicked the pencil). Cleared on
  // save / blur. Not persisted: the chip default-collapses on every
  // load.
  repoEditing: false,
  sortBy: 'severity',
  // 'table' (default) renders one compact block per finding, never
  // grouped — the most scannable layout for triage. 'list' renders
  // per-finding cards flat in sort order (each in a self-contained
  // card with its own location header). 'grouped' renders the same
  // per-finding cards under per-file headers, the original layout.
  // Selected via the icon-button group in the toolbar; persisted
  // to localStorage so the choice survives reloads (events.js
  // writes on click).
  viewMode: readSavedViewMode() ?? 'table',
  // Per-finding manual annotations. Keyed by `tabKey(f)` =
  // `f.id ?? String(f._id)`: the export's derived uuid when available
  // (persists across reloads via localStorage), else a session-local
  // numeric id (session-only). uuid-shaped keys round-trip through a
  // single `deepview.triage` localStorage entry; numeric-_id keys do
  // not. Both PER-TAB (per individual finding even within a dedup
  // group). Group-level rollup is computed on demand in groupState().
  markers: new Map(),
  // Per-finding free-text annotation, keyed the same way as markers
  // (uuid `f.id` when present, else session `String(f._id)`). Round-
  // trips alongside color / deleted in the `deepview.triage` blob —
  // see triage.js. Empty / cleared comments are removed from the map
  // so saveTriage doesn't persist a stale `comment: ""`.
  comments: new Map(),
  deletedIds: new Set(),
  showDeleted: false,
  nextFindingId: 0,
  // Ephemeral per-render state — which tab is active within each dedup
  // group. Keyed by `groupKey(g)` (the first member's tabKey), value is
  // a tabKey within the group. Falls back to the sorted-primary tab
  // when absent or when the stored tab no longer exists. Session-only;
  // NOT persisted (it's a pure UI focus state, not triage).
  activeTabByGroup: new Map(),
  // Table view: gid of the currently-selected row. Null when no row
  // is selected (the details panel is hidden and the list takes the
  // full width). Set by clicking a row in the table view; cleared by
  // re-clicking the same row.
  tableSelectedGid: null,
  // Files tab view mode — 'table' (one compact row per file with
  // finding chips on the right + a click-driven details panel for
  // imports / imported by / exports / hashes) or 'list' (the
  // original card layout where every file inlines all of those
  // sections). Session-only — re-renders track the toggle but it
  // doesn't persist across reloads.
  filesViewMode: 'table',
  // Free-text search query on the Files tab — case-insensitive
  // substring match against file paths, applied in both view modes
  // before render.
  filesSearch: '',
  // Currently-selected file in the Files-tab table view (null = no
  // selection, details panel hidden). Re-clicking the row clears it.
  filesSelectedFile: null,
})
