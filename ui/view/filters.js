import { state } from '#client/index.js'
import { SEVERITY_ORDER, findingText, isModule, prettyModel } from './format.js'
import { primaryTab, tabKey } from './group.js'

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
  if (state.filterAnalyzer) {
    const a = f._analyzer ?? null
    const want = state.filterAnalyzer === NULL_ANALYZER_SENTINEL ? null : state.filterAnalyzer
    if (a !== want) return false
  }
  if (state.filterModel) {
    const m = modelOfFinding(f)
    const want = state.filterModel === NULL_MODEL_SENTINEL ? null : state.filterModel
    if (m !== want) return false
  }
  return true
}

// Resolve a finding's repo to a single string key, or null when no
// repo signal is available. Mirrors `repoOf` in
// client/bundle-finding-index.js — kept local because that helper
// takes a per-report fallback matchesFilters lacks (state.reports
// findings already have `_repoFallback` stamped at ingest).
export function repoOfFinding(f) {
  if (typeof f.repo?.github === 'string' && f.repo.github) return f.repo.github
  if (typeof f._repoFallback === 'string' && f._repoFallback) return f._repoFallback
  return null
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
  // Default sort tracks the dataset: if any finding carries a
  // `priority`, sort priority-descending (most important first),
  // else severity. Called on first-ingest only (subsequent loads
  // keep the user's choice).
  const hasPriority = state.reports.some((r) =>
    r.groups.some((g) => g.some((f) => f.priority !== undefined)))
  state.sortBy = hasPriority ? 'priority-desc' : 'severity'
}

// Per-tab filter predicate. Factored out so `applyFilters` (group-level)
// can ask "does ANY tab in this group match?" — per the user spec,
// one matching tab keeps the whole group visible.
export function matchesFilters(f) {
  const inc = state.filterInclude.toLowerCase()
  // Severity + color filters are multi-select Sets: empty = no
  // filter, non-empty = membership required. Unmarked tabs bucket
  // under the literal `'none'` so ticking only that chip isolates
  // unreviewed findings.
  if (state.filterSeverities.size > 0 && !state.filterSeverities.has(f.severity)) return false
  if (state.filterColors.size > 0) {
    const col = state.triage.get(tabKey(f))?.color ?? 'none'
    if (!state.filterColors.has(col)) return false
  }
  // Source filter — empty OR full (both 'own' and 'modules' set) =
  // no filter; otherwise restrict to the picked side. Both-checked
  // goes inert because including everything is what "no filter"
  // already means.
  if (state.filterSources.size === 1) {
    const allowOwn = state.filterSources.has('own')
    if (allowOwn && isModule(f.file)) return false
    if (!allowOwn && !isModule(f.file)) return false
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
  if (state.filterRepo) {
    const r = repoOfFinding(f)
    const want = state.filterRepo === NO_REPO_SENTINEL ? null : state.filterRepo
    if (r !== want) return false
  }
  // Confidence range. Slider bounds 0..10 always have a value; the
  // special positions are 0 (lower) and 10 (upper):
  //   * lower at 0 → undefined-confidence findings pass; above 0
  //     means "must have a known confidence", EXCEPT findings flagged
  //     `critical: true` (the boolean, distinct from
  //     `severity: 'critical'`) which join the 10 bucket and pass
  //     any floor.
  //   * upper at 10 → no upper cap; lets rare confidence > 10 entries
  //     through. Below 10 caps strictly — including the
  //     critical-flagged stand-ins, whose effective value is 10.
  if (f.confidence === undefined) {
    if (f.critical === true) {
      if (state.filterConfMax < 10) return false
    } else if (state.filterConfMin > 0) {
      return false
    }
  } else {
    if (f.confidence < state.filterConfMin) return false
    if (state.filterConfMax < 10 && f.confidence > state.filterConfMax) return false
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
    const entry = state.triage.get(tabKey(f))
    const hit = findingText(f).includes(inc)
      || (entry?.comment ?? '').toLowerCase().includes(inc)
      || (entry?.fix ?? '').toLowerCase().includes(inc)
    // Negation toggle: when on, the query excludes — keep the findings
    // that DON'T match. Per-finding (a group stays visible if any tab
    // is a non-match, same group rule as every other filter below).
    return state.filterIncludeNegate ? !hit : hit
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
  if (!state.filterComment && !state.filterFix && !state.filterFlagged) return true
  const groupHas = (pred) => group.some((f) => pred(state.triage.get(tabKey(f))))
  if (state.filterComment) {
    const has = groupHas((e) => Boolean(e?.comment))
    if (state.filterComment === 'with' ? !has : has) return false
  }
  if (state.filterFix) {
    const has = groupHas((e) => Boolean(e?.fix))
    if (state.filterFix === 'with' ? !has : has) return false
  }
  if (state.filterFlagged) {
    const has = groupHas((e) => e?.flagged === true)
    if (state.filterFlagged === 'with' ? !has : has) return false
  }
  return true
}

export function applyFilters(groups) {
  // Per-tab existential filters (severity / color / source / analyzer /
  // model / repo / search) via `g.some`, AND the group-level annotation
  // filters.
  return groups.filter((g) => g.some(matchesFilters) && matchesAnnotationFilters(g))
}

// Numeric-field comparator factory — the `confidence-*` /
// `priority-*` modes differ only in (a) which field they pull off
// the primary tab, (b) whether higher comes first, and (c) the
// missing-value substitute. That substitute pushes valueless
// findings to the FAR end: -1 for desc (bottom), 11 for asc (above
// the [0..10] band, so also bottom). File-path is the universal
// tiebreaker.
function numericSorter(field, dir, missing) {
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
    (SEVERITY_ORDER[pb.severity] || 0) - (SEVERITY_ORDER[pa.severity] || 0)
    || confDescCmp(pa, pb)
    || parseInt(pa.line, 10) - parseInt(pb.line, 10),
  'confidence-desc': confDescCmp,
  'confidence-asc':  confidenceSorter('asc'),
  'priority-desc':   numericSorter('priority',   'desc', -1),
  'priority-asc':    numericSorter('priority',   'asc',  11),
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
  return groups
    .map((g) => ({ p: primaryTab(g), g }))
    .toSorted((a, b) => cmp(a.p, b.p))
    .map((x) => x.g)
}
