import { state } from './state.js'
import { isModule, findingText, SEVERITY_ORDER } from './format.js'
import { tabKey, primaryTab } from './group.js'

export function resetFilters() {
  state.filterSeverities = new Set()
  state.filterColors = new Set()
  state.filterSource = 'all'
  state.filterConfMin = 8
  state.filterConfMax = ''
  state.filterInclude = ''
  state.filterExclude = ''
  state.sortBy = 'severity'
}

// Per-tab filter predicate. Factored out so `applyFilters` (group-level)
// can ask "does ANY tab in this group match?" — per the user spec,
// one matching tab keeps the whole group visible.
export function matchesFilters(f) {
  const inc = state.filterInclude.toLowerCase()
  const exc = state.filterExclude.toLowerCase()
  // Severity + color filters are multi-select Sets: empty = no filter,
  // non-empty = membership required. Unmarked tabs are bucketed under
  // the literal `'none'` so the user can isolate unreviewed findings by
  // ticking only that chip.
  if (state.filterSeverities.size > 0 && !state.filterSeverities.has(f.severity)) return false
  if (state.filterColors.size > 0) {
    const col = state.markers.get(tabKey(f)) ?? 'none'
    if (!state.filterColors.has(col)) return false
  }
  if (state.filterSource === 'own' && isModule(f.file)) return false
  if (state.filterSource === 'modules' && !isModule(f.file)) return false
  if (state.filterConfMin !== '' && (f.confidence === undefined || f.confidence < state.filterConfMin)) return false
  if (state.filterConfMax !== '' && (f.confidence === undefined || f.confidence > state.filterConfMax)) return false
  if (inc) { const text = findingText(f); if (!text.includes(inc)) return false }
  if (exc) { const text = findingText(f); if (text.includes(exc)) return false }
  return true
}

export function applyFilters(groups) {
  return groups.filter((g) => g.some(matchesFilters))
}

// Group-level sort. For severity/confidence modes we compare on each
// group's primary tab (see sortTabs / primaryTab). 'file' sort is
// handled by the grouping below.
export function applySorting(groups) {
  const sorted = [...groups]
  if (state.sortBy === 'severity') {
    sorted.sort((a, b) => {
      const pa = primaryTab(a), pb = primaryTab(b)
      return (SEVERITY_ORDER[pb.severity] || 0) - (SEVERITY_ORDER[pa.severity] || 0)
        || pa.file.localeCompare(pb.file)
        || parseInt(pa.line) - parseInt(pb.line)
    })
  } else if (state.sortBy === 'confidence-desc') {
    sorted.sort((a, b) => {
      const pa = primaryTab(a), pb = primaryTab(b)
      return (pb.confidence ?? -1) - (pa.confidence ?? -1) || pa.file.localeCompare(pb.file)
    })
  } else if (state.sortBy === 'confidence-asc') {
    sorted.sort((a, b) => {
      const pa = primaryTab(a), pb = primaryTab(b)
      return (pa.confidence ?? 11) - (pb.confidence ?? 11) || pa.file.localeCompare(pb.file)
    })
  } else if (state.sortBy === 'priority-desc') {
    sorted.sort((a, b) => {
      const pa = primaryTab(a), pb = primaryTab(b)
      return (pb.priority ?? -1) - (pa.priority ?? -1) || pa.file.localeCompare(pb.file)
    })
  } else if (state.sortBy === 'priority-asc') {
    sorted.sort((a, b) => {
      const pa = primaryTab(a), pb = primaryTab(b)
      return (pa.priority ?? 11) - (pb.priority ?? 11) || pa.file.localeCompare(pb.file)
    })
  }
  return sorted
}
