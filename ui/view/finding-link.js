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
import { getMergedGroups, groupKey, groupState, sortTabs, tabKey } from './group.js'
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
// Three things can hide a finding that exists:
//   1. Another top-level view (bundles / files / packages / …) is up.
//   2. A toolbar filter excludes it. Only cleared when it actually
//      excludes THIS group — a link shouldn't wipe a carefully built
//      filter set it was already compatible with. `state.sortBy` is
//      saved across the reset: `resetFilters` re-derives a default sort
//      for a fresh ingest, which is not what arriving via a link means.
//   3. The triage bucket. `commonTriage === state.shownTriage` in
//      render.js is an EXCLUSIVE partition, so a finding in a bucket
//      the reader isn't viewing isn't merely un-scrolled-to: it isn't
//      rendered at all.
//
// (3) used to be left alone, on the reasoning that a link should focus
// one finding rather than repartition the view around it. That was
// wrong, and quietly so. The per-mode selection below still names the
// target's gid, and no view holds it — so in the focus mode the queue
// falls through to the previous index and centres a DIFFERENT finding,
// and a link "to" an in-progress finding delivers somebody else's. A
// link that lands on the wrong finding is worse than one that changes
// which bucket is on screen, and the reader can see the bucket
// selector move; they cannot see that the card they were handed is not
// the one the link named.
//
// Kanban is exempt, and for the honest reason rather than by
// exception: it renders every bucket as a column, so its board already
// holds the target and `shownTriage` isn't consulted for it at all.
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
  // Which bucket the group sits in — the kanban branch needs it to
  // name a column, every other mode to name the partition. One call
  // for both.
  const bucket = groupState(group).commonTriage
  if (state.viewMode === 'kanban') {
    // A fullscreen column drops every OTHER column from the board, so a
    // link into one of them would land on a card that isn't rendered.
    // Collapse it only when the target sits elsewhere — a link into the
    // column the user already expanded shouldn't undo their layout.
    const column = bucket ?? 'untriaged'
    if (state.kanbanExpandedColumn !== null && state.kanbanExpandedColumn !== column) {
      state.kanbanExpandedColumn = null
    }
  } else if (bucket !== state.shownTriage) {
    // Every other mode shows one bucket at a time; show the one the
    // link is in. The two fields range over the same values — one of
    // the five bucket names the selector offers, or null for the live
    // list — so this is a direct assignment, including back to null
    // for a link into the live set. Guarded on inequality because an
    // equal write still wakes every autorun reading the field.
    state.shownTriage = bucket
  }
  if (applyFilters([group]).length === 0) {
    const sortBy = state.sortBy
    resetFilters()
    state.sortBy = sortBy
  }
  const gid = groupKey(group)
  if (group.length > 1) {
    // A fourth thing that can hide a finding that exists: the
    // simplified app view folds the rows the pass re-rated under its
    // own row (group.js drawnTabs), so a link to one of them would
    // open its group on the pass's row — the wrong finding, which the
    // note on (3) above calls worse than a changed view. Detail comes
    // on for it, the way a filter that excluded the target is cleared.
    if (!sortTabs(group).some((f) => tabKey(f) === id)) state.revalidationDetailed = true
    state.activeTabByGroup.set(gid, id)
  }
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
