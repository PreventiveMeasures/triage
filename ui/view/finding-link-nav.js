// Per-finding deep links — DOM half. `revealFinding(ref)` takes a ref
// parsed out of `#finding=…` (see `client/finding-link.js`) and gets the
// user looking at it: navigate to the report or workspace holding it,
// un-hide it, paint, scroll it into view, flash a ring.
//
// Deliberately forgiving about WHERE the finding lives and strict about
// WHETHER it was found. A link built inside a workspace still lands for
// a recipient who only attached the single report; but if the id isn't
// in anything we can reach, the caller gets a reason to show rather
// than a silent no-op on a pasted link.
//
// The state rules (which bucket, which filters, which member of a dedup
// group) live in `finding-link.js`; this module is navigation + paint.
import { listFiles, listWorkspaces, state } from '#client/index.js'
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
// Everywhere else `data-gid` comes from the PARENT template and lands
// with the synchronous render. `finding-card` is preferred over a bare
// `[data-gid]` for the focus view's second double-up: the centred card
// and its "up next" queue entry both carry the gid, and the card is the
// one the user is reading.
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
  return report.querySelector(`finding-card[data-gid="${escaped}"]`)
    ?? report.querySelector(`[data-gid="${escaped}"]`)
}

// Switch the app to the report / workspace a link points at, when the
// hint names one we hold and aren't already on. Returns true when a
// switch happened (the caller re-resolves against the new report set).
//
// Workspace first: a link built in workspace mode names both, and the
// workspace view is where the sender was looking. The report fallback
// covers the recipient who has the file but never joined the workspace.
async function navigateToHint({ report: reportHint, workspace }) {
  const wantsOtherWorkspace = Boolean(workspace) && state.currentWorkspace !== workspace
  if (wantsOtherWorkspace && listWorkspaces().some((w) => w.id === workspace)) {
    await switchToWorkspace(workspace)
    return true
  }
  if (!reportHint || state.currentFile === reportHint) return false
  // Dropping out of a workspace into a single-file view is the right
  // move when the workspace doesn't hold the hinted report (the link
  // came from elsewhere, or the workspace was never attached) — and the
  // wrong one when it does: we'd already have found the finding above,
  // so the report is loaded and simply no longer carries it. Leaving
  // the merged view there would cost the user their context and still
  // fail.
  const current = state.currentWorkspace
    ? listWorkspaces().find((w) => w.id === state.currentWorkspace)
    : null
  if (current?.reports.includes(reportHint)) return false
  const names = await listFiles()
  if (!names.includes(reportHint)) return false
  await switchToFile(reportHint)
  return true
}

// Why a ref didn't resolve, phrased as the next thing to do. Runs only
// on the miss path, so the extra OPFS listing costs nothing that
// matters: knowing whether the linked report is merely un-opened or
// genuinely absent is the difference between "open it" and "import it".
async function missingReason({ report: reportHint, workspace }) {
  if (reportHint) {
    const names = await listFiles().catch(() => [])
    return names.includes(reportHint)
      ? `Couldn't find that finding in "${reportHint}". The report has probably changed since the link was made.`
      : `Couldn't find that finding. It was linked from "${reportHint}", which isn't among your reports — import it, then open the link again.`
  }
  const wsName = workspace
    ? listWorkspaces().find((w) => w.id === workspace)?.name
    : null
  return wsName
    ? `Couldn't find that finding in the "${wsName}" workspace. The report holding it may no longer be attached.`
    : "Couldn't find that finding in your local reports. Import the report it came from, then open the link again."
}

// Follow a parsed link ref. Resolves to `{ ok: true }` once the finding
// is on screen, or `{ ok: false, reason }` with a message the caller can
// show — a link that goes nowhere has to say so, otherwise pasting one
// into an already-open tab looks like the app ignored the paste.
//
// The lookup runs against what's loaded BEFORE navigating as well as
// after: in a workspace that already holds the finding, re-switching to
// the hinted report would drop the user out of their merged view for no
// gain. Only a miss pays for the navigation.
export async function revealFinding(ref) {
  if (!ref?.id) return { ok: false, reason: 'This link is missing a finding id.' }
  let hit = findLoadedFinding(ref.id)
  if (!hit) {
    const moved = await navigateToHint(ref)
    if (moved) hit = findLoadedFinding(ref.id)
  }
  if (!hit) return { ok: false, reason: await missingReason(ref) }
  const gid = unhideFinding(hit.group, ref.id)
  render()
  const el = await findRenderedFinding(gid)
  if (!el) {
    // Rendered nothing for a group we just un-hid. Not fatal — the
    // navigation + selection above already landed the user on the right
    // report — so report success rather than sending them chasing a
    // phantom problem; the missing scroll is the only casualty.
    return { ok: true }
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  flash(el)
  return { ok: true }
}
