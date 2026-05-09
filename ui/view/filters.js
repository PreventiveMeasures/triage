import { state } from '../../client/state.js'
import { SEVERITY_ORDER, findingText, isModule } from './format.js'
import { primaryTab, tabKey } from './group.js'

export function resetFilters() {
  state.filterSeverities = new Set()
  state.filterColors = new Set()
  state.filterSources = new Set()
  state.filterConfMin = 0
  state.filterConfMax = 10
  state.filterInclude = ''
  // Default sort tracks the dataset: when the loaded report has any
  // finding carrying a `priority`, sort by priority (descending —
  // most important first); otherwise fall back to severity. Called
  // on first-ingest only (subsequent loads keep the user's choice),
  // so this fires once per report-set boot.
  const hasPriority = state.reports.some((r) =>
    r.groups.some((g) => g.some((f) => f.priority !== undefined)))
  state.sortBy = hasPriority ? 'priority-desc' : 'severity'
}

// Per-tab filter predicate. Factored out so `applyFilters` (group-level)
// can ask "does ANY tab in this group match?" — per the user spec,
// one matching tab keeps the whole group visible.
export function matchesFilters(f) {
  const inc = state.filterInclude.toLowerCase()
  // Severity + color filters are multi-select Sets: empty = no filter,
  // non-empty = membership required. Unmarked tabs are bucketed under
  // the literal `'none'` so the user can isolate unreviewed findings by
  // ticking only that chip.
  if (state.filterSeverities.size > 0 && !state.filterSeverities.has(f.severity)) return false
  if (state.filterColors.size > 0) {
    const col = state.markers.get(tabKey(f)) ?? 'none'
    if (!state.filterColors.has(col)) return false
  }
  // Source filter — empty OR full (both 'own' and 'modules' set) =
  // no filter; otherwise restrict to the picked side. The Set goes
  // inert when both halves are checked because including everything
  // is what "no filter" already means.
  if (state.filterSources.size === 1) {
    const allowOwn = state.filterSources.has('own')
    if (allowOwn && isModule(f.file)) return false
    if (!allowOwn && !isModule(f.file)) return false
  }
  // Confidence range. The slider's bounds (0..10) always have a
  // value; the special positions are 0 (lower) and 10 (upper):
  //   * lower at 0 → undefined-confidence findings pass through;
  //     anything above 0 means "must have a known confidence"
  //   * upper at 10 → no upper cap; allows the rare confidence > 10
  //     entries through. Anything below 10 caps strictly.
  if (f.confidence === undefined) {
    if (state.filterConfMin > 0) return false
  } else {
    if (f.confidence < state.filterConfMin) return false
    if (state.filterConfMax < 10 && f.confidence > state.filterConfMax) return false
  }
  if (inc) { const text = findingText(f); if (!text.includes(inc)) return false }
  return true
}

export function applyFilters(groups) {
  return groups.filter((g) => g.some(matchesFilters))
}

// Numeric-field comparator factory — the four `confidence-*` /
// `priority-*` sort modes only differ in (a) which field they
// pull off the primary tab, (b) whether higher comes first, and
// (c) what to substitute when the field is missing. The "missing"
// fallback is what pushes findings without a value to the FAR
// end of the sort: -1 for desc (so they land at the bottom), 11
// for asc (above the [0..10] band, so they land at the bottom
// there too). File-path is the universal tiebreaker.
function numericSorter(field, dir, missing) {
  return (pa, pb) => {
    const va = pa[field] ?? missing
    const vb = pb[field] ?? missing
    return (dir === 'desc' ? vb - va : va - vb) || pa.file.localeCompare(pb.file)
  }
}

// Per-mode primary-tab comparator. Severity stays explicit because
// it carries a three-key lex order (severity rank, then file, then
// line) — collapsing it into the numeric helper would lose the
// line-tiebreaker that makes the within-file order deterministic.
const SORTERS = {
  severity: (pa, pb) =>
    (SEVERITY_ORDER[pb.severity] || 0) - (SEVERITY_ORDER[pa.severity] || 0)
    || pa.file.localeCompare(pb.file)
    || parseInt(pa.line, 10) - parseInt(pb.line, 10),
  'confidence-desc': numericSorter('confidence', 'desc', -1),
  'confidence-asc':  numericSorter('confidence', 'asc',  11),
  'priority-desc':   numericSorter('priority',   'desc', -1),
  'priority-asc':    numericSorter('priority',   'asc',  11),
}

// Group-level sort. For severity/confidence/priority modes we
// compare on each group's primary tab (see sortTabs / primaryTab).
// 'file' sort is handled by the grouping below; an unrecognised
// `state.sortBy` falls back to insertion order via the 0 cmp.
export function applySorting(groups) {
  const cmp = SORTERS[state.sortBy]
  if (!cmp) return [...groups]
  return [...groups].sort((a, b) => cmp(primaryTab(a), primaryTab(b)))
}
