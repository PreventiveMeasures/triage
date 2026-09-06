// Summary of what a print / markdown export will contain, given the
// active filters — feeds `<export-confirm-dialog>`, and the header of
// the markdown document itself (markdown-export.js), so the dialog and
// the file describe the selection in the same words. Both export paths
// emit only the findings visible under the current triage bucket
// (live / trash) and toolbar filters, so this restates that selection
// in words + counts before the user commits.
//
// Counts are over GROUPS (a dedup group = one finding with ≥1 case),
// the same unit as the toolbar's "X of Y" counter, computed over the
// merged on-screen set so the dialog's number matches what the user
// already sees.
import { state } from '#client/index.js'
import { NO_REPO_SENTINEL, NULL_ANALYZER_SENTINEL, NULL_MODEL_SENTINEL, applyFilters } from './filters.js'
import { REVALIDATE_FILTERS, SEVERITIES } from './format.js'
import { getMergedGroups, groupState } from './group.js'
import { COLOR_LABELS, SEVERITY_LABELS, TRIAGE_LABELS } from '../../report/index.js'

// Severities listed in canonical high→low order (SEVERITIES) rather
// than Set-insertion order, so the description reads consistently
// regardless of the order chips were ticked.
function listSeverities(set) {
  return SEVERITIES.filter((s) => set.has(s)).map((s) => SEVERITY_LABELS[s] ?? s).join(', ')
}

// The outcome dropdown's own word for its selection, with the partial
// chip's state folded in where it applies — only under Confirmed, the
// one option that took the partial rows in (format.js
// activeRevalidateKinds).
function revalidateFilterLabel(value, partial) {
  const option = REVALIDATE_FILTERS.find((o) => o.value === value)
  const label = option?.label ?? value
  if (!option?.kinds.includes('partial')) return label
  if (partial === 'exclude') return `${label} (full confirmations only)`
  if (partial === 'only') return `${label} (partial confirmations only)`
  return label
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
  // Confidence and the revalidation outcome share one toolbar block,
  // and the outcome REPLACES the range — filters.js skips the
  // confidence branch entirely while one is selected — so the range
  // is described only when it is the one doing the filtering, and the
  // outcome otherwise. 0..10 is the range's no-filter default; either
  // bound moving in narrows it.
  if (state.filterRevalidate) {
    out.push({ label: 'Revalidation', value: revalidateFilterLabel(state.filterRevalidate, state.filterPartial) })
  } else if (state.filterConfMin > 0 || state.filterConfMax < 10) {
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

// `{ included, total, excluded, filters, bucketLabel }` for the
// confirm dialog. `included` runs applyFilters over the bucket (the
// exact predicate both export paths use); `bucketLabel` is non-null
// only when viewing a trash bucket, to flag that the export is scoped
// to e.g. Deleted rather than the live findings.
export function exportSelectionSummary(mode) {
  const bucket = exportBucketGroups()
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
