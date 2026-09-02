import { store } from '@rray/frontend/state-management'
import { getItem as getSecureItem, mutate as mutateSecureItem, onAfterHydrate, setItem as setSecureItem } from './secure-storage.js'
import { type ManagedServerInfo, type ServerMode, readCachedServerInfo } from './sync/server-mode.ts'

export const VIEW_MODE_KEY = 'deepview.viewMode'
export const SEVERITY_MODE_KEY = 'deepview.severityMode'
export const REPO_URLS_KEY = 'deepview.repoUrls'
export const FOCUS_SPLIT_KEY = 'deepview.focusSplit'
const VALID_VIEW_MODES = new Set(['grouped', 'list', 'table', 'kanban', 'focus'])
const VALID_SEVERITY_MODES = new Set(['corrected', 'original'])

// Focus view: where the divider between the finding-card and the
// inline Code panel sits, as a percentage of the main pane's width.
// 50 = an even 1:1 split (the default). The drag clamps to
// [MIN, MAX] so neither pane can be dragged shut — see
// `.focus-splitter` in ui/styles/findings.css and
// ui/view/focus-splitter.js.
export const FOCUS_SPLIT_DEFAULT = 50
export const FOCUS_SPLIT_MIN = 20
export const FOCUS_SPLIT_MAX = 80

export type ViewMode = 'table' | 'list' | 'grouped' | 'kanban' | 'focus'
// Global display lens for finding severities. 'corrected' (default) shows
// each finding's application-specific `correctedSeverity` when present;
// 'original' shows the analyzer's intrinsic `severity`. A pure display /
// count / sort preference — never alters report data. See ui/view/format.js
// (displayedSeverity) and <severity-mode-switch>.
export type SeverityMode = 'corrected' | 'original'
export type CurrentView = 'findings' | 'files' | 'bundles' | 'admin-users' | 'manage-repos' | 'manage-reports' | 'manage-bundles' | 'manage-teams'
export type TriageBucket = 'inprogress' | 'fixed' | 'invalid' | 'deleted'
// One kanban board column. The four real triage buckets plus the two
// pseudo-buckets the board also shows as columns: 'untriaged' (no
// `triage` set) and 'ignored' (per-report ignore, which lives outside
// `TriageEntry.triage`). See the `columns` list in ui/view/render.js.
export type KanbanColumnKey = TriageBucket | 'untriaged' | 'ignored'

// Tri-state for the toolbar annotation filters (comment / fix / flag):
// '' = off, 'with' = only findings carrying it, 'without' = only findings
// lacking it. See matchesFilters + <annotation-filter>.
export type AnnotationFilterState = '' | 'with' | 'without'

// One finding's triage annotations, keyed by `tabKey(f)` in
// `state.triage`. Unset fields are absent (not empty): the helpers in
// `triage-entry.ts` prune emptied fields and drop the id entirely when
// nothing remains, so iteration / persistence / GC only ever see
// meaningful ids. `ignoredReports` lists the report names in which the
// finding is per-report ignored. `deleted` is the legacy persisted/wire
// form, migrated to `triage: 'deleted'` on load and never written back
// in-memory.
export type TriageEntry = {
  color?: string
  triage?: TriageBucket
  comment?: string
  fix?: string
  // Tri-state attention flag. `undefined` = never set; `true` =
  // flagged; `false` = explicitly UN-flagged — a tombstone that is
  // deliberately NOT pruned. Keeping `false` distinct from absent is
  // load-bearing for sync/conflict resolution: unflagging is a real
  // change that must overwrite a peer's stale `true`, not read as "no
  // opinion" and get silently undone.
  flagged?: boolean
  ignoredReports?: string[]
  deleted?: boolean
}

// Deepview state schema. Fields with ad-hoc / nested shapes (parsed
// bundle metadata, ingested findings) stay `unknown` for now — they
// can be tightened as their consumers convert to TypeScript. The
// goal here is to type the surface accurately enough for the next
// conversion step (importers in `ui/view/` and the rest of `client/`)
// without forcing every caller to change in this PR.
export interface State {
  reports: unknown[]
  workspaceMerges: Array<Set<string>>
  currentFile: string | null
  currentWorkspace: string | null
  currentView: CurrentView
  bundles: unknown[]
  selectedBundle: string | null
  bundleDetails: unknown
  bundleDetailsTab: string
  selectedPackage: string | null
  selectedPackageVersion: string | null
  packageDetailsTab: 'overview' | 'issues'
  packageSlideTriage: 'invalid' | 'deleted' | null
  packageSlideTransient: boolean
  packagesSearchQuery: string
  packagesSortBy: string
  expandedPackages: Set<string>
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
  bundleSearchQuery: string
  bundleSearchRegex: boolean
  bundleSearchCase: boolean
  bundleSearchContext: boolean
  filterSeverities: Set<string>
  filterColors: Set<string>
  filterSources: Set<string>
  filterAnalyzer: string
  filterModel: string
  filterRepo: string
  filterRevalidate: string
  filterPartial: string
  showRevalidation: boolean
  codePreviews: Set<string>
  filterConfMin: number
  filterConfMax: number
  filterInclude: string
  filterIncludeNegate: boolean
  // Annotation filters — each is a tri-state ('' / 'with' / 'without')
  // that independently (AND-combined) restricts the row set by whether a
  // finding's triage carries a comment / a fix / `flagged: true`. See
  // matchesFilters.
  filterComment: AnnotationFilterState
  filterFix: AnnotationFilterState
  filterFlagged: AnnotationFilterState
  repoUrl: string
  repoEditing: boolean
  sortBy: string
  viewMode: ViewMode
  severityMode: SeverityMode
  triage: Map<string, TriageEntry>
  shownTriage: TriageBucket | null
  nextFindingId: number
  activeTabByGroup: Map<string, string>
  tableSelectedGid: string | null
  filesViewMode: 'table' | 'list'
  filesSearch: string
  filesSelectedFile: string | null
  kanbanPopoverGid: string | null
  kanbanExpandedColumn: KanbanColumnKey | null
  focusGid: string | null
  focusCodeTick: number
  focusSplit: number
  codeBlockTick: number
  bundleHashTick: number
  // ── server protocol (detected from the `server-info` connect frame) ──
  // Which sync protocol the configured server speaks; drives mode-aware UI
  // (managed mode hides workspace export and swaps the offline toggle for
  // login/logout). Seeded from the localStorage cache so the first paint is
  // correct, then confirmed by the `server-info` connect frame (see sidebar
  // `applyServerInfo`).
  serverMode: ServerMode | 'standalone'
  // Managed-mode entry points (login path + cookie name) when managed; null
  // for e2e.
  managed: ManagedServerInfo | null
  // True when the server reported a DIFFERENT protocol than the cached one —
  // a cross-mode switch we refuse for now (explicit migration UI is future
  // work); sync stays paused while set.
  serverModeMismatch: boolean
  // The logged-in managed user (null when logged out / e2e / standalone),
  // populated by the managed session probe (client/managed/session.js).
  managedSession: { id: string; login: string; name: string | null; avatarUrl: string | null; role: string; csrfToken: string | null } | null
  // The managed user's teams (each with the reports attached to the team's
  // repos), shown in the sidebar above Workspaces. Populated alongside the
  // session probe; empty when logged out / e2e.
  managedTeams: { id: string; name: string; reports: { id: string; filename: string }[] }[]
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

// Same validate-on-read pattern as the view mode. A non-sensitive UI
// preference (which severity lens to show), so it lives in raw
// localStorage like viewMode / theme — not secure-storage.
function readSavedSeverityMode(): SeverityMode | null {
  try {
    const v = localStorage.getItem(SEVERITY_MODE_KEY)
    return v !== null && VALID_SEVERITY_MODES.has(v) ? (v as SeverityMode) : null
  } catch { return null }
}

// Normalise a raw split percentage (a drag position, a keyboard
// nudge, a value read back from localStorage) to something the grid
// can use: finite, clamped to the pane minimums, and rounded to a
// tenth of a percent so the persisted value doesn't carry a drag's
// sub-pixel noise. Non-numeric input falls back to the 1:1 default.
export function clampFocusSplit(pct: number): number {
  if (!Number.isFinite(pct)) return FOCUS_SPLIT_DEFAULT
  const rounded = Math.round(pct * 10) / 10
  return Math.min(Math.max(rounded, FOCUS_SPLIT_MIN), FOCUS_SPLIT_MAX)
}

// Same validate-on-read pattern as the view / severity modes, with
// the clamp standing in for the valid-value set: a stored split from
// an older build (or a hand-edited one) is pulled back into range
// rather than thrown away.
function readSavedFocusSplit(): number | null {
  try {
    const raw = localStorage.getItem(FOCUS_SPLIT_KEY)
    // `Number('')` is 0 — a finite number that would clamp to the
    // minimum, so an empty entry has to miss explicitly.
    if (raw === null || raw.trim() === '') return null
    const pct = Number(raw)
    return Number.isFinite(pct) ? clampFocusSplit(pct) : null
  } catch { return null }
}

// Per-report repo URLs. The user's typed URL is meaningful only in
// the context of one report (different reports analyze different
// projects), so we key it on the OPFS filename rather than store a
// single global value. JSON object so the whole map round-trips in
// one localStorage call; missing entries default to empty string.
// Reads go through secure-storage's sync in-memory cache; writes go
// through `mutateSecureItem` for cross-tab safety (see
// `saveRepoUrlFor`). Exported so `switchToFile` can repopulate
// `state.repoUrl` on file switch and the events.js input handler can
// write back without re-deriving the key.
function parseRepoUrlMap(raw: string | null): Record<string, string> {
  // JSON.parse can return any value — `null`, an array, a primitive
  // — depending on the source contents. Without the typeof+object
  // gate, a corrupted value like the literal string `"null"` makes
  // downstream `parsed[name]` throw TypeError on property access.
  try {
    const parsed = JSON.parse(raw || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
    return {}
  } catch { return {} }
}
export function readRepoUrlMap(): Record<string, string> {
  return parseRepoUrlMap(getSecureItem(REPO_URLS_KEY))
}
export function loadRepoUrlFor(name: string | null | undefined): string {
  if (!name) return ''
  return readRepoUrlMap()[name] ?? ''
}

// Listener registry for per-report repo-URL changes. Mirrors
// `storage.js`'s `onFileMutated` pattern so downstream indexes
// (bundle-finding-index) can prune + re-index when the user-supplied
// fallback shifts. Fires AFTER the sync in-tab cache update so
// listener callbacks see the new value via `loadRepoUrlFor`. One bad
// subscriber doesn't break the chain.
const repoUrlChangeListeners = new Set<(name: string) => void>()
export function onRepoUrlChanged(cb: (name: string) => void): () => void {
  repoUrlChangeListeners.add(cb)
  return (): void => { repoUrlChangeListeners.delete(cb) }
}
function notifyRepoUrlChanged(name: string): void {
  for (const cb of repoUrlChangeListeners) {
    try { cb(name) } catch (err) { console.warn('repo-url listener:', err) }
  }
}

export function saveRepoUrlFor(name: string | null | undefined, url: string): void {
  if (!name) return
  // Two-step write:
  //
  // 1. Sync in-tab cache update via `setSecureItem`, preserving the
  //    contract that `saveRepoUrlFor()` then `loadRepoUrlFor()`
  //    returns the new value without an `await`. Many call sites
  //    (header chip, table cell renderer) rely on this.
  // 2. Async cross-tab reconciliation via `mutateSecureItem` under a
  //    per-key Web Lock: its in-lock hydrate pulls in sibling writes
  //    we overwrote, then re-applies our change on top of the
  //    freshest disk view. Both tabs converge to the merged map after
  //    one round-trip.
  //
  // Without (2), two tabs editing different entries clobber each
  // other (each writes its whole-map view, last writer wins). Audit
  // round-N P0.
  const map = readRepoUrlMap()
  if (url) map[name] = url
  else delete map[name]
  void setSecureItem(REPO_URLS_KEY, JSON.stringify(map))
    .catch((err: unknown) => console.warn('saveRepoUrlFor:', err))
  void mutateSecureItem(REPO_URLS_KEY, (currentFromDisk) => {
    const diskMap = parseRepoUrlMap(currentFromDisk)
    if (url) diskMap[name] = url
    else delete diskMap[name]
    return JSON.stringify(diskMap)
  }).catch((err: unknown) => console.warn('saveRepoUrlFor cross-tab merge:', err))
  // Fire AFTER the sync setSecureItem above (step 1) so listeners
  // calling `loadRepoUrlFor(name)` see the new value. Listeners are
  // not awaited — the cross-tab merge (step 2) is allowed to lag.
  notifyRepoUrlChanged(name)
}

// Bulk merge an imported repo-URL map (triage backup restore) into
// the stored map. Routed through `mutateSecureItem`, NOT raw
// localStorage: under an enabled vault the slot holds an encrypted
// envelope, so a raw `getItem` + `JSON.parse` throws and drops every
// URL, and a raw `setItem` writes plaintext over the encrypted slot
// and leaves the cache stale. The per-key Web Lock + in-lock hydrate
// gives the same cross-tab entry-level guarantee as `saveRepoUrlFor`.
// Merge modes mirror `applyTriageImport`:
//   * 'replace'         — install the imported map verbatim.
//   * 'prefer-imported' — imported value wins on key collision.
//   * 'prefer-current'  — current value wins (only fills gaps).
export async function importRepoUrls(
  imported: Record<string, string>,
  mode: 'replace' | 'prefer-imported' | 'prefer-current',
): Promise<void> {
  await mutateSecureItem(REPO_URLS_KEY, (currentFromDisk) => {
    const current = parseRepoUrlMap(currentFromDisk)
    const merged =
      mode === 'replace' ? { ...imported }
      : mode === 'prefer-imported' ? { ...current, ...imported }
      : { ...imported, ...current }
    return JSON.stringify(merged)
  })
  // `mutateSecureItem`'s in-lock `setItem` refreshes the cache that
  // `loadRepoUrlFor` reads, but `state.repoUrl` (the active report's
  // header chip) is only re-derived on file switch or storage event.
  // Refresh it here so the chip reflects an imported URL for the
  // currently-open report without a reload. Bails when the user is
  // mid-edit (see `propagateRepoUrlChangesFromStorage`).
  propagateRepoUrlChangesFromStorage()
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
// Cached server protocol (from the last `server-info` connect frame), read
// once so the initial render is mode-correct before the live frame confirms it.
const INITIAL_SERVER_INFO = readCachedServerInfo()

export const state: State = store<State>({
  // Exactly one OPFS-backed report is active at a time — the sidebar
  // switches between them; merging is gone. Headless callers
  // (`window.__loadFile` from src/print.js) bypass OPFS and may call
  // `ingestReport` repeatedly, in which case `reports` does accumulate
  // (the print pipeline still merges that way). The renderer is shape-
  // agnostic.
  reports: [],
  // Cross-report duplicate-merge instructions populated at ingest.
  // Each entry's member ids land here as an order-preserving Set in
  // two cases: (1) all-seen — every member id was already loaded and
  // the ids span more than one existing group, so we'd otherwise drop
  // the entry along with its "these prior findings are the same"
  // hint; (2) partial-seen — some members are new and some seen, so
  // the new ones get stamped as a fresh group AND a merge is recorded
  // to bind them with the existing group(s) holding the seen ids. The
  // workspace overall view (`getMergedGroups` in ui/view/group.js)
  // union-finds groups whose findings share an instruction set and
  // orders the merged super-group's members by the first-recorded
  // instruction's id order (the combined entry's canonical order).
  workspaceMerges: [],
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
  // Active tab in the bundle view's tab strip: 'overview' (the
  // metadata + Packages / Files / Reports nested view), 'terminal',
  // 'treemap', 'graph', 'issues', or 'code'. The nested-overview
  // selection rides the same field with the legacy values
  // 'packages' / 'files' / 'reports' so the existing persistence
  // (LAST_FILE_KEY suffix) round-trips without migration. Reset to
  // 'overview' when selectedBundle changes.
  bundleDetailsTab: 'overview',
  // Packages view selection — the package name (string) of the open
  // row, null when no detail panel is up. Mirrors the selectedBundle
  // pattern: clicking a row sets it; the deselect button clears it.
  // Stale selections (against a package that fell out of the
  // current triage filter) auto-clear at render time.
  selectedPackage: null,
  // Pinned version inside `selectedPackage` when the row is a
  // multi-version package — null when no version is pinned (e.g.
  // the package only has one version slot, or the user picked the
  // single aggregate row of an unversioned `node_modules/<pkg>/`
  // install). Reset alongside `selectedPackage`. The Packages view
  // routes the details panel + Issues slide through this slot when
  // it's non-null, so per-version rows show only their own slice.
  selectedPackageVersion: null,
  // Active tab in the package details panel — 'overview' keeps the
  // regular list + details layout (panel content); 'issues' opens
  // the full-width slide (same chrome as the bundle slide), which
  // replaces the list + details with a back-button header + the
  // shared per-file grouped finding list edge-to-edge. Reset to
  // 'overview' when selectedPackage changes so a new pick lands
  // on the primary tab.
  packageDetailsTab: 'overview',
  // Sub-view inside the package Issues slide — null = live
  // (untriaged + in-progress + fixed, the default + the same set the rest of
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
  // Package rows whose previous-versions list is expanded. The
  // Packages view shows ONLY the latest version's row by default
  // for any package that has more than one detected version; the
  // expand chevron flips this Set membership for that package so
  // the older versions surface as sub-rows underneath. Session-only
  // — re-renders track the flag but it doesn't persist across
  // reloads.
  expandedPackages: new Set<string>(),
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
  // Search-tab state — the github-style full-bundle search (the
  // 'search' tab), kept separate from the Code tab's compact rail
  // filter above so the two surfaces don't share one string. `regex`
  // matches the query as a RegExp; `case` makes matching
  // case-sensitive (both off by default). `context` shows the lines
  // around each match (on by default; off = only the exact match
  // lines). Reset on bundle change alongside the Code-search slice.
  bundleSearchQuery: '',
  bundleSearchRegex: false,
  bundleSearchCase: false,
  bundleSearchContext: true,
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
  // Analyzer + model filters — the two dimensions of the toolbar's
  // `<analyzer-select>` dropdown (one column per dimension; setting
  // both narrows to findings carrying that exact analyzer+model
  // combination). Empty string = no filter on that dimension.
  //
  // `filterAnalyzer` matches a finding's `_analyzer` (the report's
  // `source` for DeepSec / Codex Security / Claude Security imports,
  // or the per-finding `type` for analyzer-native JSON dumps).
  // `NULL_ANALYZER_SENTINEL` (a control character, exported from
  // view/filters.js) selects findings whose effective analyzer is
  // absent (`_analyzer === null`) — picked over the bare word `'null'`
  // so a legitimate analyzer literally named `"null"` stays
  // distinguishable.
  //
  // `filterModel` matches `modelOfFinding(f)` — the PRETTY model name
  // (`prettyModel(f.model)`, the same form the header combo tags and
  // per-finding run-meta lines display), so vendor-prefixed spellings
  // of one model collapse into a single bucket. `NULL_MODEL_SENTINEL`
  // selects findings with no model (source-marked imports never stamp
  // one).
  //
  // The selector is hidden when neither dimension has more than one
  // distinct value across the loaded reports — nothing to choose
  // between.
  filterAnalyzer: '',
  filterModel: '',
  // Repository filter — single-select dropdown, only meaningful in
  // workspace view (single-file mode usually has one repo). Empty
  // string = no filter. Otherwise the value matches a finding's
  // resolved repo (`f.repo?.github ?? f._repoFallback`).
  // `NO_REPO_SENTINEL` (a control character, exported from
  // view/filters.js) selects findings with no derivable repo —
  // picked over the bare word `'null'` so a legitimate repo slug
  // literally named `"null"` stays distinguishable. The selector
  // is hidden when the loaded reports involve only one distinct
  // repo or aren't a workspace merge.
  filterRepo: '',
  // Revalidation outcome — empty string = no filter; otherwise a value
  // from view/format.js's REVALIDATE_FILTERS (`confirmed` / `refuted`),
  // each covering one or more values of a finding's `revalidate` field.
  // The dropdown lists only the outcomes the loaded set reaches and is
  // hidden entirely when it reaches none, so this stays '' for every
  // report that predates the revalidation pass. A selection that stops
  // being reachable is cleared in render.js, the same way a stale repo
  // filter is.
  filterRevalidate: '',
  // Where the `partial` rows go while Confirmed is up — '' keeps them
  // alongside the full confirmations, 'exclude' holds them out, 'only'
  // leaves nothing else. A chip inside the Confirmed row cycles it
  // (format.js PARTIAL_MODES / activeRevalidateKinds). Inert under any
  // other outcome, and cleared in render.js when the loaded set has no
  // partial rows to sort.
  filterPartial: '',
  // The revalidation LAYER — the toolbar's "App" switch. On (the
  // default), the findings are about the running app: what it can
  // reach, re-rated by the second pass. Off, they are about the code
  // as written, with the pass's own rows, stamps, verdicts and filter
  // taken away — see format.js configureRevalidation, which is handed
  // this once per render. Offered only where a report carries the
  // field at all; a set without one is already the code view.
  showRevalidation: true,
  // Which source previews are open — the eye beside a finding's code
  // links, keyed `<tabKey>\0<path>\0<line>` (render-finding.js
  // codePreviewKey). A Set rather than one open at a time: the
  // previews are context for the prose around them, and a reader
  // comparing an evidence row against the finding's own line wants
  // both. Not persisted; a reload opens on the prose.
  codePreviews: new Set<string>(),
  // Confidence range — both bounds always set (the new
  // `<range-slider>` has no "unset" concept). 0 / 10 means "no
  // filter": findings with `f.confidence === undefined` pass when
  // the lower bound is at 0, and findings with `f.confidence > 10`
  // (rare but possible) pass when the upper bound is at 10. See
  // filters.js / matchesFilters for the membership semantics.
  filterConfMin: 0,
  filterConfMax: 10,
  filterInclude: '',
  // Negation toggle for the findings search: when true the query
  // EXCLUDES — show findings that DON'T match. See matchesFilters.
  filterIncludeNegate: false,
  // Annotation-filter tri-states (the toolbar's comment | fix | flag chip
  // group after the Sources / Dependencies switch). '' = no filter,
  // 'with' = only those carrying it, 'without' = only those lacking it.
  // AND-combined.
  filterComment: '',
  filterFix: '',
  filterFlagged: '',
  repoUrl: '',
  // Transient flag — true while the header's repo chip has expanded
  // into its `<input>` form (user clicked the pencil). Cleared on
  // save / blur. Not persisted: the chip default-collapses on every
  // load.
  repoEditing: false,
  sortBy: 'severity',
  // 'kanban' (default) lays the findings out as a status board, one
  // column per triage bucket — the layout that opens on what triage
  // is actually for, so it leads the chooser and greets a first-time
  // load. 'focus' walks one finding at a time with a queue beside it.
  // 'table' renders one compact block per finding, never grouped —
  // the most scannable flat layout. 'list' renders per-finding cards
  // flat in sort order (each in a self-contained card with its own
  // location header). 'grouped' renders the same per-finding cards
  // under per-file headers, the original layout. Selected via the
  // icon-button group in the toolbar; persisted to localStorage so
  // the choice survives reloads (events.js writes on click).
  viewMode: readSavedViewMode() ?? 'kanban',
  // Severity display lens — 'corrected' (default) or 'original'. Global,
  // persisted to raw localStorage (events.js writes on toggle), so the
  // choice survives reloads like viewMode. The corrected DATA is per-
  // report and read-only; this is only which value the UI surfaces.
  severityMode: readSavedSeverityMode() ?? 'corrected',
  // Per-finding triage annotations — color, triage bucket, comment,
  // fix reference, and per-report ignore — bundled into one TriageEntry
  // per finding. Keyed by `tabKey(f)` = `f.id ?? String(f._id)`: the
  // export's derived uuid when available (persists across reloads via
  // the single `deepview.triage` localStorage blob), else a session-
  // local numeric id (session-only). PER-TAB (per individual finding
  // even within a dedup group); group-level rollup is computed on
  // demand in groupState(). Writes go through `client/triage-entry.ts`
  // (immutable whole-entry replace) so observer-util re-renders the
  // readers of a finding when its entry changes; emptied entries are
  // dropped from the map. `ignoredReports` lists the report names in
  // which the finding is ignored — ignoring it in report A doesn't
  // ignore the same finding in report B; mutually exclusive with the
  // triage bucket at the action layer. Loaded entries with the legacy
  // `deleted: true` shape are migrated to `triage: 'deleted'` on load.
  triage: new Map<string, TriageEntry>(),
  // Currently displayed triage bucket — null = live view (no triage
  // state); 'inprogress' / 'fixed' / 'invalid' / 'deleted' = filter to
  // that bucket only. The toolbar's segmented selector flips between
  // these states (+ 'ignored' on the findings tab).
  shownTriage: null,
  nextFindingId: 0,
  // Ephemeral per-render state — which tab is active within each dedup
  // group. Keyed by `groupKey(g)` (the first member's tabKey), value is
  // a tabKey within the group. When absent (or the stored tab no longer
  // exists), the default-tab resolution in view/group.js's activeTabFor
  // applies — analyzer/model-filter match, then annotation marker, then
  // the sorted-primary tab. Session-only; NOT persisted (it's a pure UI
  // focus state, not triage).
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
  // Kanban view: gid of the group whose detail popover is currently
  // open (null = no popover). Session-only — not persisted, since the
  // popover is a transient inspection affordance. Re-clicking the
  // same card (or clicking the backdrop / pressing Esc) clears it.
  kanbanPopoverGid: null,
  // Kanban view: key of the column currently shown fullscreen (null =
  // the regular all-columns board). Set by the expand button in the
  // column header; the board then renders that column alone, across
  // the full width, with its cards laid out in as many tracks as the
  // board would have shown columns — so the cards keep their usual
  // width. Session-only, like kanbanPopoverGid: which column you last
  // zoomed into isn't a preference worth restoring on the next visit.
  kanbanExpandedColumn: null,
  // Focus view: gid of the finding currently displayed in the center
  // pane (null = no explicit pick yet; render falls back to position
  // 0 of the filtered list). Session-only — not persisted, since
  // which finding is "current" only makes sense within an active
  // triage session. A stale gid (filter or sort changed, finding
  // triaged out of the visible set) falls back to the previous
  // render's index in render.js — so triaging the focused finding
  // advances the queue to the next slot rather than jumping back to
  // the top.
  focusGid: null,
  // Tick incremented every time the focus view's inline Code panel
  // settles a new bundle source / Prism highlight. The focus body
  // template reads it so observer-util consumers see the cache
  // change as a state mutation — without this, the cache lived
  // entirely in module-scope Maps and `render()` calls after async
  // loads occasionally didn't propagate down to the DOM until the
  // next manual render (the user reproduced this as "code loads
  // but doesn't appear until I navigate").
  focusCodeTick: 0,
  // Focus view: how the main pane splits between the finding-card and
  // the inline Code panel, as the divider's percentage along the pane
  // (50 = the 1:1 default). Only meaningful while the Code panel is
  // mounted — a finding with no bundle source gives the card the whole
  // pane. Persisted to raw localStorage (a layout preference, like
  // viewMode / severityMode) by ui/view/focus-splitter.js, which also
  // owns the drag.
  focusSplit: readSavedFocusSplit() ?? FOCUS_SPLIT_DEFAULT,
  // The same trick for the fenced code blocks in finding descriptions:
  // bumped every time view/code-highlight.js settles a Prism highlight,
  // and read by the block template so an observer-util consumer (the
  // `<finding-card>` autorun) repaints the block coloured instead of
  // sitting on the plain-text first pass until something else renders.
  codeBlockTick: 0,
  // And once more for the cross-bundle file-hash index
  // (client/bundle-hash-index.js), which fills asynchronously: at
  // ingest via a fire-and-forget prefetch, and from an empty start on
  // every reload. The finding-card's "Code →" button asks that index
  // whether this finding's source is in a bundle, and a plain module
  // Map is invisible to the card's autorun — so the answer it got
  // before the hashes landed ("no bundle") would stand until some
  // unrelated state change re-rendered the card. events.js bumps this
  // when the index changes; render-finding.js reads it next to the
  // lookup. The parent-rendered surfaces (focus view's Code panel,
  // Files tab) don't need it — the same subscriber re-renders them
  // directly.
  bundleHashTick: 0,
  // Sync protocol of the configured server (e2e vs managed), seeded from the
  // localStorage cache so mode-aware UI is correct on first paint; the live
  // `server-info` connect frame confirms / updates it.
  serverMode: INITIAL_SERVER_INFO?.mode ?? 'e2e',
  managed: INITIAL_SERVER_INFO?.managed ?? null,
  // Set when the server reports a different protocol than the cached one; the
  // switch is refused (migration is future work) and sync stays paused.
  serverModeMismatch: false,
  // Logged-in managed user, or null (e2e / logged out). Future managed
  // session probe populates this.
  managedSession: null,
  // The managed user's teams (sidebar Teams section); the session probe fills it.
  managedTeams: [],
})

// Cross-tab propagation: a sibling tab's `saveRepoUrlFor` writes
// through secure-storage, which fires an after-hydrate listener once
// the encrypted-cache refresh completes. Subscribing to that hook
// (instead of the raw `storage` event) ensures `loadRepoUrlFor` sees
// the post-decrypt cache, not the pre-hydrate stale one. The raw
// `storage` event would fire synchronously on the just-written
// envelope base64, and our sync `getSecureItem` would read the
// not-yet-rehydrated cache — silently reverting the chip to the
// stale URL. Audit round-8 H3 + round-N concurrency.
//
// Bail when `state.repoEditing` is set — the user has the header
// chip expanded into its `<input>` and overwriting `state.repoUrl`
// would re-render the chip and vanish their typed-but-unsaved URL.
// The blur / Save handlers in events.js read the user's input and
// call `saveRepoUrlFor` on commit; if they prefer the sibling's
// value they can re-enter and re-edit. Audit round-9 M2.
export function propagateRepoUrlChangesFromStorage(): void {
  if (state.repoEditing) return
  if (state.currentFile) state.repoUrl = loadRepoUrlFor(state.currentFile)
}
onAfterHydrate(() => {
  propagateRepoUrlChangesFromStorage()
})
