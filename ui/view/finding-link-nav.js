// Per-finding deep links — DOM half. `revealFinding(ref)` takes a ref
// parsed out of `#finding=…` (see `client/finding-link.js`) and gets the
// user looking at it: navigate to the report or workspace holding it,
// un-hide it (which in kanban means opening its detail modal), paint,
// scroll it into view, flash a ring.
//
// Resolve the workspace/report in `v=` before inspecting loaded findings.
// A report hint selects that report; a workspace hint on its own selects
// the workspace. Missing or stale hints fall back to locally held data.
// The viewer's display mode is preserved throughout.
//
// Nothing here fetches from the network: the finding must already be in
// local storage. A link is a pointer into the recipient's own data, not
// a transfer — that's what the workspace share link and the export
// bundle are for.
//
// The state rules (which bucket, which filters, which member of a dedup
// group) live in `finding-link.js`; this module is navigation + paint.
import { saveTriage, state } from '#client/index.js'
import { report } from './dom.js'
import { findLoadedFinding, unhideFinding } from './finding-link.js'
import { locateLinkedFinding } from './finding-link-route.js'
import { findGroupById, groupKey, syncGroupTriage } from './group.js'
import { switchToFile, switchToWorkspace } from './ingest.js'
import { scrollRootOf } from './lazy-render.js'
import { render } from './render.js'

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

// How many frames an element has to hold still before a scroll counts
// as finished, and how long to wait for that at most (a smooth scroll
// across a long list runs well under two seconds).
const SETTLE_FRAMES = 3
const SETTLE_MAX_FRAMES = 150
// Rounds of correction after the first scroll. Two is the usual
// outcome; the cap is for a target the scroller can't centre (the
// last card in a list), which would otherwise be asked forever.
const SCROLL_ROUNDS = 5

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

// Resolves once `el` has stopped moving on screen — the same position
// for a few frames running — or after the cap.
function settled(el) {
  return new Promise((resolve) => {
    let last = null
    let still = 0
    let frames = 0
    const tick = () => {
      const top = Math.round(el.getBoundingClientRect().top)
      still = top === last ? still + 1 : 0
      last = top
      if (still >= SETTLE_FRAMES || ++frames >= SETTLE_MAX_FRAMES) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

// The part of the screen `el` can be seen in: the box of the nearest
// container that scrolls it (the lists scroll inside
// `#findings-body-slot` / `.findings-table-list`, under the page header
// and the toolbar), cut down to the window. Measured against the
// window alone, an element sitting under the toolbar — on screen by
// its coordinates, clipped by the scroller — would count as visible.
function visibleBox(el) {
  let top = 0
  let bottom = window.innerHeight
  const scroller = scrollRootOf(el)
  if (scroller) {
    const s = scroller.getBoundingClientRect()
    top = Math.max(top, s.top)
    bottom = Math.min(bottom, s.bottom)
  }
  return { top, bottom }
}

// Whether `el` is where a `block: 'center'` scroll leaves it: wholly
// inside its visible box, or — for one taller than the box — around
// its middle.
function inView(el) {
  const r = el.getBoundingClientRect()
  if (r.height === 0) return false
  const { top, bottom } = visibleBox(el)
  if (bottom <= top) return false
  const mid = (top + bottom) / 2
  return (r.top >= top && r.bottom <= bottom) || (r.top <= mid && r.bottom >= mid)
}

// Scroll `el` to the middle of the view, and make sure it stays there.
//
// The lists estimate the height of everything not yet built — the
// `contain-intrinsic-size` of a skipped group (findings.css,
// finding-table.css) and the shell of a card still out of range
// (view/lazy-render.js) — so the position a scroll aims at is a guess,
// and a smooth scroll that builds a thousand cards on its way there
// arrives somewhere the target has since moved away from: thousands
// of pixels short, on a long list. Once the animation has stopped
// moving the element, the heights around it are real, and an instant
// correction lands on it. One round usually does; the loop is for a
// correction that itself builds the last few neighbours.
async function scrollToSettled(el) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  for (let round = 0; round < SCROLL_ROUNDS; round++) {
    await settled(el)
    if (!el.isConnected || inView(el)) return
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
  }
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
        if (row.group && groupKey(row.group) === gid) return row
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

// Put a located finding on screen: un-hide it, paint, scroll to it,
// ring it. Shared by both entry points below — everything up to this
// point is about FINDING the thing, and everything from here is the
// same regardless of how it was found.
async function focusFound(hit, id) {
  const gid = unhideFinding(hit.group, id)
  // A link opens this finding as surely as a click does, so its group
  // gets the same levelling the detail surfaces do (see
  // syncGroupTriage). It lives here rather than in `unhideFinding`,
  // which is a pure state mutation by contract; persistence waits for
  // the paint, as everywhere else that levels.
  const shownGroup = findGroupById(gid)
  if (shownGroup && syncGroupTriage(shownGroup)) queueMicrotask(saveTriage)
  render()
  const el = await findRenderedFinding(gid)
  if (!el) {
    // Nothing painted for this group. `unhideFinding` clears whatever
    // it can reach — the view, the filters, the triage bucket — so
    // this is now the residue: a mode whose DOM doesn't carry the
    // group, or a group that fell out between the mutation and the
    // paint. Still a success, because the navigation happened and the
    // right member is selected; only the scroll is missing, and an
    // alert here would fire on something the reader can't act on.
    return { ok: true }
  }
  // A card or row past the first screen is an empty shell until it
  // comes within range (view/lazy-render.js): build it first, so the
  // scroll lands on its real height and the ring has a body to sit on.
  if (typeof el.ensureRendered === 'function') await el.ensureRendered()
  await scrollToSettled(el)
  // Flash after the scroll, not before it: the ring lasts a moment and
  // a long scroll would spend most of that moment on the way.
  flash(el)
  return { ok: true }
}

// Follow a parsed link ref. Resolves to `{ ok: true }` once the finding
// is on screen, or `{ ok: false, reason }` with a message the caller can
// show — a link that goes nowhere has to say so, otherwise pasting one
// into an already-open tab looks like the app ignored the paste.
export async function revealFinding(ref) {
  if (!ref?.id) return { ok: false, reason: 'This link is missing a finding id.' }
  const hit = await locateLinkedFinding(ref, {
    openReport: switchToFile,
    openWorkspace: switchToWorkspace,
  })
  if (!hit) return { ok: false, reason: NOT_FOUND }
  return await focusFound(hit, ref.id)
}

// The Links view names a specific report's copy, even when a workspace
// holds several reports with that id. Open it directly so the selected
// copy retains that report's severity, corrections, and annotations.
export async function revealFindingInReport(id, reportName) {
  if (!id || !reportName) return { ok: false, reason: 'Missing finding id or report name.' }
  if (state.currentFile !== reportName || state.currentWorkspace) await switchToFile(reportName)
  const hit = findLoadedFinding(id)
  if (!hit) {
    return {
      ok: false,
      reason: `Couldn't find that finding in "${reportName}". `
        + 'It may have been re-imported since this links file was written.',
    }
  }
  return await focusFound(hit, id)
}
