import { isPlaceholderNpmPackage, state } from '#client/index.js'
import { SEVERITY_ORDER, activeRevalidateKinds, displayedSeverity, findingText, isModule, isRuledOut, prettyModel, revalidateKind, voidsConfidence } from './format.js'
import { drawnTabs, primaryTab, tabKey, triageEntry, underlyingFindingsShown } from './group.js'
import { reportDuplicateIds } from './report-duplicates.js'

// Stand-in for the "no analyzer" bucket in the analyzer dropdown.
// Plain `'null'` would collide with a legitimate analyzer literally
// named `"null"` (a valid name) — both would render as
// `<option value="null">` and conflate. A NUL character won't be a
// real analyzer name and roundtrips through HTML option values +
// state.filterAnalyzer fine. Written as the `\u0000` escape (NOT a
// literal NUL byte): a literal NUL trips git's / GitHub's binary-file
// heuristic, which then suppresses textual diffs for this whole file.
export const NULL_ANALYZER_SENTINEL = '\u0000'

// Same idea for the workspace-view repo dropdown — stands in for
// findings whose repo can't be derived (no `repo.github` AND no
// `_repoFallback` URL). Deliberately a different control character
// from NULL_ANALYZER_SENTINEL so the two dropdowns can't silently
// couple through a shared sentinel value — no current reader
// compares both off one source, but the distinct bytes keep that
// safety property explicit. Written as the `\u0001` escape for the same
// source-stays-text reason as NULL_ANALYZER_SENTINEL above.
export const NO_REPO_SENTINEL = '\u0001'

// Third control-character sentinel — the "(no model)" bucket in the
// model column of the analyzer/model dropdown (`<analyzer-select>`).
// Distinct byte from the two above for the same no-silent-coupling
// reason: the analyzer and model dimensions sit side by side in one
// control, so sharing NULL_ANALYZER_SENTINEL would make a "(none)"
// analyzer and a "(no model)" selection indistinguishable in state.
// Written as the `\u0002` escape — see NULL_ANALYZER_SENTINEL for why
// not a literal control byte.
export const NULL_MODEL_SENTINEL = '\u0002'

// A finding's model dimension for the analyzer/model dropdown — the
// pretty display name (the form the header combo tags and per-finding
// run-meta lines already show), so vendor-prefixed spellings of the
// same model (`anthropic/claude-opus-4-7` vs `claude-opus-4-7`)
// collapse into one filterable bucket instead of two identical-looking
// options. `null` when the finding carries no model (source-marked
// imports never stamp run meta onto findings). `||` rather than `??`
// so a blank-string model joins the null bucket instead of becoming an
// empty option label.
export function modelOfFinding(f) {
  return prettyModel(f.model) || null
}

// Analyzer + model dimension predicate — the two run-meta checks of
// the toolbar's `<analyzer-select>` dropdown, factored out of
// matchesFilters because group.js's activeTabFor ALSO consults it:
// when the dropdown narrows the view, the tab a dedup group opens on
// by default should be one the filter actually matched, not whichever
// sorted first. A separate export (rather than reusing matchesFilters)
// keeps the default-tab preference from dragging the search box /
// severity / confidence state into tab resolution.
//
// Analyzer: empty = no filter. Findings with no analyzer
// (`_analyzer === null`) match NULL_ANALYZER_SENTINEL; other values
// are straight string equality.
//
// Model: matched on `modelOfFinding` (the pretty name; see that
// helper for why). Findings with no model match NULL_MODEL_SENTINEL.
//
// Both dimensions are evaluated per-finding, so selecting both means
// "SOME finding carries this exact analyzer+model combination" — not
// one finding with the analyzer and a different one with the model.
export function matchesRunFilters(f) {
  const F = activeFilters()
  if (F.filterAnalyzer) {
    const a = f._analyzer ?? null
    const want = F.filterAnalyzer === NULL_ANALYZER_SENTINEL ? null : F.filterAnalyzer
    if (a !== want) return false
  }
  if (F.filterModel) {
    const m = modelOfFinding(f)
    const want = F.filterModel === NULL_MODEL_SENTINEL ? null : F.filterModel
    if (m !== want) return false
  }
  return true
}

// Resolve a finding's repo to a single string key, or null when no
// repo signal is available. DeepView App findings describe the app in
// their report, even when their source code lives in a dependency repo.
// Prefer their report's repo (stamped at ingest as `_repoFallback`) for
// both the repository selector and its matching predicate. Other findings
// keep the source repo first. File/source links resolve separately.
export function repoOfFinding(f) {
  const reportRepo = typeof f._repoFallback === 'string' && f._repoFallback ? f._repoFallback : null
  if (f.isApp && !(f._source ?? f.source) && reportRepo) return reportRepo
  if (typeof f.repo?.github === 'string' && f.repo.github) return f.repo.github
  return reportRepo
}

// The caller supplies the scope-filtered, visible tabs from applyScopeFilters.
// Use the same repo resolver for both selector choices and matching.
export function repositoryFilterValues(groups) {
  const repos = new Set()
  for (const group of groups) {
    for (const finding of group) repos.add(repoOfFinding(finding))
  }
  return repos
}

export function resetFilters() {
  state.filterSeverities = new Set()
  state.filterColors = new Set()
  state.filterSources = new Set()
  state.filterAnalyzer = ''
  state.filterModel = ''
  state.filterRepo = ''
  state.filterConfMin = 0
  state.filterConfMax = 10
  state.filterInclude = ''
  state.filterIncludeNegate = false
  state.filterComment = ''
  state.filterFix = ''
  state.filterFlagged = ''
  state.filterDuplicates = ''
  state.filterCrossContext = ''
  state.filterAppStacked = ''
  // Including the revalidation outcome: this is "no filters", and one
  // that survived would keep hiding findings after a reset — which
  // matters more now that a revalidation report can OPEN on it (see
  // ingest.js maybeDefaultToConfirmed), and that the deep-link and
  // graph-jump paths reset precisely so the finding they navigate to
  // is on screen.
  state.filterRevalidate = ''
  state.filterPartial = ''
  // Opening sort is derived from the complete, merged view in
  // applyOpeningFilters(). Reports are ingested one at a time, so
  // looking at state.reports here would let an early report decide the
  // sort before the workspace's other rows have arrived.
  state.sortBy = 'severity'
}

// Every `filter*` field the predicates below read — the same set
// `resetFilters` clears, which is what makes a clone of them a complete
// stand-in for `state` as far as filtering is concerned.
const FILTER_FIELDS = [
  'filterSeverities', 'filterColors', 'filterSources',
  'filterAnalyzer', 'filterModel', 'filterRepo',
  'filterConfMin', 'filterConfMax',
  'filterInclude', 'filterIncludeNegate',
  'filterComment', 'filterFix', 'filterFlagged', 'filterDuplicates', 'filterCrossContext', 'filterAppStacked',
  'filterRevalidate', 'filterPartial',
]

// A detached copy of the current filter selection. The Sets are copied
// too, so a caller can relax one without reaching back into the
// toolbar's. For the export confirm dialog, which lets a user drop a
// filter from what it is about to write WITHOUT changing what the app
// is showing.
export function cloneFilterFields() {
  const out = {}
  for (const key of FILTER_FIELDS) {
    const v = state[key]
    out[key] = v instanceof Set ? new Set(v) : v
  }
  return out
}

// While set, the predicates read their `filter*` values from here
// instead of `state` — everything else (triage entries, severityMode)
// still comes from `state`, since only the selection is being stood in
// for. Deliberately sticky rather than a callback wrapper: print has to
// hold it across a render and the browser's own print dialog, which no
// synchronous scope can span. Callers pair it with `clearFilterOverride`
// in a `finally` / restore path.
let filterOverride = null

export function setFilterOverride(fields) { filterOverride = fields }
export function clearFilterOverride() { filterOverride = null }

// `state` unless something is standing in for it. Read once per
// predicate call rather than per field, so a filter pass can't see half
// of one selection and half of another. Exported for the markdown
// adapter, which describes in its file's header the selection the file
// was written under — the one its own `applyFilters` pass read.
export function activeFilters() {
  return filterOverride ?? state
}

// Does the confidence floor leave this group on screen? The rule
// matchesFilters applies below, with the upper bound at 10 so only the
// floor bites, hoisted to the group because that is the unit the list
// shows: a group is on screen when ANY of its rows clears the floor —
// an unscored row only at floor 0 unless it is flagged `critical`, and
// a row the pass knocked down reading as 0 whatever number it carries.
// A finding's place on the 0—10 confidence scale, or undefined when it
// has none. The one reader every confidence question goes through:
// what the range matches, what the auto-tune counts, and whether the
// control is offered at all (render.js hasAnyConfidence).
//
// Three ways to have a place:
//
//   * a `confidence` the analyzer scored it with;
//   * `critical: true` — the boolean, NOT `severity: 'critical'` —
//     which stands in for a top score;
//   * coming from another producer at all. An import carries no
//     confidence because its producer doesn't emit one (Claude
//     Security's parser reads none), not because anyone was unsure —
//     there is no doubt here for a floor to act on. Reading it as 10
//     keeps it on screen under any floor and out only under a cap
//     that excludes the top: `8—10` and `2—10` show it, `0—5` and
//     `7—9` don't. It also stops one imported report from taking the
//     range away from a workspace: an unscored finding DISABLES the
//     control for everyone (render.js), which left the range filtering
//     nothing and every low-confidence row on screen.
//
// A row the pass knocked down reads as 0 instead, where that matters
// (voidsConfidence) — applied by the callers, since whether a finding
// has a place at all is about the finding, not about the pass.
export function confidenceOnScale(f) {
  if (f.confidence !== undefined) return f.confidence
  if (f.critical === true || f._source) return 10
  return undefined
}

// Does this finding put itself on the scale, rather than ride the
// stand-in confidenceOnScale hands a row that carries no score? A
// number its producer wrote, or the `critical: true` that stands in
// for one.
const scoresItself = (f) => f.confidence !== undefined || f.critical === true

// Is the confidence range a live control over these rows — offered,
// and actually filtering? Two conditions, which the toolbar reads as
// one (render.js hasAnyConfidence):
//
//   * every row has a place on the scale, or the first lift off 0
//     would silently drop the ones that don't. A single analyzer
//     finding with no confidence and no `critical: true` disables the
//     control for the whole set;
//   * something on screen puts ITSELF on that scale. A row riding the
//     stand-in doesn't: a set of nothing but unscored imports is all
//     10s by definition, and a range over one value says nothing.
//     There the control isn't disabled, it isn't offered at all — the
//     toolbar drops the whole block when the outcome dropdown beside
//     it has nothing to offer either.
//
//     What answers this is the SCORE, not who wrote it. Asked as "not
//     an import" it gave the same answer for every producer that emits
//     no confidence — and the wrong one for DeepSec, which rates every
//     finding it reports and whose words this app places on the scale
//     itself (report/src/parse-deepsec.js). A workspace of nothing but
//     DeepSec reports is a real range over real numbers, and asking
//     for a non-import took the slider, the confidence sort and the
//     opening floor away from exactly the load whose producer had
//     scored every row in it.
//
// Both halves are asked of the rows ON SCREEN by every caller, since
// this is about a control in front of a reader.
export function rangeApplies(groups) {
  return groups.every((g) => g.every((f) => confidenceOnScale(f) !== undefined))
    && groups.some((g) => g.some(scoresItself))
}

function showsAtConfidence(g, min) {
  return g.some((f) => {
    const conf = voidsConfidence(f) ? 0 : confidenceOnScale(f)
    return conf === undefined ? min === 0 : conf >= min
  })
}

// The confidence floor a freshly-loaded set should OPEN on, tuned so
// the initial view fits ~25 groups. Step up 6 → 7 → 8 until the
// visible count is within budget; cap at 8 (the old static default).
// Nothing carrying a confidence at all means no floor — without that
// guard countAtMin(6) = 0 ≤ 25 lands it at 6, which then excludes
// every finding; 0 lets the filter no-op instead, and the toolbar
// hides the control anyway (see toolbarHtml in render.js).
//
// After picking the base, walk DOWN while each lower step surfaces no
// new groups — i.e. there's a "gap" in the confidence distribution
// below the chosen floor. Lowering for free puts the slider at the
// natural break: e.g. picked 8, nothing at 7 or 6 but some at 5 →
// settle at 6 (the lowest step revealing nothing new). Down to 0.
//
// Pure in its argument, and paired with defaultRevalidateFilter below:
// together they are "what does this set open on", asked by ingest.js
// on a first load and again by the App switch (events.js), which
// reshapes the set and so has to ask again rather than keep an answer
// that was about a different one.
export function defaultConfidenceFloor(groups) {
  // App mode folds the source tabs a revalidation pass already answered
  // under its App tab. Those hidden copies must not lower the opening floor
  // for a workspace that otherwise has the same visible rows as its App
  // report. Keep source-only rows intact; they are real rows in the App view.
  const visible = groups.map(drawnTabs).filter((g) => g.length > 0)
  if (!visible.some((g) => g.some((f) => confidenceOnScale(f) !== undefined))) return 0
  const countAtMin = (min) => visible.reduce((n, g) =>
    n + (g.some((f) => (confidenceOnScale(f) ?? -1) >= min) ? 1 : 0), 0)
  let base
  if (countAtMin(6) <= 25) base = 6
  else if (countAtMin(7) <= 25) base = 7
  else base = 8
  while (base > 0 && countAtMin(base - 1) === countAtMin(base)) base--
  return base
}

// The outcome a row ANSWERS TO when the toolbar filters by one — the
// pass's own reading where there is one, and `revalidation` (the value
// naming the pass itself) for a row NO pass ever reached.
//
// A product's import — Claude Security, Codex Security, DeepSec,
// Piolium; anything carrying a `source` marker, which is everything
// that isn't DeepView's own dump (file-display.js PRODUCER_LABELS) —
// was never put in front of DeepView's revalidation pass, so that pass
// never ruled it out. Where nothing else judged it either, it stands,
// exactly as a row the pass re-examined and left alone stands. That
// makes such a finding permanently part of the app view and
// permanently Confirmed: the App switch has no layer to take off it,
// and picking Confirmed in a workspace that mixes a revalidated report
// with imported ones keeps the imports on screen instead of filtering
// them away for lacking a stamp they could never have carried.
//
// But a product can run a pass of its own and write down what it
// concluded. DeepSec does, and this app reads it
// (report/src/parse-deepsec.js). There the stand-in would be a claim
// the document doesn't make — a finding that report left unjudged is
// not one it confirmed — and applied to every unstamped row it would
// empty Confirmed of meaning for exactly the imports that arrive with
// real verdicts. So the stand-in asks whether the producer's own pass
// reached the report this row came from at all (`_sourcePass`, stamped
// per finding by ingest.js), and stands aside where it did: the row
// then answers nothing, the same as the analyzer's own unstamped rows
// in a revalidated report.
//
// Only the two filter questions below read this. What a card DRAWS
// still comes from format.js's own readers, so an imported finding
// grows no stamp it wasn't given — and the toolbar's option list is
// still scanned off the real values (render.js), so a set with no pass
// anywhere gets no dropdown rather than a Confirmed option that
// matches every finding in it.
//
// A stamp the row DOES carry always wins: a product's finding its own
// pass refuted is refuted like any other. The stand-in only fills the
// gap where there is no verdict to read and no pass that could have
// left one.
export function filterRevalidateKind(f) {
  return revalidateKind(f) || (f._source && !f._sourcePass ? 'revalidation' : '')
}

export function matchesConfirmed(group) {
  const kinds = activeRevalidateKinds('confirmed', '')
  return group.some((f) => kinds.includes(filterRevalidateKind(f)))
}

// The floor the default view will REALLY apply. The range is a
// whole-set control: one finding on screen with no confidence and no
// `critical: true` and render.js disables it and resets the bounds to
// 0—10 (hasAnyConfidence there), so the auto-tuned floor never bites
// and every row is on screen — an unscored finding is not hidden by a
// filter that isn't running. Measuring the comparison below against a
// floor the view is about to throw away would be measuring a screen
// nobody sees.
//
// `critical: true` rides the 10 bucket in place of a score
// (matchesFilters), so it doesn't block the range any more than a
// number does.
//
// render.js asks this of the on-screen bucket and we ask it of the
// whole set; at open time, before anything is triaged away, they are
// the same groups.
function effectiveFloor(groups, confMin) {
  return rangeApplies(groups) ? confMin : 0
}

// The revalidation outcome a freshly-loaded set should OPEN on, given
// the confidence floor ingest.js just auto-tuned: `'confirmed'` for a
// revalidation report, `''` (no outcome) for everything else.
//
// The two share a toolbar block and only one of them can lead
// (conf-filter.js), so this is the switch the dropdown would make by
// hand; the floor stays set underneath, and clearing the outcome
// hands back the range that would otherwise have been the default.
//
// The question is what Confirmed would COST, asked of findings rather
// than of rows: every finding visible as part of a visible row under
// the default range has to be visible as part of some visible row
// under Confirmed. If it is, Confirmed leads.
//
// Findings, not rows, because a row is not a thing that goes missing.
// Two reports over the same code — an analysis and the revalidation
// of it — put the same finding in two rows, and Confirmed dropping
// the un-stamped copy loses nothing while the stamped row still shows
// it. Nor is a whole row the unit of what a row costs: a row shows in
// FULL when any of its findings answers the filter, so a row visible
// under the range carries its unscored members onto the screen with
// it, and those are findings Confirmed can lose.
//
// What Confirmed shows is the dropdown's own answer — the confirmed,
// the PARTIAL and the pass's own rows (REVALIDATE_FILTERS), with the
// partial chip where a fresh load leaves it — read through
// filterRevalidateKind, so an import the pass never saw counts as
// shown rather than as a loss.
//
// Two conditions beyond that:
//   * something has to BE on screen, or an empty load opens on a
//     filter for no reason;
//   * Confirmed has to be REACHABLE, and by the pass's OWN answer —
//     asked of the real values, not filterRevalidateKind's reading.
//     An import riding Confirmed is a finding the pass never saw, and
//     a set of nothing but imports carries no pass at all: the
//     toolbar offers it no dropdown (render.js scans the real values
//     too), so opening it on an outcome would set a filter with no
//     control on screen to clear it.
//
// Both the opening default and the dropdown lock use the same coverage:
// findings represented by Confirmed rows, plus findings explicitly ruled out.
// Read the original groups before drawnTabs folds away their source members.
function confirmedCoverage(groups) {
  // A workspace may carry an un-stamped source copy from report A while
  // report B explicitly ruled out the same id. The ruled-out copy is
  // removed before workspace rows are merged, so it cannot vouch for its
  // source copy during the coverage check below. Remember those ids before
  // that projection disappears: Confirmed may hide the source copy too,
  // even when the App finding that caused the ruling has no
  // `revalidateInputs` list of its own.
  const covered = new Set(groups.ruledOutIds ?? [])
  for (const raw of groups) {
    for (const f of raw) if (isRuledOut(f)) covered.add(tabKey(f))
  }
  for (const raw of groups) {
    const g = drawnTabs(raw)
    if (g.length === 0) continue
    if (!matchesConfirmed(g)) continue
    // A folded source copy is not a cost of Confirmed, but its id is still
    // represented by the App row. Keep all raw members in the coverage set
    // so a duplicate source-only row from another report is recognized as
    // the same issue rather than making Confirmed look lossy.
    for (const f of raw) {
      covered.add(tabKey(f))
      // App reports can carry the source findings they represent only as
      // `revalidateInputs`, rather than as members of the same physical row.
      // Those inputs are still present in the App row's visible result, so a
      // duplicate source-only row from another report must not keep the
      // workspace on Confidence.
      if (f.isApp && Array.isArray(f.revalidateInputs)) {
        for (const id of f.revalidateInputs) if (id) covered.add(id)
      }
    }
  }
  return covered
}

function confirmedIsDefault(visible, confMin, covered) {
  const floor = effectiveFloor(visible, confMin)
  const shown = visible.filter((g) => showsAtConfidence(g, floor))
  if (shown.length === 0) return false
  const kinds = new Set(activeRevalidateKinds('confirmed', ''))
  if (!visible.some((g) => g.some((f) => kinds.has(revalidateKind(f))))) return false
  return shown.every((g) => g.every((f) => covered.has(tabKey(f))))
}

export function defaultRevalidateFilter(groups, confMin) {
  const visible = groups.map(drawnTabs).filter((g) => g.length > 0)
  return confirmedIsDefault(visible, confMin, confirmedCoverage(groups)) ? 'confirmed' : ''
}

// Basic App view can fix the outcome to Confirmed only when it is already
// the opening default, Confirmed covers every finding the opening confidence
// range would show, and it also covers every non-LOW row the 6–10 range would
// show. LOW rows below the opening floor are deliberately allowed to remain
// hidden: a large set can open at 7 or 8, so those rows are outside the
// reader's default view even though they sit in the broader 6–10 band.
export function shouldLockConfirmed(groups) {
  if (state.showRevalidation === false || state.upstreamOnly || underlyingFindingsShown()) return false
  const visible = groups.map(drawnTabs).filter((g) => g.length > 0)
  const covered = confirmedCoverage(groups)
  if (!confirmedIsDefault(visible, defaultConfidenceFloor(groups), covered)) return false
  const floor = effectiveFloor(visible, 6)
  return visible.every((g) => !showsAtConfidence(g, floor)
    || !g.some((f) => displayedSeverity(f, state.severityMode) !== 'low')
    || g.every((f) => covered.has(tabKey(f))))
}

// Put the confidence block where a fresh load of `groups` would put
// it — the two questions above asked together, with the fields each
// answer replaces cleared alongside it. That block is one control
// with two faces (conf-filter.js): an outcome, when the set has one
// to lead with, and the range underneath it otherwise.
//
// One helper because three callers ask it of three different moments
// and have to agree:
//
//   * the first report of a load (ingestReport);
//   * the whole workspace, once every member is in
//     (switchToWorkspace) — a workspace is ONE view over its reports,
//     and asked report by report the answer is whichever member
//     happened to load first;
//   * the App switch, which reshapes the set and so has to ask again
//     rather than keep an answer that was about a different one
//     (events.js).
//
// Always the groups the view SHOWS — getMergedGroups, not a report's
// own — since that is the set the answer will be applied to.
export function applyOpeningFilters(groups, { resetSort = true } = {}) {
  state.filterConfMin = defaultConfidenceFloor(groups)
  state.filterConfMax = 10
  state.filterRevalidate = defaultRevalidateFilter(groups, state.filterConfMin)
  state.filterPartial = ''
  if (resetSort) state.sortBy = priorityApplies(groups) ? 'priority-desc' : 'severity'
}

// Priority is a meaningful ordering only when every visible row can be
// ordered. A workspace can merge a priority-stamped source finding from one
// report with an App finding from another, so checking for any priority would
// promote an ordering whose primary App entries have no value. Rows carrying
// App entries must have a priority on one of those App entries; a source copy
// cannot stand in for it while the App layer is on screen.
export function priorityApplies(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return false
  return groups.every((group) => {
    if (priorityForGroup(group) === undefined) return false
    const app = group.filter((f) => f.isApp)
    if (app.length === 0) return true
    // A ruled-out App finding has a useful implicit priority of zero when
    // the row has no explicit priority anywhere. An explicit source-copy
    // priority cannot vouch for an App entry in a row that has one.
    const rowHasExplicit = group.some((f) => f.priority !== undefined)
    return app.some((f) => f.priority !== undefined
      || (!rowHasExplicit && isRuledOut(f)))
  })
}

// A ruled-out finding still needs a stable place in a priority ordering. It
// is priority 0 when the row carries no explicit priority; an explicit value
// anywhere in that row wins, as it does for the availability test above.
export function priorityForGroup(group) {
  const explicit = group.find((f) => f.priority !== undefined)
  if (explicit) return explicit.priority
  return group.some(isRuledOut) ? 0 : undefined
}

// Source/dependency and confidence/revalidation selectors establish the
// scope for the second-row counts and repository choices below them.
function matchesScopeFilters(f) {
  const F = activeFilters()
  // Source filter — empty OR full (both 'own' and 'modules' set) =
  // no filter; otherwise restrict to the picked side. Both-checked
  // goes inert because including everything is what "no filter"
  // already means.
  if (F.filterSources.size === 1) {
    const allowOwn = F.filterSources.has('own')
    if (allowOwn && isModule(f.file)) return false
    if (!allowOwn && !isModule(f.file)) return false
  }
  // Revalidation outcome — single-select dropdown shown only when the
  // loaded set has something to choose between (the toolbar drops the
  // whole control otherwise, and offers only the reachable options).
  // Empty = no filter. One option can cover more than one value of the
  // field: CONFIRMED takes the revalidation row too, since that row IS
  // the pass leaving the finding standing (see REVALIDATE_FILTERS) —
  // and with it every finding the pass never judged, which rides the
  // same value (filterRevalidateKind). Group-visibility via
  // applyFilters's `g.some(...)`, same as every predicate above: a
  // dedup group shows in full when any of its rows carries the
  // selected outcome.
  if (F.filterRevalidate) {
    const kinds = activeRevalidateKinds(F.filterRevalidate, F.filterPartial)
    if (kinds && !kinds.includes(filterRevalidateKind(f))) return false
  }
  // Confidence range — SKIPPED entirely while a revalidation outcome is
  // selected. The two share one toolbar block and the outcome replaces
  // the range there (conf-filter.js renders it inert), so the bounds
  // read as 0—10 whatever the slider was left at: a user who narrowed
  // the range, then asked for the refuted findings, is asking for all
  // of them. Clearing the outcome hands the range back untouched.
  //
  // Slider bounds 0..10 always have a value; the
  // special positions are 0 (lower) and 10 (upper):
  //   * lower at 0 → findings with no place on the scale pass; above
  //     0 means "must have a place on it" — which a `critical: true`
  //     finding and an import both have, at 10 (confidenceOnScale).
  //   * upper at 10 → no upper cap; lets rare confidence > 10 entries
  //     through. Below 10 caps strictly — including the stand-ins,
  //     whose value is 10.
  //   * a row the pass KNOCKED DOWN — refuted, or unreachable — reads
  //     as 0 whatever number it carries (format.js voidsConfidence).
  //     Its confidence is not the group's to claim: a group shows in
  //     full when any tab matches, and without this a refuted 10 would
  //     float the whole group over a floor its surviving rows can't
  //     meet. Reading as 0 leaves it matching only the unfiltered
  //     floor — so `[{plain 3}, {refuted 10}]` behaves as a 3, and
  //     `[{refuted 3}, {refuted 10}]` shows only at 0. Such a row
  //     flagged `critical` doesn't ride the 10 bucket either, for the
  //     same reason.
  if (!F.filterRevalidate) {
    const conf = voidsConfidence(f) ? 0 : confidenceOnScale(f)
    if (conf === undefined) {
      if (F.filterConfMin > 0) return false
    } else {
      if (conf < F.filterConfMin) return false
      if (F.filterConfMax < 10 && conf > F.filterConfMax) return false
    }
  }
  return true
}

// Per-tab filter predicate. Factored out so `applyFilters` (group-level)
// can ask "does ANY tab in this group match?" — per the user spec,
// one matching tab keeps the whole group visible.
export function matchesFilters(f) {
  if (!matchesScopeFilters(f)) return false
  const F = activeFilters()
  const inc = F.filterInclude.toLowerCase()
  // Severity + color filters are multi-select Sets: empty = no
  // filter, non-empty = membership required. Unmarked tabs bucket
  // under the literal `'none'` so ticking only that chip isolates
  // unreviewed findings.
  if (F.filterSeverities.size > 0 && !F.filterSeverities.has(displayedSeverity(f, state.severityMode))) return false
  if (F.filterColors.size > 0) {
    const col = triageEntry(f)?.color ?? 'none'
    if (!F.filterColors.has(col)) return false
  }
  // NOTE: the annotation filters (comment | fix | flag) are intentionally
  // NOT evaluated here — they're GROUP-level (see matchesAnnotationFilters
  // / applyFilters) so 'with' / 'without' stay complementary across a
  // dedup group.
  // Analyzer + model filters — the `<analyzer-select>` dropdown's two
  // dimensions, shared with group.js's default-tab resolution via
  // matchesRunFilters (see its comment above for the matching rules).
  // applyFilters runs this at the GROUP level via `g.some(...)`, so a
  // dedup group shows in full when any entry matches — same
  // group-visibility as severity / color.
  if (!matchesRunFilters(f)) return false
  // Repo filter — single-select dropdown shown only in workspace
  // view (parent gates the chip on `state.currentWorkspace` + a
  // multi-repo option list). Empty = no filter; `NO_REPO_SENTINEL`
  // selects findings whose repo can't be derived (no `repo.github`
  // and no `_repoFallback`). Group-visibility via applyFilters's
  // `g.some(...)`, same as the other per-finding predicates above.
  if (F.filterRepo) {
    const r = repoOfFinding(f)
    const want = F.filterRepo === NO_REPO_SENTINEL ? null : F.filterRepo
    if (r !== want) return false
  }
  if (inc) {
    // Triage annotations (the free-form `comment` and the `fix`
    // reference — PR URL, issue link, or free-text note) live off the
    // finding in `state.triage`, so they're matched here rather than
    // folded into `findingText` (which stays free of any `#client`
    // import — see format.js). Both are searched on every query so a
    // keyword like "false positive" surfaces findings the user
    // annotated, and pasting a fix URL surfaces the finding it's filed
    // against.
    const entry = triageEntry(f)
    const hit = findingText(f).includes(inc)
      || (entry?.comment ?? '').toLowerCase().includes(inc)
      || (entry?.fix ?? '').toLowerCase().includes(inc)
    // Negation toggle: when on, the query excludes — keep the findings
    // that DON'T match. Per-finding (a group stays visible if any tab
    // is a non-match, same group rule as every other filter below).
    return F.filterIncludeNegate ? !hit : hit
  }
  return true
}

// Group-level annotation filters (comment | fix | flag), each a tri-state
// '' / 'with' / 'without'. These are deliberately NOT per-tab: 'without'
// must mean "NO tab in the dedup group carries it" (¬∃) — the exact
// complement of 'with' = "≥1 tab carries it" (∃). A per-tab `g.some`
// negation would instead keep a group that has the annotation on one tab
// just because ANOTHER tab lacks it, which is not complementary. Existence
// is computed once over the whole group, then 'with'/'without' applied.
function matchesAnnotationFilters(group) {
  const F = activeFilters()
  if (!F.filterComment && !F.filterFix && !F.filterFlagged) return true
  const groupHas = (pred) => group.some((f) => pred(triageEntry(f)))
  if (F.filterComment) {
    const has = groupHas((e) => Boolean(e?.comment))
    if (F.filterComment === 'with' ? !has : has) return false
  }
  if (F.filterFix) {
    const has = groupHas((e) => Boolean(e?.fix))
    if (F.filterFix === 'with' ? !has : has) return false
  }
  if (F.filterFlagged) {
    const has = groupHas((e) => e?.flagged === true)
    if (F.filterFlagged === 'with' ? !has : has) return false
  }
  return true
}

// Return the npm package carried by a finding, or recover it from a
// dependency path when the analyzer did not stamp one. Own-source paths
// deliberately return null: a top-level directory is not an npm package.
function npmPackageOfFinding(f) {
  const npm = f?.package?.npm
  if (typeof npm?.name === 'string' && npm.name && !isPlaceholderNpmPackage(npm)) return npm.name
  const file = typeof f?.file === 'string' ? f.file : ''
  const match = /(?:^|\/)(?:node_modules|dependencies|vendor)\/(@[^/]+\/[^/]+|[^/]+)(?:\/|$)/u.exec(file)
  return match?.[1] ?? null
}

// App mode is the default revalidation lens, with only the upstream lens
// explicitly excluded. Showing underlying findings adds detail to App mode;
// it does not change the mode itself. These two filter predicates are kept
// separate because they answer different questions and are offered in
// different modes.
export function appLensActive() {
  return state.showRevalidation !== false && !state.upstreamOnly
}

// A source/underlying row is cross-context when its visible findings span
// multiple repositories or multiple npm packages. Unknown context is not a
// second context: the filter is deliberately about an observable repo/package
// split, rather than merely about a row having two tabs.
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

// An App stack counts only App findings when the row has any. Thus
// `[App, App]` qualifies while `[App, source, source]` does not. The App
// identities come from the row itself: two App findings can carry different
// revalidation stamps even when the default tab projection chooses one pass.
export function isAppStackedGroup(group) {
  if (!appLensActive()) return false
  const visible = drawnTabs(group)
  if (visible.length === 0) return false
  const app = group.filter((f) => f.isApp)
  return app.length > 0 && app.length > 1
}

// Base rows for analyzer/severity/color counts and repository options. The
// caller supplies the current lens's rows and triage bucket. After filtering
// rows, project their visible tabs too: App mode folds underlying findings
// inside surviving rows, and those hidden tabs must not contribute values.
// Annotation and second-row filters don't narrow these selector choices.
export function applyScopeFilters(groups) {
  return groups.filter((g) => g.some(matchesScopeFilters)).map(drawnTabs)
}

export function applyFilters(groups) {
  // Per-tab existential filters (severity / color / source / analyzer /
  // model / repo / search) via `g.some`, AND the group-level annotation
  // filters.
  const duplicatesMode = !state.currentWorkspace && activeFilters().filterDuplicates
  const duplicateIds = duplicatesMode ? reportDuplicateIds() : null
  const crossContextMode = activeFilters().filterCrossContext
  const appStackedMode = activeFilters().filterAppStacked
  return groups.filter((g) => g.some(matchesFilters) && matchesAnnotationFilters(g)
    && (!duplicatesMode || (duplicatesMode === 'with') === g.some((f) => duplicateIds.has(tabKey(f))))
    && (!crossContextMode || (crossContextMode === 'with') === isCrossContextGroup(g))
    && (!appStackedMode || (appStackedMode === 'with') === isAppStackedGroup(g)))
}

// Numeric-field comparator factory behind the `priority-*` modes
// (the `confidence-*` modes get their own sorter below, for the
// critical-flag rule): which field to pull off the primary tab and
// whether higher comes first. Valueless findings go to the FAR end —
// -1 for desc (bottom), 11 for asc (above the [0..10] band, so also
// bottom). File-path is the universal tiebreaker.
function numericSorter(field, dir) {
  const missing = dir === 'desc' ? -1 : 11
  return (pa, pb) => {
    const va = pa[field] ?? missing
    const vb = pb[field] ?? missing
    return (dir === 'desc' ? vb - va : va - vb) || pa.file.localeCompare(pb.file)
  }
}

// Confidence sort variant. `critical: true` findings (the boolean
// flag, not the severity label) without an explicit confidence join
// the 10 bucket and rank above actual confidence-10 entries in both
// directions, keeping the most-important unscored items at the top
// of the 10s.
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

// Per-mode primary-tab comparator. Severity stays explicit because
// it composes multiple keys: severity rank, then confidence
// (delegated to the confidence-desc sorter so critical-flagged
// findings join the 10 bucket, matching the dedicated confidence
// sort), then line as the final within-file tiebreaker — file
// ordering already falls out of confidenceSorter's own file
// tiebreaker.
const confDescCmp = confidenceSorter('desc')
const SORTERS = {
  severity: (pa, pb) =>
    (SEVERITY_ORDER[displayedSeverity(pb, state.severityMode)] || 0) - (SEVERITY_ORDER[displayedSeverity(pa, state.severityMode)] || 0)
    || confDescCmp(pa, pb)
    || parseInt(pa.line, 10) - parseInt(pb.line, 10),
  'confidence-desc': confDescCmp,
  'confidence-asc':  confidenceSorter('asc'),
  'priority-desc':   numericSorter('priority',   'desc'),
  'priority-asc':    numericSorter('priority',   'asc'),
}

// Group-level sort. Severity/confidence/priority modes compare on
// each group's primary tab (see sortTabs / primaryTab). 'file' sort
// is handled by the grouping below; an unrecognised `state.sortBy`
// falls back to insertion order via the 0 cmp.
//
// Decorate-sort-undecorate: resolve each group's primary tab once (N
// calls) rather than inside the comparator (2·N·log N calls —
// primaryTab re-sorts a multi-tab group's tabs on every call, which
// dominated large-list renders).
export function applySorting(groups) {
  const cmp = SORTERS[state.sortBy]
  if (!cmp) return [...groups]
  if (state.sortBy === 'priority-desc' || state.sortBy === 'priority-asc') {
    const dir = state.sortBy === 'priority-desc' ? 'desc' : 'asc'
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
  return groups
    .map((g) => ({ p: primaryTab(g), g }))
    .toSorted((a, b) => cmp(a.p, b.p))
    .map((x) => x.g)
}
