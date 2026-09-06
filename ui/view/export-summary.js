// Summary of what a print / markdown export will contain, given the
// active filters — feeds `<export-confirm-dialog>`, and the header of
// the markdown document itself (markdown-export.js reads the same
// descriptions, so the dialog and the file describe the selection in
// the same words). Both export paths emit only the findings visible
// under the current triage bucket (live / trash) and toolbar filters,
// so this restates that selection in words + counts before the user
// commits.
//
// Counts are over GROUPS (a dedup group = one finding with ≥1 case),
// the same unit as the toolbar's "X of Y" counter, computed over the
// merged on-screen set so the dialog's number matches what the user
// already sees.
import { state } from '#client/index.js'
import { NO_REPO_SENTINEL, NULL_ANALYZER_SENTINEL, NULL_MODEL_SENTINEL, applyFilters, clearFilterOverride, cloneFilterFields, setFilterOverride } from './filters.js'
import { REVALIDATE_FILTERS, SEVERITIES, revalidateFilterKinds } from './format.js'
import { getMergedGroups, groupState } from './group.js'
// The words the markdown writer spells the same enumerations with, so
// a row here and a header line in the file can't disagree on one.
import { COLOR_LABELS, SEVERITY_LABELS, TRIAGE_LABELS } from '../../report/index.js'

// The revalidation outcome in words, with the partial switch folded in
// where it applies. That switch lives INSIDE Confirmed (it is the one
// option whose kinds take the partial rows), so the other outcomes
// describe as their bare label — `activeRevalidateKinds` reads it the
// same way.
function revalidateValue(value, partial) {
  const label = REVALIDATE_FILTERS.find((o) => o.value === value)?.label ?? value
  if (!revalidateFilterKinds(value)?.includes('partial')) return label
  if (partial === 'exclude') return `${label} (full only)`
  if (partial === 'only') return `${label} (partial only)`
  return label
}

// Severities listed in canonical high→low order (SEVERITIES) rather
// than Set-insertion order, so the description reads consistently
// regardless of the order chips were ticked.
function listSeverities(set) {
  return SEVERITIES.filter((s) => set.has(s)).map((s) => SEVERITY_LABELS[s] ?? s).join(', ')
}

// Build a `{ key, label, value, clear }` list describing every active
// filter, in toolbar order. Mirrors the predicate gating in filters.js's
// matchesFilters / matchesAnnotationFilters so the dialog lists a
// filter iff it actually narrows the export (e.g. the source filter is
// a no-op unless exactly one side is picked). Empty array = nothing is
// filtered; the full bucket exports.
//
// Reads `fields` rather than `state` directly so the confirm dialog can
// describe a RELAXED copy of the selection — the one it is about to
// export — while the toolbar keeps showing the real thing. Defaults to
// `state`, which is the unrelaxed case.
//
// `clear` is the patch that drops the filter: what to assign onto a
// clone so that row stops narrowing anything. It lives here rather than
// in the dialog because which state fields a described filter is made
// of is this module's knowledge — Confidence is a pair of bounds, a
// search carries its negate flag, and the three Annotation rows share a
// label but not a field.
export function activeFilterDescriptions(fields = state) {
  const out = []
  if (fields.filterSeverities.size > 0) {
    out.push({ key: 'severity', label: 'Severity', value: listSeverities(fields.filterSeverities), clear: { filterSeverities: new Set() } })
  }
  if (fields.filterColors.size > 0) {
    out.push({ key: 'marks', label: 'Marks', value: [...fields.filterColors].map((c) => COLOR_LABELS[c] ?? c).join(', '), clear: { filterColors: new Set() } })
  }
  // Source: only a single picked side filters; empty or both = no-op.
  // Clearing empties the Set rather than filling it — both-checked is
  // inert too, but empty is the state the toolbar's own reset uses.
  if (fields.filterSources.size === 1) {
    out.push({ key: 'source', label: 'Source', value: fields.filterSources.has('own') ? 'Sources only' : 'Dependencies only', clear: { filterSources: new Set() } })
  }
  if (fields.filterAnalyzer) {
    out.push({ key: 'analyzer', label: 'Analyzer', value: fields.filterAnalyzer === NULL_ANALYZER_SENTINEL ? '(none)' : fields.filterAnalyzer, clear: { filterAnalyzer: '' } })
  }
  if (fields.filterModel) {
    out.push({ key: 'model', label: 'Model', value: fields.filterModel === NULL_MODEL_SENTINEL ? '(none)' : fields.filterModel, clear: { filterModel: '' } })
  }
  if (fields.filterRepo) {
    out.push({ key: 'repo', label: 'Repository', value: fields.filterRepo === NO_REPO_SENTINEL ? '(no repo)' : fields.filterRepo, clear: { filterRepo: '' } })
  }
  // Revalidation outcome — the toolbar's Confirmed / Unreachable /
  // Refuted dropdown. Gated on the value resolving to a set of kinds,
  // because matchesFilters treats one that names no option as no filter
  // rather than hiding everything behind it.
  if (revalidateFilterKinds(fields.filterRevalidate)) {
    out.push({
      key: 'revalidate',
      label: 'Revalidation',
      value: revalidateValue(fields.filterRevalidate, fields.filterPartial),
      clear: { filterRevalidate: '', filterPartial: '' },
    })
  }
  // Confidence: 0..10 is the no-filter default; either bound moving in
  // narrows the range. One row for the pair, so dropping it hands both
  // bounds back at once.
  //
  // Not described at all while an outcome is selected: the two share a
  // toolbar block and the outcome REPLACES the range there (conf-filter
  // renders it inert, matchesFilters skips it entirely), so the bounds
  // narrow nothing however they were left. Listing them anyway offered a
  // filter whose × moved no counts — and left the filter that was doing
  // the narrowing unlisted and unremovable. Dropping the outcome brings
  // the range back into force, and this row back with it.
  if (!fields.filterRevalidate && (fields.filterConfMin > 0 || fields.filterConfMax < 10)) {
    let value
    if (fields.filterConfMin > 0 && fields.filterConfMax < 10) value = `${fields.filterConfMin}–${fields.filterConfMax}`
    else if (fields.filterConfMin > 0) value = `≥ ${fields.filterConfMin}`
    else value = `≤ ${fields.filterConfMax}`
    out.push({ key: 'confidence', label: 'Confidence', value, clear: { filterConfMin: 0, filterConfMax: 10 } })
  }
  // The negate flag rides along: on its own it filters nothing, but
  // left set it would invert the NEXT search a caller assigned.
  if (fields.filterInclude) {
    out.push({
      key: 'search',
      label: fields.filterIncludeNegate ? 'Excluding' : 'Search',
      value: `"${fields.filterInclude}"`,
      clear: { filterInclude: '', filterIncludeNegate: false },
    })
  }
  // Annotation tri-state filters (comment / fix / flag): '' = off,
  // 'with' / 'without' = present / absent across the group. Three rows
  // under one label, so each needs its own key to be removable.
  for (const [field, noun] of [['filterComment', 'comment'], ['filterFix', 'fix'], ['filterFlagged', 'flag']]) {
    const v = fields[field]
    if (v) out.push({ key: `annotation:${noun}`, label: 'Annotation', value: `${v === 'with' ? 'With' : 'Without'} ${noun}`, clear: { [field]: '' } })
  }
  return out
}

// The groups an export draws from: the current triage bucket over the
// MERGED on-screen set (render.js's `allGroups` = getMergedGroups
// narrowed to the bucket), so a workspace's cross-report duplicates
// count — and export — as one finding with several cases, exactly as
// the views show them. Shared by the dialog's counts and the markdown
// adapter's selection, so the two can't disagree. `commonTriage ===
// state.shownTriage` is the bucket split (null = live); kanban isn't
// reachable here (print/download buttons hide in kanban mode).
export function exportBucketGroups() {
  return getMergedGroups().filter((g) => groupState(g).commonTriage === state.shownTriage)
}

// The bucket's name when it is a trash bucket, for the dialog's note
// and the document's header; null for the live findings.
export function exportBucketLabel() {
  return state.shownTriage ? (TRIAGE_LABELS[state.shownTriage] ?? state.shownTriage) : null
}

// `{ included, total, excluded, filters, fields, bucketLabel }` for the
// confirm dialog. `included` runs applyFilters over the bucket (the
// exact predicate both export paths use); `bucketLabel` is non-null
// only when viewing a trash bucket, to flag that the export is scoped
// to e.g. Deleted rather than the live findings.
//
// `fields` is the selection the counts were computed under. On open
// that is a fresh clone of the toolbar's; the dialog then hands back a
// relaxed copy each time a filter is dropped, and the counts move with
// it. Nothing here writes `state`: the relaxed copy is installed as an
// override for the length of the count and pulled straight back out, so
// the toolbar's own filters never see it.
export function exportSelectionSummary(mode, fields = cloneFilterFields()) {
  const bucket = exportBucketGroups()
  const total = bucket.length
  setFilterOverride(fields)
  let included
  try {
    included = applyFilters(bucket).length
  } finally {
    clearFilterOverride()
  }
  return {
    included,
    total,
    excluded: total - included,
    fields,
    filters: activeFilterDescriptions(fields),
    bucketLabel: exportBucketLabel(),
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
