// Per-finding deep links, the headless half: the URL `.mark-link` copies,
// and what must change in `state` for a linked finding to be on screen,
// pure state so the rules are testable without a browser (the DOM half is
// finding-link-nav.js). A link carries a finding's identity, never report
// contents or credentials.
import { buildFindingUrl, isLinkableFindingId, isManagedUiMode, knownLinkHint, state, workspacesHoldingReport } from '#client/index.js'
import { managedRouteForIds, managedRoutePath } from '../../common/managed/routes.js'
import { applyFilters, matchesConfirmed, resetFilters, shouldLockConfirmed } from './filters.js'
import { getMergedGroups, getShownGroups, groupKey, groupState, linkableGroups, sortTabs, tabKey } from './group.js'
import { configureRevalidation, isRuledOut } from './format.js'
import { cleanupGraph2 } from './graph/state.js'

// A finding's shareable URL, or null where its id is session-local
// (isLinkableFindingId), which the next load would hand out again. A
// workspace's carries its hint, a report's its own and its workspace's
// where known, each a 3-byte digest of the name; no display mode. The hints
// are read synchronously (`knownLinkHint`, primed by ingest): the clipboard
// write in the click handler must not follow an await, and a miss leaves
// the receiver's scan to find it.
export function findingLinkFor(finding, { teamOnly = false, reportId: targetReportId } = {}) {
  if (!finding) return null
  const id = tabKey(finding)
  if (!isLinkableFindingId(id)) return null
  if (isManagedUiMode()) {
    const reportId = teamOnly ? null : targetReportId ?? (state.currentView === 'links' ? finding._managedReportId : state.currentManagedReport)
    const path = managedRoutePath(managedRouteForIds({ view: 'findings', teamId: state.currentManagedTeam, reportId, finding: { id } }, state.managedTeams))
    return path ? `${typeof location === 'undefined' ? '' : location.origin}${path}` : null
  }
  const reportName = finding._reportName || state.currentFile || ''
  const workspaceId = state.currentWorkspace || reportWorkspaceFor(reportName)
  return buildFindingUrl({
    id,
    report: state.currentWorkspace ? null : knownLinkHint('report', reportName),
    workspace: knownLinkHint('workspace', workspaceId ?? ''),
  })
}

// A report can belong to several workspaces. Preserve the row the user
// opened; otherwise infer a parent only when membership is unambiguous.
// Rechecking membership also handles reports moved while still open.
export function reportWorkspaceFor(name, preferred = state.currentReportWorkspace || state.currentWorkspace) {
  const holders = workspacesHoldingReport(name)
  if (holders.some((w) => w.id === preferred)) return preferred
  return holders.length === 1 ? holders[0].id : null
}

// A finding id among what is loaded, by the merged groups the UI renders
// (a per-report group's key would name nothing on screen): the visible copy
// first, as a workspace may also hold a hidden, ruled-out one, then those
// any lens hides (`linkableGroups`), which unhideFinding takes off.
export function findLoadedFinding(id) {
  for (const groups of [getMergedGroups(), linkableGroups()]) {
    for (const group of groups) {
      const finding = group.find((f) => tabKey(f) === id)
      if (finding) return { group, finding }
    }
  }
  return null
}

// `group` made reachable on screen, the view pointed at `id` in it, by
// state alone (no render, no DOM); its gid, for the nav module to scroll
// to. What can hide a finding that exists: another view; the graph mode,
// which draws no cards; the triage bucket, an exclusive partition, which
// otherwise leaves the focus view centring a different finding (kanban
// shows every bucket, but a fullscreen column hides the others); the
// upstream lens, which reaches inside a group (workspace-groups.js
// mergeReportGroups), kept where every member is upstream; a ruled-out or
// folded copy; and a filter, reset only where it excludes this group, the
// sort kept. The linked member is selected, not whichever sibling
// activeTabFor prefers.
export function unhideFinding(group, id) {
  state.currentView = 'findings'
  if (state.viewMode === 'graph') {
    state.viewMode = 'table'
    cleanupGraph2()
  }
  const bucket = groupState(group).commonTriage
  if (state.viewMode === 'kanban') {
    const column = bucket ?? 'untriaged'
    if (state.kanbanExpandedColumn !== null && state.kanbanExpandedColumn !== column) {
      state.kanbanExpandedColumn = null
    }
  } else if (bucket !== state.shownTriage) {
    // Guarded: an equal write still wakes every autorun reading it.
    state.shownTriage = bucket
  }
  if (state.upstreamOnly && !group.every((f) => f.isUpstream)) state.upstreamOnly = false
  configureRevalidation(state.showRevalidation, state.upstreamOnly)
  // Following a link explicitly asks to see its target, including a ruled-out
  // finding, a folded tab or a row excluded by the fixed Confirmed view.
  const target = group.find((f) => tabKey(f) === id)
  const needsUnderlying = isRuledOut(target)
    || (shouldLockConfirmed(getShownGroups()) && !matchesConfirmed(group))
    || !sortTabs(group).some((f) => tabKey(f) === id)
  if (needsUnderlying) {
    if (state.currentWorkspace) {
      // A workspace cannot unfold an app-specific verdict. Reveal source
      // findings in the corresponding source lens, then resolve its merged row.
      if (target?.isUpstream) state.upstreamOnly = true
      else state.showRevalidation = false
      configureRevalidation(state.showRevalidation, state.upstreamOnly)
      const revealed = getMergedGroups().find((g) => g.some((f) => tabKey(f) === id))
      if (revealed) return unhideFinding(revealed, id)
    } else state.revalidationDetailed = true
  }
  if (applyFilters([group]).length === 0) {
    const sortBy = state.sortBy
    resetFilters()
    state.sortBy = sortBy
  }
  const gid = groupKey(group)
  if (group.length > 1) {
    state.activeTabByGroup.set(gid, id)
  }
  // Each mode's own selection: the table's details, the focus card, the
  // kanban detail modal (set directly, as a card-to-card switch is: no
  // morph without a card clicked). The lists have none; the nav module's
  // scroll and flash are their signal.
  if (state.viewMode === 'table') state.tableSelectedGid = gid
  else if (state.viewMode === 'focus') state.focusGid = gid
  else if (state.viewMode === 'kanban') state.kanbanPopoverGid = gid
  return gid
}
