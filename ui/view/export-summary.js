// What a print / markdown export will contain under the active filters:
// the `<export-confirm-dialog>`'s summary, and the markdown document's
// header (markdown-export.js reads the same descriptions, so the two say
// the same thing). Both exports take only the findings visible under the
// current triage bucket and toolbar filters, counted in GROUPS over the
// merged set, the unit of the toolbar's "X of Y".
import { state } from '#client/index.js'
import { NO_REPO_SENTINEL, NULL_ANALYZER_SENTINEL, NULL_MODEL_SENTINEL, applyFilters, clearFilterOverride, cloneFilterFields, setFilterOverride } from './filters.js'
import { SEVERITIES, revalidateFilterKinds, revalidateFilterOption } from './format.js'
import { getMergedGroups, groupState } from './group.js'
// The words the markdown writer spells the same enumerations with, so
// a row here and a header line in the file can't disagree on one.
import { COLOR_LABELS, SEVERITY_LABELS, TRIAGE_LABELS } from '@preventive/report'

// The run-meta and repository picks: key, label, field, the no-value
// bucket's sentinel and its words.
const PICKS = [
  ['analyzer', 'Analyzer', 'filterAnalyzer', NULL_ANALYZER_SENTINEL, '(none)'],
  ['model', 'Model', 'filterModel', NULL_MODEL_SENTINEL, '(none)'],
  ['validationModel', 'Validation model', 'filterValidationModel', NULL_MODEL_SENTINEL, '(none)'],
  ['repo', 'Repository', 'filterRepo', NO_REPO_SENTINEL, '(no repo)'],
]

// The row filters' tri-states ('with' / 'without'): key, label, field, and
// the rows they keep or drop.
const ROW_FILTERS = [
  ['duplicates', 'Duplicates', 'filterDuplicates', 'rows linked to other reports'],
  ['cross-context', 'Context', 'filterCrossContext', 'rows across multiple repos or packages'],
  ['app-stacked', 'App stack', 'filterAppStacked', 'rows with multiple App findings'],
  ['security', 'Security', 'filterSecurity', 'security-related rows'],
]

// The revalidation outcome in words, with the partial switch folded in
// where it applies: it lives INSIDE Confirmed, the one option whose kinds
// take the partial rows (as `activeRevalidateKinds` reads it).
function revalidateValue(value, partial) {
  const label = revalidateFilterOption(value)?.label ?? value
  if (!revalidateFilterKinds(value)?.includes('partial')) return label
  if (partial === 'exclude') return `${label} (full only)`
  if (partial === 'only') return `${label} (partial only)`
  return label
}

// Every active filter as `{ key, label, value, clear }`, in toolbar order,
// listed iff it actually narrows the export (filters.js matchesFilters /
// matchesAnnotationFilters gating). `fields` is a selection — `state`, or
// the confirm dialog's RELAXED copy, which it is about to export while the
// toolbar keeps the real one. `clear` is the patch that drops the row's
// filter from such a copy: which fields make up a filter is this module's
// knowledge (Confidence is a pair of bounds, a search carries its negate
// flag, the Annotation rows share a label but not a field).
export function activeFilterDescriptions(fields = state) {
  const out = []
  // Severities in canonical order, however the chips were ticked.
  if (fields.filterSeverities.size > 0) {
    out.push({ key: 'severity', label: 'Severity', value: SEVERITIES.filter((s) => fields.filterSeverities.has(s)).map((s) => SEVERITY_LABELS[s] ?? s).join(', '), clear: { filterSeverities: new Set() } })
  }
  if (fields.filterColors.size > 0) {
    out.push({ key: 'marks', label: 'Marks', value: [...fields.filterColors].map((c) => COLOR_LABELS[c] ?? c).join(', '), clear: { filterColors: new Set() } })
  }
  // Only a single picked side filters. Clearing empties the Set, the
  // state the toolbar's own reset uses.
  if (fields.filterSources.size === 1) {
    out.push({ key: 'source', label: 'Source', value: fields.filterSources.has('own') ? 'Sources only' : 'Dependencies only', clear: { filterSources: new Set() } })
  }
  for (const [key, label, field, sentinel, none] of PICKS) {
    if (fields[field]) out.push({ key, label, value: fields[field] === sentinel ? none : fields[field], clear: { [field]: '' } })
  }
  // An outcome naming no option filters nothing (matchesFilters).
  if (revalidateFilterKinds(fields.filterRevalidate)) {
    out.push({
      key: 'revalidate',
      label: 'Revalidation',
      value: revalidateValue(fields.filterRevalidate, fields.filterPartial),
      clear: { filterRevalidate: '', filterPartial: '' },
    })
  }
  // Confidence: 0..10 is no filter. One row for both bounds, and none
  // while an outcome is selected: it REPLACES the range (conf-filter.js,
  // matchesFilters), so the bounds narrow nothing, and listing them would
  // offer a × that moved no counts.
  if (!fields.filterRevalidate && (fields.filterConfMin > 0 || fields.filterConfMax < 10)) {
    let value
    if (fields.filterConfMin > 0 && fields.filterConfMax < 10) value = `${fields.filterConfMin}–${fields.filterConfMax}`
    else if (fields.filterConfMin > 0) value = `≥ ${fields.filterConfMin}`
    else value = `≤ ${fields.filterConfMax}`
    out.push({ key: 'confidence', label: 'Confidence', value, clear: { filterConfMin: 0, filterConfMax: 10 } })
  }
  // The negate flag rides along: left set, it would invert the next search.
  if (fields.filterInclude) {
    out.push({
      key: 'search',
      label: fields.filterIncludeNegate ? 'Excluding' : 'Search',
      value: `"${fields.filterInclude}"`,
      clear: { filterInclude: '', filterIncludeNegate: false },
    })
  }
  // Annotation tri-states, one removable row each.
  for (const [field, noun] of [['filterComment', 'comment'], ['filterIssue', 'issue'], ['filterFix', 'fix'], ['filterFlagged', 'flag']]) {
    const v = fields[field]
    if (v) out.push({ key: `annotation:${noun}`, label: 'Annotation', value: `${v === 'with' ? 'With' : 'Without'} ${noun}`, clear: { [field]: '' } })
  }
  for (const [key, label, field, rows] of ROW_FILTERS) {
    // Duplicates is report-only.
    if (!fields[field] || (key === 'duplicates' && state.currentWorkspace)) continue
    out.push({ key, label, value: `${fields[field] === 'with' ? 'Only' : 'Exclude'} ${rows}`, clear: { [field]: '' } })
  }
  return out
}

// The groups an export draws from: the triage bucket on screen
// (`commonTriage === state.shownTriage`, null = live) over the MERGED set,
// so a workspace's cross-report duplicates export as one finding with
// several cases, as the views show them. Kanban isn't reachable here (the
// print / download buttons hide there).
export function exportBucketGroups() {
  return getMergedGroups().filter((g) => groupState(g).commonTriage === state.shownTriage)
}

// The bucket's name when it is a trash bucket, for the dialog's note
// and the document's header; null for the live findings.
export function exportBucketLabel() {
  return state.shownTriage ? (TRIAGE_LABELS[state.shownTriage] ?? state.shownTriage) : null
}

// The confirm dialog's `{ included, total, excluded, fields, filters,
// bucketLabel, focusedOnly }`, under `fields`: a clone of the toolbar's on
// open, then the relaxed copy as filters are dropped, installed as an
// override only for the count, so `state` is never written.
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
    // Printing the focus view prints its one focused card (the queue hides
    // on paper), though the counts describe the queue; the markdown always
    // takes the whole filtered set.
    focusedOnly: mode === 'print' && state.viewMode === 'focus',
  }
}
