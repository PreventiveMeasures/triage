import { managedRouteForIds, managedRoutePath } from '../../common/managed/routes.js'
import { activeTabFor, groupKey, tabKey } from './group.js'
import { linkedFilters } from './filters.js'

// Use the filtered, sorted groups that are actually rendered. Focus can pick
// the next queue position without changing its last explicitly selected gid.
export function findingDetailGroup(groups, selection, previousFocusIndex = 0) {
  const { viewMode, focusGid, tableSelectedGid, kanbanPopoverGid } = selection
  const gid = viewMode === 'focus' ? focusGid : viewMode === 'table' ? tableSelectedGid : viewMode === 'kanban' ? kanbanPopoverGid : null
  const selected = gid ? groups.find(group => groupKey(group) === gid) : null
  if (selected) return selected
  return viewMode === 'focus' ? groups[Math.min(previousFocusIndex, groups.length - 1)] ?? null : null
}

// The page's URL as it is shown: the open finding's, or else the page's.
// A team's board names its repository and severity filters as well, when
// they are all it is filtered by (filters.js linkedFilters); only Kanban,
// as every other view is filtered by triage status too, which no link names.
export function managedFindingSelectionRoute(group, state) {
  if (state.currentView !== 'findings') return null
  const base = managedRouteForIds({ view: 'findings', teamId: state.currentManagedTeam, reportId: state.currentManagedReport }, state.managedTeams)
  if (base && !group && base.reportSlug == null && state.viewMode === 'kanban') {
    const filters = linkedFilters()
    return filters ? { ...base, filters } : base
  }
  if (!base || !group) return base
  const route = { ...base, finding: { id: tabKey(activeTabFor(group)) } }
  // Session-local IDs (and IDs that cannot survive a URL round trip) must not
  // replace a valid report/team URL with a link to a different finding.
  return managedRoutePath(route) ? route : base
}
