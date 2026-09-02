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
import { buildFindingUrl, isLinkableFindingId, knownLinkHint, state } from '#client/index.js'
import { applyFilters, resetFilters } from './filters.js'
import { getMergedGroups, groupKey, groupState, syncGroupTriage, tabKey } from './group.js'
import { cleanupGraph2 } from './graph/state.js'

// Shareable URL for one finding, or null when the finding can't carry a
// stable link (a session-local numeric `_id` — see
// `isLinkableFindingId`). Callers render the Link affordance only for a
// non-null result, so a link that would rot on the next reload is never
// offered in the first place.
//
// Both location hints ride along when known: the report the finding was
// ingested from (`_reportName`, stamped on every finding) and the
// workspace being viewed — each as the 3-byte digest `computeLinkHint`
// derives, never the name itself. In workspace mode the link carries
// both, so it resolves for a recipient holding either.
//
// `knownLinkHint` is the SYNCHRONOUS memo read, because this runs inside
// the Link button's click handler and the clipboard write must not be
// preceded by an await. Ingest primes the memo for every report it
// loads, so a miss means a report that arrived by some path that didn't
// — in which case the hint is simply omitted and the receiver's scan
// picks up the slack.
export function findingLinkFor(finding) {
  if (!finding) return null
  const id = tabKey(finding)
  if (!isLinkableFindingId(id)) return null
  const reportName = finding._reportName || state.currentFile || ''
  return buildFindingUrl({
    id,
    report: knownLinkHint('report', reportName),
    workspace: knownLinkHint('workspace', state.currentWorkspace ?? ''),
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
// Two things can hide a finding that exists:
//   1. Another top-level view (bundles / files / packages / …) is up.
//   2. A toolbar filter excludes it. Only cleared when it actually
//      excludes THIS group — a link shouldn't wipe a carefully built
//      filter set it was already compatible with. `state.sortBy` is
//      saved across the reset: `resetFilters` re-derives a default sort
//      for a fresh ingest, which is not what arriving via a link means.
//
// A third could, and deliberately isn't touched: the triage bucket split
// (`commonTriage === state.shownTriage` in render.js) is an EXCLUSIVE
// partition, so adopting the target's bucket shows it at the price of
// replacing everything else on screen — following "duplicate of <link>"
// out of the live list dropped the reader into the Invalid bucket and
// their working set vanished. A link should focus one finding, not
// repartition the view around it. The app's own graph "Findings →" jump
// sets filters and leaves the bucket alone for the same reason.
//
// The cost is that a link to a finding in a bucket the reader isn't
// viewing lands on the right report but doesn't scroll to anything —
// the toolbar's triage selector is one click away, and which bucket
// they're working in is their call, not the link's. Kanban is exempt
// from the whole question: it renders every bucket as a column.
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
  if (state.viewMode === 'kanban') {
    // A fullscreen column drops every OTHER column from the board, so a
    // link into one of them would land on a card that isn't rendered.
    // Collapse it only when the target sits elsewhere — a link into the
    // column the user already expanded shouldn't undo their layout.
    const column = groupState(group).commonTriage ?? 'untriaged'
    if (state.kanbanExpandedColumn !== null && state.kanbanExpandedColumn !== column) {
      state.kanbanExpandedColumn = null
    }
  }
  if (applyFilters([group]).length === 0) {
    const sortBy = state.sortBy
    resetFilters()
    state.sortBy = sortBy
  }
  const gid = groupKey(group)
  if (group.length > 1) state.activeTabByGroup.set(gid, id)
  // A link opens this finding as surely as a click does, in every mode
  // — including grouped / list, which have no selection to set below —
  // so level the group's triage here too (see syncGroupTriage).
  syncGroupTriage(group)
  // Per-mode selection — each mode's own "this one" state. Table opens
  // its details aside on the row, focus centres the card, and kanban
  // opens the detail modal: a board card is a title and a badge, which
  // is not what someone following a link to a specific finding came to
  // read. Setting the gid directly (rather than going through events.js's
  // `setKanbanPopoverGid`) matches what that helper does for a
  // card-to-card switch — a plain render, no view transition. The morph
  // animation only makes sense growing out of a card the user just
  // clicked, and on arrival there was no such click.
  //
  // Grouped and list have no selection concept; there the scroll + flash
  // in the nav module is the whole signal.
  if (state.viewMode === 'table') state.tableSelectedGid = gid
  else if (state.viewMode === 'focus') state.focusGid = gid
  else if (state.viewMode === 'kanban') state.kanbanPopoverGid = gid
  return gid
}
