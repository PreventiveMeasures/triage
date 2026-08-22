// Per-finding deep links — DOM half. `revealFinding(ref)` takes a ref
// parsed out of `#finding=…` (see `client/finding-link.js`) and gets the
// user looking at it: navigate to the report or workspace holding it,
// un-hide it (which in kanban means opening its detail modal), paint,
// scroll it into view, flash a ring.
//
// Resolution walks from cheap to thorough, stopping at the first hit:
//
//   1. Already loaded — the recipient is looking at the report (or a
//      workspace merging it) right now. No navigation at all.
//   2. The `v=` workspace half matches a local workspace → open it.
//   3. The `v=` report half matches a local report filename → open it.
//   4. Neither matched, or what they named no longer carries the
//      finding: scan every other stored report for the id and open
//      wherever it actually lives.
//
// Step 4 is what makes the hashed hints safe to be approximate. They
// are 3-byte digests of the SENDER's filename / workspace id, so they
// match only a recipient holding the very same name — and the same
// finding routinely lives under a different one (a re-run, a re-export,
// a copy in someone's own workspace). Rather than declare that a dead
// link, the scan finds the finding and shows it in whichever report
// does hold it. A stale or colliding hint costs one wasted load.
//
// Nothing here fetches from the network: the finding must already be in
// local storage. A link is a pointer into the recipient's own data, not
// a transfer — that's what the workspace share link and the export
// bundle are for.
//
// The state rules (which bucket, which filters, which member of a dedup
// group) live in `finding-link.js`; this module is navigation + paint.
import { findReportWithFinding, listWorkspaces, reportForHint, state, workspaceForHint, workspacesHoldingReport } from '#client/index.js'
import { report } from './dom.js'
import { findLoadedFinding, unhideFinding } from './finding-link.js'
import { switchToFile, switchToWorkspace } from './ingest.js'
import { render } from './render.js'
import { tableRowGid } from './render-finding.js'

// How long the arrived-at finding keeps its highlight. Long enough to
// catch the eye after the scroll settles, short enough that it doesn't
// read as a persistent selection state the user has to dismiss.
const FLASH_MS = 1600
const FLASH_CLASS = 'link-target'

// Shown when every step above came up empty. It deliberately doesn't
// name a report: the hints are digests, so we never learn the sender's
// filename — and after step 4 the honest statement is the broader one
// anyway, that the finding is in none of the reports this user holds.
const NOT_FOUND = "Couldn't find that finding in any of your reports. "
  + 'Import the report it came from, then open the link again.'

let flashTimer = null

// Clear the previous highlight before painting a new one — two links
// followed in quick succession should leave exactly one thing lit.
function flash(el) {
  if (flashTimer !== null) clearTimeout(flashTimer)
  for (const prev of document.querySelectorAll(`.${FLASH_CLASS}`)) {
    prev.classList.remove(FLASH_CLASS)
  }
  el.classList.add(FLASH_CLASS)
  flashTimer = setTimeout(() => {
    el.classList.remove(FLASH_CLASS)
    flashTimer = null
  }, FLASH_MS)
}

// Find the element standing in for `gid` in the just-painted view.
//
// Table view first, because it's the one mode where the gid appears
// TWICE: once on the row and once on the `<finding-card>` in the
// details aside `unhideFinding` just opened. The row is what needs
// scrolling — the aside is pinned in view already. Rows are
// `<finding-row>` children inside `<finding-table>`'s shadow root,
// populated when the table's own Lit update flushes (hence the
// `updateComplete` await), and each row stamps its own `data-gid` a
// microtask later still — so they're matched on the `group` property
// the table assigned rather than on the attribute.
//
// Kanban is the third double-up, and resolves the other way: the detail
// modal `unhideFinding` just opened holds a `<finding-card>` for the
// same gid, but that one is centred on screen already. What needs
// positioning is the BOARD card underneath, so dismissing the modal
// leaves the finding in view instead of wherever its column happened to
// be scrolled — and `scrollIntoView` on it also brings its column into
// view on a horizontally-scrolled board.
//
// Everywhere else `data-gid` comes from the PARENT template and lands
// with the synchronous render. `finding-card` is preferred over a bare
// `[data-gid]` for the focus view's double-up: the centred card and its
// "up next" queue entry both carry the gid, and the card is the one the
// user is reading.
async function findRenderedFinding(gid) {
  const escaped = CSS.escape(gid)
  if (state.viewMode === 'table') {
    const table = report.querySelector('finding-table')
    if (table) {
      try { await table.updateComplete } catch {}
      for (const row of table.shadowRoot?.querySelectorAll('finding-row') ?? []) {
        if (row.group && tableRowGid(row.group) === gid) return row
      }
    }
  }
  if (state.viewMode === 'kanban') {
    const card = report.querySelector(`.kanban-card[data-gid="${escaped}"]`)
    if (card) return card
  }
  return report.querySelector(`finding-card[data-gid="${escaped}"]`)
    ?? report.querySelector(`[data-gid="${escaped}"]`)
}

// Open a report by name, preferring the workspace it belongs to.
//
// A report attached to exactly one workspace is normally READ through
// that workspace — merged with its siblings, deduped across them — so
// dropping the user into a bare single-file view would show them the
// finding stripped of the context they'd have reached it with. With
// zero or several candidate workspaces there's no unambiguous choice,
// and the single-file view is the honest answer.
async function openReport(name) {
  const holders = workspacesHoldingReport(name)
  if (holders.length === 1) {
    if (state.currentWorkspace !== holders[0].id) await switchToWorkspace(holders[0].id)
    return
  }
  if (state.currentFile !== name) await switchToFile(name)
}

// Steps 2 and 3: turn the hint digests back into something local and
// switch to it. Returns true when a switch happened, so the caller
// re-runs the lookup against the new report set.
//
// Workspace first: a link built in workspace mode carries both hints,
// and the workspace is where the sender was looking. The report hint
// then covers the recipient who has the file but never joined the
// workspace.
async function navigateToHint({ report: reportHint, workspace }) {
  const ws = await workspaceForHint(workspace)
  if (ws && ws.id !== state.currentWorkspace) {
    await switchToWorkspace(ws.id)
    return true
  }
  const name = await reportForHint(reportHint)
  if (!name || state.currentFile === name) return false
  // Dropping out of a workspace into a single-file view is the right
  // move when the workspace doesn't hold the hinted report (the link
  // came from elsewhere, or the workspace was never attached) — and the
  // wrong one when it does: we'd already have found the finding above,
  // so the report is loaded and simply no longer carries it. Leaving
  // the merged view there would cost the user their context and still
  // fail. The scan (step 4) covers what's left either way.
  const current = state.currentWorkspace
    ? listWorkspaces().find((w) => w.id === state.currentWorkspace)
    : null
  if (current?.reports.includes(name)) return false
  await openReport(name)
  return true
}

// Step 4: the hints got us nowhere, so go looking. Reports already
// loaded are excluded — their in-memory groups were searched first, so
// re-reading them off disk could only repeat the miss.
async function navigateByScan(id) {
  const loaded = state.reports.map((r) => r.fileName).filter(Boolean)
  const name = await findReportWithFinding(id, { skip: loaded })
  if (!name) return false
  await openReport(name)
  return true
}

// Follow a parsed link ref. Resolves to `{ ok: true }` once the finding
// is on screen, or `{ ok: false, reason }` with a message the caller can
// show — a link that goes nowhere has to say so, otherwise pasting one
// into an already-open tab looks like the app ignored the paste.
export async function revealFinding(ref) {
  if (!ref?.id) return { ok: false, reason: 'This link is missing a finding id.' }
  let hit = findLoadedFinding(ref.id)
  if (!hit && await navigateToHint(ref)) hit = findLoadedFinding(ref.id)
  if (!hit && await navigateByScan(ref.id)) hit = findLoadedFinding(ref.id)
  if (!hit) return { ok: false, reason: NOT_FOUND }
  const gid = unhideFinding(hit.group, ref.id)
  render()
  const el = await findRenderedFinding(gid)
  if (!el) {
    // Nothing painted for this group. The expected reason is the triage
    // bucket: `unhideFinding` deliberately leaves `state.shownTriage`
    // alone (see its notes), so a link to a finding in a bucket the
    // reader isn't viewing resolves and navigates but has nothing on
    // screen to scroll to. Still a success — we're on the right report,
    // with the right member selected, and the toolbar's triage selector
    // is one click away. The missing scroll is the only casualty, and
    // an alert here would fire on an ordinary case.
    return { ok: true }
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  flash(el)
  return { ok: true }
}
