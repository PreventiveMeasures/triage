// Per-finding deep links — headless half. Builds the `#finding=…` URL
// the `.mark-link` button copies, and works out what has to change in
// `state` for a linked finding to be on screen. The DOM half (navigate
// to the right report, scroll, flash) lives in `finding-link-nav.js`.
//
// The split mirrors `client/finding-lookup.js`: everything here is pure
// state in / state out, so the resolution rules — which are the part
// with real edge cases — are unit-testable without a browser, and the
// nav module stays a thin shell around them.
//
// Nothing in either half fetches: the finding must already be in local
// storage. A link is a pointer into the recipient's own data, not a
// transfer — that's what the workspace share link and the export bundle
// are for.
import { buildFindingUrl, isLinkableFindingId, state } from '#client/index.js'
import { applyFilters, resetFilters } from './filters.js'
import { getMergedGroups, groupKey, groupState, tabKey } from './group.js'
import { cleanupGraph2 } from './graph/state.js'

// Shareable URL for one finding, or null when the finding can't carry a
// stable link (a session-local numeric `_id` — see
// `isLinkableFindingId`). Callers render the Link affordance only for a
// non-null result, so a link that would rot on the next reload is never
// offered in the first place.
//
// Both location hints ride along when known: `report` is the OPFS
// filename the finding was ingested from (stamped as `_reportName` on
// every finding), `ws` the workspace being viewed. In workspace mode
// that means the link names both, so it resolves for a recipient
// holding either.
export function findingLinkFor(finding) {
  if (!finding) return null
  const id = tabKey(finding)
  if (!isLinkableFindingId(id)) return null
  return buildFindingUrl({
    id,
    report: finding._reportName ?? state.currentFile ?? '',
    workspace: state.currentWorkspace ?? '',
  })
}

// Locate a finding id in what's currently loaded. Walks the merged
// group view (not `state.reports` directly) so a cross-report dedup
// super-group resolves to the group the UI actually renders — selecting
// the per-report group would stamp an active-tab / selection key no
// rendered element carries.
export function findLoadedFinding(id) {
  for (const group of getMergedGroups()) {
    for (const finding of group) {
      if (tabKey(finding) === id) return { group, finding }
    }
  }
  return null
}

// Make `group` reachable on screen, and point the view at `id` within
// it. Pure state mutation — no render, no DOM — so the ordering rules
// below are testable and the nav module stays a thin shell. Returns the
// group's gid, which is what the nav module scrolls to.
//
// Three things can hide a finding that exists:
//   1. Another top-level view (bundles / files / packages / …) is up.
//   2. It sits in a triage bucket the toolbar isn't showing. The bucket
//      split is an equality test (`commonTriage === state.shownTriage`),
//      so we adopt the group's own bucket rather than clearing to live.
//   3. A toolbar filter excludes it. Only cleared when it actually
//      excludes THIS group — a link shouldn't wipe a carefully built
//      filter set it was already compatible with. `state.sortBy` is
//      saved across the reset: `resetFilters` re-derives a default sort
//      for a fresh ingest, which is not what arriving via a link means.
//
// Selecting the linked member (rather than just its group) matters for
// a multi-tab dedup group: without it the group opens on whichever
// sibling `activeTabFor` prefers, and the recipient reads a different
// finding than the sender pointed at.
export function unhideFinding(group, id) {
  state.currentView = 'findings'
  // The graph view mode paints a canvas, not per-finding cards — there
  // is nothing there to scroll to or select. Same fallback the graph's
  // own "Findings →" jump uses.
  if (state.viewMode === 'graph') {
    state.viewMode = 'table'
    cleanupGraph2()
  }
  const bucket = groupState(group).commonTriage
  state.shownTriage = bucket
  if (state.viewMode === 'kanban') {
    // Kanban ignores `shownTriage` (it shows every bucket as a column),
    // but has two ways of its own to hide the target: a fullscreen
    // column drops every OTHER column from the board, and an open
    // detail modal covers the board entirely. Collapse the first only
    // when the target sits elsewhere — a link into the column the user
    // already expanded shouldn't undo their layout — and always drop a
    // modal left open on some other finding.
    const column = bucket ?? 'untriaged'
    if (state.kanbanExpandedColumn !== null && state.kanbanExpandedColumn !== column) {
      state.kanbanExpandedColumn = null
    }
    state.kanbanPopoverGid = null
  }
  if (applyFilters([group]).length === 0) {
    const sortBy = state.sortBy
    resetFilters()
    state.sortBy = sortBy
  }
  const gid = groupKey(group)
  if (group.length > 1) state.activeTabByGroup.set(gid, id)
  // Per-mode selection. Table opens its details aside on the row and
  // focus centres the card, both of which are the mode's own "this
  // one" state; grouped / list / kanban have no selection concept, so
  // the scroll + flash in the nav module is the whole signal there.
  if (state.viewMode === 'table') state.tableSelectedGid = gid
  else if (state.viewMode === 'focus') state.focusGid = gid
  return gid
}
