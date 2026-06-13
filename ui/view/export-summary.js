// Summary of what a print / markdown export will contain, given the
// active filters — feeds `<export-confirm-dialog>`. Both export paths
// emit only the findings visible under the current triage bucket
// (live / trash) and toolbar filters (see markdown-export.js's
// visibleGroups and the print pipeline in events.js), so this restates
// that selection in words + counts before the user commits.
//
// Counts are over GROUPS (a dedup group = one finding with ≥1 case),
// the same unit as the toolbar's "X of Y" counter, computed over the
// merged on-screen set so the dialog's number matches what the user
// already sees.
import { state } from '#client/index.js'
import { NO_REPO_SENTINEL, NULL_ANALYZER_SENTINEL, NULL_MODEL_SENTINEL, applyFilters } from './filters.js'
import { SEVERITIES } from './format.js'
import { getMergedGroups, groupState } from './group.js'

const SEVERITY_LABELS = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
  high_bug: 'High bug', bug: 'Bug', informational: 'Informational',
}
const COLOR_LABELS = { red: 'Red', blue: 'Blue', green: 'Green', gray: 'Gray', none: 'Unmarked' }
const TRIAGE_LABELS = {
  inprogress: 'In progress', fixed: 'Fixed', invalid: 'Invalid',
  deleted: 'Deleted', ignored: 'Ignored',
}

// Severities listed in canonical high→low order (SEVERITIES) rather
// than Set-insertion order, so the description reads consistently
// regardless of the order chips were ticked.
function listSeverities(set) {
  return SEVERITIES.filter((s) => set.has(s)).map((s) => SEVERITY_LABELS[s] ?? s).join(', ')
}

// Build a `{ label, value }` list describing every active filter, in
// toolbar order. Mirrors the predicate gating in filters.js's
// matchesFilters / matchesAnnotationFilters so the dialog lists a
// filter iff it actually narrows the export (e.g. the source filter is
// a no-op unless exactly one side is picked). Empty array = nothing is
// filtered; the full bucket exports.
export function activeFilterDescriptions() {
  const out = []
  if (state.filterSeverities.size > 0) {
    out.push({ label: 'Severity', value: listSeverities(state.filterSeverities) })
  }
  if (state.filterColors.size > 0) {
    out.push({ label: 'Marks', value: [...state.filterColors].map((c) => COLOR_LABELS[c] ?? c).join(', ') })
  }
  // Source: only a single picked side filters; empty or both = no-op.
  if (state.filterSources.size === 1) {
    out.push({ label: 'Source', value: state.filterSources.has('own') ? 'Sources only' : 'Dependencies only' })
  }
  if (state.filterAnalyzer) {
    out.push({ label: 'Analyzer', value: state.filterAnalyzer === NULL_ANALYZER_SENTINEL ? '(none)' : state.filterAnalyzer })
  }
  if (state.filterModel) {
    out.push({ label: 'Model', value: state.filterModel === NULL_MODEL_SENTINEL ? '(none)' : state.filterModel })
  }
  if (state.filterRepo) {
    out.push({ label: 'Repository', value: state.filterRepo === NO_REPO_SENTINEL ? '(no repo)' : state.filterRepo })
  }
  // Confidence: 0..10 is the no-filter default; either bound moving in
  // narrows the range.
  if (state.filterConfMin > 0 || state.filterConfMax < 10) {
    let value
    if (state.filterConfMin > 0 && state.filterConfMax < 10) value = `${state.filterConfMin}–${state.filterConfMax}`
    else if (state.filterConfMin > 0) value = `≥ ${state.filterConfMin}`
    else value = `≤ ${state.filterConfMax}`
    out.push({ label: 'Confidence', value })
  }
  if (state.filterInclude) {
    out.push({ label: state.filterIncludeNegate ? 'Excluding' : 'Search', value: `"${state.filterInclude}"` })
  }
  // Annotation tri-state filters (comment / fix / flag): '' = off,
  // 'with' / 'without' = present / absent across the group.
  for (const [key, noun] of [['filterComment', 'comment'], ['filterFix', 'fix'], ['filterFlagged', 'flag']]) {
    const v = state[key]
    if (v) out.push({ label: 'Annotation', value: `${v === 'with' ? 'With' : 'Without'} ${noun}` })
  }
  return out
}

// Groups in the current triage bucket, on the basis the chosen export
// actually serializes:
//   * 'print' renders the MERGED on-screen DOM (render.js's `allGroups`
//     = getMergedGroups narrowed to the bucket), so cross-report
//     workspace merges collapse into single super-groups;
//   * 'download' (markdown) iterates each report's OWN groups with no
//     merging (see markdown-export.js's visibleGroups).
// Counting on the matching basis keeps the dialog's number equal to
// what that path emits — when a workspace merge is active the two
// bases (and their per-group triage rollups) can otherwise diverge.
// `commonTriage === state.shownTriage` is the bucket split (null =
// live); kanban isn't reachable here (print/download buttons hide in
// kanban mode).
function currentBucketGroups(mode) {
  const groups = mode === 'download'
    ? state.reports.flatMap((r) => r.groups ?? [])
    : getMergedGroups()
  return groups.filter((g) => groupState(g).commonTriage === state.shownTriage)
}

// `{ included, total, excluded, filters, bucketLabel }` for the
// confirm dialog. `included` runs applyFilters over the bucket (the
// exact predicate both export paths use); `bucketLabel` is non-null
// only when viewing a trash bucket, to flag that the export is scoped
// to e.g. Deleted rather than the live findings.
export function exportSelectionSummary(mode) {
  const bucket = currentBucketGroups(mode)
  const total = bucket.length
  const included = applyFilters(bucket).length
  return {
    included,
    total,
    excluded: total - included,
    filters: activeFilterDescriptions(),
    bucketLabel: state.shownTriage ? (TRIAGE_LABELS[state.shownTriage] ?? state.shownTriage) : null,
    // Focus view-mode prints ONLY the single focused finding: the print
    // pipeline swaps table → list but leaves focus as-is, so the printed
    // DOM is the one focused finding-card (the "Up next" queue is hidden
    // on paper). The included/total counts above still describe the
    // filtered set (the focus queue), but `focusedOnly` tells the dialog
    // that print emits just one of them. Download is unaffected —
    // markdown serializes the full filtered set regardless of view-mode.
    focusedOnly: mode === 'print' && state.viewMode === 'focus',
  }
}
