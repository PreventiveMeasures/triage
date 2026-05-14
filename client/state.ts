import { store } from '@rray/frontend/state-management'

export const VIEW_MODE_KEY = 'deepview.viewMode'
export const REPO_URLS_KEY = 'deepview.repoUrls'
const VALID_VIEW_MODES = new Set(['grouped', 'list', 'table'])

export type ViewMode = 'table' | 'list' | 'grouped'
export type CurrentView = 'findings' | 'files' | 'bundles'
export type TriageBucket = 'fixed' | 'invalid' | 'deleted'

// Deepview state schema. Fields with ad-hoc / nested shapes (parsed
// bundle metadata, ingested findings) stay `unknown` for now — they
// can be tightened as their consumers convert to TypeScript. The
// goal here is to type the surface accurately enough for the next
// conversion step (importers in `ui/view/` and the rest of `client/`)
// without forcing every caller to change in this PR.
export interface State {
  reports: unknown[]
  currentFile: string | null
  currentWorkspace: string | null
  currentView: CurrentView
  bundles: unknown[]
  selectedBundle: string | null
  bundleDetails: unknown
  bundleDetailsTab: string
  selectedPackage: string | null
  packageDetailsTab: 'overview' | 'issues'
  packageSlideTriage: 'invalid' | 'deleted' | null
  packageSlideTransient: boolean
  packagesSearchQuery: string
  packagesSortBy: string
  selectedRepository: string | null
  repositoryDetailsTab: 'overview' | 'issues'
  repositorySlideTriage: 'invalid' | 'deleted' | null
  repositorySlideTransient: boolean
  repositoriesSearchQuery: string
  repositoriesSortBy: string
  bundleSourceFile: string | null
  bundleSourceFindingIdx: number | null
  bundleCodeSearchMode: string
  bundleCodeSearchQuery: string
  filterSeverities: Set<string>
  filterColors: Set<string>
  filterSources: Set<string>
  filterConfMin: number
  filterConfMax: number
  filterInclude: string
  repoUrl: string
  repoEditing: boolean
  sortBy: string
  viewMode: ViewMode
  markers: Map<string, string>
  comments: Map<string, string>
  fixes: Map<string, string>
  triageState: Map<string, TriageBucket>
  ignoredIds: Set<string>
  shownTriage: TriageBucket | null
  nextFindingId: number
  activeTabByGroup: Map<string, string>
  tableSelectedGid: string | null
  filesViewMode: 'table' | 'list'
  filesSearch: string
  filesSelectedFile: string | null
}

// Hoisted so the `state` object literal below can call it during its
// own initialization. Reads localStorage and validates against the
// known set — anything else (missing, corrupted, future-only value)
// returns null and the default kicks in.
function readSavedViewMode(): ViewMode | null {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY)
    return v !== null && VALID_VIEW_MODES.has(v) ? (v as ViewMode) : null
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
function readRepoUrlMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(REPO_URLS_KEY) || '{}') } catch { return {} }
}
function writeRepoUrlMap(map: Record<string, string>): void {
  try { localStorage.setItem(REPO_URLS_KEY, JSON.stringify(map)) } catch {}
}
export function loadRepoUrlFor(name: string | null | undefined): string {
  if (!name) return ''
  return readRepoUrlMap()[name] ?? ''
}
export function saveRepoUrlFor(name: string | null | undefined, url: string): void {
  if (!name) return
  const map = readRepoUrlMap()
  if (url) map[name] = url
  else delete map[name]
  writeRepoUrlMap(map)
}

// Centralised mutable view state. Every module that reads or writes
// shared state imports this object and accesses fields directly —
// `state.reports`, `state.currentView = 'files'`, etc. Wrapped in
// `store()` (see @rray/frontend/state-management) so
// reads done from inside a `StateElement.render()` are tracked and
// the element re-renders automatically when those properties (or
// keys inside the Maps / Sets) mutate.
//
// Graph-tab state lives separately in `./graph2/state.js` because it
// has its own teardown semantics tied to the canvas lifecycle.
export const state: State = store<State>({
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
  // Top-level view — 'findings' (default; table / list / grouped /
  // graph view-modes inside), 'files' (per-file cards listing,
  // reached via the page-header Files toggle), or 'bundles' (list
  // of OPFS-stored sourcemap / stasis blobs, reached via the
  // sidebar's BUNDLES header). Files is gated on a tree-bearing
  // report with >1 file; bundles is gated on at least one bundle in
  // OPFS; both auto-fall back to 'findings' if their gate fails.
  currentView: 'findings',
  // Bundles list cached for synchronous render. Populated on every
  // renderSidebar() (which lists OPFS) so render.js's `bundles`
  // branch can paint without an async round-trip. Empty array when
  // no bundles are stored.
  bundles: [],
  // Bundles view selection (integrity of the open row, null = none),
  // and the parsed details cache for the open bundle. Selection
  // opens a right-side panel mirroring the findings-table details
  // pattern; details load asynchronously (readBundle + parse for
  // .map) and stay cached on this slot until selection changes.
  selectedBundle: null,
  bundleDetails: null,
  // Active tab in the bundle details panel — only used when the
  // open bundle has > 5 packages and the panel splits the per-
  // package size visualization from the flat file list across two
  // tabs. Reset to 'packages' when selectedBundle changes.
  bundleDetailsTab: 'packages',
  // Packages view selection — the package name (string) of the open
  // row, null when no detail panel is up. Mirrors the selectedBundle
  // pattern: clicking a row sets it; the deselect button clears it.
  // Stale selections (against a package that fell out of the
  // current triage filter) auto-clear at render time.
  selectedPackage: null,
  // Active tab in the package details panel — 'overview' keeps the
  // regular list + details layout (panel content); 'issues' opens
  // the full-width slide (same chrome as the bundle slide), which
  // replaces the list + details with a back-button header + the
  // shared per-file grouped finding list edge-to-edge. Reset to
  // 'overview' when selectedPackage changes so a new pick lands
  // on the primary tab.
  packageDetailsTab: 'overview',
  // Sub-view inside the package Issues slide — null = live
  // (untriaged + fixed, the default + the same set the rest of
  // the package surface counts as "issues"), 'invalid' / 'deleted'
  // = the corresponding triage bucket. Surfaced as `[Invalid |
  // Deleted]` tabs in the slide's header, only when the bucket
  // is non-empty. Reset to null when selectedPackage changes or
  // when the slide closes.
  packageSlideTriage: null,
  // True when the Issues slide was opened via the row's
  // `[Issues →]` shortcut button (vs. the details panel's Issues
  // tab). On slide-back, the click handler also clears
  // `selectedPackage` so the user lands back on the plain list
  // instead of the row+details panel state — the row button is
  // meant to be a transient drill-in, not a row selection.
  packageSlideTransient: false,
  // Packages list — text filter (case-insensitive substring match
  // on the package name) and sort key. Sort options:
  // 'findings-desc' (default — most issues first),
  // 'files-desc', 'reports-desc', 'name-asc'.
  packagesSearchQuery: '',
  packagesSortBy: 'findings-desc',
  // Repositories view — same shape as Packages but bucketed by
  // each finding's repo URL (own-source findings only; deps live
  // in Packages). The two views complement each other.
  selectedRepository: null,
  repositoryDetailsTab: 'overview',
  repositorySlideTriage: null,
  repositorySlideTransient: false,
  repositoriesSearchQuery: '',
  repositoriesSortBy: 'findings-desc',
  // Path of the bundle source currently open in the source viewer
  // modal (null when closed). Reset on bundle change / view switch
  // so an old viewer doesn't reopen against a different bundle.
  bundleSourceFile: null,
  // Index of the finding currently highlighted in the source
  // viewer's side panel (within the bundle's per-file findings
  // array; null when no panel is open). Reset alongside
  // bundleSourceFile.
  bundleSourceFindingIdx: null,
  // Code-slide search state — `mode` selects what gets filtered
  // by `query`: file paths (default), source content, or matched
  // findings. Reset on bundle change / slide exit so a stale
  // query doesn't carry over to the next bundle.
  bundleCodeSearchMode: 'files',
  bundleCodeSearchQuery: '',
  // Severity + color filters are multi-select: empty Set = "no filter,
  // show everything" (selecting every option individually is equivalent
  // — the predicate passes when every finding's value is in the Set).
  // UI-wise each .stat card toggles membership independently; no single
  // "all" sentinel. `filterColors` stores mark colors
  // (`red|blue|green|gray`) plus the literal `'none'` for unmarked
  // findings.
  filterSeverities: new Set<string>(),
  filterColors: new Set<string>(),
  // Source filter — Set<'own' | 'modules'>. Empty (default) = no
  // filter; single member = restrict to that side. The toolbar
  // chips behave as a single-select with toggle-off: clicking a
  // chip switches to it (clearing the other), clicking the active
  // chip again clears the set entirely.
  filterSources: new Set<string>(),
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
  markers: new Map<string, string>(),
  // Per-finding free-text annotation, keyed the same way as markers
  // (uuid `f.id` when present, else session `String(f._id)`). Round-
  // trips alongside color / deleted in the `deepview.triage` blob —
  // see triage.js. Empty / cleared comments are removed from the map
  // so saveTriage doesn't persist a stale `comment: ""`.
  comments: new Map<string, string>(),
  // Per-finding "fix" reference — typically a PR URL, but anything
  // string-shaped works (commit hash, ticket link, etc.). Same key
  // and persistence rules as `comments`; rendered as a clickable
  // link in the tab body when present.
  fixes: new Map<string, string>(),
  // Triage state per finding — one of 'fixed' / 'invalid' / 'deleted'
  // (mutually exclusive). Findings without an entry are "active"
  // (the default live view). Setting any state for a tab clears the
  // others in the same slot. Persists alongside markers / comments
  // / fixes in the deepview.triage blob (see triage.js); loaded
  // entries with the legacy `deleted: true` shape are migrated to
  // 'deleted' on load.
  triageState: new Map<string, TriageBucket>(),
  // Per-report ignore set — keyed by `${reportName}\0${tabKey}` so
  // ignoring a finding in report A doesn't ignore the same finding
  // when it shows up in report B. Mutually exclusive with the
  // triage state (setting any state clears the ignore on the same
  // tab; setting ignore clears the triage). Lives next to triage
  // in the deepview.triage blob, persisted as `ignoredReports:
  // ['nameA', 'nameB']` on each id-keyed entry — see triage.js.
  ignoredIds: new Set<string>(),
  // Currently displayed triage bucket — null = live view (no triage
  // state); 'fixed' / 'invalid' / 'deleted' = filter to that bucket
  // only. Replaces the prior boolean showDeleted; the toolbar's
  // 4-segment selector flips between the four states.
  shownTriage: null,
  nextFindingId: 0,
  // Ephemeral per-render state — which tab is active within each dedup
  // group. Keyed by `groupKey(g)` (the first member's tabKey), value is
  // a tabKey within the group. Falls back to the sorted-primary tab
  // when absent or when the stored tab no longer exists. Session-only;
  // NOT persisted (it's a pure UI focus state, not triage).
  activeTabByGroup: new Map<string, string>(),
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

// Cross-tab propagation: a sibling tab's `saveRepoUrlFor` fires a
// `storage` event in this tab. When the active file's URL changed
// upstream, sync `state.repoUrl` so the header chip refreshes
// immediately rather than showing stale text until the next
// switchToFile / reload. Audit round-8 H3.
//
// Bail when `state.repoEditing` is set — the user has the header
// chip expanded into its `<input>` and overwriting `state.repoUrl`
// would re-render the chip and vanish their typed-but-unsaved URL.
// The blur / Save handlers in events.js read the user's input and
// call `saveRepoUrlFor` on commit; if they prefer the sibling's
// value they can re-enter and re-edit. Audit round-9 M2.
//
// Exported so node:test environments can invoke the handler
// directly — `window` doesn't exist in tests and the storage
// event never fires there.
export function propagateRepoUrlChangesFromStorage(): void {
  if (state.repoEditing) return
  if (state.currentFile) state.repoUrl = loadRepoUrlFor(state.currentFile)
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== REPO_URLS_KEY) return
    propagateRepoUrlChangesFromStorage()
  })
}
