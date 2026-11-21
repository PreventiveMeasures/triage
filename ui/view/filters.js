import { automaticFixFor, managedIssueFor } from './managed-issues.js'
import { isPlaceholderNpmPackage, state } from '#client/index.js'
import { SEVERITY_ORDER, displayedSeverity, findingText, isModule, isRevalidation, isRuledOut, prettyModel, revalidateKind } from './format.js'
import { drawnTabs, getMergedGroups, primaryTab, tabKey, triageEntry, underlyingFindingsShown } from './group.js'
import { activeRevalidateKinds, canLockConfirmed, defaultConfidenceFloor as confidenceFloor, confidenceOnScale, confirmedCoverage, confirmedIsDefault, rangeApplies } from '../../common/finding-filters.js'
export { rangeApplies } from '../../common/finding-filters.js'
import { reportDuplicateIds } from './report-duplicates.js'
import { ignoresOwnRepo } from '../../common/finding-repo.js'

// Dropdown stand-ins for "no value", each a distinct control character so
// they can't collide with a real name (an analyzer may be called `null`)
// or couple two dropdowns through a shared value. Written as escapes: a
// literal NUL makes git treat the file as binary.
// The analyzer dropdown's "no analyzer".
export const NULL_ANALYZER_SENTINEL = '\u0000'
// The workspace repo dropdown's "no repo" (no `repo.github`, no `_repoFallback`).
export const NO_REPO_SENTINEL = '\u0001'
// The `<analyzer-select>` model columns' "(no model)".
export const NULL_MODEL_SENTINEL = '\u0002'

// A finding's model as the dropdown buckets it: the pretty name, so
// vendor-prefixed spellings of one model are one option; null for none (a
// blank one included).
export function modelOfFinding(f) {
  return prettyModel(f.model) || null
}

// A dropdown selection as the value it asks for: `undefined` for none,
// `null` for the no-value bucket.
export function runFilterValue(value, sentinel) {
  return value === '' ? undefined : value === sentinel ? null : value
}

const analyzerOf = (f) => f._analyzer ?? null
// The pass's own row has no Model: it answers to the Validation model, so a
// model the pass ran on can be asked for what IT found in the scans beneath.
const analyzerMatches = (f, want) => want === undefined || analyzerOf(f) === want
const modelMatches = (f, want) => want === undefined || (!isRevalidation(f) && modelOfFinding(f) === want)

// The `<analyzer-select>` Analyzer + Model selection asked of one tab. Per
// tab, so both mean "SOME finding carries this pair". Also asked by
// group.js activeTabFor (via matchesRunTab), apart from matchesFilters so
// tab resolution doesn't depend on the other filters.
function matchesRunFilters(f) {
  const F = activeFilters()
  return analyzerMatches(f, runFilterValue(F.filterAnalyzer, NULL_ANALYZER_SENTINEL))
    && modelMatches(f, runFilterValue(F.filterModel, NULL_MODEL_SENTINEL))
}

// The dropdown's third dimension, in App mode: the model of the pass's own
// row (`revalidate: "revalidation"`). No other row has one.
function matchesValidationModel(f) {
  const want = runFilterValue(activeFilters().filterValidationModel, NULL_MODEL_SENTINEL)
  return want === undefined || (isRevalidation(f) && modelOfFinding(f) === want)
}

// The `<analyzer-select>` counts: per column, a Map of each value to how
// many of `groups` (whole rows, the scans App mode folds under a pass
// included) it would show under the other columns' selection — each value
// counting its group once, as matchesRunRow would show it.
export function runFilterCounts(groups) {
  const F = activeFilters()
  const wantA = runFilterValue(F.filterAnalyzer, NULL_ANALYZER_SENTINEL)
  const wantM = runFilterValue(F.filterModel, NULL_MODEL_SENTINEL)
  const counts = { analyzers: new Map(), models: new Map(), validationModels: new Map() }
  const count = (map, values) => { for (const value of values) map.set(value, (map.get(value) ?? 0) + 1) }
  for (const g of groups) {
    const validated = g.some(matchesValidationModel)
    const paired = g.some(matchesRunFilters)
    const analyzers = new Set()
    const models = new Set()
    const validationModels = new Set()
    for (const f of g) {
      const pass = isRevalidation(f)
      if (validated && modelMatches(f, wantM)) analyzers.add(analyzerOf(f))
      if (validated && !pass && analyzerMatches(f, wantA)) models.add(modelOfFinding(f))
      if (paired && pass) validationModels.add(modelOfFinding(f))
    }
    count(counts.analyzers, analyzers)
    count(counts.models, models)
    count(counts.validationModels, validationModels)
  }
  return counts
}

// Whether the dropdown has a choice to offer over `groups`, given the Sets
// each column would list: a column with more than one value, or a single
// validation model some row has no pass of (picking it leaves that out).
export function runFiltersOffered(groups, { analyzers, models, validationModels }) {
  return analyzers.size > 1 || models.size > 1 || validationModels.size > 1
    || (validationModels.size === 1 && groups.some((g) => !g.some(isRevalidation)))
}

// The tabs a row should open on under the dropdown's selection (group.js
// activeTabFor): one matching what the selection asks of a single tab.
export function matchesRunTab(f) {
  const F = activeFilters()
  return (Boolean(F.filterAnalyzer || F.filterModel) && matchesRunFilters(f))
    || (Boolean(F.filterValidationModel) && matchesValidationModel(f))
}

// The selection asked of a whole row: some tab with the analyzer+model
// pair, and some pass row of the Validation model — separately, since the
// pass's row is the only one with a Validation model and without a Model.
function matchesRunRow(group) {
  const F = activeFilters()
  if (F.filterValidationModel && !group.some(matchesValidationModel)) return false
  return !(F.filterAnalyzer || F.filterModel) || group.some(matchesRunFilters)
}

// A finding's repo as one key, or null. A DeepView App finding describes
// its report's app even when its code lives in a dependency, so it takes
// the report's repo (`_repoFallback`); others take their own `repo.github`
// first, unless it names the package they advise against
// (common/finding-repo.js). File links resolve separately.
export function repoOfFinding(f) {
  const reportRepo = typeof f._repoFallback === 'string' && f._repoFallback ? f._repoFallback : null
  if (f.isApp && !(f._source ?? f.source) && reportRepo) return reportRepo
  if (!ignoresOwnRepo(f, reportRepo) && typeof f.repo?.github === 'string' && f.repo.github) return f.repo.github
  return reportRepo
}

// The repository choices over the scope-filtered, visible tabs
// (applyScopeFilters), through the same resolver the filter matches by.
export function repositoryFilterValues(groups) {
  return new Set(groups.flatMap((group) => group.map(repoOfFinding)))
}

// Every `filter*` field and its "no filter" value, in reset order. Sets are
// reset to fresh ones.
const FILTER_DEFAULTS = {
  filterSeverities: new Set(), filterColors: new Set(), filterSources: new Set(),
  filterAnalyzer: '', filterModel: '', filterValidationModel: '', filterRepo: '',
  filterConfMin: 0, filterConfMax: 10,
  filterInclude: '', filterIncludeNegate: false,
  filterComment: '', filterIssue: '', filterFix: '', filterFlagged: '', filterDuplicates: '', filterCrossContext: '', filterAppStacked: '', filterSecurity: '',
  // The outcome too: one surviving a reset would keep hiding findings, and
  // the deep-link and graph-jump paths reset so their target is on screen.
  filterRevalidate: '', filterPartial: '',
}
const FILTER_FIELDS = Object.keys(FILTER_DEFAULTS)

export function resetFilters() {
  for (const key of FILTER_FIELDS) state[key] = FILTER_DEFAULTS[key] instanceof Set ? new Set() : FILTER_DEFAULTS[key]
  // The opening sort is derived from the whole merged view
  // (applyOpeningFilters): reports ingest one at a time, and an early one
  // must not decide it.
  state.sortBy = 'severity'
}

// A detached copy of the filter selection, Sets copied too: the export
// confirm dialog relaxes one without changing what the app shows.
export function cloneFilterFields() {
  const out = {}
  for (const key of FILTER_FIELDS) {
    const v = state[key]
    out[key] = v instanceof Set ? new Set(v) : v
  }
  return out
}

// While set, the predicates read their `filter*` values from here instead
// of `state` (everything else still comes from `state`). Sticky rather than
// a callback scope: print holds it across a render and the browser's print
// dialog. Callers clear it in a `finally` / restore path.
let filterOverride = null

export function setFilterOverride(fields) { filterOverride = fields }
export function clearFilterOverride() { filterOverride = null }

// `state` unless something stands in for it, read once per predicate call
// so a pass can't mix two selections. The markdown adapter describes the
// selection its file was written under through this.
export function activeFilters() {
  return filterOverride ?? state
}

// The outcome a row answers to when the toolbar filters by one: its stamp,
// else `revalidation` for a product import (anything with a `source`
// marker) whose producer ran no pass of its own on its report — such a
// finding was never put before a pass, so it stands, as a row a pass left
// alone does, and Confirmed keeps it. Where the producer did judge
// (DeepSec writes its verdicts; `_sourcePass`, stamped at ingest), an
// unstamped row answers nothing. Only the filter reads this: cards draw
// format.js's readers, and render.js scans the real values to offer the
// dropdown, so a set with no pass gets none.
export function filterRevalidateKind(f) {
  return revalidateKind(f) || (f._source && !f._sourcePass ? 'revalidation' : '')
}

export function matchesConfirmed(group) {
  const kinds = activeRevalidateKinds('confirmed', '')
  return group.some((f) => kinds.includes(filterRevalidateKind(f)))
}

// The outcome a fresh load opens on, given the auto-tuned floor:
// 'confirmed' when Confirmed costs nothing on screen, else ''. Asked of
// FINDINGS, not rows: every finding visible under the default range (a row
// shows whole, unscored members too) must be visible in some row under
// Confirmed (finding-filters.js confirmedIsDefault, through
// filterRevalidateKind for the shown side). Something must be on screen,
// and Confirmed must be reachable by the pass's own, real values — a set
// of nothing but imports has no dropdown to clear the filter with.
export function defaultRevalidateFilter(groups, confMin) {
  const visible = groups.map(drawnTabs).filter((g) => g.length > 0)
  return confirmedIsDefault(visible, confMin, confirmedCoverage(groups, drawnTabs, revalidateKind), revalidateKind) ? 'confirmed' : ''
}

// The floor rule lives in finding-filters.js; asked here through the lens.
export function defaultConfidenceFloor(groups) {
  return confidenceFloor(groups, drawnTabs)
}

// Basic App view can fix the outcome to Confirmed only when it is already
// the opening default, Confirmed covers every finding the opening confidence
// range would show, and it also covers every non-LOW row the 6–10 range would
// show. LOW rows below the opening floor are deliberately allowed to remain
// hidden: a large set can open at 7 or 8, so those rows are outside the
// reader's default view even though they sit in the broader 6–10 band.
export function shouldLockConfirmed(groups) {
  if (state.showRevalidation === false || state.upstreamOnly || underlyingFindingsShown()) return false
  return canLockConfirmed(groups, { tabs: drawnTabs, kindOf: revalidateKind, severityMode: state.severityMode })
}

// Put the confidence block (one control, two faces: an outcome, else the
// range) where a fresh load of `groups` — the groups the view SHOWS — would
// put it. Shared by a load's first report, a whole workspace once every
// member is in, and the App switch, which reshapes the set (events.js).
export function applyOpeningFilters(groups, { resetSort = true } = {}) {
  state.filterConfMin = defaultConfidenceFloor(groups)
  state.filterConfMax = 10
  state.filterRevalidate = defaultRevalidateFilter(groups, state.filterConfMin)
  state.filterPartial = ''
  if (resetSort) state.sortBy = priorityApplies(groups) ? 'priority-desc' : 'severity'
}

// The filters a team's Kanban board opens on (and a team link opens it on
// again): applyOpeningFilters' choices over every status on it, the range
// at 0—10 where render.js drops it (rangeApplies). Asked of the board as it
// is now, never of how this view happened to open.
function kanbanOpening(groups) {
  const drawn = groups.map(drawnTabs).filter((g) => g.length > 0)
  const floor = defaultConfidenceFloor(groups)
  return { filterConfMin: drawn.length > 0 && rangeApplies(drawn) ? floor : 0, filterConfMax: 10,
    filterRevalidate: defaultRevalidateFilter(groups, floor), filterPartial: '' }
}

// The repository and severities the board is filtered to, for a team link
// that opens it so (common/managed/routes.js) — only when they are ALL it
// is filtered by, so the link names the view exactly or not at all. Null
// when neither is set, or for the "no repository" choice no link names.
export function linkedFilters() {
  if (state.filterRepo === NO_REPO_SENTINEL || (!state.filterRepo && state.filterSeverities.size === 0)) return null
  // Every other filter's "off" is an empty set or string, but for those
  // the board opens on; the search's negation is nothing without a search.
  const opening = ['filterConfMin', 'filterConfMax', 'filterRevalidate', 'filterPartial']
  for (const key of FILTER_FIELDS) {
    if (opening.includes(key) || key === 'filterRepo' || key === 'filterSeverities' || key === 'filterIncludeNegate') continue
    if (state[key] instanceof Set ? state[key].size > 0 : state[key] !== '') return null
  }
  const opens = kanbanOpening(getMergedGroups())
  if (opening.some((key) => state[key] !== opens[key])) return null
  return {
    ...(state.filterRepo ? { repo: state.filterRepo } : {}),
    ...(state.filterSeverities.size > 0 ? { severities: [...state.filterSeverities] } : {}),
  }
}

// A team link's filters on its board once the findings are in: every other
// filter as the board opens, the sort left alone. A repository the board
// has no choice for is left out rather than emptying it.
export function applyLinkedFilters(filters) {
  const sortBy = state.sortBy
  const groups = getMergedGroups()
  resetFilters()
  Object.assign(state, kanbanOpening(groups), { sortBy })
  if (filters?.repo && repositoryFilterValues(applyScopeFilters(groups)).has(filters.repo)) state.filterRepo = filters.repo
  if (filters?.severities?.length > 0) state.filterSeverities = new Set(filters.severities)
}

// Priority orders the view only when every row can be ordered. A row with
// App entries needs a priority on one of THEM (a source copy can't vouch
// for it while the App layer is on screen) — or, with no explicit priority
// anywhere in the row, a ruled-out App entry's implicit 0.
export function priorityApplies(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return false
  return groups.every((group) => {
    if (priorityForGroup(group) === undefined) return false
    const app = group.filter((f) => f.isApp)
    if (app.length === 0) return true
    const rowHasExplicit = group.some((f) => f.priority !== undefined)
    return app.some((f) => f.priority !== undefined
      || (!rowHasExplicit && isRuledOut(f)))
  })
}

// A row's priority: its first explicit one, else 0 for a row with a
// ruled-out finding (a stable place in the ordering), else undefined.
export function priorityForGroup(group) {
  const explicit = group.find((f) => f.priority !== undefined)
  if (explicit) return explicit.priority
  return group.some(isRuledOut) ? 0 : undefined
}

// The source and confidence / outcome selectors: the scope for the
// second-row counts and the repository choices.
function matchesScopeFilters(f) {
  const F = activeFilters()
  // Source: one side picked restricts to it; none or both is no filter.
  if (F.filterSources.size === 1) {
    const allowOwn = F.filterSources.has('own')
    if (allowOwn && isModule(f.file)) return false
    if (!allowOwn && !isModule(f.file)) return false
  }
  // Outcome: one option can cover several values (Confirmed takes the pass's
  // row and the findings no pass judged, filterRevalidateKind).
  if (F.filterRevalidate) {
    const kinds = activeRevalidateKinds(F.filterRevalidate, F.filterPartial)
    if (kinds && !kinds.includes(filterRevalidateKind(f))) return false
  }
  // Confidence: SKIPPED while an outcome is selected, which replaces the
  // range in its toolbar block (conf-filter.js) — asking for the refuted
  // findings asks for all of them. Lower at 0 lets findings with no place
  // on the scale through (a `critical: true` finding and an import sit at
  // 10, confidenceOnScale); upper at 10 means no cap. A ruled-out row reads
  // as 0 whatever it claims: a group shows when any tab matches, and a
  // refuted 10 must not float it over a floor its surviving rows can't
  // meet (`[{plain 3}, {refuted 10}]` behaves as a 3).
  if (!F.filterRevalidate) {
    const conf = isRuledOut(f) ? 0 : confidenceOnScale(f)
    if (conf === undefined) {
      if (F.filterConfMin > 0) return false
    } else {
      if (conf < F.filterConfMin) return false
      if (F.filterConfMax < 10 && conf > F.filterConfMax) return false
    }
  }
  return true
}

// The search query case-folded, with the words long enough to match an ID,
// worked out once per query rather than per finding.
let searchQuery = { raw: '', inc: '', idWords: [] }
function searchOf(raw) {
  if (searchQuery.raw !== raw) {
    const inc = raw.toLowerCase()
    searchQuery = { raw, inc, idWords: inc.length >= 6 ? inc.split(/\s+/u).filter(word => word.length >= 6) : [] }
  }
  return searchQuery
}

// Per-tab predicate: one matching tab keeps the whole group (applyFilters).
export function matchesFilters(f) {
  return matchesEntryFilters(f) && matchesRunFilters(f)
}

// All of it but the `<analyzer-select>` dimensions, which a row holding a
// pass row asks as a whole (matchesRunRow). The annotation filters are
// group-level (matchesAnnotationFilters).
function matchesEntryFilters(f) {
  if (!matchesScopeFilters(f)) return false
  const F = activeFilters()
  const { inc, idWords } = searchOf(F.filterInclude)
  // Multi-select: empty = no filter; an unmarked tab's color is `'none'`.
  if (F.filterSeverities.size > 0 && !F.filterSeverities.has(displayedSeverity(f, state.severityMode))) return false
  if (F.filterColors.size > 0 && !F.filterColors.has(triageEntry(f)?.color ?? 'none')) return false
  if (F.filterRepo && repoOfFinding(f) !== (F.filterRepo === NO_REPO_SENTINEL ? null : F.filterRepo)) return false
  if (inc) {
    // The triage comment and fix live in `state.triage`, out of
    // findingText's reach, so they are matched here.
    const entry = triageEntry(f)
    const hit = findingText(f).includes(inc)
      || (entry?.comment ?? '').toLowerCase().includes(inc)
      || (entry?.fix ?? '').toLowerCase().includes(inc)
      // Short words still search text, but must not match incidental ID fragments.
      || idWords.some(word => f.id?.toLowerCase().includes(word))
    // Negated, the query keeps the findings that DON'T match.
    return F.filterIncludeNegate ? !hit : hit
  }
  return true
}

// A tri-state '' / 'with' / 'without' filter over a whole-group test.
const triState = (mode, has) => !mode || (mode === 'with') === has()

// Group-level annotation filters. Not per tab: 'without' must mean NO tab
// carries it, the exact complement of 'with' (some tab does). Issue is the
// managed issue saved for the finding (managed-issues.js).
const ANNOTATION_FILTERS = [
  ['filterComment', (f) => Boolean(triageEntry(f)?.comment)],
  ['filterIssue', (f) => Boolean(managedIssueFor(f))],
  ['filterFix', (f) => Boolean(triageEntry(f)?.fix || automaticFixFor(f))],
  ['filterFlagged', (f) => triageEntry(f)?.flagged === true],
]
function matchesAnnotationFilters(group) {
  const F = activeFilters()
  return ANNOTATION_FILTERS.every(([key, has]) => triState(F[key], () => group.some(has)))
}

// The npm package a finding carries, or the one its dependency path names;
// null for own source (a top-level directory is no package).
function npmPackageOfFinding(f) {
  const npm = f?.package?.npm
  if (typeof npm?.name === 'string' && npm.name && !isPlaceholderNpmPackage(npm)) return npm.name
  const file = typeof f?.file === 'string' ? f.file : ''
  const match = /(?:^|\/)(?:node_modules|dependencies|vendor)\/(@[^/]+\/[^/]+|[^/]+)(?:\/|$)/u.exec(file)
  return match?.[1] ?? null
}

// App mode is the default revalidation lens, the upstream lens excluded;
// the detail stop doesn't change the mode. The two filters below are
// offered in different modes.
function appLensActive() {
  return state.showRevalidation !== false && !state.upstreamOnly
}

// A source row is cross-context when its visible findings span repositories
// or npm packages; an unknown context is not a second one.
export function isCrossContextGroup(group) {
  if (appLensActive()) return false
  const visible = drawnTabs(group)
  if (visible.length < 2) return false
  const repos = new Set()
  const packages = new Set()
  for (const f of visible) {
    const repo = repoOfFinding(f)
    if (repo) repos.add(repo)
    const pkg = npmPackageOfFinding(f)
    if (pkg) packages.add(pkg)
  }
  return repos.size > 1 || packages.size > 1
}

// An App stack is a row of more than one App finding (`[App, App]`, not
// `[App, source, source]`), counted off the row itself: the drawn tabs may
// fold two App findings with different stamps into one pass.
export function isAppStackedGroup(group) {
  if (!appLensActive() || drawnTabs(group).length === 0) return false
  return group.filter((f) => f.isApp).length > 1
}

// `isSecurity` is propagated over whole original rows, so a hidden tab
// still classifies its row.
function isSecurityGroup(group) { return group.some((f) => f.isSecurity === true) }

export function hasSecurityContrast(groups) {
  return groups.some(isSecurityGroup) && groups.some((g) => !isSecurityGroup(g))
}

// The rows severity / color counts and repository choices are read from:
// the scope filters only, then each row's visible tabs (App mode folds
// underlying findings, which must not contribute values).
export function applyScopeFilters(groups) {
  return scopeRows(groups).map(drawnTabs)
}

// The same rows, whole: the `<analyzer-select>` counts ask for the rows App
// mode folds under the pass's, as applyFilters does.
export function scopeRows(groups) {
  return groups.filter((g) => g.some(matchesScopeFilters))
}

// Per-tab filters via `g.some`, then the group-level ones. A row holding a
// pass row asks the `<analyzer-select>` dimensions of the row as a whole
// (matchesRunRow): App mode draws the pass's row, and the Model asked for is
// one of the scans beneath it, which need not agree with it on severity,
// confidence or outcome.
export function applyFilters(groups) {
  const F = activeFilters()
  const duplicatesMode = !state.currentWorkspace && F.filterDuplicates
  const duplicateIds = duplicatesMode ? reportDuplicateIds() : null
  return groups.filter((g) => (g.some(isRevalidation) ? g.some(matchesEntryFilters) : g.some(matchesFilters)) && matchesRunRow(g)
    && matchesAnnotationFilters(g)
    && triState(duplicatesMode, () => g.some((f) => duplicateIds.has(tabKey(f))))
    && triState(F.filterCrossContext, () => isCrossContextGroup(g))
    && triState(F.filterAppStacked, () => isAppStackedGroup(g))
    && triState(F.filterSecurity, () => isSecurityGroup(g)))
}

// Confidence sort: `critical: true` findings (the flag, not the severity)
// without a confidence join the 10 bucket, above real 10s either way.
// Valueless findings go to the far end (-1 descending, 11 ascending); the
// file path breaks ties.
function confidenceSorter(dir) {
  const missing = dir === 'desc' ? -1 : 11
  return (pa, pb) => {
    const aCrit = pa.confidence === undefined && pa.critical === true
    const bCrit = pb.confidence === undefined && pb.critical === true
    const va = pa.confidence ?? (aCrit ? 10 : missing)
    const vb = pb.confidence ?? (bCrit ? 10 : missing)
    return (dir === 'desc' ? vb - va : va - vb)
      || (aCrit === bCrit ? 0 : aCrit ? -1 : 1)
      || pa.file.localeCompare(pb.file)
  }
}

// Comparators over each group's primary tab. Severity: rank, then
// confidence as the confidence sort reads it, then line.
const confDescCmp = confidenceSorter('desc')
const SORTERS = {
  severity: (pa, pb) =>
    (SEVERITY_ORDER[displayedSeverity(pb, state.severityMode)] || 0) - (SEVERITY_ORDER[displayedSeverity(pa, state.severityMode)] || 0)
    || confDescCmp(pa, pb)
    || parseInt(pa.line, 10) - parseInt(pb.line, 10),
  'confidence-desc': confDescCmp,
  'confidence-asc':  confidenceSorter('asc'),
}
const PRIORITY_SORTS = { 'priority-desc': 'desc', 'priority-asc': 'asc' }

// Group-level sort; an unrecognised `state.sortBy` ('file' is grouped
// elsewhere) keeps insertion order. Each group's primary tab / priority is
// resolved once, not per comparison (primaryTab re-sorts a group's tabs).
export function applySorting(groups) {
  const dir = Object.hasOwn(PRIORITY_SORTS, state.sortBy) ? PRIORITY_SORTS[state.sortBy] : null
  if (dir) {
    // By the row's priority (priorityForGroup), valueless rows last.
    const missing = dir === 'desc' ? -1 : 11
    return groups
      .map((g) => ({ p: priorityForGroup(g), g }))
      .toSorted((a, b) => {
        const va = a.p ?? missing
        const vb = b.p ?? missing
        return (dir === 'desc' ? vb - va : va - vb)
          || primaryTab(a.g).file.localeCompare(primaryTab(b.g).file)
      })
      .map((x) => x.g)
  }
  const cmp = SORTERS[state.sortBy]
  if (!cmp) return [...groups]
  return groups
    .map((g) => ({ p: primaryTab(g), g }))
    .toSorted((a, b) => cmp(a.p, b.p))
    .map((x) => x.g)
}
